/**
 * Outcome-trim planner — 「成果取代探索」(R2 improvement).
 * Round-12 hardening (Codex independent-test failures F01–F06):
 *   F01  only status==="completed" rows can be method/outcome anchors; running/pending/
 *        waiting rows are retained as unfinished_* — never anchors.
 *   F02  scope = DIRECT declared-topic matches only. A shared URL/target key does NOT
 *        adopt rows from other tasks (harvest-adoption removed; re-declaring topics is
 *        the documented remedy for topic drift).
 *   F03  protectedPartIds are honoured BEFORE every other branch (incl. archiveFailures);
 *        retained and candidates are strictly disjoint (conservation throws).
 *   F04  every in-scope row lands in EXACTLY one bucket; candidate ids are unique;
 *        counts.candidates === candidates.length; violations throw.
 *   F06  rows carry data_sha256; the plan binds source_digests + a session snapshot, so
 *        same-byte-length edits are detected at apply time.
 * I3 exceptions are recorded per item: candidates that are the last row of their command
 * line carry override_of:"i3-last-per-group" — never a blanket "none".
 * Pure module: no database access, no I/O, no text rewriting.
 */
import { createHash } from "node:crypto";

const CRITICAL_RE = /pass|fail|error|commit|hash|applied|deleted|created|solv(?:ed|es)|assert/i;
const norm = (s) => String(s ?? "").toLowerCase().replace(/\s+/g, " ").trim();

/** Stable identifiers worth reporting as task targets (informational). */
export function extractTargetKeys(text) {
  const keys = new Set();
  for (const re of [/https?:\/\/[^\s"'<>\\]+/g, /\b[0-9a-f]{16,}\b/gi, /[A-Za-z]:\\[^\s"'<>|*?]{6,}/g]) {
    for (const m of String(text ?? "").match(re) ?? []) {
      const k = m.toLowerCase().replace(/[.,;)\]]+$/, "");
      if (k.length >= 12) keys.add(k);
    }
  }
  return keys;
}

/**
 * Build the outcome-trim plan for one session's console rows.
 * @param {object} p
 * @param {Array}  p.rows    chronological console rows:
 *        {part_id, tool, bytes, input_text, output_text, status, data_sha256?, message_id?, rowid?, sequence?}
 * @param {string[]} p.topics user-declared topics (seed substrings, case-insensitive)
 * @param {object} [p.opts]  {keepLast=1, archiveFailures=false, protectedPartIds:Set}
 * @returns {{plan:Object|null, notes:string[]}} plan has NO hash yet — caller stamps it.
 */
export function planOutcomeTrim({ rows, topics, opts = {} }) {
  const notes = [];
  const keepLast = Math.max(1, Number(opts.keepLast ?? 1));
  const archiveFailures = !!opts.archiveFailures;
  const protectedIds = opts.protectedPartIds instanceof Set ? opts.protectedPartIds : new Set(opts.protectedPartIds ?? []);
  const topicsNorm = (topics ?? []).map((t) => String(t).toLowerCase()).filter(Boolean);
  if (!topicsNorm.length) throw new Error("outcome-trim: at least one --topic is required (declaration is the user's, not the engine's)");

  // F02: scope = DIRECT declared-topic matches. Shared URLs/tools/bootstrap strings do not
  // adopt rows from other tasks; widening coverage = declaring more topics.
  const inScope = rows.filter((r) => topicsNorm.some((t) => (r.input_text + "\n" + r.output_text).toLowerCase().includes(t)));
  if (!inScope.length) {
    return { plan: null, notes: ["no rows match the declared topics — nothing proposed; all rows stay kept (reason: outside_declared_scope)"] };
  }
  notes.push(`scope: ${inScope.length}/${rows.length} console rows (direct declared-topic matches only — shared targets do not adopt other tasks' rows)`);

  // command-line grouping for the I3-override record (same rule as the policy layer)
  const lineKey = (r) => r.tool + "|" + norm(r.input_text).slice(0, 160);
  const lastOfLine = new Set();
  {
    const seen = new Set();
    for (let i = inScope.length - 1; i >= 0; i--) {
      const k = lineKey(inScope[i]);
      if (!seen.has(k)) lastOfLine.add(inScope[i].part_id);
      seen.add(k);
    }
  }

  // F01/F03: single classification pass, one bucket per row. Order matters:
  //   protected → unfinished (F01) → failure/critical (or Tier-2 archive) → empty → success
  const retained = [];
  const candidatesTier2 = [];
  const plain = [];
  const bucketOf = new Map(); // part_id -> bucket (conservation bookkeeping)
  for (const r of inScope) {
    const head = String(r.output_text ?? "").replace(/\s+/g, " ").slice(0, 80);
    if (protectedIds.has(r.part_id)) {
      retained.push({ part_id: r.part_id, bytes: r.bytes, reason: "protected_by_policy_pin", head });
      bucketOf.set(r.part_id, "retained");
      continue;
    }
    if (isCritical(r)) { // failure/critical evidence first: an errored row is failure evidence, not "unfinished"
      if (archiveFailures) {
        candidatesTier2.push({ part_id: r.part_id, bytes: r.bytes, head, archived_evidence: true });
        bucketOf.set(r.part_id, "candidate_tier2");
      } else {
        retained.push({ part_id: r.part_id, bytes: r.bytes, reason: r.status === "error" ? "failure_evidence" : "critical_evidence", head });
        bucketOf.set(r.part_id, "retained");
      }
      continue;
    }
    if (r.status && r.status !== "completed") { // F01: running/pending/awaiting approval is unfinished, never an outcome
      retained.push({ part_id: r.part_id, bytes: r.bytes, reason: "unfinished_" + String(r.status).toLowerCase(), head });
      bucketOf.set(r.part_id, "retained");
      continue;
    }
    if ((r.output_text ?? "").length === 0) {
      if (archiveFailures) {
        candidatesTier2.push({ part_id: r.part_id, bytes: r.bytes, head, archived_evidence: true });
        bucketOf.set(r.part_id, "candidate_tier2");
      } else {
        retained.push({ part_id: r.part_id, bytes: r.bytes, reason: "empty_result_unproven", head });
        bucketOf.set(r.part_id, "retained");
      }
      continue;
    }
    plain.push(r);
    bucketOf.set(r.part_id, "plain_success");
  }
  if (!plain.length) {
    return { plan: null, notes: [...notes, "no successful (completed, non-empty) row in scope — outcome not established; nothing proposed (reason: no_outcome_evidence)"] };
  }

  // method record = first success; outcome anchors = last keepLast successes
  const methodRow = plain[0];
  const outcomeRows = plain.slice(Math.max(0, plain.length - keepLast));
  const anchor = outcomeRows.at(-1);
  const anchorId = anchor.part_id;
  const keepIds = new Set([methodRow.part_id, ...outcomeRows.map((r) => r.part_id)]);
  notes.push(`outcome anchor: part ${anchorId} (heuristic: last completed success; semantic sufficiency declared by user)`);
  notes.push(`method record: part ${methodRow.part_id} (first completed success in scope)`);
  // method + outcome anchors appear in the retained list with explicit reasons, so the
  // dry-run preview and byte accounting always show them alongside the other protections
  retained.push({ part_id: methodRow.part_id, bytes: methodRow.bytes, reason: "method_record_first_success", head: String(methodRow.output_text ?? "").replace(/\s+/g, " ").slice(0, 80) });
  for (const r of outcomeRows) if (r.part_id !== methodRow.part_id) retained.push({ part_id: r.part_id, bytes: r.bytes, reason: "outcome_anchor", head: String(r.output_text ?? "").replace(/\s+/g, " ").slice(0, 80) });

  // candidates = tier2-archived evidence + plain successes between method and outcome
  const candById = new Map();
  for (const c of candidatesTier2) {
    candById.set(c.part_id, { part_id: c.part_id, bytes: c.bytes, replaced_by: anchorId, override_of: lastOfLine.has(c.part_id) ? "i3-last-per-group" : "none", head: c.head, archived_evidence: true });
  }
  for (const r of plain) {
    if (keepIds.has(r.part_id)) continue;
    if (candById.has(r.part_id)) continue;
    candById.set(r.part_id, { part_id: r.part_id, bytes: r.bytes, replaced_by: anchorId, override_of: lastOfLine.has(r.part_id) ? "i3-last-per-group" : "none", head: String(r.output_text ?? "").replace(/\s+/g, " ").slice(0, 80) });
  }
  const candidates = [...candById.values()];

  // F03/F04 conservation — hard assertions (throw, never silently mis-count)
  const retainedIds = retained.map((x) => x.part_id);
  if (new Set(retainedIds).size !== retainedIds.length) throw new Error("outcome-trim conservation: duplicate retained part_id");
  if (new Set(candidates.map((c) => c.part_id)).size !== candidates.length) throw new Error("outcome-trim conservation: duplicate candidate part_id");
  for (const c of candidates) if (retained.some((x) => x.part_id === c.part_id) || keepIds.has(c.part_id))
    throw new Error(`outcome-trim conservation: part ${c.part_id} is both retained/kept and a candidate`);
  if (candidates.some((c) => protectedIds.has(c.part_id))) throw new Error("outcome-trim conservation: a protected part id entered the candidate list");
  if (candidates.some((c) => !bucketOf.has(c.part_id))) throw new Error("outcome-trim conservation: candidate row was never classified");
  const outside = rows.length - inScope.length;

  // F06: bind the plan to the source content (digest per affected row; caller supplies data_sha256)
  const source_digests = {};
  let missingDigests = 0;
  for (const id of [...candidates.map((c) => c.part_id), ...retained.map((x) => x.part_id), ...keepIds]) {
    const r = rows.find((x) => x.part_id === id);
    if (r?.data_sha256) source_digests[id] = r.data_sha256; else missingDigests++;
  }
  if (missingDigests) notes.push(`${missingDigests} affected rows lack data_sha256 (planner-only use) — apply will refuse plans without complete digests`);

  const plan = {
    schema: 2,
    mode: "outcome-trim",
    session_scope: "single session; candidate ids bind to this session only",
    topics: topicsNorm,
    outcome: {
      anchor_part_id: anchorId,
      anchors: outcomeRows.map((r) => r.part_id),
      method_part_id: methodRow.part_id,
      evidence: "heuristic: first completed success = method record, last completed successes = outcome; semantic sufficiency declared by user",
    },
    method: { kind: "in-session-kept", part_id: methodRow.part_id, note: "the first successful row carries the working method; external skill stamp optional via --skill-path" },
    candidates: candidates.map((c) => ({ ...c, bytes_final_after_apply: 0 })),
    retained,
    counts: { in_scope: inScope.length, candidates: candidates.length, retained: retained.length, outside_scope: outside, outcome_anchors: outcomeRows.length },
    bytes: { candidates_bytes: candidates.reduce((a, c) => a + c.bytes, 0), retained_bytes: retained.reduce((a, r) => a + r.bytes, 0) },
    source_digests,
    tier2: archiveFailures ? { archive_failures: true, declaration: "user-declared: failure/empty/critical evidence inside the declared scope may be archived; recoverable from the verified backup (sealed set)" } : undefined,
    guarantees: {
      i1_text: "untouched (planner only sees tool rows)",
      i3_relationship: "normal mode unchanged; per-command last-result rows entering candidates carry override_of:i3-last-per-group with replaced_by evidence — recorded per item, never a blanket value",
      decision_source: "deterministic planner rules + user declaration; no Jev verdicts are claimed",
    },
  };
  return { plan, notes };
}

function isCritical(r) {
  return r.status === "error" || CRITICAL_RE.test(r.output_text ?? "");
}

/** Canonical hash of a plan (hash field excluded). */
export function planSha256(plan) {
  const body = { ...plan };
  delete body.plan_sha256;
  return createHash("sha256").update(JSON.stringify(body)).digest("hex");
}

/**
 * Verify the live rows still match the plan's bound digests (F06: same-length edits are
 * caught because the comparison is content-hash based, not byte-count based).
 * rowsNow: [{part_id, data_sha256}] — computed by the caller from the live store.
 */
export function verifyPlanSource(plan, rowsNow) {
  const digests = plan.source_digests;
  if (!digests || typeof digests !== "object") return { ok: false, problems: [{ problem: "plan_missing_source_digests" }] };
  const now = new Map(rowsNow.map((r) => [r.part_id, r.data_sha256]));
  const problems = [];
  for (const [id, want] of Object.entries(digests)) {
    const got = now.get(id);
    if (got == null) problems.push({ part_id: id, problem: "missing_in_source" });
    else if (got !== want) problems.push({ part_id: id, problem: "content_changed", plan_digest: want, live_digest: got });
  }
  return { ok: problems.length === 0, problems };
}

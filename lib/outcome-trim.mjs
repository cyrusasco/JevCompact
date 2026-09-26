/**
 * Outcome-trim planner — 「成果取代探索」(R2 improvement, round-10).
 *
 * A completed sub-task keeps its actual result, source/scope, still-valid limits, user
 * corrections and unfinished work; exploration rows superseded by the outcome are archived
 * (dropped from the active context) — per declared scope, never by tool family or by a
 * shared bootstrap prefix (Codex round-9: a shared 160-char prefix is NOT a task boundary).
 *
 * Pure module: no database access, no I/O. The DB walk lives in zcode-jve.mjs; the CLI in
 * bin/jevcompact.mjs. Every retained/blocked row carries an explicit reason; anything the
 * planner cannot prove superseded stays kept. No text is ever rewritten; the only effect
 * of applying a plan is deleting whole candidate part rows.
 */
import { createHash } from "node:crypto";

/** Stable identifiers we treat as task targets: URLs, long hex/base62 ids, absolute paths. */
const TARGET_URL = /https?:\/\/[^\s"'<>\\]+/g;
const TARGET_ID = /\b[0-9a-f]{16,}\b/gi;
const TARGET_PATH = /[A-Za-z]:\\[^\s"'<>|*?]{6,}/g;

export function extractTargetKeys(text) {
  const keys = new Set();
  for (const re of [TARGET_URL, TARGET_ID, TARGET_PATH]) {
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
 * @param {Array}  p.rows           chronological console rows: {part_id, tool, bytes, input_text, output_text, status}
 * @param {string[]} p.topics       user-declared topics (seed substrings, case-insensitive)
 * @param {object} [p.opts]         {keepLast=1, toolFamilyRegex="/node_repl|computer-use|browser/i", protectedPartIds:Set}
 * @returns {{plan:Object, notes:string[]}} plan has NO hash yet — caller stamps it.
 */
export function planOutcomeTrim({ rows, topics, opts = {} }) {
  const notes = [];
  const keepLast = Math.max(1, Number(opts.keepLast ?? 1));
  const topicsNorm = (topics ?? []).map((t) => String(t).toLowerCase()).filter(Boolean);
  if (!topicsNorm.length) throw new Error("outcome-trim: at least one --topic is required (declaration is the user's, not the engine's)");
  const protectedIds = opts.protectedPartIds instanceof Set ? opts.protectedPartIds : new Set();

  // 1. seed rows = rows whose input/output text contains any declared topic
  const seeds = rows.filter((r) => topicsNorm.some((t) => (r.input_text + "\n" + r.output_text).toLowerCase().includes(t)));
  if (!seeds.length) {
    return { plan: null, notes: ["no rows match the declared topics — nothing proposed; all rows stay kept (reason: outside_declared_scope)"] };
  }
  // 2. grow the scope: harvest stable target keys from seed rows, then adopt rows sharing any key
  const targetKeys = new Set();
  for (const s of seeds) for (const k of extractTargetKeys(s.input_text + "\n" + s.output_text)) targetKeys.add(k);
  const inScope = [];
  for (const r of rows) {
    const keys = extractTargetKeys(r.input_text + "\n" + r.output_text);
    const hit = topicsNorm.some((t) => (r.input_text + "\n" + r.output_text).toLowerCase().includes(t)) || [...keys].some((k) => targetKeys.has(k));
    if (hit) inScope.push(r);
  }
  notes.push(`scope: ${inScope.length}/${rows.length} console rows (seed ${seeds.length} → target-key harvest ${targetKeys.size} keys)`);

  // 3. classification inside scope (order matters): failure/critical/empty rows are retained
  //    BEFORE anchor selection, so a later CRITICAL row can never demote the real result row.
  //    Among the plain successes: the FIRST is the method record (承接做法), the LAST keepLast
  //    are the outcome anchors (承接成果) — everything between is superseded exploration.
  const isCritical = (r) => r.status === "error" || /pass|fail|error|commit|hash|applied|deleted|created|solv(?:ed|es)|assert/i.test(r.output_text ?? "");
  const isPlainSuccess = (r) => r.status !== "error" && (r.output_text ?? "").length > 0 && !isCritical(r);
  const retained = [];
  const plainSuccesses = [];
  for (const r of inScope) {
    const head = String(r.output_text ?? "").replace(/\s+/g, " ").slice(0, 80);
    if (isCritical(r)) { retained.push({ part_id: r.part_id, bytes: r.bytes, reason: r.status === "error" ? "failure_evidence" : "critical_evidence", head }); continue; }
    if ((r.output_text ?? "").length === 0) { retained.push({ part_id: r.part_id, bytes: r.bytes, reason: "empty_result_unproven", head }); continue; }
    plainSuccesses.push(r);
  }
  if (!plainSuccesses.length) {
    return { plan: null, notes: ["no successful row in scope — outcome not established; nothing proposed (reason: no_outcome_evidence)"] };
  }
  const methodRow = plainSuccesses[0]; // first success carries the working method (承接做法)
  const outcomeRows = plainSuccesses.slice(Math.max(0, plainSuccesses.length - keepLast)); // last keepLast = outcome
  const outcomeIds = new Set(outcomeRows.map((r) => r.part_id));
  const methodIds = new Set([methodRow.part_id]);
  const anchor = outcomeRows.at(-1);
  notes.push(`outcome anchor: part ${anchor.part_id} (heuristic: last successful row; semantic sufficiency declared by user)`);
  notes.push(`method record: part ${methodRow.part_id} (first success in scope)`);
  const outcomeIdsAll = new Set([...outcomeIds, ...methodIds]);
  // anchors and the method record appear in the retained list with explicit reasons, so the
  // dry-run preview and the byte accounting always show them alongside the other protections
  if (!retained.some((x) => x.part_id === methodRow.part_id)) retained.push({ part_id: methodRow.part_id, bytes: methodRow.bytes, reason: "method_record_first_success", head: String(methodRow.output_text ?? "").replace(/\s+/g, " ").slice(0, 80) });
  for (const r of outcomeRows) if (r.part_id !== methodRow.part_id) retained.push({ part_id: r.part_id, bytes: r.bytes, reason: "outcome_anchor", head: String(r.output_text ?? "").replace(/\s+/g, " ").slice(0, 80) });

  // 4. per-row classification inside scope; anything not provably superseded stays kept
  const candidates = [];
  for (const r of inScope) {
    if (outcomeIdsAll.has(r.part_id)) continue;
    if (retained.some((x) => x.part_id === r.part_id)) continue;
    if (protectedIds.has(r.part_id)) { retained.push({ part_id: r.part_id, bytes: r.bytes, reason: "protected_by_policy_pin" }); continue; }
    candidates.push({ part_id: r.part_id, bytes: r.bytes, replaced_by: anchor.part_id, override_of: "none", head: String(r.output_text ?? "").replace(/\s+/g, " ").slice(0, 80) });
  }
  // rows outside every declared scope: never candidates
  const outside = rows.length - inScope.length;

  const plan = {
    schema: 1,
    mode: "outcome-trim",
    session_scope: "single session; candidate ids bind to this session only",
    topics: topicsNorm,
    outcome: {
      anchor_part_id: anchor.part_id,
      anchors: outcomeRows.map((r) => r.part_id),
      method_part_id: methodRow.part_id,
      evidence: "heuristic: first success = method record, last successes = outcome; semantic sufficiency declared by user",
    },
    method: { kind: "in-session-kept", part_id: methodRow.part_id, note: "the first successful row carries the working method; external skill stamp optional via --skill-path" },
    candidates: candidates.map((c) => ({ ...c, bytes_final_after_apply: 0 })),
    retained: retained,
    counts: { in_scope: inScope.length, candidates: candidates.length, retained: retained.length, outside_scope: outside, outcome_anchors: outcomeRows.length },
    bytes: { candidates_bytes: candidates.reduce((a, c) => a + c.bytes, 0), retained_bytes: retained.reduce((a, r) => a + r.bytes, 0) },
    guarantees: {
      i1_text: "untouched (planner only sees tool rows)",
      i3_relationship: "normal mode unchanged; per-command last-result rows entering candidates are listed with override_of and replaced_by evidence; no global I3 off",
      decision_source: "deterministic planner rules + user declaration; no Jev verdicts are claimed",
    },
  };
  return { plan, notes };
}

/** Canonical hash of a plan (hash field excluded). */
export function planSha256(plan) {
  const body = { ...plan };
  delete body.plan_sha256;
  return createHash("sha256").update(JSON.stringify(body)).digest("hex");
}

/** Verify the live rows still match what the plan was built from (parallel-modification check). */
export function verifyPlanSource(plan, rowsNow) {
  const now = new Map(rowsNow.map((r) => [r.part_id, r.bytes]));
  const problems = [];
  for (const id of [...plan.candidates.map((c) => c.part_id), ...plan.retained.map((r) => r.part_id), ...plan.outcome.anchors]) {
    const b = now.get(id);
    if (b == null) problems.push({ part_id: id, problem: "missing_in_source" });
    else {
      const inPlan = plan.candidates.find((c) => c.part_id === id) ?? plan.retained.find((r) => r.part_id === id);
      if (inPlan && inPlan.bytes !== b) problems.push({ part_id: id, problem: "bytes_changed", plan: inPlan.bytes, live: b });
    }
  }
  return { ok: problems.length === 0, problems };
}

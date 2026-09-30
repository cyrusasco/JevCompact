/**
 * context-slim.mjs — Context-20 planner (round-22, "B+" variant).
 *
 * ONE CLICK on Compact now runs this as the final stage of the pipeline: it rewrites the
 * SENT-CONTEXT representation of a session so the model's next request is ~20% of its
 * current size, WITHOUT an LLM summary and WITHOUT touching a single user word.
 *
 * What it does to each part row (DB writes, backup+ledger first, reversible):
 *   text (real user words)                    → UNTOUCHED
 *   text (platform noise: todo reminders,
 *         task-notifications, plugin refs,
 *         continuation summaries, tool
 *         replays)                            → replaced by a ONE-LINE note per kind
 *   text (assistant conclusions)              → keep the newest `keepConclusions` (15)
 *   tool result: last carrier of a sentence-
 *         type correction entity              → keep head 300 + marker
 *   tool result: I3 critical                  → keep head 300 + marker
 *   tool (TodoWrite)                          → keep only the LAST one; older → one line
 *   tool (Write/Edit confirm text)            → one line (path kept — it's in the anchor index)
 *   everything else (old exploration)         → one line
 *   + one synthetic anchor-index row          → every path/file/hash remains citable
 *
 * The planner is PURE (rows in → plan out); applyContextSlim() executes with the same
 * backup/ledger/atomic machinery as every other JevCompact deletion.
 */
import { createHash } from "node:crypto";

const CRITICAL_RE = /pass|fail|error|commit|hash|applied|deleted|created|solv(?:ed|es)|assert/i;
const norm = (s) => String(s).toLowerCase().replace(/\s+/g, " ").trim();
const sha = (s) => createHash("sha256").update(Buffer.from(String(s), "utf8")).digest("hex");

export const PLATFORM_NOISE_RE =
  /^(\s*(The TodoWrite tool hasn\x27t been used|\[SYSTEM NOTIFICATION|<task-notification>|<plugin_reference>|Called the Read tool|Called the Bash tool|Called the Write tool|Called the Edit tool|This session is being continued))/;

/** Build the Context-20 (B+) plan from chronological part rows of ONE session.
 *  rows: [{part_id, message_id, msg_index, role, type, tool, input, output, display, status, data, data_sha256}]
 *  opts: { keepConclusions=15, headChars=300, correctionEntities:Set<string> (sentence-type),
 *          i3CallIds:Set<string>, pendingCallIds:Set<string>, recentMsgs=2, budgetPct=0.20 } */
export function planContextSlim(rows, opts = {}) {
  const keepConclusions = opts.keepConclusions ?? 15;
  const headChars = opts.headChars ?? 300;
  const recentMsgs = opts.recentMsgs ?? 2;
  const corrEnts = [...(opts.correctionEntities ?? [])].filter((e) => e.length > 8);
  const isSentenceEnt = (e) => /[\u4e00-\u9fff]/.test(e) || e.includes(" ");
  const sentEnts = corrEnts.filter(isSentenceEnt);
  const i3 = opts.i3CallIds instanceof Set ? opts.i3CallIds : new Set(opts.i3CallIds ?? []);
  const pending = opts.pendingCallIds instanceof Set ? opts.pendingCallIds : new Set(opts.pendingCallIds ?? []);

  // ---- classification pass (single bucket per row; conservation-checked) ----
  const byId = new Map(rows.map((r) => [r.part_id, r]));
  const toolRows = rows.filter((r) => r.type === "tool");
  // last carrier per sentence entity
  const lastCarrier = new Map();
  for (let i = toolRows.length - 1; i >= 0; i--) {
    const x = toolRows[i];
    const hay = norm(String(x.input ?? "") + "\n" + String(x.output ?? "") + "\n" + String(x.display ?? ""));
    for (const e of sentEnts) if (!lastCarrier.has(e) && hay.includes(norm(e))) lastCarrier.set(e, x.part_id);
  }
  const carrierIds = new Set([...lastCarrier.values()]);
  // last TodoWrite row
  let lastTodo = null;
  for (const x of toolRows) if (/todowrite/i.test(String(x.tool ?? ""))) lastTodo = x.part_id; // chronological ⇒ last wins
  // assistant conclusions: newest N text rows with role assistant
  const assistantTexts = rows.filter((r) => r.type === "text" && r.role === "assistant");
  const keepConcIds = new Set(assistantTexts.slice(-keepConclusions).map((r) => r.part_id));
  // recent messages
  const maxMsg = Math.max(0, ...rows.map((r) => r.msg_index ?? 0));
  const recentFrom = maxMsg - recentMsgs + 1;
  // anchor universe (from ALL rows before changes)
  const ctxAll = rows.map((r) => [r.input, r.output, r.display, r.type === "text" ? r.text : ""].map(String).join("\n")).join("\n");
  const anchors = [...new Set((ctxAll.match(/[A-Za-z]:\\[^\s"'<>|*?]{6,}|[\w.-]+\.(?:ts|js|mjs|cjs|json|md|py|rs|toml|ya?ml|sqlite|log|lock|txt|html|css)\b/g) ?? []).map((a) => a.toLowerCase()))].filter((a) => a.length > 6);

  const edits = []; // {part_id, action: "noise-note"|"slim"|"keep", new_data?}
  const noiseKinds = {};
  for (const r of rows) {
    const isRecent = (r.msg_index ?? 0) >= recentFrom;
    if (r.type === "text") {
      if (r.role === "user" && PLATFORM_NOISE_RE.test(String(r.text ?? ""))) {
        const kind = /TodoWrite tool/.test(r.text) ? "todo-reminder" : /task-notification/.test(r.text) ? "task-notification" : /plugin_reference/.test(r.text) ? "plugin-ref" : /This session is being continued/.test(r.text) ? "old-summary" : "tool-replay";
        noiseKinds[kind] = (noiseKinds[kind] ?? 0) + 1;
        edits.push({ part_id: r.part_id, action: "noise-note", kind, old_sha: r.data_sha256 });
        continue;
      }
      if (r.role === "user") { edits.push({ part_id: r.part_id, action: "keep", why: "real-user-word" }); continue; }
      // assistant
      if (keepConcIds.has(r.part_id)) edits.push({ part_id: r.part_id, action: "keep", why: "recent-conclusion" });
      else edits.push({ part_id: r.part_id, action: "noise-note", kind: "old-conclusion", old_sha: r.data_sha256 });
      continue;
    }
    if (r.type !== "tool") { edits.push({ part_id: r.part_id, action: "keep", why: "non-core-type" }); continue; }
    // tool rows
    if (isRecent || pending.has(r.part_id)) { edits.push({ part_id: r.part_id, action: "keep", why: isRecent ? "recent" : "unfinished" }); continue; }
    if (/todowrite/i.test(String(r.tool ?? ""))) {
      if (r.part_id === lastTodo) edits.push({ part_id: r.part_id, action: "keep", why: "latest-todo" });
      else edits.push({ part_id: r.part_id, action: "noise-note", kind: "old-todo-snapshot", old_sha: r.data_sha256 });
      continue;
    }
    if (carrierIds.has(r.part_id)) { edits.push({ part_id: r.part_id, action: "slim", why: "lesson-carrier", head: headChars, old_sha: r.data_sha256 }); continue; }
    if (i3.has(r.part_id)) { edits.push({ part_id: r.part_id, action: "slim", why: "i3-critical", head: headChars, old_sha: r.data_sha256 }); continue; }
    edits.push({ part_id: r.part_id, action: "noise-note", kind: "old-exploration", old_sha: r.data_sha256 });
  }

  // conservation
  const ids = edits.map((e) => e.part_id);
  if (new Set(ids).size !== ids.length) throw new Error("context-slim conservation: duplicate part_id");
  if (ids.length !== rows.length) throw new Error(`context-slim conservation: ${ids.length} edits vs ${rows.length} rows`);
  for (const e of edits) if (!byId.has(e.part_id)) throw new Error("context-slim conservation: unknown part_id " + e.part_id);

  // token estimate (chars/4 — same ballpark the panel uses for context display)
  const est = (s) => Math.ceil(String(s ?? "").length / 4);
  const beforeTok = rows.reduce((a, r) => a + est(r.data), 0);
  let afterTok = 0;
  const noteTok = 6;
  for (const e of edits) {
    const r = byId.get(e.part_id);
    if (e.action === "keep") afterTok += est(r.data);
    else if (e.action === "slim") afterTok += Math.min(est(r.data), est(String(r.tool)) + 30 + e.head / 4 + 20);
    else afterTok += noteTok;
  }
  const indexTok = est(anchors.join(" | ")) + 8;
  afterTok += indexTok;

  const plan = {
    schema: 1,
    mode: "context-slim-B+",
    session_scope: "single session",
    opts: { keepConclusions, headChars, recentMsgs },
    counts: {
      rows: rows.length,
      keep_user_words: edits.filter((e) => e.why === "real-user-word").length,
      keep_recent: edits.filter((e) => e.why === "recent").length,
      keep_unfinished: edits.filter((e) => e.why === "unfinished").length,
      keep_conclusions: edits.filter((e) => e.why === "recent-conclusion").length,
      keep_latest_todo: edits.filter((e) => e.why === "latest-todo").length,
      slim_lesson_carriers: edits.filter((e) => e.why === "lesson-carrier").length,
      slim_i3: edits.filter((e) => e.why === "i3-critical").length,
      noise_notes: edits.filter((e) => e.action === "noise-note").length,
      noise_kinds: noiseKinds,
      sentence_entities: sentEnts.length, filename_entities: corrEnts.length - sentEnts.length,
      anchors: anchors.length,
    },
    est: { before_tokens: beforeTok, after_tokens: afterTok, index_tokens: indexTok, reduction_pct: beforeTok ? Math.round(1000 * (beforeTok - afterTok) / beforeTok) / 10 : 0 },
    edits,
    anchors,
    guarantees: {
      user_words: "UNTOUCHED — real user text rows are never edited (only platform-noise rows are replaced by one-line notes)",
      reversibility: "every edit is a row rewrite recorded with old_sha in the ledger; restore replays them",
      decision_source: "deterministic B+ rules (round-21 evidence: platform noise 201k vs real words 19k across 7 sessions; critical value lives in the first 300 chars)",
    },
  };
  return plan;
}

export function contextSlimSha(plan) {
  const body = { ...plan };
  delete body.plan_sha256;
  return createHash("sha256").update(JSON.stringify(body)).digest("hex");
}

#!/usr/bin/env node
/**
 * jve — compact a ZCode session IN PLACE over its persisted history, zero LLM in the loop.
 *
 *   CLI:  node zcode-jve.mjs <session-id|prefix|live> [--apply] [options]
 *   API:  import { compactZcodeSession } from "./zcode-jve.mjs"
 *         const report = await compactZcodeSession(idOrPrefix, { apply: true, log })
 *
 * Pipeline: read the session's message/part rows from ~/.zcode/cli/db/db.sqlite
 * -> build the fast-jev transcript -> HTTPS to api.typesafe.ai (Jev decides;
 * no host agent, no local model in the loop) -> translate the decisions back
 * to SQL on the SAME session:
 *   drop_call   : DELETE the tool part row(s) (a retried call may store
 *                 several rows under one callID — every one of them is removed)
 *   drop_result : UPDATE the part row, truncating state.output to head + note
 *   everything else (text, reasoning, step-*): NEVER touched — verbatim kept
 *
 * The t<n> numbering replicates collectToolCalls (src/state.ts) exactly: only
 * tool_uses that have a paired tool_result consume an id, iterated in message
 * order — which is what makes decision -> part-row lookup reliable.
 *
 * Safety model
 *   - API/CLI default is a DRY RUN: builds the plan, commits nothing.
 *   - apply:true refuses while the session has a turn_usage row 'running', or
 *     while its rollout log was touched in the last 120 s (session probably
 *     still open in the UI; closing the app flushes the log once, so waiting
 *     120 s after a close is enough). force:true skips both guards (not recommended).
 *   - a guarded refusal or a below-the-floor reduction returns a BENIGN result
 *     (ok:false, benign:true, CLI exit 0): nothing was written, nothing broke —
 *     the session was already tight under the lossless policy.
 *   - a session whose skeleton alone exceeds the per-request state budget is
 *     compacted window by window (each request stays inside maxStateTokens), so
 *     long sessions no longer fail "history too large"; a call whose pair straddles
 *     a window boundary is numbered by neither half and therefore stays kept —
 *     safe by design.
 *   - apply:true takes an online backup first via db.backup() into
 *     ~/.zcode/backups/db-<timestamp>-pre-jve.sqlite.
 *   - All writes run in one BEGIN IMMEDIATE transaction; on any error, ROLLBACK.
 *   - Exit strategy (CLI): main() returns the code, the process ends naturally
 *     — no db.close()/process.exit dance that once caused a libuv assertion.
 *
 * Options (CLI; same keys in the API opts object)
 *   --keep=<n>            newest messages pinned            (default 6)
 *   --threshold=<0..1>    keep probability cutoff           (default 0.6)
 *   --truncate-head=<n>   chars kept when truncating output (default 300)
 *   --goal=<text>         what the session was about (helps Jev)
 *   --force               skip the liveness guards (not recommended)
 *   --min-reduction=<0..1>  apply floor: a plan below it is a BENIGN skip, nothing
 *                             written, exit 0 — the policy found nothing worth pruning
 *                             (default 0.05)
 *   --max-state-tokens=<n>  per-request state budget for the classifier (default 25000)
 *   --max-request-tokens=<n> full request budget including the question batch (default 30000)
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { compactMessages } from "./dist/index.js";
import { estimateTokens, goalFromMessages } from "./dist/state.js";
import { mineSets, applyPolicy, runExtraPasses, planBookkeepingClearing } from "./policy.mjs";
import { resolveApiKey } from "./mcp-server.mjs";

const DB_PATH = path.join(os.homedir(), ".zcode", "cli", "db", "db.sqlite");

/**
 * Rebuild the conversation from persisted message/part rows (pure; no database access).
 * Shared by compactZcodeSession (live) and the bench --mega capacity regression (frozen
 * fixture) so both read the history the exact same way.
 */
export function buildTranscript(messageRows, partRowsOf) {
  const transcript = [];
  for (const row of messageRows) {
    let data;
    try { data = JSON.parse(row.data); } catch { continue; }
    const msg = { role: data.role === "assistant" ? "assistant" : "user", text: "", toolUses: [], toolResults: [] };
    const texts = [];
    for (const p of partRowsOf.all(row.id)) {
      let pd;
      try { pd = JSON.parse(p.data); } catch { continue; }
      if (pd.type === "text") texts.push(pd.text ?? "");
      else if (pd.type === "tool") {
        const callId = pd.callID;
        if (!callId) continue;
        const st = pd.state ?? {};
        msg.toolUses.push({ tool_use_id: callId, tool: pd.tool ?? "tool", input: st.input ?? {} });
        // judgement payload: full visibility fix (P0 round-4) — the console-family tools carry
        // payload in BOTH state.output and metadata.display (measured: R2 rows with both
        // non-empty: 1,351/1,078/655); picking one left the other unseen. Fold order: non-empty
        // output, else display, else error; when both exist and the display is not already
        // contained in the output, append it (bounded cap keeps the remote payload finite).
        const oRaw = st.output, dRaw = st.metadata?.display;
        const oStr = typeof oRaw === "string" ? oRaw : (oRaw == null ? "" : JSON.stringify(oRaw));
        const dStr = dRaw == null ? "" : (typeof dRaw === "string" ? dRaw : JSON.stringify(dRaw));
        let jp = oStr || dStr || st.error || (st.status === "error" ? "error" : "");
        if (oStr && dStr && !oStr.includes(dStr)) jp = oStr + "\n[display] " + dStr;
        if (typeof jp !== "string") jp = JSON.stringify(jp ?? "");
        if (jp.length > 4096) jp = jp.slice(0, 4096) + " […judgement payload capped at 4096 chars…]";
        msg.toolResults.push({ tool_use_id: callId, text: jp, ...(st.status === "error" ? { isError: true } : {}) });
      }
      // every other type — reasoning, step-start, step-finish — is left alone
    }
    msg.text = texts.filter(Boolean).join("\n");
    transcript.push(msg);
  }
  return transcript;
}

/**
 * The shipped windowed classifier, split out of compactZcodeSession so the bench --mega
 * capacity regression can drive the exact production code path against a frozen fixture.
 *
 * The whole conversation skeleton goes into every request as the state, and the per-request
 * budget is maxStateTokens; when even a fully abridged skeleton does not fit (fitState
 * throws "history too large"), the transcript is partitioned into disjoint message
 * windows and each window classified with its own request. Numbering replicates
 * collectToolCalls exactly (only paired tool_uses consume an id, in message order);
 * entries carry (tool_use_id, message index, occurrence) so window-local t-numbers remap
 * onto the global rows. A call whose result falls outside its window is numbered by
 * neither half and receives no decision — it stays kept, safe by construction.
 */
export async function classifyTranscript(transcript, opts = {}) {
  const { apiKey, threshold = 0.6, keep = 6, truncateHead = 300, goal, maxStateTokens = 25000, maxRequestTokens = 30000, log = () => {} } = opts;
  const numbered = [];
  {
    const results = new Map();
    transcript.forEach((m, index) => { for (const r of m.toolResults ?? []) results.set(r.tool_use_id, index); }); // last wins, as in the library
    let n = 0;
    for (let mi = 0; mi < transcript.length; mi++) {
      const seen = new Map();
      for (const tu of transcript[mi].toolUses) {
        if (!results.has(tu.tool_use_id)) continue; // unpaired call: not a candidate, no id
        const occ = seen.get(tu.tool_use_id) ?? 0;
        seen.set(tu.tool_use_id, occ + 1);
        numbered.push({ id: `t${++n}`, tool_use_id: tu.tool_use_id, mi, occ });
      }
    }
  }
  const globalIdFor = new Map(numbered.map((c) => [`${c.tool_use_id}|${c.mi}|${c.occ}`, c.id]));
  log("contacting Jev (api.typesafe.ai) …");
  const perWindowBudget = Math.max(2000, Math.floor(Number(maxStateTokens) * 0.78));
  const windows = [];
  {
    let a = 0, est = 0;
    for (let i = 0; i < transcript.length; i++) {
      const m = transcript[i];
      const cost = estimateTokens((m.text ?? "") + JSON.stringify((m.toolUses ?? []).map((tu) => [tu.tool, tu.input]))) + 4;
      if (i > a && est + cost > perWindowBudget) { windows.push([a, i]); a = i; est = cost; }
      else est += cost;
    }
    windows.push([a, transcript.length]);
  }
  const sessionGoal = goal || goalFromMessages(transcript);
  const charsOf = (m) => (m.text?.length ?? 0) + (m.toolUses ?? []).reduce((sum, tu) => sum + (typeof tu.input === "string" ? tu.input.length : JSON.stringify(tu.input ?? {}).length), 0) + (m.toolResults ?? []).reduce((sum, r) => sum + (r.text?.length ?? 0), 0);
  const merged = [];
  const s = { messagesBefore: transcript.length, messagesAfter: 0, charsBefore: 0, charsAfter: 0, calls: 0, kept: 0, callsDropped: 0, resultsDropped: 0, pinned: 0, requests: 0, stateTokens: 0, stateStage: "", windowTokens: [] };
  let classified = 0, failed = 0;
  for (let w = 0; w < windows.length; w++) {
    const [a, b] = windows[w];
    const win = transcript.slice(a, b);
    const pairedIn = new Set();
    for (const m of win) for (const r of m.toolResults ?? []) pairedIn.add(r.tool_use_id);
    const local = []; // t1..tK in the library's exact numbering order (message, then toolUses within message)
    for (let mi = a; mi < b; mi++) {
      const seen = new Map();
      for (const tu of transcript[mi].toolUses) {
        if (!pairedIn.has(tu.tool_use_id)) continue;
        const occ = seen.get(tu.tool_use_id) ?? 0;
        seen.set(tu.tool_use_id, occ + 1);
        local.push(`${tu.tool_use_id}|${mi}|${occ}`);
      }
    }
    if (!local.length) { s.messagesAfter += b - a; s.windowTokens.push(0); continue; } // nothing to ask about in this window
    let wp = null;
    try {
      wp = await compactMessages(win, {
        apiKey,
        keepThreshold: Number(threshold),
        preserveRecentMessages: w === windows.length - 1 ? Number(keep) : 0,
        truncateHeadChars: Number(truncateHead),
        maxStateTokens: Number(maxStateTokens),
        maxRequestTokens: Number(maxRequestTokens),
        ...(goal ? { goal } : { goal: sessionGoal }),
      });
    } catch (e) {
      failed++;
      const approx = win.reduce((sum, m) => sum + charsOf(m), 0);
      s.messagesAfter += b - a; s.charsBefore += approx; s.charsAfter += approx; s.windowTokens.push(0);
      log(`warning: window ${w + 1}/${windows.length} (messages ${a}–${b - 1}) refused: ${String(e?.message ?? e).slice(0, 150)} — its calls stay kept`);
      continue;
    }
    classified++;
    s.messagesAfter += wp.stats.messagesAfter;
    s.charsBefore += wp.stats.charsBefore;
    s.charsAfter += wp.stats.charsAfter;
    s.calls += wp.stats.calls;
    s.kept += wp.stats.kept;
    s.callsDropped += wp.stats.callsDropped;
    s.resultsDropped += wp.stats.resultsDropped;
    s.pinned += wp.stats.pinned;
    s.requests += wp.stats.requests;
    s.stateTokens = Math.max(s.stateTokens, wp.stats.stateTokens ?? 0);
    s.windowTokens.push(wp.stats.stateTokens ?? 0);
    s.stateStage = windows.length > 1 ? `windows ${classified}/${windows.length}` : wp.stats.stateStage;
    for (const d of wp.decisions) {
      const lid = /^t(\d+)$/.exec(String(d.id ?? ""));
      const key = lid && Number(lid[1]) >= 1 && Number(lid[1]) <= local.length ? local[Number(lid[1]) - 1] : undefined;
      const gid = key === undefined ? undefined : globalIdFor.get(key);
      if (gid === undefined) { log(`warning: decision ${d.id} of window ${w + 1} has no global counterpart — its call stays kept`); continue; }
      merged.push({ ...d, id: gid });
    }
  }
  if (!merged.length) return { ok: false, reason: failed ? "all-windows-refused" : "no-paired-calls", stats: s, numbered, windows, classified, failed };
  if (windows.length > 1) log(`transcript partitioned into ${windows.length} windows (${classified} classified, ${failed} refused-and-kept), requests ${s.requests}, state ≤ ${s.stateTokens} tokens each`);
  return { ok: true, decisions: merged, stats: s, numbered, windows, classified, failed };
}

export async function compactZcodeSession(idOrPrefix, opts = {}) {
  const { apply = false, keep = 6, threshold = 0.6, truncateHead = 300, policy = true, goal, force = false, minReduction = 0.05, maxStateTokens = 25000, maxRequestTokens = 30000, dedup = false, trimCarriers = false, bookkeeping = false, log = () => {} } = opts;
  const apiKey = resolveApiKey();
  if (!apiKey) return { ok: false, error: "no TypeSafe API key (TYPESAFE_API_KEY or ~/.claude/settings.json env)" };

  const db = new DatabaseSync(DB_PATH, { open: true, readOnly: !apply });
  try {
    // 1. resolve the session row -------------------------------------------------
    const session = idOrPrefix === "live"
      ? db.prepare(`SELECT s.id, s.title, s.parent_id FROM session s
          WHERE (SELECT MAX(m.time_created) FROM message m WHERE m.session_id=s.id) IS NOT NULL
            AND instr(s.id, 'sess_subagent') = 0 AND (s.parent_id IS NULL OR s.parent_id = '')
          ORDER BY (SELECT MAX(m.time_created) FROM message m WHERE m.session_id=s.id) DESC LIMIT 1`).get()
      : (db.prepare("SELECT id, title, parent_id FROM session WHERE id = ?").get(idOrPrefix)
          ?? db.prepare("SELECT id, title, parent_id FROM session WHERE id LIKE ?").get(idOrPrefix + "%"));
    if (!session) return { ok: false, error: `no such session: ${idOrPrefix}` };
    // Subagent/derived sessions are not conversational — they are permanently
    // out of compaction scope (they only serve their parent session).
    if (session.id.includes("sess_subagent") || session.parent_id) {
      return { ok: false, error: `refused: ${session.id} is a subagent/derived session — listing and compaction both exclude it (it serves only its parent)` };
    }
    log(`session ${session.id} — ${String(session.title).slice(0, 60)}`);

    // 2. liveness guards -----------------------------------------------------------
    const runningTurns = db.prepare("SELECT COUNT(*) n FROM turn_usage WHERE session_id = ? AND status = 'running'").get(session.id).n;
    const rolloutFile = path.join(os.homedir(), ".zcode", "cli", "rollout", `model-io-${session.id}.jsonl`);
    const rolloutAgeSec = fs.existsSync(rolloutFile) ? Math.floor((Date.now() - fs.statSync(rolloutFile).mtimeMs) / 1000) : Number.POSITIVE_INFINITY;
    if (apply && !force && (runningTurns > 0 || rolloutAgeSec < 120)) {
      return { ok: false, guarded: true, benign: true, session, error: `the session looks live (running turns=${runningTurns}, last write ${rolloutAgeSec}s ago). If you just closed ZCode, the closing flush touched the log once — that is normal: wait until it has been idle for 120 s, then run again. If the session is open in the UI, close its tab first. force:true skips this guard (not recommended).` };
    }

    // 3. load the persisted history --------------------------------------------------
    const messageRows = db.prepare("SELECT id, data FROM message WHERE session_id = ? ORDER BY time_created, rowid").all(session.id);
    const partRowsOf = db.prepare("SELECT id, data FROM part WHERE message_id = ? ORDER BY (sequence IS NULL), sequence, rowid");
    const transcript = buildTranscript(messageRows, partRowsOf);
    if (!transcript.length) return { ok: false, error: "session has no readable messages" };

    // 4. multimap callID -> part rows (the t<n> numbering lives in classifyTranscript) ----
    const partRowsByCallId = new Map();
    {
      const allParts = db.prepare("SELECT id, data FROM part WHERE session_id = ?").all(session.id);
      for (const p of allParts) {
        let pd; try { pd = JSON.parse(p.data); } catch { continue; }
        if (pd?.type !== "tool" || !pd.callID) continue;
        const list = partRowsByCallId.get(pd.callID) ?? [];
        list.push(p);
        partRowsByCallId.set(pd.callID, list);
      }
    }
    // 5. ask Jev — the shipped windowed classifier (the bench --mega capacity regression
    // drives the same code path against the frozen fixture; see classifyTranscript above)
    const cls = await classifyTranscript(transcript, { apiKey, threshold, keep, truncateHead, goal, maxStateTokens, maxRequestTokens, log });
    if (!cls.ok) return { ok: false, benign: cls.reason !== "all-windows-refused", error: cls.reason === "all-windows-refused" ? `all ${cls.windows.length} window(s) refused to classify — session left untouched` : "no paired tool calls found — nothing to compact" };
    const numbered = cls.numbered;
    const s = cls.stats;
    const numberedById = new Map(numbered.map((c) => [c.id, c]));
    const plan = { stats: s, decisions: cls.decisions };
    // 5b. lossless policy pass (bench/IMPROVEMENT-PLAN.md): force-keep goal / correction-round /
    // failure-cause evidence and the last result of each distinct command line, then recompute
    // the footprint so the plan reflects what will actually be pruned once policy is applied.
    let policyPinned = null;
    if (policy) {
      policyPinned = applyPolicy(transcript, plan.decisions, mineSets(transcript)).pinned;
      // v1.1 opt-in passes — only ever turn drop rows (dedup / dependent-carrier trim);
      // the footprint recompute below folds them into the same plan the floor guards check.
      if (dedup || trimCarriers) Object.assign(policyPinned, runExtraPasses(transcript, plan.decisions, mineSets(transcript), { dedup: !!dedup, trimCarriers: !!trimCarriers }));
      const str = (x) => (typeof x === "string" ? x : x == null ? "" : JSON.stringify(x));
      const resLen = new Map();
      for (const m of transcript) for (const r of m.toolResults ?? []) resLen.set(r.tool_use_id, (r.text ?? "").length);
      const size = new Map();
      let q = 0;
      for (const m of transcript) for (const tu of m.toolUses ?? []) if (resLen.has(tu.tool_use_id)) size.set(`t${++q}`, { call: str(tu.input).length, result: resLen.get(tu.tool_use_id) });
      let pruned = 0;
      for (const d of plan.decisions) {
        const sz = size.get(d.id);
        if (!sz) continue;
        if (d.action === "drop_call") pruned += sz.call + sz.result;
        else if (d.action === "drop_result") pruned += Math.max(0, sz.result - Number(truncateHead));
      }
      s.charsAfter = Math.max(0, s.charsBefore - pruned);
      s.kept = plan.decisions.filter((d) => d.action === "keep").length;
      s.callsDropped = plan.decisions.filter((d) => d.action === "drop_call").length;
      s.resultsDropped = plan.decisions.filter((d) => d.action === "drop_result").length;
    }
    const ratio = s.charsBefore > 0 ? Math.max(0, Math.min(1, (s.charsBefore - s.charsAfter) / s.charsBefore)) : 0;

    // 6. translate decisions to SQL ---------------------------------------------------
    const deletes = [];
    const updates = [];
    for (const d of plan.decisions) {
      if (d.action === "keep" || d.reason === "pinned") continue;
      const call = numberedById.get(d.id);
      if (!call) { log(`warning: decision ${d.id} has no collected counterpart — skipped`); continue; }
      const rows = partRowsByCallId.get(call.tool_use_id) ?? [];
      if (!rows.length) continue;
      if (d.action === "drop_call") {
        for (const r of rows) deletes.push(r.id);
      } else if (d.action === "drop_result") {
        for (const r of rows) {
          let pd;
          try { pd = JSON.parse(r.data); } catch { continue; }
          const outStr = typeof pd.state?.output === "string" ? pd.state.output : JSON.stringify(pd.state?.output ?? "");
          if (outStr.length > Number(truncateHead)) {
            pd.state = pd.state ?? {};
            pd.state.output = outStr.slice(0, Number(truncateHead)) + `\n[… ${outStr.length - Number(truncateHead)} chars pruned by jve …]`;
            updates.push({ partId: r.id, data: JSON.stringify(pd) });
          }
        }
      }
    }

    // 6b. bookkeeping-reduction (v1.1, opt-in): the file-state snapshots the Edit tool
    // stores per call exist so it can later detect a concurrent modification on disk — only
    // the NEWEST snapshot per path is ever consulted. Every older snapshot's content can be
    // cleared without loss (the file itself lives on disk); path/revisionId/mtime/size stay.
    let bk = null;
    if (bookkeeping) {
      const delSet = new Set(deletes);
      const snapRows = db.prepare("SELECT id, rowid AS seq, json_extract(data, '$.state.metadata.readFileState.path') AS path, json_extract(data, '$.state.metadata.readFileState.readAtMs') AS readAtMs, LENGTH(json_extract(data, '$.state.metadata.readFileState.content')) AS contentBytes FROM part WHERE session_id = ? AND json_extract(data, '$.type') = 'tool'").all(session.id);
      const present = [];
      for (const r of snapRows) if (!delSet.has(r.id) && r.path != null && r.contentBytes > 0) present.push({ rid: r.id, seq: Number(r.seq) || 0, path: String(r.path), readAtMs: Number(r.readAtMs) || 0, contentBytes: Number(r.contentBytes) });
      bk = planBookkeepingClearing(present);
      log(`bookkeeping-reduction: ${bk.files} file paths, newest kept ${bk.keptNewest}, ${bk.clearIds.size} stale snapshot contents cleared (~${(bk.clearedBytes / 1024).toFixed(0)} KiB freed)`);
    }

    const report = {
      ok: true,
      apply,
      session,
      plan: { messagesBefore: s.messagesBefore, messagesAfter: s.messagesAfter, charsBefore: s.charsBefore, charsAfter: s.charsAfter, reduction: Number(ratio.toFixed(4)), calls: s.calls, kept: s.kept, callsDropped: s.callsDropped, resultsDropped: s.resultsDropped, pinned: s.pinned, policyPins: policyPinned, requests: s.requests, stateTokens: s.stateTokens, stateStage: s.stateStage },
      sql: { deletes: deletes.length, updates: updates.length, nonToolPartsTouched: 0, clears: bk ? bk.clearIds.size : 0 },
      bookkeeping: bk ? { files: bk.files, keptNewest: bk.keptNewest, clearedRows: bk.clearIds.size, clearedBytes: bk.clearedBytes } : null,
    };
    // decision table preview so callers (the Studio log tab) can show per-call probabilities
    report.decisions = plan.decisions.slice(0, 80).map((d) => ({ id: d.id, tool: d.tool, action: d.action, keep_call: Number(d.keepCall.toFixed(2)), keep_result: Number(d.keepResult.toFixed(2)) }));
    if (!apply) { log("DRY RUN — nothing committed. Set apply:true to write back to the SAME session."); return report; }
    // A reduction under the 5% floor means the lossless policy kept every row
    // worth keeping — there is nothing left worth compacting. That is the
    // design succeeding, so report it as benign (exit 0), not as a failure.
    if (ratio < Number(minReduction)) return { ...report, ok: false, benign: true, error: `nothing worth compacting: reduction ${(ratio * 100).toFixed(1)}% is below the ${(Number(minReduction) * 100).toFixed(1)}% floor — the policy kept every row worth keeping, so no write was made. This is by design, not an error; compaction pays off on longer sessions.` };

    // 7. backup, then one transaction ---------------------------------------------------
    fs.mkdirSync(backupDir, { recursive: true });
    let backupFile = path.join(backupDir, `db-${Date.now()}-pre-jve.sqlite`);
    for (let i = 1; fs.existsSync(backupFile); i++) backupFile = path.join(backupDir, `db-${Date.now()}-${i}-pre-jve.sqlite`); // unique name
    // This runtime's node:sqlite DatabaseSync exposes no .backup() — use the SQLite
    // online backup method VACUUM INTO on the live connection (single-connection safe).
    if (typeof db.backup === "function") {
      await db.backup(backupFile);
    } else {
      db.exec(`VACUUM main INTO '${backupFile.replace(/'/g, "''")}'`);
    }
    if (!fs.existsSync(backupFile) || fs.statSync(backupFile).size < 1024)
      return { ok: false, error: `backup verification failed (missing or too small) — refusing to write: ${backupFile}` };
    log(`online backup taken + verified: ${backupFile} (${fs.statSync(backupFile).size} bytes)`);
    db.exec("BEGIN IMMEDIATE");
    try {
      const del = db.prepare("DELETE FROM part WHERE id = ?");
      for (const id of deletes) del.run(id);
      const upd = db.prepare("UPDATE part SET data = ?, time_updated = ? WHERE id = ?");
      const now = Date.now();
      for (const u of updates) upd.run(u.data, now, u.partId);
      if (bk) { const clr = db.prepare("UPDATE part SET data = json_remove(data, '$.state.metadata.readFileState.content'), time_updated = ? WHERE id = ?"); for (const id of bk.clearIds) clr.run(now, id); }
      db.exec("COMMIT");
      db.exec("PRAGMA wal_checkpoint");
    } catch (e) {
      try { db.exec("ROLLBACK"); } catch { /* already gone */ }
      return { ok: false, error: `transaction rolled back, nothing changed: ${e?.message ?? e}`, report };
    }
    report.committed = { partsDeleted: deletes.length, partsTruncated: updates.length, bookkeepingCleared: bk ? bk.clearIds.size : 0, bookkeepingBytes: bk ? bk.clearedBytes : 0, backup: backupFile };
    // per-call decision ledger, persisted beside the backup so the archive is self-auditing:
    // t ID -> tool_use_id -> part IDs, the Jev scores, the final action/reason with the
    // prior_reason audit trail, and the exact SQL change sets. Integrity: sha256 over the
    // canonical JSON body (written into report.ledger). Runs from before the ledger existed
    // keep no file — their audits then show the aggregate registry figures only (insufficient).
    try {
      const ledgerFile = `${backupFile}.ledger.json`;
      const ledger = {
        schema: 1, run_at: new Date().toISOString(), harness: "zcode",
        session: { id: session.id, title: session.title ?? null },
        backup: backupFile,
        sql: { deleted_part_ids: [...deletes], updated_part_ids: updates.map((u) => u.partId), cleared_part_ids: bk ? [...bk.clearIds] : [] },
        rows: plan.decisions.map((d) => { const c = numberedById.get(d.id) ?? {}; return { id: d.id, tool: d.tool ?? null, tool_use_id: c.tool_use_id ?? null, part_ids: (partRowsByCallId.get(c.tool_use_id) ?? []).map((r) => r.id), action: d.action ?? null, reason: d.reason ?? null, prior_reason: d.prior_reason ?? null, keep_call: d.keepCall ?? null, keep_result: d.keepResult ?? null }; }),
      };
      const body = JSON.stringify(ledger);
      fs.writeFileSync(ledgerFile, body);
      report.ledger = { file: ledgerFile, decisions: ledger.rows.length, sha256: createHash("sha256").update(body).digest("hex") };
      log(`decision ledger persisted: ${ledgerFile} (${ledger.rows.length} rows, sha256 ${report.ledger.sha256.slice(0, 16)}…)`);
    } catch { log("warning: decision ledger could not be written"); }
    log(`committed IN PLACE: ${deletes.length} part row(s) deleted, ${updates.length} truncated — session ${session.id} updated, history preserved (backup: ${backupFile}).`);
    return report;
  } finally {
    try { db.close(); } catch { /* closed */ }
  }
}

/* --------------------------- outcome-trim mode (round-10) ---------------------------
 * 「成果取代探索」：one completed sub-task keeps its actual result, source, still-valid
 * limits, user corrections and unfinished work; exploration rows superseded by the outcome
 * are archived. Opt-in, per declared scope, plan-hash bound, default dry-run. The normal
 * compaction path above is untouched. No text is ever rewritten; applying a plan deletes
 * whole candidate part rows and nothing else. Uses an isolated copy via opts.dbPath for
 * drills; the live DB is never touched unless the caller points at it with apply:true.
 */
import { planOutcomeTrim, planSha256, verifyPlanSource } from "./outcome-trim.mjs";

function outcomeReadConsoleRows(db, sessionId) {
  const mrows = db.prepare("SELECT id, data FROM message WHERE session_id = ? ORDER BY time_created, rowid").all(sessionId);
  const prows = db.prepare("SELECT id, data FROM part WHERE message_id = ? ORDER BY (sequence IS NULL), sequence, rowid");
  const rows = [];
  for (const m of mrows) {
    for (const p of prows.all(m.id)) {
      let pd; try { pd = JSON.parse(p.data); } catch { continue; }
      if (pd?.type !== "tool") continue;
      if (!/node_repl|computer-use|browser/i.test(String(pd?.tool ?? ""))) continue;
      const st = pd?.state ?? {};
      const o = st.output; const d = st.metadata?.display;
      const output_text = typeof o === "string" && o.length ? o : (o == null && d != null ? (typeof d === "string" ? d : JSON.stringify(d)) : (typeof o === "string" ? o : JSON.stringify(o ?? "")));
      rows.push({
        part_id: p.id, tool: String(pd.tool ?? "?"), bytes: Buffer.byteLength(p.data, "utf8"),
        input_text: JSON.stringify(st.input ?? {}), output_text,
        status: String(st.status ?? ""), data: p.data,
      });
    }
  }
  return rows;
}

function outcomeResolveSession(db, idOrPrefix) {
  const session = idOrPrefix === "live"
    ? db.prepare(`SELECT s.id, s.title, s.parent_id FROM session s
        WHERE (SELECT MAX(m.time_created) FROM message m WHERE m.session_id=s.id) IS NOT NULL
          AND instr(s.id, 'sess_subagent') = 0 AND (s.parent_id IS NULL OR s.parent_id = '')
        ORDER BY (SELECT MAX(m.time_created) FROM message m WHERE m.session_id=s.id) DESC LIMIT 1`).get()
    : (db.prepare("SELECT id, title, parent_id FROM session WHERE id = ?").get(idOrPrefix)
        ?? db.prepare("SELECT id, title, parent_id FROM session WHERE id LIKE ?").get(idOrPrefix + "%"));
  if (!session) return null;
  if (session.id.includes("sess_subagent") || session.parent_id) return { refused: session.id };
  return session;
}

function outcomeLivenessGuard(db, sessionId, apply, log) {
  let runningTurns = 0;
  try { runningTurns = db.prepare("SELECT COUNT(*) n FROM turn_usage WHERE session_id = ? AND status = 'running'").get(sessionId).n; } catch { /* fixture/isolated DBs have no turn_usage table */ }
  const rolloutFile = path.join(os.homedir(), ".zcode", "cli", "rollout", `model-io-${sessionId}.jsonl`);
  const rolloutAgeSec = fs.existsSync(rolloutFile) ? Math.floor((Date.now() - fs.statSync(rolloutFile).mtimeMs) / 1000) : Number.POSITIVE_INFINITY;
  if (apply && (runningTurns > 0 || rolloutAgeSec < 120)) {
    return { blocked: true, error: `the session looks live (running turns=${runningTurns}, last write ${rolloutAgeSec}s ago) — wait for 120 s idle, then run again` };
  }
  return { blocked: false };
}

function outcomeSessionStoreBytes(db, sessionId) {
  return db.prepare("SELECT COALESCE(SUM(LENGTH(CAST(data AS BLOB))),0) b, COUNT(*) n FROM part WHERE session_id = ?").get(sessionId);
}

/** Plan only (dry by definition — nothing is written). Returns the stamped plan. */
export function planOutcomeTrimForSession(idOrPrefix, opts = {}) {
  const { topics, keepLast = 1, dbPath = DB_PATH, log = () => {} } = opts;
  const db = new DatabaseSync(dbPath, { open: true, readOnly: true });
  try {
    const session = outcomeResolveSession(db, idOrPrefix);
    if (!session) return { ok: false, error: `no such session: ${idOrPrefix}` };
    if (session.refused) return { ok: false, error: `refused: ${session.refused} is a subagent/derived session` };
    const rows = outcomeReadConsoleRows(db, session.id);
    const { plan, notes } = planOutcomeTrim({ rows, topics, opts });
    if (!plan) return { ok: false, benign: true, error: notes.join("; "), notes };
    plan.session_id = session.id;
    plan.session_title = String(session.title ?? "").slice(0, 80);
    plan.plan_sha256 = planSha256(plan);
    log(`outcome plan: ${plan.counts.candidates} candidate rows (${(plan.bytes.candidates_bytes / 1048576).toFixed(2)} MiB) of ${rows.length} console rows; retained ${plan.counts.retained} (with reasons); outside scope ${plan.counts.outside_scope}`);
    return { ok: true, session, plan, notes, rows_total: rows.length };
  } finally { try { db.close(); } catch { /* closed */ } }
}

/** Apply (or re-verify) a stamped outcome plan: verified backup -> prepared ledger -> one atomic delete transaction. */
export async function applyOutcomePlan({ planFile, plan: planIn, apply = false, dbPath = DB_PATH, skillPath = null, backupDir = path.join(os.homedir(), ".zcode", "backups"), log = () => {} } = {}) {
  let plan = planIn;
  if (!plan && planFile) plan = JSON.parse(fs.readFileSync(planFile, "utf8"));
  if (!plan) return { ok: false, error: "no plan given (planFile or plan)" };
  if (planSha256(plan) !== plan.plan_sha256) return { ok: false, error: `plan hash mismatch: file says ${plan.plan_sha256}, computed ${planSha256(plan)} — the plan was edited after stamping` };
  const sessionId = plan.session_id;
  if (!sessionId) return { ok: false, error: "plan has no session_id" };

  const db = new DatabaseSync(dbPath, { open: true });
  try {
    // source-unchanged verification (parallel-modification check)
    const rowsNow = outcomeReadConsoleRows(db, sessionId);
    const src = verifyPlanSource(plan, rowsNow);
    if (!src.ok) return { ok: false, error: "source rows changed since the plan was stamped — regenerate the plan", problems: src.problems.slice(0, 10) };
    // liveness guard on apply
    const guard = outcomeLivenessGuard(db, sessionId, apply, log);
    if (guard.blocked) return { ok: false, guarded: true, benign: true, error: guard.error };

    const before = outcomeSessionStoreBytes(db, sessionId);
    // 1. verified backup
    const backupDir = path.join(os.homedir(), ".zcode", "backups");
    fs.mkdirSync(backupDir, { recursive: true });
    let backupFile = path.join(backupDir, `db-${Date.now()}-pre-outcome.sqlite`);
    for (let i = 1; fs.existsSync(backupFile); i++) backupFile = path.join(backupDir, `db-${Date.now()}-${i}-pre-outcome.sqlite`);
    db.exec(`VACUUM main INTO '${backupFile.replace(/'/g, "''")}'`);
    const backupSha = createHash("sha256").update(fs.readFileSync(backupFile)).digest("hex");
    // content verification: reopen the backup read-only and compare every affected row byte-for-byte
    const bdb = new DatabaseSync(backupFile, { open: true, readOnly: true });
    const digests = {};
    let backupRowMismatch = 0;
    const affected = [...plan.candidates.map((c) => c.part_id), ...plan.retained.map((r) => r.part_id), ...plan.outcome.anchors];
    const bCount = bdb.prepare("SELECT COUNT(*) n FROM part WHERE session_id = ?").get(sessionId).n;
    const lCount = db.prepare("SELECT COUNT(*) n FROM part WHERE session_id = ?").get(sessionId).n;
    const getB = bdb.prepare("SELECT data FROM part WHERE id = ?");
    const getL = db.prepare("SELECT data FROM part WHERE id = ?");
    for (const id of affected) {
      const bd = getB.get(id)?.data, ld = getL.get(id)?.data;
      if (bd == null || ld == null || bd !== ld) { backupRowMismatch++; continue; }
      digests[id] = createHash("sha256").update(Buffer.from(bd, "utf8")).digest("hex");
    }
    bdb.close();
    if (backupRowMismatch > 0 || bCount !== lCount)
      return { ok: false, error: `backup content verification failed (mismatched=${backupRowMismatch}, rows backup=${bCount} live=${lCount}) — nothing was written; delete the failed backup if desired: ${backupFile}` };
    // optional external skill stamp (full copy into the seal; hash recorded)
    let stamp = null;
    if (skillPath) {
      const sp = path.resolve(skillPath);
      if (!fs.existsSync(sp)) return { ok: false, error: `skill path not found: ${sp}` };
      const st = fs.statSync(sp);
      stamp = { skill_path: sp, bytes: st.size, sha256: createHash("sha256").update(fs.readFileSync(sp)).digest("hex"), mode: st.isDirectory() ? "directory-pending" : "file-copy", copied: false };
      if (st.isFile()) {
        const dest = path.join(backupDir, path.basename(backupFile, ".sqlite") + "-skill-" + path.basename(sp));
        fs.copyFileSync(sp, dest);
        stamp.copied = true; stamp.archive_copy = dest;
      } else stamp.mode = "directory-manifest-pending"; // directories: manifest walk is future work — declared, not faked
    }
    // 2. prepared ledger (written BEFORE the transaction)
    const ledgerFile = `${backupFile}.outcome-ledger.json`;
    const ledger = {
      schema: 2, kind: "outcome-trim", status: "prepared",
      run_at: new Date().toISOString(), session_id: sessionId,
      plan_sha256: plan.plan_sha256, topics: plan.topics,
      backup: { file: backupFile, sha256: backupSha, content_verified: true },
      digests, deleted_part_ids: plan.candidates.map((c) => c.part_id),
      stamp, counts: plan.counts,
    };
    fs.writeFileSync(ledgerFile, JSON.stringify(ledger, null, 1));
    log(`verified backup + prepared ledger: ${ledgerFile}`);
    // 3. dry-run exits here — the plan and its verification artifacts are the deliverable
    if (!apply) {
      return { ok: true, dry_run: true, session_id: sessionId, plan_sha256: plan.plan_sha256, ledger_file: ledgerFile, backup_file: backupFile, candidates: plan.counts.candidates, candidates_bytes: plan.bytes.candidates_bytes, retained: plan.counts.retained, notes: ["dry run: nothing deleted; apply with --apply --plan=<this plan file> --plan-hash=<plan_sha256>"] };
    }
    // 4. one atomic delete transaction
    db.exec("BEGIN IMMEDIATE");
    try {
      const del = db.prepare("DELETE FROM part WHERE id = ?");
      for (const id of ledger.deleted_part_ids) del.run(id);
      db.exec("COMMIT");
      db.exec("PRAGMA wal_checkpoint");
    } catch (e) {
      try { db.exec("ROLLBACK"); } catch { /* already gone */ }
      return { ok: false, error: `transaction rolled back, nothing changed: ${e?.message ?? e}`, ledger_file: ledgerFile };
    }
    const after = outcomeSessionStoreBytes(db, sessionId);
    // 5. finalize the ledger — failure here is NOT treated as success: the report says the DB is committed but the ledger is stale (recovery_pending)
    ledger.status = "committed"; ledger.committed_at = new Date().toISOString();
    ledger.applied = { rows_deleted: ledger.deleted_part_ids.length, bytes_removed: plan.bytes.candidates_bytes, session_part_bytes_before: before.b, session_part_bytes_after: after.b };
    let recovery_pending = false, finalize_error = null;
    try { fs.writeFileSync(ledgerFile, JSON.stringify(ledger, null, 1)); }
    catch (e) { recovery_pending = true; finalize_error = String(e?.message ?? e); }
    log(`committed: ${ledger.deleted_part_ids.length} rows deleted (${(plan.bytes.candidates_bytes / 1048576).toFixed(2)} MiB); session parts ${(before.b / 1048576).toFixed(2)}→${(after.b / 1048576).toFixed(2)} MiB`);
    return {
      ok: true, applied: true, session_id: sessionId, plan_sha256: plan.plan_sha256,
      ledger_file: ledgerFile, ledger_status: recovery_pending ? "prepared (stale)" : "committed",
      recovery_pending, finalize_error,
      applied: ledger.applied,
      restore_hint: `node bin/jevcompact.mjs outcome --restore --ledger="${ledgerFile}"${dbPath !== DB_PATH ? ` --db="${dbPath}"` : ""}`,
    };
  } finally { try { db.close(); } catch { /* closed */ } }
}

/** Record-level restore of an applied outcome plan: only the plan's own rows, conflicts listed, never a whole-DB overwrite. */
export function restoreOutcomePlan({ ledgerFile, dbPath = DB_PATH, log = () => {} } = {}) {
  if (!ledgerFile || !fs.existsSync(ledgerFile)) return { ok: false, error: `ledger not found: ${ledgerFile}` };
  const ledger = JSON.parse(fs.readFileSync(ledgerFile, "utf8"));
  if (ledger.kind !== "outcome-trim") return { ok: false, error: "not an outcome-trim ledger" };
  if (!fs.existsSync(ledger.backup.file)) return { ok: false, error: `backup file missing: ${ledger.backup.file}` };
  const backupSha = createHash("sha256").update(fs.readFileSync(ledger.backup.file)).digest("hex");
  if (backupSha !== ledger.backup.sha256) return { ok: false, error: `backup file hash mismatch (${backupSha} vs ${ledger.backup.sha256}) — refusing` };
  const db = new DatabaseSync(dbPath, { open: true });
  try {
    const bdb = new DatabaseSync(ledger.backup.file, { open: true, readOnly: true });
    const getB = bdb.prepare("SELECT id, message_id, session_id, time_created, time_updated, data, sequence FROM part WHERE id = ?");
    const getL = db.prepare("SELECT data FROM part WHERE id = ?");
    const restored = []; const conflicts = []; let bytesRestored = 0;
    db.exec("BEGIN IMMEDIATE");
    try {
      const ins = db.prepare("INSERT INTO part (id, message_id, session_id, time_created, time_updated, data, sequence) VALUES (?, ?, ?, ?, ?, ?, ?)");
      for (const id of ledger.deleted_part_ids) {
        const src = getB.get(id);
        if (!src) { conflicts.push({ part_id: id, problem: "missing_in_backup" }); continue; }
        const live = getL.get(id);
        if (live != null) {
          if (live.data === src.data) { restored.push({ part_id: id, note: "already_present_identical" }); continue; }
          conflicts.push({ part_id: id, problem: "row_exists_with_different_content", restore_skipped: true }); continue; // never overwrite silently
        }
        ins.run(src.id, src.message_id, src.session_id, src.time_created, src.time_updated, src.data, src.sequence);
        restored.push({ part_id: id }); bytesRestored += Buffer.byteLength(src.data, "utf8");
      }
      db.exec("COMMIT");
      db.exec("PRAGMA wal_checkpoint");
    } catch (e) {
      try { db.exec("ROLLBACK"); } catch { /* already gone */ }
      return { ok: false, error: `restore transaction rolled back: ${e?.message ?? e}`, conflicts };
    } finally { bdb.close(); }
    // verification: every restored row must be byte-identical to the ledger digest
    const getD = db.prepare("SELECT data FROM part WHERE id = ?");
    let verified = 0; const mismatches = [];
    for (const r of restored) {
      if (r.note) { verified++; continue; }
      const d = createHash("sha256").update(Buffer.from(getD.get(r.part_id).data, "utf8")).digest("hex");
      if (d === ledger.digests[r.part_id]) verified++; else mismatches.push(r.part_id);
    }
    log(`restore: ${restored.length - conflicts.length} rows restored (${(bytesRestored / 1048576).toFixed(2)} MiB), verified byte-identical ${verified}/${restored.length}, conflicts ${conflicts.length}`);
    return { ok: mismatches.length === 0 && conflicts.length === 0, restored: restored.length, bytes_restored: bytesRestored, verified, mismatches, conflicts, ledger_status: ledger.status };
  } finally { try { db.close(); } catch { /* closed */ } }
}

/** Finalize a stale prepared ledger after a crash between COMMIT and the ledger write: verifies the DB really matches the plan, then marks committed. */
export function finalizeOutcomeLedger({ ledgerFile, dbPath = DB_PATH, log = () => {} } = {}) {
  const ledger = JSON.parse(fs.readFileSync(ledgerFile, "utf8"));
  if (ledger.status === "committed") return { ok: true, note: "already committed" };
  const db = new DatabaseSync(dbPath, { open: true, readOnly: true });
  try {
    const getL = db.prepare("SELECT data FROM part WHERE id = ?");
    for (const id of ledger.deleted_part_ids) if (getL.get(id)) return { ok: false, error: `row ${id} still exists — DB does not match the plan; do not finalize` };
    let ok = 0;
    for (const [id, dig] of Object.entries(ledger.digests)) {
      const row = getL.get(id);
      if (!row) continue; // deleted candidate
      if (createHash("sha256").update(Buffer.from(row.data, "utf8")).digest("hex") === dig) ok++;
    }
    ledger.status = "committed"; ledger.committed_at = new Date().toISOString();
    ledger.finalized_after_recovery = true;
    fs.writeFileSync(ledgerFile, JSON.stringify(ledger, null, 1));
    log(`ledger finalized after recovery (retained-row digests re-verified: ${ok})`);
    return { ok: true, finalized: true };
  } finally { try { db.close(); } catch { /* closed */ } }
}

/* ------------------------------- CLI adapter ------------------------------- */
const IS_MAIN = process.argv[1] ? path.basename(process.argv[1]) === "zcode-jve.mjs" : false;
if (IS_MAIN) {
  const argv = process.argv.slice(2);
  const target = argv.find((a) => !a.startsWith("--"));
  const opt = (name, def) => {
    const prefix = `--${name}=`;
    const hit = argv.find((a) => a.startsWith(prefix));
    return hit === undefined ? def : hit.slice(prefix.length);
  };
  if (!target) { console.error("usage: node zcode-jve.mjs <session-id|prefix|live> [--apply] [--keep=6] [--threshold=0.6] [--truncate-head=300] [--min-reduction=0.05] [--max-state-tokens=25000] [--max-request-tokens=30000] [--goal=...] [--no-policy] [--dedup] [--trim-carriers] [--bookkeeping] [--force]"); process.exit(2); }
  compactZcodeSession(target, {
    apply: argv.includes("--apply"),
    force: argv.includes("--force"),
    dedup: argv.includes("--dedup"),
    trimCarriers: argv.includes("--trim-carriers"),
    bookkeeping: argv.includes("--bookkeeping"),
    minReduction: Number(opt("min-reduction", 0.05)),
    keep: Number(opt("keep", 6)),
    threshold: Number(opt("threshold", 0.6)),
    policy: !argv.includes("--no-policy"),
    truncateHead: Number(opt("truncate-head", 300)),
    maxStateTokens: Number(opt("max-state-tokens", 25000)),
    maxRequestTokens: Number(opt("max-request-tokens", 30000)),
    ...(opt("goal") ? { goal: opt("goal") } : {}),
    log: (m) => console.log(m),
  }).then((r) => {
    const p = r.plan;
    if (p) {
      console.log(`plan: messages ${p.messagesBefore} -> ${p.messagesAfter} | chars ${p.charsBefore} -> ${p.charsAfter} | reduction ${(p.reduction * 100).toFixed(1)}%${p.policyPins ? " | policy " + JSON.stringify(p.policyPins) : " | policy OFF"}`);
      console.log(`decisions: calls ${p.calls} -> kept ${p.kept}, drop_call ${p.callsDropped}, drop_result ${p.resultsDropped}, pinned ${p.pinned} | requests ${p.requests} (state ${p.stateTokens} tok, stage ${p.stateStage})`);
      console.log(`SQL plan: DELETE ${r.sql.deletes} part row(s); UPDATE ${r.sql.updates} part row(s); non-tool parts touched: ${r.sql.nonToolPartsTouched}`);
    }
    if (!r.ok) {
      if (r.benign) { console.log(`SKIP (benign): ${r.error}`); return; } // nothing was changed, nothing broke
      console.error(`FAILED: ${r.error}`); process.exitCode = 5;
    }
  }).catch((e) => {
    // anything escaping the compaction (network down, a single message too large for every
    // possible request) is reported, not crashed — the session stays untouched either way
    console.error(`FAILED: ${String(e?.stack ?? e).split("\n").slice(0, 4).join(" | ").slice(0, 600)}`);
    process.exitCode = 6;
  });
}

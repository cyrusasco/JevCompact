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
    const backupDir = path.join(os.homedir(), ".zcode", "backups");
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

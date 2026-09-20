#!/usr/bin/env node
/**
 * jve — compact a ZCode session IN PLACE over its persisted history, zero LLM in the loop.
 *
 *   CLI:  node jve.mjs <session-id|prefix|live> [--apply] [options]
 *   API:  import { compactZcodeSession } from "./jve.mjs"
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
 *     still open in the UI). force:true skips both guards (not recommended).
 *   - apply:true takes an online backup first via db.backup() into
 *     ~/.zcode/backups/db-<timestamp>-pre-jve.sqlite.
 *   - All writes run in one BEGIN IMMEDIATE transaction; on any error, ROLLBACK.
 *   - Exit strategy (CLI): main() returns the code, the process ends naturally
 *     — no db.close()/process.exit dance that once caused a libuv assertion.
 *
 * Options (CLI; same keys in the API opts object)
 *   --keep=<n>            newest messages pinned            (default 6)
 *   --threshold=<0..1>    keep probability cutoff           (default 0.5)
 *   --truncate-head=<n>   chars kept when truncating output (default 300)
 *   --goal=<text>         what the session was about (helps Jev)
 *   --force               skip the liveness guards (not recommended)
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";
import { compactMessages, reductionRatio } from "./dist/index.js";
import { mineSets, applyPolicy } from "./policy.mjs";
import { resolveApiKey } from "./mcp-server.mjs";

const DB_PATH = path.join(os.homedir(), ".zcode", "cli", "db", "db.sqlite");

export async function compactZcodeSession(idOrPrefix, opts = {}) {
  const { apply = false, keep = 6, threshold = 0.6, truncateHead = 300, policy = true, goal, force = false, log = () => {} } = opts;
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
      return { ok: false, guarded: true, session, error: `refusing to write: running turns=${runningTurns}, rollout last touched ${rolloutAgeSec}s ago — close the session tab in the ZCode UI first, then try again` };
    }

    // 3. load the persisted history --------------------------------------------------
    const messageRows = db.prepare("SELECT id, data FROM message WHERE session_id = ? ORDER BY time_created, rowid").all(session.id);
    const partRowsOf = db.prepare("SELECT id, data FROM part WHERE message_id = ? ORDER BY (sequence IS NULL), sequence, rowid");
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
          const out = st.output ?? st.error ?? (st.status === "error" ? "error" : "");
          msg.toolResults.push({ tool_use_id: callId, text: typeof out === "string" ? out : JSON.stringify(out), ...(st.status === "error" ? { isError: true } : {}) });
        }
        // every other type — reasoning, step-start, step-finish — is left alone
      }
      msg.text = texts.filter(Boolean).join("\n");
      transcript.push(msg);
    }
    if (!transcript.length) return { ok: false, error: "session has no readable messages" };

    // 4. multimap callID -> part rows + t<n> numbering (exact library replica) ----
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
    const numbered = [];
    {
      const results = new Map();
      transcript.forEach((m, index) => { for (const r of m.toolResults ?? []) results.set(r.tool_use_id, index); }); // last wins, as in the library
      let n = 0;
      for (const m of transcript) for (const tu of m.toolUses) {
        if (!results.has(tu.tool_use_id)) continue; // unpaired call: not a candidate, no id
        numbered.push({ id: `t${++n}`, tool_use_id: tu.tool_use_id });
      }
    }
    const numberedById = new Map(numbered.map((c) => [c.id, c]));

    // 5. ask Jev — direct HTTPS, no LLM in the loop --------------------------------
    log("contacting Jev (api.typesafe.ai) …");
    const plan = await compactMessages(transcript, {
      apiKey,
      keepThreshold: Number(threshold),
      preserveRecentMessages: Number(keep),
      truncateHeadChars: Number(truncateHead),
      ...(goal ? { goal } : {}),
    });
    const s = plan.stats;
    // 5b. lossless policy pass (bench/IMPROVEMENT-PLAN.md): force-keep goal / correction-round /
    // failure-cause evidence and the last result of each distinct command line, then recompute
    // the footprint so the plan reflects what will actually be pruned once policy is applied.
    let policyPinned = null;
    if (policy) {
      policyPinned = applyPolicy(transcript, plan.decisions, mineSets(transcript)).pinned;
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
    const ratio = reductionRatio(plan);

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

    const report = {
      ok: true,
      apply,
      session,
      plan: { messagesBefore: s.messagesBefore, messagesAfter: s.messagesAfter, charsBefore: s.charsBefore, charsAfter: s.charsAfter, reduction: Number(ratio.toFixed(4)), calls: s.calls, kept: s.kept, callsDropped: s.callsDropped, resultsDropped: s.resultsDropped, pinned: s.pinned, policyPins: policyPinned, requests: s.requests, stateTokens: s.stateTokens, stateStage: s.stateStage },
      sql: { deletes: deletes.length, updates: updates.length, nonToolPartsTouched: 0 },
    };
    // decision table preview so callers (the Studio log tab) can show per-call probabilities
    report.decisions = plan.decisions.slice(0, 80).map((d) => ({ id: d.id, tool: d.tool, action: d.action, keep_call: Number(d.keepCall.toFixed(2)), keep_result: Number(d.keepResult.toFixed(2)) }));
    if (!apply) { log("DRY RUN — nothing committed. Set apply:true to write back to the SAME session."); return report; }
    if (ratio < 0.05) return { ok: false, error: "reduction below 5% — refusing to write for nothing", report };

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
      db.exec("COMMIT");
      db.exec("PRAGMA wal_checkpoint");
    } catch (e) {
      try { db.exec("ROLLBACK"); } catch { /* already gone */ }
      return { ok: false, error: `transaction rolled back, nothing changed: ${e?.message ?? e}`, report };
    }
    report.committed = { partsDeleted: deletes.length, partsTruncated: updates.length, backup: backupFile };
    log(`committed IN PLACE: ${deletes.length} part row(s) deleted, ${updates.length} truncated — session ${session.id} updated, history preserved (backup: ${backupFile}).`);
    return report;
  } finally {
    try { db.close(); } catch { /* closed */ }
  }
}

/* ------------------------------- CLI adapter ------------------------------- */
const IS_MAIN = process.argv[1] ? path.basename(process.argv[1]) === "jve.mjs" : false;
if (IS_MAIN) {
  const argv = process.argv.slice(2);
  const target = argv.find((a) => !a.startsWith("--"));
  const opt = (name, def) => {
    const prefix = `--${name}=`;
    const hit = argv.find((a) => a.startsWith(prefix));
    return hit === undefined ? def : hit.slice(prefix.length);
  };
  if (!target) { console.error("usage: node jve.mjs <session-id|prefix|live> [--apply] [--keep=6] [--threshold=0.6] [--truncate-head=300] [--goal=...] [--no-policy] [--force]"); process.exit(2); }
  compactZcodeSession(target, {
    apply: argv.includes("--apply"),
    force: argv.includes("--force"),
    keep: Number(opt("keep", 6)),
    threshold: Number(opt("threshold", 0.6)),
    policy: !argv.includes("--no-policy"),
    truncateHead: Number(opt("truncate-head", 300)),
    ...(opt("goal") ? { goal: opt("goal") } : {}),
    log: (m) => console.log(m),
  }).then((r) => {
    const p = r.plan;
    if (p) {
      console.log(`plan: messages ${p.messagesBefore} -> ${p.messagesAfter} | chars ${p.charsBefore} -> ${p.charsAfter} | reduction ${(p.reduction * 100).toFixed(1)}%${p.policyPins ? " | policy " + JSON.stringify(p.policyPins) : " | policy OFF"}`);
      console.log(`decisions: calls ${p.calls} -> kept ${p.kept}, drop_call ${p.callsDropped}, drop_result ${p.resultsDropped}, pinned ${p.pinned} | requests ${p.requests} (state ${p.stateTokens} tok, stage ${p.stateStage})`);
      console.log(`SQL plan: DELETE ${r.sql.deletes} part row(s); UPDATE ${r.sql.updates} part row(s); non-tool parts touched: ${r.sql.nonToolPartsTouched}`);
    }
    if (!r.ok) { console.error(`FAILED: ${r.error}`); process.exitCode = 5; }
  });
}

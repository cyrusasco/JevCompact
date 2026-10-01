// apply-context-slim.mjs (round-22) — executes a context-slim plan with the same safety
// machinery as every JevCompact write: content-verified backup → prepared ledger → ONE
// atomic UPDATE transaction with in-transaction digest re-verification.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { contextSlimSha, PLATFORM_NOISE_RE } from "./context-slim.mjs";
import { buildTranscript } from "./zcode-jve.mjs";
import { mineSets, applyPolicy } from "./policy.mjs";

const sha256buf = (s) => createHash("sha256").update(typeof s === "string" ? Buffer.from(s, "utf8") : Buffer.from(s)).digest("hex");

/** Read the chronological rows the planner needs (pure read). */
export function readContextSlimRows(db, sessionId) {
  const mrows = db.prepare("SELECT id, data FROM message WHERE session_id = ? ORDER BY time_created, rowid").all(sessionId);
  const prows = db.prepare("SELECT rowid, id, data FROM part WHERE message_id = ? ORDER BY (sequence IS NULL), sequence, rowid");
  const rows = [];
  mrows.forEach((m, idx) => {
    let md; try { md = JSON.parse(m.data); } catch { return; }
    for (const p of prows.all(m.id)) {
      let pd; try { pd = JSON.parse(p.data); } catch { continue; }
      const base = { part_id: p.id, message_id: m.id, msg_index: idx, role: md.role, type: pd?.type ?? "?", data: p.data, data_sha256: sha256buf(p.data) };
      if (pd?.type === "text") rows.push({ ...base, text: String(pd.text ?? "") });
      else if (pd?.type === "tool") {
        const st = pd.state ?? {};
        rows.push({ ...base, tool: String(pd.tool ?? "?"), input: JSON.stringify(st.input ?? {}), output: typeof st.output === "string" ? st.output : JSON.stringify(st.output ?? ""), display: st.metadata?.display == null ? "" : String(st.metadata.display), status: String(st.status ?? "") });
      } else rows.push(base);
    }
  });
  return rows;
}

/** Derive the policy sets the planner needs (sentence correction entities + I3 call ids +
 *  pending call ids) — local, no Jev calls. Returns { sentenceEnts:Set, i3PartIds:Set,
 *  pendingPartIds:Set }. part_id-keyed where applicable. */
export function derivePolicySets(db, sessionId) {
  const mrows = db.prepare("SELECT id, data FROM message WHERE session_id = ? ORDER BY time_created, rowid").all(sessionId);
  const prows = db.prepare("SELECT id, data FROM part WHERE message_id = ? ORDER BY (sequence IS NULL), sequence, rowid");
  const rows = readContextSlimRows(db, sessionId);
  // callID↔part_id mapping from the raw rows
  const callIdByPart = new Map();
  for (const p of rows) { if (p.type === "tool") { let pd; try { pd = JSON.parse(p.data); } catch { continue; } if (pd?.callID) callIdByPart.set(p.part_id, pd.callID); } }
  const transcript = buildTranscript(mrows, prows);
  const calls = [];
  { const res = new Set(); transcript.forEach((m) => (m.toolResults ?? []).forEach((r) => res.add(r.tool_use_id)));
    transcript.forEach((m) => (m.toolUses ?? []).forEach((tu) => { if (res.has(tu.tool_use_id)) calls.push(tu.tool_use_id); })); }
  const reasonByCall = new Map();
  try {
    const dec = calls.map((_, i) => ({ id: "t" + (i + 1), action: "drop_call", reason: "noul", keepCall: 0, keepResult: 0 }));
    applyPolicy(transcript, dec, mineSets(transcript));
    dec.forEach((d, i) => reasonByCall.set(calls[i], String(d.reason ?? "")));
  } catch { calls.forEach((c) => reasonByCall.set(c, "policy:error")); }
  const corrEnts = [...(mineSets(transcript).correctionEntities ?? [])].filter((e) => e.length > 8);
  const isSentence = (e) => /[\u4e00-\u9fff]/.test(e) || e.includes(" ");
  const sentenceEnts = new Set(corrEnts.filter(isSentence));
  const i3PartIds = new Set();
  const pendingPartIds = new Set();
  for (const [pid, cid] of callIdByPart) {
    const r = reasonByCall.get(cid) ?? "";
    if (r === "policy:pin-last-per-group") i3PartIds.add(pid);
  }
  for (const p of rows) if (p.type === "tool" && p.status && p.status !== "completed") pendingPartIds.add(p.part_id);
  return { sentenceEnts, i3PartIds, pendingPartIds };
}


export async function applyContextSlim({ plan, dbPath, backupDir = path.join(os.homedir(), ".zcode", "backups"), log = () => {} } = {}) {
  if (!plan) return { ok: false, error: "no plan" };
  if (contextSlimSha(plan) !== plan.plan_sha256) return { ok: false, error: "plan hash mismatch — regenerate" };
  const sessionId = plan.session_id;
  if (!sessionId) return { ok: false, error: "plan has no session_id" };
  const db = new DatabaseSync(dbPath, { open: true });
  try {
    const rowsNow = readContextSlimRows(db, sessionId);
    const byId = new Map(rowsNow.map((r) => [r.part_id, r]));
    // source verification
    for (const e of plan.edits) {
      const r = byId.get(e.part_id);
      if (!r) return { ok: false, error: `source row missing: ${e.part_id} — regenerate the plan` };
      if (e.old_sha && r.data_sha256 !== e.old_sha) return { ok: false, error: `source row changed: ${e.part_id} — regenerate the plan` };
    }
    // verified backup
    fs.mkdirSync(backupDir, { recursive: true });
    let backupFile = path.join(backupDir, `db-${Date.now()}-pre-slim.sqlite`);
    for (let i = 1; fs.existsSync(backupFile); i++) backupFile = path.join(backupDir, `db-${Date.now()}-${i}-pre-slim.sqlite`);
    db.exec(`VACUUM main INTO '${backupFile.replace(/'/g, "''")}'`);
    const backupSha = sha256buf(fs.readFileSync(backupFile));
    // prepare ledger (atomic write)
    const ledgerFile = `${backupFile}.slim-ledger.json`;
    const restore_rows = {};
    const getFull = db.prepare("SELECT rowid, id, message_id, session_id, time_created, time_updated, data, sequence FROM part WHERE id = ?");
    for (const e of plan.edits) if (e.action !== "keep") restore_rows[e.part_id] = getFull.get(e.part_id) ?? null;
    const ledger = {
      schema: 1, kind: "context-slim", status: "prepared",
      run_at: new Date().toISOString(), session_id: sessionId, plan_sha256: plan.plan_sha256,
      backup: { file: backupFile, sha256: backupSha, content_verified: true },
      restore_rows, counts: plan.counts, est: plan.est,
    };
    try { fs.writeFileSync(ledgerFile, JSON.stringify(ledger, null, 1)); } catch (e) { return { ok: false, error: "ledger prepare failed — nothing written: " + (e?.message ?? e) }; }
    // ONE atomic transaction: rewrites with in-transaction digest guard
    const upd = db.prepare("UPDATE part SET data = ?, time_updated = ? WHERE id = ?");
    db.exec("BEGIN IMMEDIATE");
    try {
      const now = Date.now();
      for (const e of plan.edits) {
        if (e.action === "keep") continue;
        const cur = db.prepare("SELECT data FROM part WHERE id = ?").get(e.part_id);
        if (!cur || sha256buf(cur.data) !== e.old_sha) throw new Error(`row ${e.part_id} changed inside the transaction — rollback (race guard)`);
        let pd; try { pd = JSON.parse(cur.data); } catch { continue; }
        if (e.action === "noise-note") {
          if (pd?.type === "text") pd.text = `[${e.kind} cleared — recoverable from backup]`;
          else if (pd?.type === "tool") {
            const st = pd.state ?? {};
            st.output = `[${e.kind} cleared — recoverable from backup]`;
            if (st.metadata?.display != null) st.metadata.display = `[${e.kind} cleared]`;
            pd.state = st;
          }
        } else if (e.action === "slim") {
          const st = pd.state ?? {};
          const out = typeof st.output === "string" ? st.output : JSON.stringify(st.output ?? "");
          if (out.length > e.head) st.output = out.slice(0, e.head) + `\n[… ${out.length - e.head} chars slimmed by context-slim — recoverable from backup]`;
          if (typeof st.metadata?.display === "string" && st.metadata.display.length > e.head) st.metadata.display = st.metadata.display.slice(0, e.head);
          pd.state = st;
        }
        upd.run(JSON.stringify(pd), now, e.part_id);
      }
      db.exec("COMMIT");
      db.exec("PRAGMA wal_checkpoint");
    } catch (e) {
      try { db.exec("ROLLBACK"); } catch { /* gone */ }
      return { ok: false, error: "transaction rolled back, nothing changed: " + (e?.message ?? e), ledger_file: ledgerFile };
    }
    ledger.status = "committed"; ledger.committed_at = new Date().toISOString();
    let recovery_pending = false, finalize_error = null;
    try { fs.writeFileSync(ledgerFile, JSON.stringify(ledger, null, 1)); } catch (e) { recovery_pending = true; finalize_error = String(e?.message ?? e); }
    log(`context-slim committed: ${plan.counts.noise_notes} noise notes + ${plan.counts.slim_lesson_carriers + plan.counts.slim_i3} slimmed rows; est context ${plan.est.before_tokens.toLocaleString()} → ${plan.est.after_tokens.toLocaleString()} tok (−${plan.est.reduction_pct}%)`);
    if (recovery_pending) return { ok: false, committed_in_db: true, recovery_pending: true, finalize_error, ledger_file: ledgerFile, error: "DB committed but ledger finalize failed — run outcome --finalize or restore" };
    return { ok: true, committed: true, session_id: sessionId, ledger_file: ledgerFile, est: plan.est, counts: plan.counts, restore_hint: `node bin/jevcompact.mjs outcome --restore --ledger="${ledgerFile}"` };
  } finally { try { db.close(); } catch { /* closed */ } }
}

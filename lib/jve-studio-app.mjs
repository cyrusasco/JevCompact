#!/usr/bin/env node
/**
 * Jve Studio — desktop app for ZCode/Claude/Codex/Prime session compaction (local web GUI).
 *
 *   Launch: node bin/jevcompact.mjs studio   (or npm run studio)
 *   Desktop icon: node bin/jevcompact.mjs studio install-desktop --autostart
 *   Then open (just) http://127.0.0.1:50505/ in your browser (auto-opens).
 *   Pass --no-browser (or set JVE_STUDIO_NO_BROWSER=1) to suppress the pop-up — that is
 *   the mode the logon autostart uses. A second copy probes the canonical port first and
 *   exits quietly when a live Studio already answers there, so autostart is idempotent
 *   and the server never forks twice on the same port.
 *
 * Flow: choose harness from the dropdown -> press [Sync 同步] to read the stores ->
 *   per session row: [Dry run 预览] [Compact 压缩] [Restore 还原] ->
 *   click the Size cell to show the context-window breakdown (like ZCode's own panel) ->
 *   every action is recorded centrally in the Log tab (server-side ring, survives refresh).
 *
 * Built with: Node only (http, sqlite). No frameworks, no CDNs. Binds to 127.0.0.1 only.
 * Safety: compaction defaults to DRY RUN; real writes are guarded (running turns / fresh
 * rollout) and preceded by an online backup; Restore replays the newest recorded backup.
 */
import http from "node:http";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { compactZcodeSession } from "./zcode-jve.mjs";
import { studioCodecs } from "./jve-studio.mjs";

const HOME = os.homedir();
const DB_PATH = path.join(HOME, ".zcode", "cli", "db", "db.sqlite");
const BACKUP_DIR = path.join(HOME, ".zcode", "backups");
const INDEX_FILE = path.join(BACKUP_DIR, "jve-index.json");
const ROLLOUT_DIR = path.join(HOME, ".zcode", "cli", "rollout");
const HOST = "127.0.0.1";
const BASE_PORT = 50505;
const DEFAULT_LIMIT = 500000; // tokens; override per session with ?limit=

/* ------------------------------------------------------------- central log */
const LOG_RING = [];
const LOG_CAP = 600;
function slog(level, msg) {
  LOG_RING.push({ t: Date.now(), level, msg: String(msg) });
  if (LOG_RING.length > LOG_CAP) LOG_RING.shift();
}
const readIndex = () => { try { return JSON.parse(fs.readFileSync(INDEX_FILE, "utf8")); } catch { return { version: 1, entries: [] }; } };
const writeIndex = (ix) => { fs.mkdirSync(BACKUP_DIR, { recursive: true }); fs.writeFileSync(INDEX_FILE, JSON.stringify(ix, null, 1), "utf8"); };

/* ------------------------------------------------------------- scanning */
function scanZcode() {
  const db = new DatabaseSync(DB_PATH, { open: true, readOnly: true });
  try {
    const rows = db.prepare(`SELECT s.id, s.title, s.time_created,
        (SELECT COUNT(*) FROM part p WHERE p.session_id = s.id) AS parts,
        (SELECT COALESCE(SUM(LENGTH(p.data)), 0) FROM part p WHERE p.session_id = s.id) AS bytes,
        (SELECT COUNT(*) FROM turn_usage tu WHERE tu.session_id = s.id AND tu.status = 'running') AS running
      FROM session s
      WHERE instr(s.id, 'sess_subagent') = 0 AND (s.parent_id IS NULL OR s.parent_id = '')
      ORDER BY s.time_created DESC LIMIT 200`)
      .all()
      .map((r) => ({
        harness: "zcode", id: r.id,
        title: String(r.title ?? "").replace(/\s+/g, " ").trim() || "(untitled)",
        bytes: r.bytes, parts: r.parts, updated: r.time_created, running: r.running > 0,
      }));
    const hidden = db.prepare(`SELECT
        SUM(CASE WHEN instr(s.id, 'sess_subagent') > 0 THEN 1 ELSE 0 END) AS sub,
        SUM(CASE WHEN instr(s.id, 'sess_subagent') = 0 AND s.parent_id IS NOT NULL AND s.parent_id <> '' THEN 1 ELSE 0 END) AS derived
      FROM session s`).get() ?? {};
    return { rows, hidden: { sub: hidden.sub ?? 0, derived: hidden.derived ?? 0 } };
  } finally { try { db.close(); } catch { /* closed */ } }
}

const SCAN_CACHE = new Map();
const CACHE_TTL = 60000;
function cached(key, fn) {
  const hit = SCAN_CACHE.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL) { slog("info", `sync ${key}: cache hit (${Math.round((Date.now() - hit.at) / 1000)}s ago)`); return hit.val; }
  const val = fn();
  SCAN_CACHE.set(key, { at: Date.now(), val });
  slog("info", `sync ${key}: ${val.rows.length} sessions read, ${val.hidden.sub + val.hidden.derived} hidden (subagent/derived, not listed, not compactable)`);
  return val;
}
function scanHarness(h) {
  if (h === "zcode") return cached(h, scanZcode);
  const codec = studioCodecs.find((c) => c.tag === h);
  if (!codec) return { rows: [], hidden: { sub: 0, derived: 0 } };
  return cached(h, () => ({ rows: codec.scan().map((e) => ({ harness: h, id: e.id, title: e.title, bytes: e.size ?? 0, parts: 0, updated: e.when ?? 0, running: false, file: e.file })), hidden: { sub: 0, derived: 0 } }));
}

/* --------------------------------------------------- context window stats */
const byteLen = (x) => Buffer.byteLength(typeof x === "string" ? x : JSON.stringify(x ?? ""), "utf8");
const CATS = ["Messages", "MCP tools", "System tools", "Skills", "System prompt", "Meta context"];

function classifyToolName(name) {
  const n = String(name ?? "");
  if (/^mcp[_.-]/i.test(n) || /^mcp__/i.test(n)) return "MCP tools";
  if (/skill/i.test(n)) return "Skills";
  return "System tools";
}

function zcodeContext(id, limit) {
  // 1. prefer the session's own rollout (model-io) log: the largest request record
  const rollout = path.join(ROLLOUT_DIR, `model-io-${id}.jsonl`);
  const cats = Object.fromEntries(CATS.map((c) => [c, 0]));
  let source = "db-only";
  if (fs.existsSync(rollout)) {
    const raw = fs.readFileSync(rollout, "utf8").split(String.fromCharCode(10));
    let best = null;
    for (let i = raw.length - 1; i >= 0 && !best; i--) {
      if (!raw[i].trim()) continue;
      try { const j = JSON.parse(raw[i]); if (j?.request?.messages?.length || j?.request?.body?.messages?.length) { best = j; break; } } catch { /* skip malformed */ }
    }
    // take the LAST (most complete) request record; fall back to largest when scanning all
    if (best) {
      source = "rollout";
      // the wire payload lives under request.body (system, tools); request.messages
      // is a convenience copy of body.messages — read both paths, prefer the body
      const req = best.request ?? {};
      const body = req.body ?? {};
      cats["System prompt"] = byteLen(body.system ?? req.system ?? "");
      cats["Messages"] = byteLen(req.messages?.length ? req.messages : (body.messages ?? []));
      for (const t of body.tools ?? req.tools ?? []) {
        const b = byteLen(t);
        cats[classifyToolName(t.name ?? t.function?.name)] += b;
      }
      const counted = CATS.reduce((s, c) => s + cats[c], 0);
      cats["Meta context"] = Math.max(0, byteLen(best) - counted);
    }
  }
  // 2. fallback: compute from DB parts (single SQL, with CASE, JSON1)
  if (source === "db-only") {
    const db = new DatabaseSync(DB_PATH, { open: true, readOnly: true });
    try {
      const r = db.prepare(`SELECT
          SUM(CASE WHEN json_extract(p.data,'$.type') IN ('text','reasoning') THEN LENGTH(p.data) ELSE 0 END) AS msgs,
          SUM(CASE WHEN json_extract(p.data,'$.type')='tool' AND json_extract(p.data,'$.tool') LIKE 'mcp%'  THEN LENGTH(p.data) ELSE 0 END) AS mcp,
          SUM(CASE WHEN json_extract(p.data,'$.type')='tool' AND json_extract(p.data,'$.tool') LIKE '%skill%' THEN LENGTH(p.data) ELSE 0 END) AS skills,
          SUM(CASE WHEN json_extract(p.data,'$.type')='tool' AND json_extract(p.data,'$.tool') NOT LIKE 'mcp%' AND json_extract(p.data,'$.tool') NOT LIKE '%skill%' THEN LENGTH(p.data) ELSE 0 END) AS systools
        FROM part p WHERE p.session_id = ?`).get(id);
      cats["Messages"] = r?.msgs ?? 0; cats["MCP tools"] = r?.mcp ?? 0; cats["Skills"] = r?.skills ?? 0; cats["System tools"] = r?.systools ?? 0;
    } finally { try { db.close(); } catch { /* closed */ } }
  }
  // used tokens and a sane display denominator, measured from the model_usage ledger when present
  const TOKEN_COLS = ["context_tokens", "total_tokens", "input_tokens", "prompt_tokens", "used_tokens"]; // fixed whitelist — safe to interpolate into MAX()
  let used = 0, measured = false, maxObserved = 0, modelId = "";
  {
    const db = new DatabaseSync(DB_PATH, { open: true, readOnly: true });
    try {
      const row = db.prepare("SELECT * FROM model_usage WHERE session_id = ? ORDER BY rowid DESC LIMIT 1").get(id) ?? {};
      modelId = String(row.model_id ?? row.provider_id ?? "");
      const col = TOKEN_COLS.find((k) => typeof row[k] === "number" && row[k] > 0);
      if (col) { used = row[col]; measured = true; maxObserved = db.prepare(`SELECT MAX(${col}) AS m FROM model_usage WHERE session_id = ?`).get(id)?.m ?? 0; }
    } catch { /* table layout may vary across versions */ } finally { try { db.close(); } catch { /* closed */ } }
  }
  const totalBytes = CATS.reduce((s, c) => s + cats[c], 0);
  if (!measured) used = Math.round(totalBytes / 4);
  // auto-detect the denominator when the caller gave none: model hint first, then observed max with headroom
  let limit_source = "user";
  if (!(limit > 0)) {
    if (/(?:^|[^0-9a-z])1\s*m(?![0-9a-z])|\[1m\]/i.test(modelId)) { limit = 1000000; limit_source = "model-id"; }
    else if (maxObserved > 0) { limit = Math.ceil((maxObserved * 1.5) / 100000) * 100000; limit_source = "observed"; }
    else { limit = DEFAULT_LIMIT; limit_source = "default"; }
  }
  const total = Math.max(totalBytes, 1);
  return {
    id, source, measured,
    total_bytes: totalBytes,
    used, limit, limit_source, pct: Math.min(1, used / limit),
    categories: CATS.map((c) => ({ name: c, bytes: cats[c], pct: cats[c] / total })),
  };
}

function fileContext(entry, limit) {
  if (!(limit > 0)) limit = DEFAULT_LIMIT; // file stores carry no model hint — fall back to the documented default
  // generic classifier for file-based stores (claude / codex / prime)
  const cats = Object.fromEntries(CATS.map((c) => [c, 0]));
  let total = 0;
  let lines = [];
  try { lines = fs.readFileSync(entry.file, "utf8").split(String.fromCharCode(10)).filter((l) => l.trim()); } catch { /* empty */ }
  for (const l of lines) {
    let j; try { j = JSON.parse(l); } catch { cats["Meta context"] += l.length; continue; }
    const b = l.length;
    total += b;
    const t = String(j.type ?? "");
    if (t === "session_meta" || t === "session" || t === "turn_context" || t === "world_state" || t === "event_msg" || t === "inter_agent_communication_metadata" || /^queue-/.test(t) || t === "attachment") { cats["Meta context"] += b; continue; }
    if (t === "system") { cats["System prompt"] += b; continue; }
    // walk blocks: content blocks / payload items
    const blocks = Array.isArray(j?.message?.content) ? j.message.content : Array.isArray(j?.payload?.content) ? j.payload.content : [];
    const ptype = String(j?.payload?.type ?? "");
    const isTool = /^(tool_use|tool_result|custom_tool_call|custom_tool_call_output|function_call|function_call_output)$/.test(ptype) || blocks.some((c) => c && /^(tool_use|tool_result)$/.test(String(c.type ?? "")));
    if (/^(thinking|reasoning)$/.test(ptype) || t === "assistant" || t === "user") { cats.Messages += b - (isTool ? Math.round(b / 3) : 0); if (isTool) cats[classifyToolName(j?.payload?.name ?? j?.payload?.tool ?? blocks.find((c) => c?.type === "tool_use")?.name)] += Math.round(b / 3) * 2; continue; }
    if (isTool) { cats[classifyToolName(j?.payload?.name ?? blocks.find((c) => c?.type === "tool_use")?.name)] += b; continue; }
    cats.Messages += b;
  }
  const tot = Math.max(CATS.reduce((s, c) => s + cats[c], 0), 1);
  const used = Math.round(total / 4);
  return { id: entry.id, source: "file-approx", measured: false, total_bytes: total, used, limit, pct: Math.min(1, used / limit), categories: CATS.map((c) => ({ name: c, bytes: cats[c], pct: cats[c] / tot })) };
}

/* ------------------------------------------------------------- actions */
async function compactAction({ harness, id, dryRun, keep, threshold, truncateHead, goal, minReduction, maxStateTokens, maxRequestTokens }) {
  const logRing = [];
  if (harness === "zcode" || (harness === undefined && dbHasSession(id))) {
      const report = await compactZcodeSession(id, { apply: !dryRun, keep: Number(keep ?? 6), threshold: Number(threshold ?? 0.6), truncateHead: Number(truncateHead ?? 300), ...(minReduction ? { minReduction: Number(minReduction) } : {}), ...(maxStateTokens ? { maxStateTokens: Number(maxStateTokens) } : {}), ...(maxRequestTokens ? { maxRequestTokens: Number(maxRequestTokens) } : {}), ...(goal ? { goal } : {}), log: (m) => logRing.push(m) });
      if (report.ok && report.committed) {
        SCAN_CACHE.delete("zcode"); // a committed write invalidates the scan cache (avoid serving stale rows)
      const ix = readIndex();
      ix.entries.push({ harness: "zcode", sessionId: report.session.id, backup: report.committed.backup, at: Date.now(), summary: report.plan });
      ix.entries = ix.entries.slice(-200);
      writeIndex(ix);
      logRing.push(`restore index updated (${INDEX_FILE})`);
    }
    report.log = logRing;
    return report;
  }
  const codec = studioCodecs.find((c) => c.tag === harness);
  if (!codec) return { ok: false, error: `unsupported harness: ${harness}` };
  // read the store FRESH: a cached scan row carries an out-of-date mtime, which
  // would make the freshness guard below misjudge (reject) legitimate writes
  let entry = null;
  try { entry = codec.scan().find((e) => e.id === id || e.file === id); } catch { /* scan failure */ }
  if (!entry) return { ok: false, error: `${harness}: no such session: ${id}` };
  try {
    const r = await codec.compact(entry);
    if (r.refused) return { ok: false, error: r.refused };
    SCAN_CACHE.delete(harness); // committed write — drop the cached listing for this store
    const ix = readIndex();
    ix.entries.push({ harness, sessionId: id, backup: entry.file + ".pre-jve.bak", at: Date.now(), summary: r });
    ix.entries = ix.entries.slice(-200);
    writeIndex(ix);
    logRing.push(`backup: ${entry.file}.pre-jve.bak`);
    return { ok: true, harness, id, plan: { messagesBefore: r.before, messagesAfter: r.after, reduction: r.ratio, calls: r.calls }, committed: dryRun ? undefined : { backup: entry.file + ".pre-jve.bak" }, log: logRing };
  } catch (e) { return { ok: false, error: String(e?.message ?? e) }; }
}

function dbHasSession(id) {
  const db = new DatabaseSync(DB_PATH, { open: true, readOnly: true });
  try { return !!db.prepare("SELECT id FROM session WHERE id = ? OR id LIKE ? LIMIT 1").get(id, id + "%"); } catch { return false; } finally { try { db.close(); } catch { /* closed */ } }
}

function restoreAction({ harness, id }) {
  const ix = readIndex();
  const entries = ix.entries.filter((e) => (e.harness === harness || harness === "zcode" && e.harness === "zcode") && (e.sessionId === id || String(e.sessionId).startsWith(id)));
  const last = entries[entries.length - 1];
  if (!last) return { ok: false, error: `尚無壓縮記錄，無須還原：${id}（index 內無此 session 的備份）` };
  if (harness === "zcode") {
    if (!last.backup || !last.backup.startsWith(BACKUP_DIR) || /['"]/.test(last.backup)) return { ok: false, error: "備份路徑無效，拒絕還原（安全檢查）" };
    if (!fs.existsSync(last.backup)) return { ok: false, error: `備份文件不存在：${last.backup}` };
    const db = new DatabaseSync(DB_PATH, { open: true });
    try {
      const sid = last.sessionId;
      const before = db.prepare("SELECT COUNT(*) n FROM part WHERE session_id = ?").get(sid).n;
      db.exec(`ATTACH DATABASE '${last.backup.replace(/'/g, "''")}' AS bak`);
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare("DELETE FROM part WHERE session_id = ?").run(sid);
        const ins = db.prepare("INSERT OR REPLACE INTO main.part SELECT * FROM bak.part WHERE session_id = ?");
        ins.run(sid);
        db.exec("COMMIT");
      } catch (e) { try { db.exec("ROLLBACK"); } catch { /* */ } throw e; }
      db.exec("DETACH DATABASE bak");
      const after = db.prepare("SELECT COUNT(*) n FROM part WHERE session_id = ?").get(sid).n;
      SCAN_CACHE.delete("zcode"); // restored rows are new — refresh the cached listing
      slog("ok", `restore zcode ${sid} from ${path.basename(last.backup)}: parts ${before} -> ${after}`);
      return { ok: true, harness, id, partsBefore: before, partsAfter: after, backup: last.backup, at: last.at };
    } catch (e) { return { ok: false, error: `還原失敗（已復，詳情請看少）：${e?.message ?? e}` }; } finally { try { db.close(); } catch { /* closed */ } }
  }
  const codec = studioCodecs.find((c) => c.tag === harness);
  if (!codec) return { ok: false, error: `unsupported harness: ${harness}` };
  let entry = null;
  try { entry = codec.scan().find((e) => e.id === id || e.file === id); } catch { /* scan failure */ }
  if (!entry) return { ok: false, error: `${harness}: no such session: ${id}` };
  const bak = entry.file + ".pre-jve.bak";
  if (!fs.existsSync(bak)) return { ok: false, error: `無備份可還原：${bak}` };
  fs.copyFileSync(bak, entry.file);
  slog("ok", `restore ${harness} ${id} from ${path.basename(bak)}`);
  return { ok: true, harness, id, backup: bak, at: last.at };
}

/* ------------------------------------------------------------- HTTP plumbing */
const send = (res, code, obj) => { res.writeHead(code, { "content-type": "application/json; charset=utf-8" }); res.end(JSON.stringify(obj)); };

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch { return {}; }
}

async function handle(req, res) {
  const u = new URL(req.url, `http://${HOST}`);
  const start = Date.now();
  try {
    if (req.method === "GET" && (u.pathname === "/" || u.pathname === "/index.html")) {
      slog("info", "GET / — app served");
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      return res.end(HTML);
    }
    if (req.method === "GET" && u.pathname === "/api/sync") {
      const h = u.searchParams.get("harness") ?? "zcode";
      const pack = h === "all"
        ? (() => { const parts = ["zcode", "claude", "codex", "prime"].map(scanHarness); return { rows: parts.flatMap((p) => p.rows).sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0)).slice(0, 200), hidden: { sub: parts.reduce((s, p) => s + p.hidden.sub, 0), derived: parts.reduce((s, p) => s + p.hidden.derived, 0) } }; })()
        : scanHarness(h);
      slog("info", `sync harness=${h} rows=${pack.rows.length} hidden=${pack.hidden.sub + pack.hidden.derived} (${Date.now() - start}ms)`);
      return send(res, 200, pack);
    }
    if (req.method === "POST" && u.pathname === "/api/compact") {
      const b = await readBody(req);
      if (!b.id) return send(res, 400, { ok: false, error: "missing id" });
      slog("info", `compact request harness=${b.harness ?? "zcode"} id=${b.id} dryRun=${!!b.dryRun}`);
      const r = await compactAction(b);
      for (const line of r.log ?? []) slog(r.ok || r.benign ? "ok" : "err", `[${b.harness ?? "zcode"}] ${line}`);
      return send(res, r.ok || r.benign ? 200 : 422, r); // benign refusals are not network errors
    }
    if (req.method === "POST" && u.pathname === "/api/restore") {
      const b = await readBody(req);
      if (!b.id) return send(res, 400, { ok: false, error: "missing id" });
      slog("info", `restore request harness=${b.harness ?? "zcode"} id=${b.id}`);
      const r = restoreAction(b);
      return send(res, r.ok ? 200 : 422, r);
    }
    if (req.method === "GET" && u.pathname === "/api/context") {
      const h = u.searchParams.get("harness") ?? "zcode";
      const id = u.searchParams.get("id") ?? "";
      const rawLimit = Number(u.searchParams.get("limit"));
      const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : 0; // 0 => auto-detect the display denominator
      if (!id) return send(res, 400, { ok: false, error: "missing id" });
      if (h === "zcode") return send(res, 200, { ok: true, ...zcodeContext(id, limit) });
      const codec = studioCodecs.find((c) => c.tag === h);
      const entry = codec?.scan?.().find((e) => e.id === id || e.file === id);
      if (!entry) return send(res, 404, { ok: false, error: `no such session: ${id}` });
      return send(res, 200, { ok: true, ...fileContext(entry, limit) });
    }
    if (req.method === "GET" && u.pathname === "/api/log") return send(res, 200, { lines: LOG_RING });
    if (req.method === "POST" && u.pathname === "/api/log") {
      const b = await readBody(req);
      slog(String(b.level ?? "info"), `client: ${String(b.msg ?? "")}`);
      return send(res, 200, { ok: true });
    }
    return send(res, 404, { ok: false, error: "not found" });
  } catch (e) {
    slog("err", `${req.method} ${u.pathname} -> ${e?.message ?? e}`);
    return send(res, 500, { ok: false, error: String(e?.message ?? e) });
  }
}

/* ------------------------------------------------------------- the page */
const HTML = String.raw`<!doctype html>
<html lang="zh-HK">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Jve Studio — 會話壓縮器</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { font-family: "Segoe UI", system-ui, sans-serif; background:#12141a; color:#e6e9f0; margin:0; padding:0; }
  header { padding:16px 22px 0; }
  h1 { font-size:19px; margin:0 0 2px; }
  .sub { color:#8b93a5; font-size:12px; line-height:1.6; }
  .tabs { display:flex; gap:4px; padding:12px 22px 0; border-bottom:1px solid #232833; }
  .tabs button { background:transparent; color:#9aa3b5; border:0; border-bottom:2px solid transparent; padding:8px 14px; font-size:13px; cursor:pointer; border-radius:6px 6px 0 0; }
  .tabs button.on { color:#fff; border-bottom-color:#2668d0; background:#181c26; }
  main { padding:14px 22px 26px; }
  .bar { display:flex; gap:10px; align-items:center; margin-bottom:12px; flex-wrap:wrap; }
  select, input[type=number] { background:#1b1f28; color:#e6e9f0; border:1px solid #2c3342; border-radius:6px; padding:6px 8px; font-size:13px; }
  button.act { background:#2668d0; color:#fff; border:0; border-radius:6px; padding:7px 14px; font-size:13px; cursor:pointer; }
  button.act:hover { background:#3a7be0; }
  button.row { padding:4px 10px; font-size:12px; margin-right:6px; border:0; border-radius:5px; cursor:pointer; color:#fff; background:#232833; }
  button.row:hover { background:#2c3342; }
  button.row.go { background:#1f6b3a; } button.row.go:hover { background:#28844a; }
  button.row.warn { background:#b7791f; } button.row.warn:hover { background:#d18c26; }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  th, td { padding:7px 9px; border-bottom:1px solid #232833; text-align:left; white-space:nowrap; }
  td.name { white-space:normal; max-width:44vw; overflow:hidden; text-overflow:ellipsis; }
  td.id { font-family:Consolas, monospace; font-size:11.5px; color:#9aa3b5; }
  td.size { cursor:pointer; color:#7fb4ff; text-decoration:underline dotted; text-underline-offset:3px; }
  td.size:hover { color:#a9cdff; }
  tr:hover { background:#181c26; }
  .badge { font-size:10.5px; padding:1px 7px; border-radius:8px; margin-left:6px; }
  .b-zcode { background:#1c3a5e; color:#9ecbff; } .b-claude { background:#41352a; color:#e8c39a; }
  .b-codex { background:#22402e; color:#9fe0b4; } .b-prime { background:#3d2a4d; color:#d7b0ef; }
  .running { background:#5b2330; color:#ff9a9a; }
  .muted { color:#8b93a5; }
  #stat { font-size:12px; color:#8b93a5; }
  #log { background:#0c0e13; border:1px solid #232833; border-radius:8px; padding:10px 12px; height:calc(100vh - 220px); overflow:auto; font-family:Consolas, monospace; font-size:12px; line-height:1.55; }
  #log .ok { color:#7bd88b; } #log .err { color:#ff7b7b; } #log .info { color:#9fb4d8; } #log .warn { color:#f6c37c; }
  /* modal: context windows */
  .overlay { position:fixed; inset:0; background:rgba(0,0,0,.55); display:none; text-align:center; z-index:50; }
  .overlay.show { display:block; }
  .panel { display:inline-block; text-align:left; width:min(520px, 92vw); margin:8vh auto 0; background:#1b1f28; border:1px solid #2c3342; border-radius:12px; padding:18px 20px; box-shadow:0 12px 40px rgba(0,0,0,.5); }
  .panel .head { display:block; font-size:17px; font-weight:600; }
  .panel .head .nums { float:right; font-size:13px; color:#cfd6e4; font-family:Consolas, monospace; }
  .bar-track { height:8px; background:#2a2f3a; border-radius:4px; margin:12px 0 14px; overflow:hidden; }
  .bar-fill { height:100%; background:linear-gradient(90deg, #2f8ef0, #6cc1ff); width:0; transition:width .4s; }
  .rows .r { display:block; padding:7px 2px; border-bottom:1px solid #232833; font-size:13.5px; }
  .rows .r:last-child { border-bottom:0; }
  .dot { display:inline-block; width:9px; height:9px; border-radius:50%; background:#4a9fe8; vertical-align:middle; margin-right:10px; }
  .dot.off { background:#3a4150; }
  .r .nm { display:inline-block; width:78%; } .r .pc { float:right; font-family:Consolas, monospace; color:#e6e9f0; }
  .panel .foot { display:block; margin-top:14px; }
  #ctxClose { float:right; }
  .panel .src { font-size:11px; color:#8b93a5; }
  footer { margin-top:16px; font-size:11px; color:#6c7383; }
</style>
</head>
<body>
<header>
  <h1>Jve Studio <span class="muted">· 會話壓縮器（Jev verbatim compaction）</span></h1>
  <div class="sub">揀 harness → 【Sync 同步】讀取門 → 行內操作：預覽 / 壓縮 / 還原；撳大小欄睇 context 統計。所有操作記錄喺 【日誌 Log】分頁。</div>
</header>
<nav class="tabs">
  <button id="tabSessions" class="on">會話 Sessions</button>
  <button id="tabLog">日誌 Log</button>
</nav>
<main>
  <div id="paneSessions">
    <div class="bar">
      <label class="muted" for="harnessSel">Harness</label>
      <select id="harnessSel">
        <option value="all">全部（合併顯示）</option>
        <option value="zcode" selected>ZCode</option>
        <option value="claude">Claude Code</option>
        <option value="codex">Codex</option>
        <option value="prime">Prime Agent</option>
      </select>
      <label class="muted" for="limitIn">Context 上限（僅供顯示比率，唔影響壓縮）</label>
      <label class="muted" style="font-size:12px"><input type="checkbox" id="autoLimit" checked> 自動</label>
      <input id="limitIn" type="number" value="500000" style="width:90px" disabled>
      <button class="act" id="syncBtn">🔄 Sync 同步</button>
      <span id="stat">尚未同步 — 撳 【Sync 同步】</span>
    </div>
    <table>
      <thead><tr><th>Harness</th><th>Session ID</th><th>名稱 Name</th><th>大小 Size（撳開睇統計）</th><th>最後更新 Updated</th><th>操作 Actions</th></tr></thead>
      <tbody id="rows"><tr><td colspan="6" class="muted">— 無數據：請先 【Sync 同步】 —</td></tr></tbody>
    </table>
  </div>
  <div id="paneLog" style="display:none"><div id="log"></div></div>
  <footer>本地環境 · 只綁定 127.0.0.1 · 壓縮前自動備份喺 ~/.zcode/backups/ · 還原按記錄、還原按 distribuitions（讀 index 檔）</footer>
</main>

<div class="overlay" id="ctxOverlay">
  <div class="panel">
    <div class="head"><span id="ctxTitle">Context windows</span><span class="nums" id="ctxNums"></span></div>
    <div class="bar-track"><div class="bar-fill" id="ctxFill"></div></div>
    <div class="rows" id="ctxRows"></div>
    <div class="foot"><span class="src" id="ctxSrc"></span><button class="row" id="ctxClose">關閉 ✕</button></div>
  </div>
</div>

<script>
"use strict";
var $ = function (s) { return document.querySelector(s); };
function esc(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
function fmtSize(b) { if (b > 1048576) { return (b / 1048576).toFixed(1) + " MB"; } if (b > 1024) { return (b / 1024).toFixed(1) + " KB"; } return b + " B"; }
function fmtK(n) { if (n >= 1000000) { return (n / 1000000).toFixed(1) + "M"; } if (n >= 1000) { return (n / 1000).toFixed(1) + "K"; } return String(n); }
function fmtPct(x) { return (x * 100).toFixed(1) + "%"; }
function fmtWhen(ms) { if (!ms) { return "—"; } var d = new Date(ms); var p = function (n) { return String(n).padStart(2, "0"); }; return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes()); }
function postLog(level, msg) {
  try { fetch("/api/log", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ level: level, msg: msg }) }); } catch (e) { /* offline */ }
  appendLocal(level, msg, true);
}
function appendLocal(level, msg, now) {
  var box = $("#log");
  var d = document.createElement("div");
  d.className = level;
  d.textContent = new Date(now ? Date.now() : Date.now()).toLocaleTimeString() + "  " + msg;
  box.appendChild(d);
  box.scrollTop = 1e9;
}
function renderLog(lines) {
  var box = $("#log");
  box.textContent = "";
  lines.forEach(function (l) { appendLocal(l.level || "info", l.msg, l.t); });
}
var current = [];
function doSync(silent) {
  var h = $("#harnessSel").value;
  $("#stat").textContent = "同步中 " + h + " …";
  fetch("/api/sync?harness=" + encodeURIComponent(h)).then(function (r) { return r.json(); }).then(function (payload) {
    var rows = payload.rows || payload;
    var hidden = payload.hidden || { sub: 0, derived: 0 };
    current = rows;
    var tb = $("#rows");
    tb.textContent = "";
    if (!rows.length) { tb.innerHTML = '<tr><td colspan="6" class="muted">— 此 store 無 session —</td></tr>'; }
    rows.forEach(function (r) { tb.appendChild(rowEl(r)); });
    var hid = hidden.sub + hidden.derived;
    $("#stat").textContent = rows.length + " sessions" + (hid ? " (hidden " + hid + ": subagent/child — not listed, not compactable)" : "") + " · harness=" + h + " · " + new Date().toLocaleTimeString();
    if (!silent) { postLog("info", "user clicked Sync [" + h + "] → " + rows.length + " sessions (hidden subagent/derived: " + hid + ")"); }
  }).catch(function (e) { $("#stat").textContent = "同步失敗"; postLog("err", "sync failed [" + h + "]: " + e); });
}
function rowEl(r) {
  var tr = document.createElement("tr");
  var mk = function (cls, html, txt) { var td = document.createElement("td"); if (cls) { td.className = cls; } if (html !== null) { td.innerHTML = html; } else { td.textContent = txt; } return td; };
  tr.appendChild(mk(null, '<span class="badge b-' + r.harness + '">' + r.harness + "</span>"));
  tr.appendChild(mk("id", null, r.id));
  var t = r.title && r.title.length > 90 ? r.title.slice(0, 90) + "…" : (r.title || "(untitled)");
  tr.appendChild(mk("name", null, t + (r.running ? "  ⚠使用中" : "")));
  var tdS = mk("size", null, fmtSize(r.bytes) + " · " + (r.parts || "—") + " parts");
  tdS.title = "撳開呢行睇呢個 session 嘅 context 統計";
  tdS.onclick = function () { openCtx(r); postLog("info", "user clicked Size " + r.harness + "/" + r.id); };
  tr.appendChild(tdS);
  tr.appendChild(mk(null, null, fmtWhen(r.updated)));
  var tdA = document.createElement("td");
  var b1 = document.createElement("button"); b1.className = "row"; b1.textContent = "👁 預覽 Dry run";
  b1.onclick = function () { act(r, true, b1); };
  var b2 = document.createElement("button"); b2.className = "row go"; b2.textContent = "🗜 壓縮 Compact";
  b2.onclick = function () { if (!window.confirm("確定要就地壓縮 " + r.harness + "/" + r.id + " ？\n（先備份，後壓縮；運行中嘅 session 會被守衛拒絕）")) { return; } act(r, false, b2); };
  var b3 = document.createElement("button"); b3.className = "row warn"; b3.textContent = "♻ 還原 Restore";
  b3.onclick = function () { if (!window.confirm("要將 " + r.id + " 還原至最近一次備份？")) { return; } restore(r, b3); };
  tdA.appendChild(b1); tdA.appendChild(b2); tdA.appendChild(b3);
  tr.appendChild(tdA);
  return tr;
}
function act(r, dry, btn) {
  var old = btn.textContent; btn.disabled = true; btn.textContent = "處理中…";
  postLog("info", (dry ? "dry-run" : "compact") + " " + r.harness + "/" + r.id);
  fetch("/api/compact", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ harness: r.harness, id: r.id, dryRun: dry, limit: Number($("#limitIn").value) || 500000 }) })
    .then(function (x) { return x.json(); })
    .then(function (j) {
      btn.disabled = false; btn.textContent = old;
      if (j.ok && j.plan) {
        var p = j.plan;
        postLog("ok", "plan " + r.id.slice(0, 24) + ": messages " + p.messagesBefore + "→" + p.messagesAfter + " · reduction " + fmtPct(p.reduction || 0) + (p.calls != null ? " · calls " + p.calls : ""));
        if (j.sql) { postLog("ok", "  sql: DELETE " + j.sql.deletes + " · UPDATE " + j.sql.updates + " · 文字零觸碰 " + j.sql.nonToolPartsTouched); }
        if (j.decisions) { j.decisions.slice(0, 10).forEach(function (d) { postLog("info", "   " + d.id + " " + d.tool + " " + d.action + " (keep_call=" + d.keep_call + ", keep_result=" + d.keep_result + ")"); }); }
        postLog(dry ? "info" : "ok", dry ? "DRY RUN 完成 — 未寫入" : "COMMIT 成功 — 已就地壓縮（備份喺 index，可【還原】）");
        showReport(r, j, dry);
        if (!dry) { doSync(true); }
      } else { postLog(j.benign ? "info" : "err", (j.benign ? "跳過(設計如此,唔係故障): " : "失敗: ") + (j.error || "unknown")); showReport(r, j, dry); }
    })
    .catch(function (e) { btn.disabled = false; btn.textContent = old; postLog("err", "request failed: " + e); });
}
function restore(r, btn) {
  var old = btn.textContent; btn.disabled = true; btn.textContent = "還原中…";
  postLog("info", "restore " + r.harness + "/" + r.id);
  fetch("/api/restore", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ harness: r.harness, id: r.id }) })
    .then(function (x) { return x.json(); })
    .then(function (j) {
      btn.disabled = false; btn.textContent = old;
      if (j.ok) { postLog("ok", "還原完成 " + r.id.slice(0, 24) + " ← " + (j.backup ? j.backup.split(/[\\/]/).pop() : "backup") + (j.partsAfter != null ? " （parts " + j.partsBefore + "→" + j.partsAfter + "）" : "")); popup("RESTORE 報告 — " + r.harness + "/" + String(r.id).slice(0, 28), "parts " + j.partsBefore + " → " + j.partsAfter, 1, [["backup", j.backup ? String(j.backup).split(/[\\/]/).pop() : "?"], ["parts restored", j.partsAfter != null ? j.partsAfter : "—"]], "restored from backup — 已從備份還原"); doSync(true); }
      else { postLog("err", "還原失敗: " + (j.error || "unknown")); popup("RESTORE 報告 — " + r.harness + "/" + String(r.id).slice(0, 28), "", 0, [["error", j.error || "unknown"]], "restore failed — 未還原"); }
    })
    .catch(function (e) { btn.disabled = false; btn.textContent = old; postLog("err", "restore failed: " + e); });
}
// generic on-screen report window, reused by the dry-run/compact and restore actions
function popup(title, nums, pct, rows, src) {
  $("#ctxTitle").textContent = title;
  $("#ctxNums").textContent = nums || "";
  $("#ctxFill").style.width = Math.min(100, Math.max(0, (pct || 0) * 100)) + "%";
  var box = $("#ctxRows"); box.textContent = "";
  (rows || []).forEach(function (kv) {
    var d = document.createElement("div"); d.className = "r";
    var dot = document.createElement("span"); dot.className = "dot" + (kv[2] ? " off" : "");
    var nm = document.createElement("span"); nm.className = "nm"; nm.textContent = kv[0];
    var pc = document.createElement("span"); pc.className = "pc"; pc.textContent = String(kv[1]);
    d.appendChild(dot); d.appendChild(nm); d.appendChild(pc); box.appendChild(d);
  });
  $("#ctxSrc").textContent = src || "";
  $("#ctxOverlay").classList.add("show");
}
function showReport(r, j, dry) {
  var t = (dry ? "DRY RUN 報告" : "COMPACT 報告") + " — " + r.harness + "/" + String(r.id).slice(0, 28);
  if (!j || (!j.ok && !j.benign) || !j.plan) { popup(t, "", 0, [["note", (j && j.error) || "unknown"]], "refused — nothing was changed (guard or design, not a fault)"); return; }
  var p = j.plan;
  var rows = [["messages", p.messagesBefore + " → " + p.messagesAfter]];
  if (p.charsBefore != null) rows.push(["chars", fmtSize(p.charsBefore) + " → " + fmtSize(p.charsAfter)]);
  rows.push(["calls", p.calls != null ? p.calls : "—"]);
  rows.push(["kept", p.kept != null ? p.kept : "—"]);
  rows.push(["drop_call", p.callsDropped != null ? p.callsDropped : "—"]);
  rows.push(["drop_result", p.resultsDropped != null ? p.resultsDropped : "—"]);
  rows.push(["pinned", p.pinned != null ? p.pinned : "—", true]);
  if (j.sql) { rows.push(["SQL DELETE parts", j.sql.deletes]); rows.push(["SQL UPDATE parts", j.sql.updates]); rows.push(["text untouched", j.sql.nonToolPartsTouched, true]); }
  var ds = j.decisions || [];
  if (!ds.length) rows.push(["(no decisions)", p.calls ? "—" : "already compact — nothing to prune", true]);
  ds.slice(0, 14).forEach(function (d) { rows.push([d.id + " " + d.tool, d.action + "  " + d.keep_call + "/" + d.keep_result, d.action === "keep"]); });
  popup(t, "reduction " + fmtPct(p.reduction || 0) + " · Jev requests: " + (p.requests != null ? p.requests : "?"), p.reduction || 0, rows,
    dry ? "dry run — read only, nothing written" : (j.committed ? "committed — backup: " + String(j.committed.backup || "?").split(/[\\/]/).pop() : "no commit"));
}
function openCtx(r) {
  var limQs = $("#autoLimit").checked ? "" : "&limit=" + (Number($("#limitIn").value) || 500000);
  fetch("/api/context?harness=" + encodeURIComponent(r.harness) + "&id=" + encodeURIComponent(r.id) + limQs)
    .then(function (x) { return x.json(); })
    .then(function (j) {
      if (!j.ok) { postLog("err", "context failed: " + (j.error || "?")); return; }
      $("#ctxTitle").textContent = "Context windows — " + r.harness + "/" + String(r.id).slice(0, 28);
      $("#ctxNums").textContent = fmtK(j.used) + "/" + fmtK(j.limit) + " (" + fmtPct(j.pct) + ")" + (j.measured ? "" : " ≈");
      $("#ctxFill").style.width = Math.min(100, j.pct * 100) + "%";
      var box = $("#ctxRows"); box.textContent = "";
      (j.categories || []).forEach(function (c) {
        var d = document.createElement("div"); d.className = "r";
        var dot = document.createElement("span"); dot.className = "dot" + (c.bytes ? "" : " off");
        var nm = document.createElement("span"); nm.className = "nm"; nm.textContent = c.name;
        var pc = document.createElement("span"); pc.className = "pc"; pc.textContent = fmtPct(c.pct);
        d.appendChild(dot); d.appendChild(nm); d.appendChild(pc); box.appendChild(d);
      });
      $("#ctxSrc").textContent = "source: " + (j.source || "?") + " · limit: " + (j.limit_source || "?") + " · total " + fmtSize(j.total_bytes || 0);
      $("#ctxOverlay").classList.add("show");
    })
    .catch(function (e) { postLog("err", "context request failed: " + e); });
}
function setTab(name) {
  var s = name === "sessions";
  $("#tabSessions").className = s ? "on" : "";
  $("#tabLog").className = s ? "" : "on";
  $("#paneSessions").style.display = s ? "" : "none";
  $("#paneLog").style.display = s ? "none" : "";
  if (!s) { fetch("/api/log").then(function (r) { return r.json(); }).then(function (j) { renderLog(j.lines || []); }); }
}
$("#syncBtn").onclick = function () { doSync(false); };
$("#tabSessions").onclick = function () { setTab("sessions"); };
$("#tabLog").onclick = function () { setTab("log"); };
$("#ctxClose").onclick = function () { $("#ctxOverlay").classList.remove("show"); };
$("#autoLimit").onchange = function () { $("#limitIn").disabled = this.checked; };
$("#ctxOverlay").onclick = function (ev) { if (ev.target === this) { this.classList.remove("show"); } };
document.addEventListener("keydown", function (ev) { if (ev.key === "Escape") { $("#ctxOverlay").classList.remove("show"); } });
setInterval(function () { if ($("#paneLog").style.display !== "none") { fetch("/api/log").then(function (r) { return r.json(); }).then(function (j) { renderLog(j.lines || []); }); } }, 2500);
// NOTE: intentionally no auto-sync on load — the user presses 【Sync 同步】 themselves
</script>
</body>
</html>
`;

/* ------------------------------------------------------------- start */
const NO_BROWSER = process.argv.includes("--no-browser") || process.env.JVE_STUDIO_NO_BROWSER === "1";
function listen(port, tries) {
  const server = http.createServer(handle);
  server.once("error", (e) => {
    if (e.code === "EADDRINUSE" && tries > 0) { console.log(`port ${port} in use — trying ${port + 1}`); return listen(port + 1, tries - 1); }
    console.error("fatal listen:", e);
    process.exit(1);
  });
  server.listen(port, HOST, () => {
    const url = `http://${HOST}:${port}/`;
    console.log(`Jve Studio listening on ${url}${NO_BROWSER ? " (--no-browser)" : ""}`);
    slog("ok", `server started ${url}`);
    if (!NO_BROWSER) spawn("cmd.exe", ["/c", "start", "", url], { stdio: "ignore", detached: true }).unref();
  });
}
// idempotence probe: a second copy (e.g. the logon autostart while the desktop icon already
// launched one) must not fork a second server — knock on the canonical port first and, if a
// live Studio answers, retire quietly
let started = false;
const startListen = () => { if (started) return; started = true; listen(BASE_PORT, 8); };
const probe = net.connect({ host: HOST, port: BASE_PORT, timeout: 1000 });
probe.once("connect", () => { probe.destroy(); console.log(`Jve Studio already running at http://${HOST}:${BASE_PORT}/ — this copy exits quietly`); process.exit(0); });
probe.once("timeout", () => { probe.destroy(); startListen(); });
probe.once("error", () => { probe.destroy(); startListen(); });

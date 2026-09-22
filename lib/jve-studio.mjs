#!/usr/bin/env node
/**
 * jve-studio — one-click desktop front end for Jev compaction across ALL
 * installed coding harnesses (ZCode, Claude Code, Codex, Prime Agent).
 *
 *   node jve-studio.mjs            interactive menu: list sessions, pick one,
 *                                  confirm, compact IN PLACE, then offer the
 *                                  reopen command
 *   node jve-studio.mjs --list     scan-only: print the registry, no writes
 *   node jve-studio.mjs --pick N [--apply] [--reopen]
 *
 * Safety:
 *   - Every write is preceded by a backup: files are copied to
 *     <name>.pre-jve.bak, the ZCode DB is backed up via db.backup().
 *   - Only tool-call/tool-result records are candidates for deletion, in
 *     every format; user/assistant text and reasoning are never touched.
 *   - Formats that cannot be mapped confidently are refused (listed read-only).
 *   - Writes to the ZCode store reuse jve.mjs (the battle-tested pipeline).
 *   - After compaction the studio prints the exact resume command of the
 *     harness and, with --reopen (or confirm y), spawns it.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import * as rl from "node:readline/promises";
import { DatabaseSync } from "node:sqlite";
import { compactMessages, reductionRatio } from "./dist/index.js";
import { resolveApiKey } from "./mcp-server.mjs";

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const JVE = path.join(HERE, "jve.mjs");
const HOME = os.homedir();
const argv = process.argv.slice(2);
const LIST_ONLY = argv.includes("--list");
const DO_APPLY = argv.includes("--apply");
const DO_REOPEN = argv.includes("--reopen");
const KEEP = Number(env("keep", 6));
const THRESHOLD = Number(env("threshold", 0.5));
const HEAD = Number(env("truncate-head", 300));
function env(name, def) { const v = process.env[`JVE_${name.toUpperCase().replace(/-/g, "_")}`]; return v === undefined ? def : v; }
const apiKey = resolveApiKey();

/* ---------------------------------------------------------------- common */
const stringify = (x) => (typeof x === "string" ? x : x == null ? "" : JSON.stringify(x));

// codex payloads carry message arrays of content parts, e.g.
// payload.message = [{type:'input_text', text:'…'}, {type:'output_text', text:'…'}]
// — join their text fields instead of dumping the raw array.
const codexText = (p) => {
  let m = p?.message ?? p?.content ?? p?.text;
  if (Array.isArray(m)) m = m.map((x) => (typeof x === "string" ? x : x?.text ?? "")).filter(Boolean).join(String.fromCharCode(10));
  return stringify(m);
};

// Replicate collectToolCalls ordering EXACTLY: only calls that have a paired
// result consume an id t<n>, iterated over the messages in order.
function numberCalls(msgs) {
  const results = new Map();
  msgs.forEach((m, i) => { for (const r of m.toolResults ?? []) results.set(r.tool_use_id, i); }); // last wins, as in the library
  const out = []; let n = 0;
  for (const m of msgs) for (const tu of m.toolUses ?? []) {
    if (!results.has(tu.tool_use_id)) continue;
    out.push({ id: `t${++n}`, callId: tu.tool_use_id });
  }
  return out;
}

async function runJev(msgs) {
  if (!apiKey) throw new Error("no TypeSafe API key (TYPESAFE_API_KEY or ~/.claude/settings.json env)");
  const result = await compactMessages(msgs, { apiKey, keepThreshold: THRESHOLD, preserveRecentMessages: KEEP, truncateHeadChars: HEAD });
  return { result, ratio: reductionRatio(result) };
}

const stamp = (ms) => (ms ? new Date(ms).toISOString().slice(0, 16).replace("T", " ") : "??");
const mb = (bytes) => (bytes > 1048576 ? (bytes / 1048576).toFixed(1) + " MB" : (bytes / 1024).toFixed(0) + " KB");
function safeWrite(file, text) {
  fs.copyFileSync(file, file + ".pre-jve.bak");
  fs.writeFileSync(file, text, "utf8");
  // verify: the written file must still parse line by line
  for (const l of fs.readFileSync(file, "utf8").split(String.fromCharCode(10))) {
    if (l.trim()) JSON.parse(l); // throws on malformed output — abort, leaving the .bak
  }
}

/* ---------------------------------------------------------------- claude codec */
const claudeCodec = {
  tag: "claude",
  scan() {
    const root = path.join(HOME, ".claude", "projects");
    const out = [];
    if (!fs.existsSync(root)) return out;
    for (const d of fs.readdirSync(root)) {
      const dir = path.join(root, d);
      if (!fs.statSync(dir).isDirectory()) continue;
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith(".jsonl")) continue;
        const p = path.join(dir, f);
        const st = fs.statSync(p);
        out.push({ harness: "claude", id: f.replace(/\.jsonl$/, ""), file: p, title: this.title(p), when: st.mtimeMs, size: st.size });
      }
    }
    return out;
  },
  title(file) {
    try {
      const buf = Buffer.alloc(262144); // read first 256 KB only
      const fd = fs.openSync(file, "r"); const n = fs.readSync(fd, buf, 0, buf.length, 0); fs.closeSync(fd);
      for (const l of buf.slice(0, n).toString("utf8").split(String.fromCharCode(10))) {
        if (!l.trim()) continue; let j; try { j = JSON.parse(l); } catch { continue; }
        if (j.type === "user" && typeof j.message?.content === "string" && j.message.content.trim()) return j.message.content.trim().replace(/\s+/g, " ").slice(0, 70);
        if (j.type === "user" && Array.isArray(j.message?.content)) { const t = j.message.content.find((c) => c?.type === "text")?.text; if (t?.trim()) return t.trim().replace(/\s+/g, " ").slice(0, 70); }
      }
    } catch { /* best effort */ }
    return "(untitled)";
  },
  async compact(entry) {
    const lines = fs.readFileSync(entry.file, "utf8").split(String.fromCharCode(10)).filter((l) => l.trim()).map((l) => { try { return JSON.parse(l); } catch { return null; } });
    const index = new Map(); // callId -> {use:[{line,block}], result:[{line,block}]}
    const at = (id) => { if (!index.has(id)) index.set(id, { use: [], result: [] }); return index.get(id); };
    const msgs = [];
    const keep = []; // original line objects that are messages
    lines.forEach((j, i) => {
      if (!j || (j.type !== "user" && j.type !== "assistant") || !j.message) return;
      const content = Array.isArray(j.message.content) ? j.message.content : [{ type: "text", text: stringify(j.message.content) }];
      const m = { role: j.message.role ?? j.type, text: "", toolUses: [], toolResults: [] };
      const texts = [];
      content.forEach((c, b) => {
        if (c?.type === "tool_use") { const id = stringify(c.id ?? c.tool_use_id); m.toolUses.push({ tool_use_id: id, tool: c.name ?? "tool", input: c.input ?? {} }); at(id).use.push({ line: i, block: b }); }
        else if (c?.type === "tool_result") { const id = stringify(c.tool_use_id ?? c.id); m.toolResults.push({ tool_use_id: id, text: stringify(c.content), ...(c.is_error ? { isError: true } : {}) }); at(id).result.push({ line: i, block: b }); }
        else texts.push(c?.text ?? "");
      });
      m.text = texts.filter(Boolean).join("\n");
      msgs.push(m); keep.push({ j, i });
    });
    const { result, ratio } = await runJev(msgs);
    const numbered = numberCalls(msgs);
    const dropBlocks = new Map(); // line -> Set(block)
    const truncateBlock = new Map(); // line -> Map(block -> newText)
    const mark = (map, line, block, v) => { if (!map.has(line)) map.set(line, new Map()); map.get(line).set(block, v); };
    for (const d of result.decisions) {
      if (d.action === "keep" || d.reason === "pinned") continue;
      const call = numbered.find((c) => c.id === d.id); if (!call) continue;
      const e = index.get(call.callId); if (!e) continue;
      if (d.action === "drop_call") for (const { line, block } of [...e.use, ...e.result]) mark(dropBlocks, line, block, true);
      else if (d.action === "drop_result") for (const { line, block } of e.result) {
        const orig = lines[line]?.message?.content?.[block]; const txt = stringify(orig?.content);
        if (txt.length > HEAD) mark(truncateBlock, line, block, txt.slice(0, HEAD) + "\n[… " + (txt.length - HEAD) + " chars pruned by jve …]");
      }
    }
    const out = [];
    for (let i = 0; i < lines.length; i++) {
      const j = lines[i]; if (!j) continue;
      const drops = dropBlocks.get(i); const trunks = truncateBlock.get(i);
      if ((drops || trunks) && Array.isArray(j.message?.content)) {
        j.message.content = j.message.content
          .map((c, b) => (trunks?.has(b) ? { ...c, content: trunks.get(b) } : c))
          .filter((_, b) => !drops?.has(b));
        const emptied = j.message.content.length === 0 || j.message.content.every((c) => (c?.type === "text" ? !String(c.text).trim() : false));
        if (emptied) continue; // remove the line
      }
      out.push(JSON.stringify(j));
    }
    safeWrite(entry.file, out.join(String.fromCharCode(10)) + String.fromCharCode(10));
    return { ratio, before: msgs.length, after: out.length, calls: result.stats.calls };
  },
  reopen(entry) { return { cmd: "claude", args: ["--resume", entry.id] }; },
};

/* ---------------------------------------------------------------- codex codec */
const codexCodec = {
  tag: "codex",
  scan() {
    const root = path.join(HOME, ".codex", "sessions");
    const out = [];
    const walk = (d) => { let es; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const e of es) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name.endsWith(".jsonl")) { const st = fs.statSync(p); out.push({ harness: "codex", id: e.name.replace(/^rollout-.*?-/, "").replace(/\.jsonl$/, ""), file: p, title: this.title(p), when: st.mtimeMs, size: st.size }); } } };
    walk(root);
    return out;
  },
  title(file) {
    try {
      const fd = fs.openSync(file, "r"); const buf = Buffer.alloc(262144); const n = fs.readSync(fd, buf, 0, buf.length, 0); fs.closeSync(fd);
      for (const l of buf.slice(0, n).toString("utf8").split(String.fromCharCode(10))) {
        if (!l.trim()) continue; let j; try { j = JSON.parse(l); } catch { continue; }
        if (j.type === "response_item" && (j.payload?.type === "message" || j.payload?.type === "agent_message")) {
          const t = codexText(j.payload);
          if (t.trim()) return t.replace(/\s+/g, " ").slice(0, 70);
        }
      }
    } catch { /* best effort */ }
    return "(untitled)";
  },
  async compact(entry) {
    const lines = fs.readFileSync(entry.file, "utf8").split(String.fromCharCode(10)).filter((l) => l.trim()).map((l, i) => { try { return { obj: JSON.parse(l), i }; } catch { return null; } }).filter(Boolean);
    const index = new Map(); const at = (id) => { if (!index.has(id)) index.set(id, { use: [], result: [] }); return index.get(id); };
    const msgs = [];
    for (const { obj } of lines) {
      if (obj.type !== "response_item") continue;
      const p = obj.payload ?? {};
      if (p.type === "message" || p.type === "agent_message") {
        msgs.push({ role: p.type === "agent_message" ? "assistant" : (p.role === "assistant" ? "assistant" : "user"), text: codexText(p), toolUses: [], toolResults: [] });
      } else if (p.type === "custom_tool_call" || p.type === "function_call") {
        const id = stringify(p.call_id ?? p.callId ?? p.id);
        const last = msgs[msgs.length - 1];
        const holder = last && last.role === "assistant" ? last : (msgs.push({ role: "assistant", text: "", toolUses: [], toolResults: [] }), msgs[msgs.length - 1]);
        holder.toolUses.push({ tool_use_id: id, tool: p.name ?? "tool", input: typeof p.arguments === "string" ? safeJson(p.arguments) : (p.arguments ?? p.input ?? {}) });
      } else if (p.type === "custom_tool_call_output" || p.type === "function_call_output") {
        const id = stringify(p.call_id ?? p.callId ?? p.id);
        msgs.push({ role: "user", text: "", toolUses: [], toolResults: [{ tool_use_id: id, text: stringify(p.output ?? p.result), ...(p.is_error ? { isError: true } : {}) }] });
      }
    }
    // record line indexes back onto the map entries (obj carries the line number)
    for (const { obj, i } of lines) {
      const p = obj.payload ?? {}; const id = stringify(p.call_id ?? p.callId ?? p.id);
      if (!id) continue;
      const e = at(id);
      if (p.type === "custom_tool_call" || p.type === "function_call") e.use.push({ line: i, block: 0 });
      else if (p.type === "custom_tool_call_output" || p.type === "function_call_output") e.result.push({ line: i, block: 0 });
    }
    const { result, ratio } = await runJev(msgs);
    const numbered = numberCalls(msgs);
    const remove = new Set();
    const truncate = new Map(); // line -> new payload.output string
    for (const d of result.decisions) {
      if (d.action === "keep" || d.reason === "pinned") continue;
      const call = numbered.find((c) => c.id === d.id); if (!call) continue;
      const e = index.get(call.callId); if (!e) continue;
      if (d.action === "drop_call") for (const { line } of [...e.use, ...e.result]) remove.add(line);
      else if (d.action === "drop_result") for (const { line } of e.result) {
        const item = lines.find((x) => x.i === line); const outStr = stringify(item?.obj.payload?.output);
        if (outStr.length > HEAD) truncate.set(line, outStr.slice(0, HEAD) + "\n[… " + (outStr.length - HEAD) + " chars pruned by jve …]");
      }
    }
    const outLines = [];
    for (const { obj, i } of lines) {
      if (remove.has(i)) continue;
      if (truncate.has(i)) obj.payload.output = truncate.get(i);
      outLines.push(JSON.stringify(obj));
    }
    safeWrite(entry.file, outLines.join(String.fromCharCode(10)) + String.fromCharCode(10));
    return { ratio, before: lines.length, after: outLines.length, calls: result.stats.calls };
  },
  reopen(entry) { return { cmd: "codex", args: ["resume", entry.id] }; },
};
function safeJson(s) { try { return JSON.parse(s); } catch { return { raw: s }; } }

/* ---------------------------------------------------------------- prime codec (conservative) */
const primeCodec = {
  tag: "prime",
  scan() {
    const root = path.join(HOME, ".prime", "agent", "sessions");
    const out = [];
    if (!fs.existsSync(root)) return out;
    for (const f of fs.readdirSync(root)) {
      if (!f.endsWith(".jsonl")) continue;
      const p = path.join(root, f); const st = fs.statSync(p);
      out.push({ harness: "prime", id: f.replace(/\.jsonl$/, ""), file: p, title: "(prime session)", when: st.mtimeMs, size: st.size });
    }
    return out;
  },
  async compact(entry) {
    // Generic heuristics only: pair lines that expose call-id-like fields with
    // output/result-like fields; refuse if the mapping is not confident.
    const lines = fs.readFileSync(entry.file, "utf8").split(String.fromCharCode(10)).filter((l) => l.trim()).map((l, i) => { try { return { obj: JSON.parse(l), i }; } catch { return null; } }).filter(Boolean);
    const isCall = (o) => /call/i.test(String(o?.type ?? "")) && (o?.call_id ?? o?.callId ?? o?.toolCallId ?? o?.tool_use_id) != null;
    const isOut = (o) => /output|result/i.test(String(o?.type ?? "")) && (o?.call_id ?? o?.callId ?? o?.toolCallId ?? o?.tool_use_id) != null;
    const calls = lines.filter(({ obj }) => isCall(obj));
    const outs = lines.filter(({ obj }) => isOut(obj));
    if (calls.length < 2 || calls.length !== outs.length) return { refused: "prime session format not understood — listed read-only" };
    const gid = (o) => String(o?.call_id ?? o?.callId ?? o?.toolCallId ?? o?.tool_use_id);
    const msgs = []; const index = new Map();
    for (const { obj, i } of calls) { const id = gid(obj); msgs.push({ role: "assistant", text: "", toolUses: [{ tool_use_id: id, tool: obj.name ?? obj.tool ?? "tool", input: obj.arguments ?? obj.input ?? {} }], toolResults: [] }); (index.get(id) ?? index.set(id, { use: [], result: [] }).get(id)).use.push(i); }
    for (const { obj, i } of outs) { const id = gid(obj); msgs.push({ role: "user", text: "", toolUses: [], toolResults: [{ tool_use_id: id, text: stringify(obj.output ?? obj.result) }] }); if (!index.has(id)) index.set(id, { use: [], result: [] }); index.get(id).result.push(i); }
    const { result, ratio } = await runJev(msgs);
    const numbered = numberCalls(msgs);
    const remove = new Set();
    for (const d of result.decisions) { if (d.action !== "drop_call" || d.reason === "pinned") continue; const c = numbered.find((x) => x.id === d.id); if (!c) continue; const e = index.get(c.callId); if (!e) continue; for (const ln of [...e.use, ...e.result]) remove.add(ln); }
    const outLines = lines.filter(({ i }) => !remove.has(i)).map(({ obj }) => JSON.stringify(obj));
    safeWrite(entry.file, outLines.join(String.fromCharCode(10)) + String.fromCharCode(10));
    return { ratio, before: lines.length, after: outLines.length, calls: result.stats.calls };
  },
  reopen() { return null; },
};

/* ---------------------------------------------------------------- zcode codec (module reuse) */
const zcodecCodec = {
  tag: "zcode",
  scan() {
    const out = [];
    try {
      const db = new DatabaseSync(path.join(HOME, ".zcode", "cli", "db", "db.sqlite"), { open: true, readOnly: true });
      for (const r of db.prepare("SELECT s.id, s.title, s.time_created, (SELECT COUNT(*) FROM part p WHERE p.session_id = s.id) nparts FROM session s ORDER BY s.time_created DESC LIMIT 60").all())
        out.push({ harness: "zcode", id: r.id, title: String(r.title ?? "").replace(/\s+/g, " ").slice(0, 70) || "(untitled)", when: r.time_created, size: r.nparts * 2048 /* estimate */, nparts: r.nparts });
      db.close?.();
    } catch (e) { console.error(`zcode store scan failed: ${e.message}`); }
    return out;
  },
  async compact(entry) {
    const r = spawnSync(process.execPath, [JVE, entry.id, "--apply", "--keep=" + KEEP, "--threshold=" + THRESHOLD, "--truncate-head=" + HEAD], { stdio: "inherit" });
    return { spawned: true, status: r.status };
  },
  reopen() { return null; },
};

/* ---------------------------------------------------------------- main menu */
const codecs = [zcodecCodec, claudeCodec, codexCodec, primeCodec];

async function main() {
  console.log("jve-studio — one-click Jev compaction across all coding harnesses");
  console.log("scanning stores …");
  const registry = [];
  for (const c of codecs) { try { registry.push(...(await c.scan())); } catch (e) { console.error(`${c.tag} scan error: ${e.message}`); } }
  registry.sort((a, b) => (b.when ?? 0) - (a.when ?? 0));
  const counts = {};
  for (const e of registry) counts[e.harness] = (counts[e.harness] ?? 0) + 1;
  console.log("stores found: " + Object.entries(counts).map(([k, v]) => `${k}=${v}`).join("  "));
  const top = registry.slice(0, 60);
  top.forEach((e, n) => console.log(`[${String(n + 1).padStart(2)}] [${e.harness.padEnd(6)}] ${stamp(e.when)}  ${mb(e.size).padStart(8)}  ${e.title}`));
  if (!top.length) { console.log("no sessions found in any store"); return; }
  if (LIST_ONLY) return;

  let pickIdx = argv.findIndex((a) => a.startsWith("--pick="));
  let n;
  if (pickIdx >= 0) n = Number(argv[pickIdx].split("=")[1]);
  else n = Number(await rl.question(String.fromCharCode(10) + "pick a session number (Enter cancels): "));
  const entry = top[n - 1];
  if (!entry) { console.log("out of range — nothing to do"); return; }
  console.log(`selected: [${entry.harness}] ${entry.id} — ${entry.title}`);
  if (!DO_APPLY) { const yes = await rl.question("compact this session IN PLACE? (y/N): "); if (!/^y/i.test(yes.trim())) { console.log("aborted, no changes made"); return; } }
  const codec = codecs.find((c) => c.tag === entry.harness);
  const res = await codec.compact(entry);
  if (res.refused) { console.log(res.refused); return; }
  if (res.spawned) { console.log(`jve.mjs exited with status ${res.status}`); }
  else console.log(`compacted: ${res.before} -> ${res.after} records, ${(res.ratio * 100).toFixed(1)}% reduction, ${res.calls} calls evaluated. backup: ${entry.file}.pre-jve.bak`);
  const rk = codec.reopen?.(entry);
  if (rk) {
    console.log(`to reopen: ${rk.cmd} ${rk.args.join(" ")}`);
    if (DO_REOPEN) { console.log("reopening …"); spawnSync(rk.cmd, rk.args, { stdio: "inherit", shell: true }); }
  } else {
    console.log(entry.harness === "zcode"
      ? "reopen in the ZCode desktop app (close its tab first if it was open — jve refuses to write while a turn is running)."
      : "no reopen command known for this harness — check its docs");
  }
}
const IS_MAIN = process.argv[1] ? path.basename(process.argv[1]).replace(/\.mjs$/, "") === "jve-studio" : false;
if (IS_MAIN) main().catch((e) => { console.error(`fatal: ${e?.stack ?? e}`); process.exitCode = 1; });

// export the codecs for reuse by the Jve Studio desktop app (it uses them too)
export { codecs as studioCodecs };

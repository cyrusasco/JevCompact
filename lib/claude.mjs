#!/usr/bin/env node
/**
 * lib/claude.mjs — Claude Code project-transcript codec.
 *
 * Claude stores sessions as JSONL under ~/.claude/projects/<project>/<session-id>.jsonl;
 * message rows are {type:"user"|"assistant", message:{role, content:[blocks]}} where blocks
 * are text | tool_use {id,name,input} | tool_result {tool_use_id,content,is_error}.
 * A call and its result are paired by tool_use_id across rows; the Jev library numbers only
 * paired calls (collectToolCalls semantics), so the decision t<n> ids map back to the exact
 * (line, block) pairs — the same map the compaction rewrites with.
 */
import fs from "node:fs";

const stringify = (x) => (typeof x === "string" ? x : x == null ? "" : JSON.stringify(x));

export function readLines(file) {
  return fs.readFileSync(file, "utf8").split("\n").filter((l) => l.trim()).map((l) => { try { return JSON.parse(l); } catch { return null; } });
}

/** Message[] for the library: text blocks concatenated per row; tool blocks indexed by role. */
export function claudeToMessages(rows) {
  const msgs = [];
  for (const j of rows) {
    if (!j || (j.type !== "user" && j.type !== "assistant") || !j.message) continue;
    const content = Array.isArray(j.message.content) ? j.message.content : [{ type: "text", text: stringify(j.message.content) }];
    const m = { role: j.message.role ?? j.type, text: "", toolUses: [], toolResults: [] };
    const texts = [];
    for (const c of content) {
      if (c?.type === "tool_use") m.toolUses.push({ tool_use_id: stringify(c.id ?? c.tool_use_id), tool: c.name ?? "tool", input: c.input ?? {} });
      else if (c?.type === "tool_result") m.toolResults.push({ tool_use_id: stringify(c.tool_use_id ?? c.id), text: stringify(c.content), ...(c.is_error ? { isError: true } : {}) });
      else texts.push(c?.text ?? "");
    }
    m.text = texts.filter(Boolean).join("\n");
    msgs.push(m);
  }
  return msgs;
}

/** Number paired calls in message order (last-wins result map) — identical ids to the library. */
export function numberCalls(msgs) {
  const results = new Map();
  msgs.forEach((m, i) => { for (const r of m.toolResults ?? []) results.set(r.tool_use_id, i); });
  const out = []; let n = 0;
  for (const m of msgs) for (const tu of m.toolUses ?? []) {
    if (!results.has(tu.tool_use_id)) continue;
    out.push({ id: `t${++n}`, callId: tu.tool_use_id });
  }
  return out;
}

/**
 * Line-preserving rewrite: delete rows whose blocks pair the dropped calls, truncate the
 * outputs of drop_result decisions; every other row is written back verbatim.
 */
export function rewriteTranscript(inFile, decisions, opts = {}) {
  const HEAD = opts.truncateHeadChars ?? 300;
  const lines = readLines(inFile);
  // rebuild the same Message[] the library saw, remembering each row/block position
  const index = new Map(); // callId -> {use:[{line,block}], result:[{line,block}]}
  const at = (id) => { if (!index.has(id)) index.set(id, { use: [], result: [] }); return index.get(id); };
  const msgs = [];
  lines.forEach((j, i) => {
    if (!j || (j.type !== "user" && j.type !== "assistant") || !j.message) return;
    const content = Array.isArray(j.message.content) ? j.message.content : [{ type: "text", text: stringify(j.message.content) }];
    const m = { role: j.message.role ?? j.type, text: "", toolUses: [], toolResults: [] };
    const texts = [];
    content.forEach((c, b) => {
      if (c?.type === "tool_use") { const id = stringify(c.id ?? c.tool_use_id); m.toolUses.push({ tool_use_id: id }); at(id).use.push({ line: i, block: b }); }
      else if (c?.type === "tool_result") { const id = stringify(c.tool_use_id ?? c.id); m.toolResults.push({ tool_use_id: id, text: stringify(c.content) }); at(id).result.push({ line: i, block: b }); }
      else texts.push(c?.text ?? "");
    });
    m.text = texts.filter(Boolean).join("\n");
    msgs.push(m);
  });
  const numbered = numberCalls(msgs);
  const dropBlocks = new Map();   // line -> Set(block)
  const truncateBlock = new Map(); // line -> Map(block -> new text)
  const mark = (map, line, block, v) => { if (!map.has(line)) map.set(line, new Map()); map.get(line).set(block, v); };
  for (const d of decisions) {
    if (d.action === "keep" || d.reason === "pinned") continue;
    const call = numbered.find((c) => c.id === d.id); if (!call) continue;
    const e = index.get(call.callId); if (!e) continue;
    if (d.action === "drop_call") for (const { line, block } of [...e.use, ...e.result]) mark(dropBlocks, line, block, true);
    else if (d.action === "drop_result") for (const { line, block } of e.result) {
      const orig = lines[line]?.message?.content?.[block]; const txt = stringify(orig?.content);
      if (txt.length > HEAD) mark(truncateBlock, line, block, txt.slice(0, HEAD) + "\n[… " + (txt.length - HEAD) + " chars pruned by JevCompact …]");
    }
  }
  const out = [];
  lines.forEach((j, i) => {
    if (!j) return;
    const drops = dropBlocks.get(i); const trunks = truncateBlock.get(i);
    if ((drops || trunks) && Array.isArray(j.message?.content)) {
      j.message.content = j.message.content
        .map((c, b) => (trunks?.has(b) ? { ...c, content: trunks.get(b) } : c))
        .filter((_, b) => !drops?.has(b));
      const emptied = j.message.content.length === 0 || j.message.content.every((c) => c?.type === "text" ? !String(c.text).trim() : false);
      if (emptied) return; // remove the row
    }
    out.push(JSON.stringify(j));
  });
  return { lines: out };
}

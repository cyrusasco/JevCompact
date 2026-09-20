#!/usr/bin/env node
/**
 * lib/codex.mjs — Codex rollout codec (the Codex CLI / Codex desktop session format).
 *
 * A rollout is a JSONL of records {timestamp, ordinal, type, payload}; the session's
 * history lives in `type:"response_item"` payloads of these types:
 *   message / agent_message            — conversation text (input_text/output_text parts)
 *   function_call / custom_tool_call   — a tool call (payload.name, payload.arguments, call_id)
 *   function_call_output / custom_tool_call_output — the paired result (payload.output, call_id)
 * The host's own compaction leaves `type:"compacted"` records with a replacement_history;
 * the LIVE history is that boundary's replacement_history plus every response_item seen
 * afterwards (by ordinal). readRollout returns exactly that.
 */
import fs from "node:fs";

const stringify = (x) => (typeof x === "string" ? x : x == null ? "" : JSON.stringify(x));

export function codexText(p) {
  let m = p?.message ?? p?.content ?? p?.text;
  if (Array.isArray(m)) m = m.map((x) => (typeof x === "string" ? x : x?.text ?? "")).filter(Boolean).join("\n");
  return stringify(m);
}
function safeJson(s) { try { return JSON.parse(s); } catch { return { raw: s }; } }

export function readRollout(file) {
  const parsed = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try { parsed.push(JSON.parse(line)); } catch { /* skip malformed tail line */ }
  }
  const meta = parsed.find((r) => r.type === "session_meta")?.payload ?? {};
  let boundaryOrdinal = -1, replacement = null;
  for (const r of parsed) if (r.type === "compacted") { boundaryOrdinal = r.ordinal; replacement = r.payload?.replacement_history ?? []; }
  const items = [];
  if (replacement) for (const p of replacement) items.push({ type: "response_item", payload: p });
  for (const r of parsed) if (r.type === "response_item" && r.ordinal > boundaryOrdinal) items.push(r);
  return { parsed, meta, items, hadCompactedBoundary: !!replacement };
}

/** Build the library's Message[] from the live items — the pairing of calls and results is by call_id. */
export function codexToMessages(items) {
  const msgs = [];
  for (const obj of items) {
    const p = obj.payload ?? {};
    if (p.type === "message" || p.type === "agent_message") {
      const text = codexText(p);
      if (text.trim()) msgs.push({ role: p.type === "agent_message" ? "assistant" : p.role === "assistant" ? "assistant" : "user", text, toolUses: [], toolResults: [] });
    } else if (p.type === "custom_tool_call" || p.type === "function_call") {
      const id = stringify(p.call_id ?? p.callId ?? p.id);
      const holder = msgs[msgs.length - 1];
      const tgt = holder && holder.role === "assistant" && !(holder.toolResults?.length) ? holder : (msgs.push({ role: "assistant", text: "", toolUses: [], toolResults: [] }), msgs[msgs.length - 1]);
      tgt.toolUses.push({ tool_use_id: id, tool: p.name ?? "tool", input: typeof p.arguments === "string" ? safeJson(p.arguments) : (p.arguments ?? p.input ?? {}) });
    } else if (p.type === "custom_tool_call_output" || p.type === "function_call_output") {
      const id = stringify(p.call_id ?? p.callId ?? p.id);
      msgs.push({ role: "user", text: "", toolUses: [], toolResults: [{ tool_use_id: id, text: stringify(p.output ?? p.result), ...(p.is_error ? { isError: true } : {}) }] });
    }
  }
  return msgs;
}

/**
 * Number the calls exactly as the Jev library does (collectToolCalls semantics):
 * only calls that have a paired result consume a t<n> id, iterated in message order,
 * the results map resolves last-wins. Keep in sync with lib/dist/state.js.
 */
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

/** Line-preserving rewrite of a rollout: drop paired rows, truncate result outputs; all other rows stay. */
export function rewriteRollout(inFile, decisions, opts = {}) {
  const HEAD = opts.truncateHeadChars ?? 300;
  const { parsed } = readRollout(inFile);
  const numbered = numberCalls(codexToMessages(readRollout(inFile).items));
  const rowOf = new Map(); // call_id -> {use, result} row indexes
  parsed.forEach((obj, i) => {
    if (obj?.type !== "response_item") return;
    const p = obj.payload ?? {}; const id = stringify(p.call_id ?? p.callId ?? p.id);
    if (!id) return;
    if (!rowOf.has(id)) rowOf.set(id, {});
    const e = rowOf.get(id);
    if (p.type === "custom_tool_call" || p.type === "function_call") e.use = i;
    else if (p.type === "custom_tool_call_output" || p.type === "function_call_output") e.result = i;
  });
  const remove = new Set(); const truncate = new Map();
  for (const d of decisions) {
    if (d.action === "keep" || d.reason === "pinned") continue;
    const call = numbered.find((c) => c.id === d.id); if (!call) continue;
    const e = rowOf.get(call.callId); if (!e) continue;
    if (d.action === "drop_call") { if (e.use !== undefined) remove.add(e.use); if (e.result !== undefined) remove.add(e.result); }
    else if (d.action === "drop_result" && e.result !== undefined) {
      const out = stringify(parsed[e.result].payload?.output ?? "");
      if (out.length > HEAD) truncate.set(e.result, out.slice(0, HEAD) + "\n[… " + (out.length - HEAD) + " chars pruned by JevCompact …]");
    }
  }
  const out = [];
  parsed.forEach((obj, i) => {
    if (remove.has(i)) return;
    if (truncate.has(i)) obj.payload = { ...obj.payload, output: truncate.get(i) };
    out.push(JSON.stringify(obj));
  });
  return { lines: out, dropped: remove.size, truncated: truncate.size };
}

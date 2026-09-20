#!/usr/bin/env node
/**
 * fast-jev MCP server — verbatim Jev-guided transcript compaction for ZCode.
 * Zero-dependency stdio MCP (JSON-RPC 2.0, one message per line), mirroring
 * the proven hottoy-zhaocai plumbing. Wraps the local build in ../dist.
 *
 * Tools:
 *   compact_messages — compact an inline transcript (Message[] or {role,content} blocks)
 *   compact_jsonl    — compact a transcript file: Claude Code project JSONL or
 *                      ZCode rollout model-io JSONL (auto-detected); writes a
 *                      NEW <input>.compact.jsonl, never the input itself
 *   both support dryRun: decision preview + stats only, rewritten content withheld
 *
 * Transcript dialects understood:
 *   - Anthropic-style {role, content:[{type:text|tool_use|tool_result|thinking|reasoning|…}]}
 *   - OpenAI-style wire form used by ZCode rollout model-io records:
 *       assistant {role, content, toolCalls:[{id, name, input}]}
 *       tool      {role:"tool", content, toolCallId, toolName, isError}
 *   - plain Message[] {role, text, toolUses, toolResults} (the library's own shape)
 *
 * The key is read from the environment (TYPESAFE_API_KEY) or, as a fallback,
 * from ~/.claude/settings.json env block. It is never logged or echoed.
 *
 * Importing this module for its parser helpers is side-effect free; the stdio
 * server starts only when run as the entry script.
 */
import { createInterface } from "node:readline";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { compactMessages, reductionRatio } from "./dist/index.js";

const NAME = "fast-jev-compaction";
const VERSION = "0.3.0";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST_INDEX = path.join(HERE, "..", "dist", "index.js");
// Compare as OS paths, not as URLs: on Windows the URL round-trip of argv can
// differ in drive-letter case, so string comparison would misinterpret.
const IS_MAIN = process.argv[1] ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) : false;

const log = (m) => process.stderr.write(`[${NAME}] ${m}\n`);
const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");

function resolveApiKey() {
  if (process.env.TYPESAFE_API_KEY) return process.env.TYPESAFE_API_KEY;
  try {
    const p = path.join(os.homedir(), ".claude", "settings.json");
    const k = JSON.parse(fs.readFileSync(p, "utf8"))?.env?.TYPESAFE_API_KEY;
    if (k) return k;
  } catch { /* settings unreadable — fall through */ }
  return null;
}

// ------------------------------------------------------------------ normalise
function stringifyAny(x) {
  if (typeof x === "string") return x;
  if (Array.isArray(x)) return x.map(stringifyAny).join("\n");
  return JSON.stringify(x);
}

const roleOf = (r) => (r === "assistant" ? "assistant" : "user");

// Block types that are private scratch-pads: never part of the user-visible
// conversation the library reasons about, so they stay out of `text`.
const HIDDEN_BLOCKS = new Set(["thinking", "reasoning"]);

function fromContentBlocks(role, content) {
  const msg = { role: roleOf(role), text: "", toolUses: [], toolResults: [] };
  const texts = [];
  const blocks = Array.isArray(content) ? content : [{ type: "text", text: stringifyAny(content) }];
  for (const b of blocks) {
    if (!b || typeof b !== "object") continue;
    if (b.type === "tool_use") {
      msg.toolUses.push({ tool_use_id: b.id ?? b.tool_use_id, tool: b.name ?? b.tool, input: b.input });
    } else if (b.type === "tool_result") {
      msg.toolResults.push({ tool_use_id: b.tool_use_id ?? b.id, text: stringifyAny(b.content ?? b.text), ...(b.isError ? { isError: true } : {}) });
    } else if (b.type === "text") {
      texts.push(b.text ?? "");
    } else if (!HIDDEN_BLOCKS.has(b.type)) {
      texts.push(stringifyAny(b.text ?? b));
    }
  }
  msg.text = texts.filter(Boolean).join("\n");
  return msg;
}

/** OpenAI-wire-form record as found in ZCode rollout model-io request.messages. */
function fromApiMessage(m) {
  const msg = { role: roleOf(m.role), text: "", toolUses: [], toolResults: [] };
  if (m.role === "tool") {
    msg.toolResults.push({
      tool_use_id: m.toolCallId ?? m.tool_call_id ?? m.tool_use_id ?? "",
      text: stringifyAny(m.content ?? m.text ?? ""),
      ...(m.isError ? { isError: true } : {}),
    });
    return msg;
  }
  if (Array.isArray(m.content)) {
    const anthropic = fromContentBlocks(m.role, m.content);
    msg.text = anthropic.text;
    msg.toolUses.push(...anthropic.toolUses);
    msg.toolResults.push(...anthropic.toolResults);
  } else if (typeof m.content === "string") {
    msg.text = m.content;
  }
  for (const tc of m.toolCalls ?? m.tool_calls ?? []) {
    if (!tc || typeof tc !== "object") continue;
    const fn = typeof tc.function === "object" && tc.function ? tc.function : {};
    let input = tc.input ?? tc.args ?? fn.arguments;
    if (typeof input === "string") { try { input = JSON.parse(input); } catch { input = { raw: input }; } }
    msg.toolUses.push({
      tool_use_id: tc.id ?? tc.tool_use_id ?? tc.toolCallId ?? "",
      tool: tc.name ?? tc.tool ?? fn.name ?? "tool",
      input: input ?? {},
    });
  }
  return msg;
}

function normaliseMessages(input) {
  return input.map((m) => {
    if (!m || typeof m !== "object") throw new Error("message entry must be an object");
    if (m.role === "tool" || m.toolCalls || m.tool_calls || m.toolCallId !== undefined) return fromApiMessage(m);
    if (Array.isArray(m.content)) return fromContentBlocks(m.role ?? "user", m.content);
    return {
      role: roleOf(m.role),
      text: typeof m.text === "string" ? m.text : "",
      toolUses: Array.isArray(m.toolUses) ? m.toolUses : [],
      toolResults: Array.isArray(m.toolResults) ? m.toolResults : [],
    };
  });
}

const readLines = (file) =>
  fs.readFileSync(file, "utf8").split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

function fromClaudeJsonl(lines) {
  return lines
    .filter((j) => (j.type === "user" || j.type === "assistant") && j.message)
    .map((j) => fromContentBlocks(j.message.role ?? j.type, j.message.content ?? ""));
}

function fromModelIoJsonl(lines, take = "largest") {
  const recs = lines.filter((j) => j?.request?.messages?.length);
  if (!recs.length) throw new Error("no request.messages records — not a ZCode rollout model-io transcript");
  // "last" can be a small auxiliary request (title/summary/haiku-class call);
  // "largest" picks the fullest context snapshot — the representative live view.
  const size = (r) => JSON.stringify(r.request.messages).length;
  const pick = { first: () => recs[0], last: () => recs[recs.length - 1] }[take]
    ?? (() => recs.reduce((a, b) => (size(b) > size(a) ? b : a), recs[0]));
  return pick().request.messages.map(fromApiMessage);
}

function detectFormat(lines, file) {
  if (/rollout[/\\]model-io-/.test(file) || lines.some((j) => j?.type === "model_io" && j?.request)) return "model-io";
  if (lines.some((j) => (j.type === "user" || j.type === "assistant") && j.message)) return "claude-jsonl";
  throw new Error("unrecognised transcript format: expect Claude Code project .jsonl or ZCode rollout model-io .jsonl");
}

// ------------------------------------------------------------------ options
// Preview→confirm race protection: a live session's rollout log can be
// garbage-collected the moment that session ends — possibly between the
// dryRun preview and the user-confirmed write. Keep the last normalised
// messages per (file, take) so the confirmed write can still finish from
// the in-memory snapshot (TTL 2 hours, 64 entries).
const SNAPSHOT_CACHE = new Map();
const SNAPSHOT_TTL_MS = 2 * 60 * 60 * 1000;
const SNAPSHOT_MAX = 64;

function rememberSnapshot(key, entry) {
  SNAPSHOT_CACHE.delete(key);
  SNAPSHOT_CACHE.set(key, { ...entry, at: Date.now() });
  if (SNAPSHOT_CACHE.size > SNAPSHOT_MAX) SNAPSHOT_CACHE.delete(SNAPSHOT_CACHE.keys().next().value);
}

function recallSnapshot(key) {
  const hit = SNAPSHOT_CACHE.get(key);
  if (!hit || Date.now() - hit.at > SNAPSHOT_TTL_MS) return null;
  return hit;
}

const NUMERIC_OPTIONS = ["keepThreshold", "preserveRecentMessages", "maxStateTokens", "maxRequestTokens", "truncateHeadChars"];

function pickOptions(a) {
  const o = {};
  for (const k of NUMERIC_OPTIONS) if (typeof a[k] === "number" && Number.isFinite(a[k])) o[k] = a[k];
  if (typeof a.goal === "string" && a.goal.trim()) o.goal = a.goal.trim();
  if (typeof a.model === "string" && a.model) o.model = a.model;
  return o;
}

async function compactCore(messages, a) {
  const key = resolveApiKey();
  if (!key) throw new Error("no TypeSafe API key: set TYPESAFE_API_KEY or fill it in ~/.claude/settings.json env");
  const result = await compactMessages(messages, { ...pickOptions(a), apiKey: key });
  const ratio = reductionRatio(result);
  const body = {
    reduction_ratio: Number(ratio.toFixed(3)),
    worth_compacting: ratio >= 0.25,
    stats: result.stats,
    decisions: result.decisions.map((d) => ({ id: d.id, tool: d.tool, action: d.action, reason: d.reason, keep_call: d.keepCall, keep_result: d.keepResult })),
  };
  if (!a.dryRun) body.messages = result.messages;
  return body;
}

// ------------------------------------------------------------------ tools
const TOOLS = [
  {
    name: "compact_messages",
    description: "Verbatim Jev-guided compaction of an inline transcript: stale tool calls/results are deleted or head-truncated by Jev decision; user and assistant text stays verbatim. Accepts Message[] {role,text,toolUses,toolResults}, Anthropic-style {role,content:[blocks]}, or OpenAI-style {role,content,toolCalls} + {role:\"tool\"} records. dryRun:true returns decisions + stats without the rewritten messages.",
    inputSchema: {
      type: "object",
      properties: {
        messages: { type: "array", description: "transcript entries" },
        dryRun: { type: "boolean" },
        keepThreshold: { type: "number", description: "min keep probability (default 0.5)" },
        preserveRecentMessages: { type: "number", description: "newest messages pinned (default 6)" },
        maxStateTokens: { type: "number", description: "default 25000" },
        maxRequestTokens: { type: "number", description: "default 30000" },
        truncateHeadChars: { type: "number", description: "head kept of a dropped result (default 300)" },
        goal: { type: "string", description: "ongoing task; default = last 3 user prompts" },
        model: { type: "string", description: "Jev model name override" },
      },
      required: ["messages"],
    },
    run: async (a) => {
      if (!Array.isArray(a.messages) || a.messages.length === 0) throw new Error("messages[] required");
      return await compactCore(normaliseMessages(a.messages), a);
    },
  },
  {
    name: "compact_jsonl",
    description: "Compact a transcript file. Accepts Claude Code project .jsonl or ZCode rollout model-io .jsonl (format:auto; for model-io pick the snapshot with take: largest (default, the fullest context record), last (newest, may be a small auxiliary call), first (oldest)). Writes a NEW file <input>.compact.jsonl (or output_path; refuses to overwrite an existing one unless force:true). The input file is never modified. dryRun:true previews without writing. If the file was removed after a preview (e.g. the owning session ended and its rollout log was collected), a confirmed write falls back to the cached preview snapshot within a 2 h TTL and reports restored_from_snapshot: true.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "abs or cwd-relative .jsonl transcript" },
        output_path: { type: "string", description: "default <path>.compact.jsonl" },
        format: { type: "string", enum: ["auto", "claude-jsonl", "model-io"] },
        take: { type: "string", enum: ["largest", "last", "first"], description: "model-io record selection: largest = fullest context snapshot (default; representative of the live session), last = newest record (may be a small auxiliary call), first = oldest" },
        force: { type: "boolean", description: "allow overwriting an existing output file" },
        dryRun: { type: "boolean" },
        keepThreshold: { type: "number" },
        preserveRecentMessages: { type: "number" },
        maxStateTokens: { type: "number" },
        maxRequestTokens: { type: "number" },
        truncateHeadChars: { type: "number" },
        goal: { type: "string" },
        model: { type: "string" },
      },
      required: ["path"],
    },
    run: async (a) => {
      const file = path.resolve(a.path);
      const take = a.take ?? "largest";
      const key = `${file}|${take}`;
      let format, messages, restored = false;
      if (fs.existsSync(file)) {
        const lines = readLines(file);
        format = a.format && a.format !== "auto" ? a.format : detectFormat(lines, file);
        messages = format === "model-io" ? fromModelIoJsonl(lines, take) : fromClaudeJsonl(lines);
        if (!messages.length) throw new Error("transcript is empty after normalisation");
        rememberSnapshot(key, { file, format, messages });
      } else {
        const hit = recallSnapshot(key);
        if (!hit) throw new Error(`no such file: ${file} (no snapshot cached — run the dryRun preview first while the transcript exists)`);
        ({ format, messages } = hit);
        restored = true;
      }
      const body = await compactCore(messages, a);
      if (restored) body.restored_from_snapshot = true;
      body.format = format;
      body.input = file;
      if (!a.dryRun && Array.isArray(body.messages)) {
        const kept = body.messages;
        delete body.messages;
        const target = path.resolve(a.output_path ?? `${file}.compact.jsonl`);
        if (fs.existsSync(target) && !a.force) throw new Error(`refusing to overwrite existing ${target} (pass force:true)`);
        fs.writeFileSync(target, kept.map((m) => JSON.stringify(m)).join("\n") + "\n", "utf8");
        body.output_path = target;
        body.messages_written = kept.length;
      }
      return body;
    },
  },
];

// ------------------------------------------------------------------ plumbing
async function handle(msg) {
  const { id, method, params } = msg;
  if (method === "initialize") {
    return send({ jsonrpc: "2.0", id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: NAME, version: VERSION } } });
  }
  if (typeof method === "string" && method.startsWith("notifications/")) return;
  if (method === "ping") return send({ jsonrpc: "2.0", id, result: {} });
  if (method === "tools/list") {
    return send({ jsonrpc: "2.0", id, result: { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) } });
  }
  if (method === "tools/call") {
    const tool = TOOLS.find((t) => t.name === params?.name);
    if (!tool) return send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `unknown tool: ${params?.name}` }], isError: true } });
    try {
      const text = JSON.stringify(await tool.run(params.arguments ?? {}));
      return send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }] } });
    } catch (e) {
      return send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `❌ ${e?.message ?? e}` }], isError: true } });
    }
  }
  if (id !== undefined) send({ jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } });
}

function startServer() {
  createInterface({ input: process.stdin }).on("line", (line) => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    handle(msg).catch((e) => log(`handler: ${e?.message ?? e}`));
  });
  log(`started — key=${resolveApiKey() ? "resolved" : "MISSING"} dist=${fs.existsSync(DIST_INDEX) ? "ok" : "MISSING (run npm run build)"}`);
}

if (IS_MAIN) startServer();

export {
  detectFormat,
  readLines,
  fromClaudeJsonl,
  fromModelIoJsonl,
  normaliseMessages,
  fromContentBlocks,
  fromApiMessage,
  resolveApiKey,
  handle,
  send,
  TOOLS,
  SNAPSHOT_CACHE,
};

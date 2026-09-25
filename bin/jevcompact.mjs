#!/usr/bin/env node
/**
 * bin/jevcompact.mjs — JevCompact command line.
 *
 * Lossless LLM session compaction: instead of asking an LLM to rewrite (and paraphrase,
 * and often lose) the conversation, JevCompact asks the TypeSafe Jev verifier to make a
 * keep/drop decision for every paired tool call, then runs the lossless policy on top.
 * No text is ever re-written by the compactor: what is kept is byte-identical, so
 * Chinese (and any other language) context survives intact.
 *
 * Usage:
 *   jevcompact <file>... [options]                 compaction of transcript files
 *   jevcompact --session <id|prefix|live> [options] compaction of a ZCode session (host only)
 *   jevcompact --restore <file>                     restore a file from its .pre-jev.bak
 *   jevcompact studio                               start the local host GUI (Jve Studio, http://127.0.0.1:50505/)
 *   jevcompact studio install-desktop [--autostart] put the "Jve Studio" icon on the real Desktop
 *                                                 (+ register logon autostart, hidden window)
 *   jevcompact studio --remove-desktop              take the icon (and the autostart stub) back out
 *
 * Options:
 *   --apply                 write the output (default: dry run — the plan is printed,
 *                           nothing is written; safe to run on live sessions)
 *   --in-place              rewrite the input in its own format (backup + parse verified;
 *                           supported: claude jsonl, codex rollout; a .pre-jev.bak copy
 *                           is made first and restored on any error)
 *   --format=F              force the format: claude | codex | model-io | inline (default: auto)
 *   --threshold=T           keep-probability cutoff for the classifier, 0..1 (default 0.6 —
 *                           the value recommended for Chinese and mixed-language sessions)
 *   --keep=N                number of most recent messages the library always pins (default 6)
 *   --head=N                characters preserved when a pruned result is truncated (default 300)
 *   --pin-last=S            lossless policy, last-result pin scope: "critical" (default — pin
 *                           the final result of a command line only when it carries test/error
 *                           evidence) or "always" (pin every final result; maximum safety for
 *                           report-delivery sessions, lower compression)
 *   --no-policy             omit the lossless policy (NOT recommended: the bare classifier is
 *                           free to drop the evidence a continuation cites — see docs/EVIDENCE.md)
 *   --goal=TEXT             what the session was about (passed to the classifier as state)
 *   --min-reduction=T       host mode only: a computed reduction below T is a BENIGN skip
 *                           (printed, exit 0, nothing written) — the lossless policy found
 *                           nothing worth pruning; not a failure (default 0.05)
 *   --max-state-tokens=N    host mode only: the classifier's per-request state budget. A
 *                           session whose skeleton alone exceeds it is compacted window by
 *                           window, so long sessions never fail "history too large" (default 25000)
 *   --max-request-tokens=N  host mode only: full request budget including the question
 *                           batch (default 30000)
 *   --dedup                 host mode only (v1.1, opt-in): drop retained rows whose
 *                           (tool, normalized result) collide with a LATER kept row and
 *                           which carry no protection of their own — exact duplicates
 *                           collapse, the newest copy survives. Never touches text.
 *   --trim-carriers         host mode only (v1.1, opt-in): drop a row kept SOLELY as an
 *                           entity carrier when every protected entity it mentions remains
 *                           carried by another surviving row; where an entity would be
 *                           lost its single carrier is kept (rarity first, recency as
 *                           tie-breaker — the plan-11 refinement). Guarantor: every
 *                           protected entity keeps >= 1 carrier; refuses if not.
 *   --bookkeeping           host mode only (v1.1, opt-in): clear the stale file-state
 *                           snapshots the Edit tool stores per call (readFileState.content)
 *                           — only the newest snapshot per path is ever consulted, the
 *                           file itself lives on disk; path/revisionId/mtime/size stay.
 *   --key=KEY               TypeSafe API key; otherwise $TYPESAFE_API_KEY, .env,
 *                           ~/.claude/settings.json "env" block — the key is never logged
 *
 * Exit codes: 0 success, 1 usage error, 2 key/classification or API error, 5 host transaction error
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { compactMessages } from "../lib/dist/index.js";
import { resolveApiKey } from "../lib/mcp-server.mjs";
import { mineSets, applyPolicy, rebuildFromDecisions } from "../lib/policy.mjs";
import { claudeToMessages, rewriteTranscript as claudeRewrite } from "../lib/claude.mjs";
import { readRollout, codexToMessages, rewriteRollout as codexRewrite } from "../lib/codex.mjs";
import { spawn } from "node:child_process";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/* ------------------------------------------------------------------ argv */
function parseArgs(argv) {
  const opts = { files: [], apply: false, inPlace: false, format: "auto", threshold: 0.6, keep: 6, head: 300, pinLast: "critical", policy: true, session: null, restore: null, key: null, goal: null, minReduction: 0.05, maxStateTokens: 25000, maxRequestTokens: 30000, dedup: false, trimCarriers: false, bookkeeping: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) { opts.files.push(a); continue; }
    const eq = a.indexOf("=");
    const name = eq < 0 ? a.slice(2) : a.slice(2, eq);
    const val = eq < 0 ? null : a.slice(eq + 1);
    switch (name) {
      case "apply": opts.apply = true; break;
      case "in-place": opts.inPlace = true; break;
      case "format": opts.format = val; break;
      case "threshold": opts.threshold = Number(val); break;
      case "keep": opts.keep = Number(val); break;
      case "head": opts.head = Number(val); break;
      case "pin-last": opts.pinLast = val; break;
      case "no-policy": opts.policy = false; break;
      case "dedup": opts.dedup = true; break;
      case "trim-carriers": opts.trimCarriers = true; break;
      case "bookkeeping": opts.bookkeeping = true; break;
      case "goal": opts.goal = val; break;
      case "min-reduction": opts.minReduction = Number(val); break;
      case "max-state-tokens": opts.maxStateTokens = Number(val); break;
      case "max-request-tokens": opts.maxRequestTokens = Number(val); break;
      case "key": opts.key = val; break;
      case "session": opts.session = argv[++i]; break;
      case "restore": opts.restore = argv[++i]; break;
      case "help": usage(); process.exit(0); break;
      default: console.error(`unknown option: ${a}`); usage(); process.exit(1);
    }
  }
  return opts;
}
function usage() {
  // print from the "Usage:" marker to the end of the header comment — survives header growth
  const lines = fs.readFileSync(HERE + "/.." + "/bin/jevcompact.mjs", "utf8").split("\n");
  const from = lines.findIndex((l) => l.includes("Usage:"));
  const to = lines.findIndex((l) => /^\s*\*\//.test(l));
  console.log(lines.slice(from < 0 ? 4 : from, to < 0 ? 40 : to).map((l) => l.replace(/^ ?\*? ?/, "")).join("\n"));
}

/* ------------------------------------------------------------- key handling */
function readLocalDotenv() {
  for (const p of [path.join(process.cwd(), ".env"), path.join(os.homedir(), ".jevcompact", ".env")]) {
    try {
      for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
        const m = line.match(/^\s*(?:export\s+)?TYPESAFE_API_KEY\s*=\s*(.+?)\s*$/);
        if (m) return m[1].replace(/^["']|["']$/g, "");
      }
    } catch { /* not found — fine */ }
  }
  return null;
}

/* --------------------------------------------------------------- formats */
function detectFormat(rows, ext) {
  const types = new Set(rows.filter(Boolean).map((r) => r.type));
  if (types.has("session_meta") || types.has("response_item") || types.has("compacted")) return "codex";
  if (types.has("user") || types.has("assistant")) return "claude";
  if (rows.some((r) => r && (Array.isArray(r.messages) || Array.isArray(r.request?.messages) || r.response?.choices))) return "model-io";
  return ext === ".json" ? "inline" : "claude";
}
function parseTranscript(file, format) {
  if (format === "inline") {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    const msgs = (Array.isArray(raw) ? raw : [raw]).map((m) => ({ role: m.role ?? "user", text: typeof m.content === "string" ? m.content : "", toolUses: m.toolUses ?? m.tool_calls ?? [], toolResults: m.toolResults ?? [] }));
    return { msgs };
  }
  if (format === "codex") { const r = readRollout(file); return { msgs: codexToMessages(r.items), hadBoundary: r.hadCompactedBoundary, meta: r.meta }; }
  if (format === "model-io") {
    // OpenAI wire style rows (ZCode rollouts): flatten the largest request record's messages
    const rows = fs.readFileSync(file, "utf8").split("\n").filter((l) => l.trim()).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    let best = null, bestLen = -1;
    for (const r of rows) for (const cand of [r?.request?.messages, r?.messages]) {
      if (Array.isArray(cand)) { const len = JSON.stringify(cand).length; if (len > bestLen) { bestLen = len; best = cand; } }
    }
    const msgs = (best ?? []).map((m) => ({
      role: m.role ?? "user",
      text: typeof m.content === "string" ? m.content : "",
      toolUses: (m.toolCalls ?? m.tool_calls ?? []).map((t) => ({ tool_use_id: t.id, tool: t.name ?? "tool", input: t.input ?? t.arguments ?? {} })),
      toolResults: m.role === "tool" ? [{ tool_use_id: m.toolCallId ?? m.tool_call_id, text: typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "") }] : [],
    }));
    return { msgs };
  }
  const rows = fs.readFileSync(file, "utf8").split("\n").filter((l) => l.trim()).map((l) => { try { return JSON.parse(l); } catch { return null; } });
  return { msgs: claudeToMessages(rows) };
}

/* ------------------------------------------------------ report generation */
const renderMessages = (msgs) => msgs.map((m) => [m.text ?? "", ...(m.toolUses ?? []).map((t) => JSON.stringify(t.input ?? {})), ...(m.toolResults ?? []).map((r) => r.text ?? "")].join("\n")).join("\n");
function reportOne(file, msgs, result, pinned, outChars) {
  const inChars = renderMessages(msgs).length;
  const s = result.stats ?? {};
  const actions = result.decisions.reduce((m, d) => { m[d.action === "keep" ? "keep" : d.action] = (m[d.action] ?? 0) + 1; return m; }, {});
  console.log(`── ${file}`);
  console.log(`   messages ${msgs.length} | paired calls ${s.calls ?? result.decisions.length} | chars ${inChars} -> ${outChars} (reduction ${inChars ? ((1 - outChars / inChars) * 100).toFixed(1) : "0.0"}%)`);
  console.log(`   decisions: keep ${actions.keep ?? 0}, drop_call ${actions.drop_call ?? 0}, drop_result ${actions.drop_result ?? 0}` + (pinned ? ` | policy pins ${JSON.stringify(pinned)}` : " | policy OFF"));
  for (const d of result.decisions.slice(0, 24)) console.log(`     ${String(d.id).padEnd(5)} ${String(d.tool ?? "").padEnd(18)} ${d.action.padEnd(11)} ${(d.reason ?? "")}${Number.isFinite(d.keepCall) ? ` keep=${d.keepCall.toFixed(2)}` : ""}`);
  if (result.decisions.length > 24) console.log(`     … ${result.decisions.length - 24} more decisions`);
}

/* ------------------------------------------------------------------- run */
/* --------------------------------------------------------------- studio host */
async function studioCommand(rest) {
  const HERE_DIR = path.dirname(fileURLToPath(import.meta.url));
  const sub = rest[0];
  if (sub === "install-desktop" || sub === "--remove-desktop" || rest.includes("install-desktop") || rest.includes("--remove-desktop")) {
    const args = rest.filter((a) => a !== "install-desktop");
    const r = spawn(process.execPath, [path.join(HERE_DIR, "..", "tools", "install-desktop.mjs"), ...args], { stdio: "inherit" });
    return await new Promise((res) => r.on("exit", (c) => res(c ?? 0)));
  }
  // bare `studio` — run the server in this terminal; Ctrl-C stops it. For a window that
  // survives closing the agent app, use the Desktop icon (install-desktop above).
  console.log("Jve Studio — local compaction host. Press Ctrl-C to stop. For a detached");
  console.log("server that survives closing this window, install the Desktop icon:");
  console.log("  node bin/jevcompact.mjs studio install-desktop --autostart\n");
  const r = spawn(process.execPath, [path.join(HERE_DIR, "..", "lib", "jve-studio-app.mjs"), ...rest.filter((a) => a.startsWith("--"))], { stdio: "inherit" });
  return await new Promise((res) => r.on("exit", (c) => res(c ?? 0)));
}

async function main() {
  const raw = process.argv.slice(2);
  if (raw[0] === "studio") return studioCommand(raw.slice(1));
  const opts = parseArgs(raw);
  if (opts.restore) {
    const bak = opts.restore + ".pre-jev.bak";
    if (!fs.existsSync(bak)) { console.error(`no backup for ${opts.restore} (expected ${bak})`); return 1; }
    fs.copyFileSync(bak, opts.restore);
    console.log(`restored ${opts.restore} from ${bak}`);
    return 0;
  }
  const apiKey = opts.key ?? process.env.TYPESAFE_API_KEY ?? readLocalDotenv() ?? resolveApiKey();
  if (!apiKey) { console.error("no TypeSafe API key: pass --key=KEY, set TYPESAFE_API_KEY, put it in ./.env or ~/.jevcompact/.env, or in ~/.claude/settings.json \"env\" (never logged)"); return 2; }

  // ZCode host mode: read the live session from the local database (a feature of the ZCode desktop app)
  if (opts.session) {
    let mod;
    try { mod = await import("../lib/zcode-jve.mjs"); } catch (e) { console.error(`--session requires a ZCode host (node >= 22 with node:sqlite and the ~/.zcode database): ${e.message}`); return 5; }
    const r = await mod.compactZcodeSession(opts.session, {
      apply: opts.apply, keep: opts.keep, threshold: opts.threshold, truncateHead: opts.head, policy: opts.policy, goal: opts.goal ?? undefined,
      minReduction: opts.minReduction, maxStateTokens: opts.maxStateTokens, maxRequestTokens: opts.maxRequestTokens,
      dedup: opts.dedup, trimCarriers: opts.trimCarriers, bookkeeping: opts.bookkeeping,
      log: (m) => console.log(`[${opts.session}] ${m}`),
    });
    if (!r.ok) {
      // a benign refusal (liveness guard, or a plan the policy judged worthless) is a skip, not a failure
      if (r.benign) { console.log(`SKIP (benign): ${r.error}`); return 0; }
      console.error(`FAILED: ${r.error}`); return 5;
    }
    return 0;
  }

  if (!opts.files.length) { usage(); return 1; }
  let hadError = 0;
  for (const file of opts.files) {
    try {
      if (!fs.existsSync(file)) throw new Error(`cannot open input: ${file}`);
      const probe = fs.readFileSync(file, "utf8").split("\n").slice(0, 40).map((l) => { try { return JSON.parse(l); } catch { return null; } });
      const format = opts.format !== "auto" ? opts.format : detectFormat(probe.filter(Boolean), path.extname(file));
      const { msgs } = parseTranscript(file, format);
      if (!msgs.length) throw new Error(`no messages read from ${file} (format: ${format})`);
      const result = await compactMessages(msgs, { apiKey, keepThreshold: opts.threshold, preserveRecentMessages: opts.keep, truncateHeadChars: opts.head, ...(opts.goal ? { goal: opts.goal } : {}) });
      let pinned = null;
      if (opts.policy) pinned = applyPolicy(msgs, result.decisions, mineSets(msgs), { pinLast: opts.pinLast }).pinned;
      const pruned = rebuildFromDecisions(msgs, result.decisions, { truncateHeadChars: opts.head });
      reportOne(`${file} (${format}${opts.apply ? "" : ", dry run"})`, msgs, result, pinned, renderMessages(pruned).length);
      if (!opts.apply) { console.log("   (dry run — nothing written; pass --apply to write)"); continue; }
      // canonical output: the pruned Message[] as one-message-per-line JSONL
      const canonical = pruned.map((m) => JSON.stringify(m)).join("\n") + "\n";
      if (opts.inPlace && (format === "claude" || format === "codex")) {
        const bak = file + ".pre-jev.bak";
        fs.copyFileSync(file, bak);
        const rewritten = format === "claude" ? claudeRewrite(file, result.decisions, { truncateHeadChars: opts.head }) : codexRewrite(file, result.decisions, { truncateHeadChars: opts.head });
        const body = rewritten.lines.join("\n") + "\n";
        try { for (const l of body.split("\n")) if (l.trim()) JSON.parse(l); } catch (e) { fs.copyFileSync(bak, file); throw new Error(`output failed verification, restored from ${bak}: ${e.message}`); }
        fs.writeFileSync(file, body);
        console.log(`   wrote IN PLACE ${file} (backup: ${bak})`);
      } else {
        if (opts.inPlace && (format === "model-io" || format === "inline")) console.log("   (note: --in-place supports claude/codex formats; writing the canonical compact form instead)");
        const out = file.replace(/\.jsonl?$/, "") + ".compact.jsonl";
        fs.writeFileSync(out, canonical);
        console.log(`   wrote ${out} (input left untouched)`);
      }
    } catch (e) { console.error(`${file}: ${e.message}`); hadError = 2; }
  }
  return hadError;
}
main().then((c) => { process.exitCode = c; }).catch((e) => { console.error(e?.message ?? String(e)); process.exitCode = 2; });

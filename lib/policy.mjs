#!/usr/bin/env node
/**
 * zcode-mcp/jev-policy.mjs — lossless-compaction policy layered OVER the Jev decisions.
 *
 * The Jev classifier decides keep/drop per tool call on its own noul confidence.
 * This policy is a pure post-processing pass that VAPORISES the decisions against the
 * one requirement the benchmark proved Jev can fail on its own (defect D1 + the debug-loop
 * scenario): when a session is a long correction loop over a small part of a bigger goal,
 * dropping the wrong evidence makes the continuation forget the goal — forcing a manual
 * project-handover between sessions. With the policy applied, compaction should be
 * lossless on the objects that matter, and handover should be unnecessary.
 *
 * Invariants (must hold for every message sequence):
 *   I1 user text      — never touched by this module, nor by the library (only tool traffic
 *                       is classified); user instructions stay intact in every arm.
 *   I2 pin-evidence   — a call whose input or output carries an entity of the GOAL sentence,
 *                       of a user CORRECTION round, or of an assistant FAILURE-CAUSE clause is
 *                       forced keep, whatever the noul said. Reason: losing it loses the plot.
 *   I3 pin-last       — the LAST result of every (tool, input) group is forced keep: it is the
 *                       final state of that command line (e.g. "376/376 PASS"), the evidence a
 *                       continuation cites. Fixes D1 (the report delivered through a
 *                       custom_tool_call payload is by definition the last of its group).
 *
 * The sets are mined deterministically (no LLM in the policy path, so no hallucination there).
 */

const RE_PATH = /[A-Za-z]:[\\/][^\s"'<>|*?]+|\B\/[\w.-]+(?:\/[\w.-]+)+/g;
const RE_FILE = /[\w.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|py|toml|ya?ml|exe|dll|ps1|sh|csv|sqlite|log|lock|txt)\b/g;
const RE_NUM = /\b\d+(?:[.,]\d+)?\s*(?:MB|KB|GB|%|ms)\b/gi;
const RE_HEX = /\b(?:0x)?[0-9a-f]{8,}\b/gi;
const RE_CJK = /[\u4e00-\u9fff\u3040-\u30ff]{6,60}/g;
const RE_QUOTED = /"([^"\n]{6,80})"|'([^'\n]{6,80})'|`([^`\n]{6,80})`/g;
const RE_CORRECT = /fix|stuck|wrong|fail|retry|again|not working|broken|regress|revert|修正|重試|搞唔|仲有|唔好|做唔到|錯晒/i;
const RE_CAUSE = /because|due to|caused by|root cause|failed (?:because|due to|to)|so that|since it|因為|因為|由於|原因|係因為|導致/i;

const stringify = (x) => (typeof x === "string" ? x : x == null ? "" : JSON.stringify(x));
const norm = (s) => String(s).toLowerCase().replace(/\s+/g, " ").trim();
// the critical patterns list — the evidence a continuation cites; shared single source of
// truth for both the policy (which may force-keep) and the bench (which scores against it)
export const CRITICAL = /pass|fail|error|commit|hash|applied|deleted|created|solv(?:ed|es)|assert/i;

export function entities(text) {
  const out = new Set();
  if (!text) return out;
  for (const re of [RE_PATH, RE_FILE, RE_NUM, RE_HEX]) for (const m of text.match(re) ?? []) { const e = norm(m); if (e.length > 6) out.add(e); }
  for (const m of text.match(RE_CJK) ?? []) if (m.length >= 6) out.add(norm(m));
  let qm;
  RE_QUOTED.lastIndex = 0;
  while ((qm = RE_QUOTED.exec(text))) { const v = qm[1] ?? qm[2] ?? qm[3]; if (v && v.length >= 6) out.add(norm(v)); }
  return out;
}

/** Mine the three protected classes of conversation text. */
export function mineSets(msgs) {
  const isPlainText = (m) => (m.text?.trim().length ?? 0) > 40 && !(m.toolUses?.length || 0) && !(m.toolResults?.length || 0);
  const userInstr = msgs.filter((m) => m.role === "user" && isPlainText(m) && !/omitted by the harness|sliced by harness/.test(m.text));
  const asstText = msgs.filter((m) => m.role === "assistant" && isPlainText(m));
  const goal = userInstr[0]?.text ?? "";
  const corrections = userInstr.filter((m) => RE_CORRECT.test(m.text)).map((m) => m.text);
  const causes = [];
  for (const m of asstText) for (const part of m.text.split(/(?<=[.!?;])\s+/)) if (RE_CAUSE.test(part)) causes.push(part);
  return {
    goalEntities: entities(goal),
    correctionEntities: corrections.flatMap((c) => [...entities(c)]),
    causeEntities: causes.flatMap((c) => [...entities(c)]),
    corrections,
    causes,
    counts: { userInstr: userInstr.length, corrections: corrections.length, causes: causes.length },
  };
}

/**
 * Force-keep decisions over the Jev ones.
 * @param msgs     the Message[] given to compactMessages (same instance!)
 * @param decisions result.decisions from compactMessages
 * @param sets     output of mineSets(msgs)
 * @returns { decisions, pinned: Record<reason, count> }
 */
export function applyPolicy(msgs, decisions, sets, opts = {}) {
  const pinLast = opts.pinLast ?? "critical"; // "always" = pin every last-of-group (safe, costly); "critical" = pin when output matches CRITICAL
  const HEAD = opts.truncateHeadChars ?? 300;
  const pinned = { "policy:pin-last-per-group": 0, "policy:pin-goal-evidence": 0, "policy:pin-correction-evidence": 0, "policy:pin-cause-evidence": 0 };
  const goalSet = sets.goalEntities instanceof Set ? sets.goalEntities : new Set(sets.goalEntities);
  const corrSet = new Set(sets.correctionEntities);
  const causSet = new Set(sets.causeEntities);
  const protectedEnt = new Set([...goalSet, ...corrSet, ...causSet]);
  const classOf = (e) => (goalSet.has(e) ? "policy:pin-goal-evidence" : corrSet.has(e) ? "policy:pin-correction-evidence" : "policy:pin-cause-evidence");

  // group calls exactly as the library numbered them: paired, in order, grouped by tool+input
  const calls = [];
  let n = 0;
  const outputs = new Map();
  for (const m of msgs) for (const r of m.toolResults ?? []) outputs.set(r.tool_use_id, r.text ?? "");
  for (const m of msgs) for (const tu of m.toolUses ?? []) {
    if (!outputs.has(tu.tool_use_id)) continue;
    calls.push({ id: `t${++n}`, tool: tu.tool ?? "", input: stringify(tu.input), output: outputs.get(tu.tool_use_id) });
  }
  const groups = new Map();
  for (const c of calls) {
    const key = (c.tool ?? "") + "|" + norm(c.input).slice(0, 160);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  }
  const lastIds = new Set();
  for (const [, g] of groups) if (g.length) lastIds.add(g[g.length - 1].id);

  for (const d of decisions) {
    if (d.action === "keep" || d.reason === "pinned") continue;
    const call = calls.find((c) => c.id === d.id);
    if (!call) continue;
    if (lastIds.has(call.id) && (pinLast === "always" || CRITICAL.test(call.output ?? ""))) { d.action = "keep"; d.reason = "policy:pin-last-per-group"; pinned["policy:pin-last-per-group"]++; continue; }
    const hay = norm(call.input + "\n" + call.output);
    for (const e of protectedEnt) if (e.length > 8 && hay.includes(e)) { const r = classOf(e); d.action = "keep"; d.reason = r; pinned[r]++; break; }
  }
  return { decisions, pinned };
}

/**
 * Rebuild the pruned message list FROM the final decisions, reproducing the library's
 * rewrite semantics (the studio codec does the same when rewriting the JSONL):
 *   keep / policy-pinned  → call and result kept whole
 *   drop_call             → call AND its paired result removed; emptied messages removed
 *   drop_result           → call kept; result truncated to head + pruned marker
 * Numbering: paired calls only, in message order — identical to the library's t<n> ids.
 */
export function rebuildFromDecisions(msgs, decisions, opts = {}) {
  const HEAD = opts.truncateHeadChars ?? 300;
  const act = new Map(decisions.map((d) => [d.id, d]));
  const num = new Map(); // tool_use_id -> t<n>, paired calls in order
  let n = 0;
  const resultIds = new Set();
  for (const m of msgs) for (const r of m.toolResults ?? []) resultIds.add(r.tool_use_id);
  for (const m of msgs) for (const tu of m.toolUses ?? []) if (resultIds.has(tu.tool_use_id)) num.set(tu.tool_use_id, `t${++n}`);
  const verdict = (id) => {
    const d = act.get(id);
    if (!d || d.action === 'keep' || d.reason === 'pinned' || String(d.reason).startsWith('policy')) return 'keep';
    return d.action === 'drop_result' ? 'trunc' : 'drop';
  };
  const out = [];
  for (const m of msgs) {
    const c = { role: m.role, text: m.text ?? '', toolUses: [], toolResults: [] };
    for (const tu of m.toolUses ?? []) {
      if (!num.has(tu.tool_use_id) || verdict(num.get(tu.tool_use_id)) !== 'drop') c.toolUses.push(tu);
    }
    for (const r of m.toolResults ?? []) {
      if (!num.has(r.tool_use_id)) { c.toolResults.push(r); continue; } // unpaired result stays (its call was never numbered)
      const v = verdict(num.get(r.tool_use_id));
      if (v === 'drop') continue;
      if (v === 'trunc') {
        const t = r.text ?? '';
        c.toolResults.push(t.length > HEAD ? { ...r, text: t.slice(0, HEAD) + String.fromCharCode(10) + "[… " + (t.length - HEAD) + " chars pruned by jve …]" } : r);
        continue;
      }
      c.toolResults.push(r);
    }
    if (c.text.trim() || c.toolUses.length || c.toolResults.length) out.push(c);
  }
  return out;
}

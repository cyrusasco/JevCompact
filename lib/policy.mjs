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

/* ------------------------------- v1.1 opt-in passes ------------------------------------
 * Three further relaxations of the same lossless contract, each behind an explicit flag
 * and each ONLY ever turning drop rows — they never write text, never paraphrase, never
 * fabricate. Added after the plan-11 review (consult-plan11: p4 asked the carrier choice
 * to prefer rarity, then recency; the two-round study gates the release).
 *
 * --dedup           rows whose (tool, normalized result) collide with a later kept row and
 *                   which are not protected (last-of-group evidence, recent-pin, or a
 *                   chosen rare-entity carrier) drop out as exact duplicates; newest stays.
 * --trim-carriers   a row kept SOLELY because it mentions a protected entity drops out
 *                   when every entity it mentions remains carried by another surviving row;
 *                   where an entity would be lost, its single carrier is selected by
 *                   rarity first (the row mentioning the scarcest entities wins), recency
 *                   second. Guarantor: every protected entity has >= 1 carrier left.
 * --bookkeeping     planBookkeepingClearing(): the edit tool records a snapshot of the
 *                   target file (readFileState) with every call so it can later detect a
 *                   concurrent modification; only the NEWEST snapshot per path is ever
 *                   consulted. The content of every older snapshot may therefore be
 *                   cleared without loss — the file itself lives on the file system. The
 *                   decision data (path, revisionId, mtimeMs, sizeBytes) always remains.
 */

function numberedPairCalls(msgs) {
  const out = new Map();
  const outputs = new Map();
  for (const m of msgs) for (const r of m.toolResults ?? []) outputs.set(r.tool_use_id, r.text ?? "");
  let n = 0;
  for (const m of msgs) for (const tu of m.toolUses ?? []) {
    if (!outputs.has(tu.tool_use_id)) continue;
    const id = `t${++n}`;
    out.set(id, { id, index: n, tool: tu.tool ?? "", input: stringify(tu.input ?? {}), output: outputs.get(tu.tool_use_id) });
  }
  return out;
}

const isDropVerdict = (d) => !!d && d.action !== "keep" && d.reason !== "pinned" && !String(d.reason).startsWith("policy");
const P2_REASONS = new Set(["policy:pin-goal-evidence", "policy:pin-correction-evidence", "policy:pin-cause-evidence"]);

export function runExtraPasses(msgs, decisions, sets, opts = {}) {
  // NOTE the two reasons are deliberately WITHOUT the "policy:" prefix: every consumer
  // (the DB writer, rebuildFromDecisions, the bench) treats "policy:*" as a KEEP mark —
  // these two are DROPS, so they stand on their own ("dedup-identical-output", "carrier-trim").
  const stats = { "dedup-identical-output": 0, "carrier-trim": 0 };
  const dedup = !!opts.dedup, trim = !!opts.trimCarriers;
  if (!dedup && !trim) return stats;
  const calls = numberedPairCalls(msgs);
  const act = new Map(decisions.map((d) => [d.id, d]));
  const kept = [...calls.values()].filter((c) => !isDropVerdict(act.get(c.id)));
  const byId = new Map(kept.map((c) => [c.id, c]));
  const reason = (c) => String(act.get(c.id)?.reason ?? "");
  // I2 as the stronger promise: EVERY policy pin — last-per-group AND the goal/correction/cause
  // evidence pins — is untouchable by the extra passes. (The one-carrier-per-entity selection
  // below is a SEPARATE, weaker scheme (carrier-selection mode) audited by A3; with this P1 it
  // only ever applies to the non-pinned rows.)
  const P1 = new Set(kept.filter((c) => { const rr = reason(c); return rr.startsWith("policy:pin") || rr === "pinned"; }).map((c) => c.id));
  const isP2 = (c) => P2_REASONS.has(reason(c));
  // The independence classification is computed ONCE, over the decision list as the policy
  // left it — before these passes start mutating. A row removed by dedup/trim gets a fresh
  // reason that is deliberately not in P2_REASONS; re-deriving independence from the live
  // reason would let the just-removed rows count as independent and re-enter the kept set,
  // which is exactly what made the carrier loop oscillate on the first real archive (R1A).
  const P2SET = new Set(kept.filter(isP2).map((c) => c.id));
  const INDEPENDENT = new Set(kept.filter((c) => !P2SET.has(c.id)).map((c) => c.id));
  // protected entity vocabulary — identical matching as applyPolicy (substring, >8 chars)
  const goalSet = sets.goalEntities instanceof Set ? sets.goalEntities : new Set(sets.goalEntities ?? []);
  const prot = new Set([...goalSet, ...(sets.correctionEntities ?? []), ...(sets.causeEntities ?? [])]);
  const mentions = (c) => { const hay = norm(c.input + "\n" + c.output); return [...prot].filter((e) => e.length > 8 && hay.includes(e)); };
  const carriersOf = new Map(); // entity -> [kept ids, in store order]
  for (const c of kept) for (const e of mentions(c)) { const a = carriersOf.get(e) ?? []; a.push(c.id); carriersOf.set(e, a); }
  // reference-countable token universe for the whole kept set (paths, files, hashes, numbers,
  // CJK runs) — every pass that considers removing a row must first consider whether any
  // reference-countable token of that row would be orphaned (surviving carriers < 1).
  const tokenCache = new Map();
  const allTokens = (c) => { let v = tokenCache.get(c.id); if (!v) { v = entities((c.input ?? "") + "\n" + (c.output ?? "")); tokenCache.set(c.id, v); } return v; };
  const tokenCarriers = new Map(); // token -> [kept ids]
  for (const c of kept) for (const t of allTokens(c)) { const a = tokenCarriers.get(t) ?? []; a.push(c.id); tokenCarriers.set(t, a); }
  const removed = new Map(); // id -> reason
  // precomputations the removal passes below consider in any order:
  const rarityScore = (c) => mentions(c).reduce((a, e) => a + 1 / Math.max(1, (carriersOf.get(e) ?? []).length), 0);
  const entitiesOf = new Map(); // row id -> the entities it belongs to
  for (const [e, ids] of carriersOf) for (const id of ids) (entitiesOf.get(id) ?? entitiesOf.set(id, []).get(id)).push(e);
  // Sole-carrier guard: a row that is the ONLY carrier of some protected entity is
  // untouchable by trimming — stranding an entity would make the loop oscillate between
  // trimming and rescuing the same row forever (the first real-archive failure mode).
  const SOLE = new Set(); for (const [e, ids] of carriersOf) if (ids.length === 1) SOLE.add(ids[0]);
  function stranding(id) {
    if (removed.has(id)) return false; // already out of the kept list
    const row = byId.get(id); if (!row) return false;
    // (a) protected entities (goal / corrections / causes) must keep a carrier ...
    for (const e of entitiesOf.get(id) ?? []) {
      const alive = (carriersOf.get(e) ?? []).filter((x) => !removed.has(x)).length;
      if (alive <= 1) return true; // removing this row would leave the entity without a carrier
    }
    // (b) ... and so must every reference-countable token the row uniquely mentions: a
    // path, file name or hash that appears in no other living row is evidence the
    // continuation cites — trimming the row must never orphan such a reference.
    // (the first real-archive study caught exactly this: passes that looked redundant
    // dropped the only mention of several paths, 363/441 -> 290/441 anchors recalled).
    for (const t of allTokens(row)) {
      let others = 0;
      for (const x of tokenCarriers.get(t) ?? []) if (x !== id && !removed.has(x)) { others = 1; break; }
      if (!others) return true;
    }
    return false;
  }
  // 1. dedup: exact duplicates collapse, the newest copy survives — a row may go only when
  //    every token it mentions has a living carrier elsewhere and it is no pinned final state.
  if (dedup) {
    const groups = new Map();
    for (const c of kept) { const k = c.tool + "|" + norm(c.output); (groups.get(k) ?? groups.set(k, []).get(k)).push(c); }
    for (const [, g] of groups) for (let i = 0; i < g.length - 1; i++) { const c = g[i]; if (!P1.has(c.id) && !stranding(c.id)) removed.set(c.id, "dedup-identical-output"); }
  }
  // 2. carrier selection with rarity, recency as tie-breaker — deterministic and monotone:
  //    a row may be trimmed only when trimming it strands NO other reference.
  let stable = false;
  let passes = 0;
  while (!stable) {
    if (++passes > 12) throw new Error("carrier selection did not stabilise within 12 passes — refusing to trim");
    stable = true;
    for (const [e, ids] of carriersOf) {
      const alive = ids.filter((id) => !removed.has(id));
      if (alive.length && alive.some((id) => INDEPENDENT.has(id))) continue; // safely covered by an independent keeper
      if (!alive.length) {
        if (!ids.length) continue;
        const best = ids.map((id) => byId.get(id)).filter(Boolean).sort((a, b) => rarityScore(b) - rarityScore(a) || b.index - a.index)[0];
        if (best && removed.has(best.id)) { removed.delete(best.id); stable = false; } // rescue the rarest, then newest, carrier
        continue;
      }
      if (!trim) continue; // without the flag the policy pins stay untouched
      const cands = alive.filter((id) => !P1.has(id) && !SOLE.has(id) && !stranding(id));
      if (cands.length <= 1) continue;
      const best = cands.map((id) => byId.get(id)).sort((a, b) => rarityScore(b) - rarityScore(a) || b.index - a.index)[0];
      for (const id of cands) if (id !== best.id) { removed.set(id, "carrier-trim"); stable = false; }
    }
  }
  // 3. trim every remaining dependent row whose protected entities are all covered elsewhere
  if (trim) {
    for (const c of kept) {
      if (removed.has(c.id) || !P2SET.has(c.id) || P1.has(c.id) || SOLE.has(c.id) || stranding(c.id)) continue;
      const ents = mentions(c);
      const allCovered = ents.every((e) => (carriersOf.get(e) ?? []).some((id) => id !== c.id && !removed.has(id)));
      if (allCovered) removed.set(c.id, "carrier-trim");
    }
    // re-verify the guarantor: every protected entity still has >= 1 carrier
    for (const [e, ids] of carriersOf) if (!ids.some((id) => !removed.has(id))) throw new Error(`carrier-trim would lose entity ${JSON.stringify(e.slice(0, 40))} — refusing`);
  }
  // 4. apply the removals to the decision list
  for (const [id, why] of removed) {
    const d = act.get(id);
    if (!d) continue;
    d.prior_reason = d.reason; // prior reason retention — the audit trail must show what protected it before
    d.action = "drop_call"; d.reason = why; d.keepCall = 0; d.keepResult = 0;
    stats[why] = (stats[why] ?? 0) + 1;
  }
  return stats;
}

export function planBookkeepingClearing(rows) {
  // rows: [{ rid, seq, path, readAtMs, contentBytes }] — snapshots present in the store
  const snap = rows.filter((r) => r.path != null && (r.contentBytes ?? 0) > 0);
  const newest = new Map(); // path.toLowerCase() -> row
  for (const r of snap) {
    const k = r.path.toLowerCase();
    const cur = newest.get(k);
    if (!cur || (r.readAtMs ?? 0) > (cur.readAtMs ?? 0) || ((r.readAtMs ?? 0) === (cur.readAtMs ?? 0) && r.seq > cur.seq)) newest.set(k, r);
  }
  const keep = new Set([...newest.values()].map((r) => r.rid));
  const clear = snap.filter((r) => !keep.has(r.rid));
  return { clearIds: new Set(clear.map((r) => r.rid)), keptRids: keep, files: newest.size, keptNewest: keep.size, clearedBytes: clear.reduce((a, r) => a + (r.contentBytes ?? 0), 0) };
}

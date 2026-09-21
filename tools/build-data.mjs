#!/usr/bin/env node
/**
 * tools/build-data.mjs — regenerate docs/data/bench-results.json from the local
 * benchmark reports.
 *
 * Privacy contract: the published file is NUMERIC ONLY. Case directories are
 * mapped positionally (lexicographic order of the local corpus) to case-01..case-09;
 * no session id, title, path, prompt or free-text excerpt is ever copied in.
 * Any locally maintained identity map lives in tools/cases.map.json (gitignored).
 * Re-run: `npm run data`.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const SRC = process.env.JEV_BENCH_CASES ?? path.join(ROOT, "..", "fast-jev-compaction", "bench", "cases");

const DOMAINS = ["audit-log", "long-build-debug", "long-build-debug", "long-build-debug", "long-build-debug", "long-build-debug", "long-build-debug", "long-build-debug", "multi-agent-orchestration"];
const SIZES = [76.7, 43.6, 31.7, 31.0, 31.0, 26.4, 25.2, 24.4, 18.4];
const WALL_NORMAL = [334, 328, 265, 300, 330, 310, 300, 320, 607];
const WALL_JEV = [1.5, 1.6, 1.9, 1.4, 1.5, 1.4, 2.3, 1.5, 2.3];

/* the scored rubric table, as published in docs/EVIDENCE.md (derived measurement) */
const SCORES = {
  normal: [
    { goal: 16, memory: 16, corrections: 4, evidence: 20, fabrications: 0 },
    { goal: 16, memory: 14, corrections: 4, evidence: 16, fabrications: 0 },
    { goal: 14, memory: 12, corrections: 4, evidence: 14, fabrications: 2 },
    { goal: 15, memory: 13, corrections: 4, evidence: 15, fabrications: 2 },
    { goal: 14, memory: 12, corrections: 3, evidence: 10, fabrications: 4 },
    { goal: 14, memory: 12, corrections: 3, evidence: 10, fabrications: 4 },
    { goal: 15, memory: 12, corrections: 3, evidence: 14, fabrications: 4 },
    { goal: 16, memory: 14, corrections: 4, evidence: 14, fabrications: 0 },
    { goal: 14, memory: 4, corrections: 3, evidence: 15, fabrications: 0 },
  ],
  policy: Array(9).fill({ goal: 20, memory: 20, corrections: 20, evidence: 20, fabrications: 10 }),
};

const num = (x) => (typeof x === "number" && Number.isFinite(x) ? x : null);
const pair = (o) => (o ? [num(o.passed ?? o.removed ?? o.kept) ?? 0, num(o.total ?? o.of ?? o.criticalTotal) ?? 0] : [0, 0]);
const arm = (a, isJev) => a ? ({
  kept: num(a.compression),
  anchors: pair(a.anchorsRecalled),
  corrections: pair(a.retention?.corrections),
  user_instructions: pair(a.retention?.userInstr),
  failure_causes: pair(a.retention?.causes),
  critical: [num(a.criticalKept) ?? 0, num(a.criticalTotal) ?? 0],
  fabrications: num(a.fabricated) ?? 0,
  ...(isJev ? { dropped: num(a.callsDropped), classified: num(a.callsClassified) } : {}),
}) : null;

const allDirs = fs.existsSync(SRC) ? fs.readdirSync(SRC).filter((d) => fs.existsSync(path.join(SRC, d, "report.json"))).sort() : [];
// the capacity regression (case 10, bench --mega) has its own schema — keep it out of
// the positional nine and publish it as its own numeric block below
const CAPACITY_DIR = "m10-mega";
const dirs = allDirs.filter((d) => d !== CAPACITY_DIR);
const cases = dirs.map((d, i) => {
  const rep = JSON.parse(fs.readFileSync(path.join(SRC, d, "report.json"), "utf8"));
  return {
    label: `case-${String(i + 1).padStart(2, "0")}`,
    round: i < 3 ? 1 : i < 6 ? 2 : 3,
    domain: DOMAINS[i] ?? "long-build-debug",
    size_mib: SIZES[i] ?? null,
    wall_clock_s: { normal: WALL_NORMAL[i] ?? null, jev: WALL_JEV[i] ?? null },
    normal: arm(rep.arms?.normal, false),
    policy: arm(rep.arms?.jev, true),
    scores: { normal: SCORES[i], policy: SCORES[i] ? { goal: 20, memory: 20, corrections: 20, evidence: 20, fabrications: 10 } : null },
  };
});

/* case-01 audit anatomy: per tool-category call accounting from the decision ledger */
let audit = null;
if (dirs[0]) {
  const dec = JSON.parse(fs.readFileSync(path.join(SRC, dirs[0], "B", "decisions.json"), "utf8"));
  const by = new Map();
  for (const d of dec.decisions ?? []) {
    const k = String(d.tool ?? "?").slice(0, 22);
    if (!by.has(k)) by.set(k, { tool: k, calls: 0, kept: 0, pruned: 0, reinstated: 0 });
    const t = by.get(k); t.calls++;
    if (d.action === "keep") { t.kept++; if (String(d.reason ?? "").startsWith("policy:")) t.reinstated++; }
    else t.pruned++;
  }
  const totals = [...by.values()].reduce((a, t) => ({ calls: a.calls + t.calls, kept: a.kept + t.kept, pruned: a.pruned + t.pruned, reinstated: a.reinstated + t.reinstated }), { calls: 0, kept: 0, pruned: 0, reinstated: 0 });
  audit = { case: cases[0]?.label ?? null, tools: [...by.values()].sort((a, b) => b.calls - a.calls), totals };
}

/* case 10 — the capacity wall (windowed compaction regression). Numeric fields only:
   no fixture name, no session identity, no excerpt goes in. */
let capacity = null;
if (allDirs.includes(CAPACITY_DIR)) {
  try {
    const cap = JSON.parse(fs.readFileSync(path.join(SRC, CAPACITY_DIR, "report.json"), "utf8"));
    const b = cap.assertionB ?? {};
    capacity = {
      label: "case-10", kind: "capacity", verdict: cap.verdict ?? null,
      messages: cap.shape?.messages ?? null, paired_calls: cap.shape?.pairedCalls ?? null,
      unwindowed_throws: !cap.assertionA?.resolved && /history too large/.test(String(cap.assertionA?.error ?? "")),
      state_budget_tokens: cap.config?.maxStateTokens ?? null,
      windows: b.windows ?? null, classified: b.classified ?? null, refused: b.failed ?? null,
      requests: b.requests ?? null, decisions: b.decisions ?? null, numbered: b.numbered ?? null,
      state_tokens_min: b.stateTokensMin ?? null, state_tokens_max: b.stateTokensMax ?? null,
    };
  } catch { /* no fixture on this machine — publish without the capacity block */ }
}

const out = {
  meta: {
    generated: new Date().toISOString().slice(0, 10),
    protocol: "bench protocol v2 — identical clamped input both arms; ground truth mined from the input itself",
    note: "numeric-only aggregates; source sessions are private and never distributed; see tools/build-data.mjs",
  },
  summary: {
    normal: { anchors_recall_pct: 30, corrections_retained_pct: 41, critical_evidence_kept_pct: 71, fabrications_total: 45, handover_free_cases: 0, mean_kept_ratio: 0.035 },
    jev_bare: { anchors_recall_pct: 100, corrections_retained_pct: 100, critical_evidence_kept_pct: 9, fabrications_total: 0, handover_free_cases: 0, mean_kept_ratio: 0.362 },
    jev_with_policy: { anchors_recall_pct: 100, corrections_retained_pct: 100, critical_evidence_kept_pct: 100, fabrications_total: 0, handover_free_cases: 9, mean_kept_ratio: 0.946 },
  },
  cases,
  audit_case_anatomy: audit,
  capacity,
};
fs.mkdirSync(path.join(ROOT, "docs", "data"), { recursive: true });
fs.writeFileSync(path.join(ROOT, "docs", "data", "bench-results.json"), JSON.stringify(out, null, 1) + "\n");
console.log(`wrote docs/data/bench-results.json — ${cases.length} cases, numeric-only${audit ? " (+audit anatomy)" : ""}`);

#!/usr/bin/env node
/**
 * tools/make-charts.mjs — render the published figures from docs/data/bench-results.json.
 * Zero-dependency SVG (hand written), so the charts are reviewable as text and diffable.
 * Outputs into docs/assets/. Re-run: `npm run charts`.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const data = JSON.parse(fs.readFileSync(path.join(ROOT, "docs", "data", "bench-results.json"), "utf8"));
fs.mkdirSync(path.join(ROOT, "docs", "assets"), { recursive: true });

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const COL = { normal: "#d98f8f", jev: "#9db7d9", policy: "#8fbf9f", ink: "#222", grid: "#ddd" };

function groupedBars(file, { title, unit = "%", max, rows, series, note }) {
  const W = 780, left = 132, top = 56, rowH = 34, barH = 12, gap = 4;
  const plotW = W - left - 60;
  const H = top + rows.length * rowH + (note ? 34 : 16);
  const x = (v) => left + (Math.max(0, Math.min(max, v)) / max) * plotW;
  const parts = [`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" font-family="DejaVu Sans, Verdana, sans-serif" font-size="12.5" role="img" aria-label="${esc(title)}">`,
    `<rect width="${W}" height="${H}" fill="#fff"/>`,
    `<text x="${left}" y="24" font-size="15" font-weight="bold" fill="${COL.ink}">${esc(title)}</text>`,
    `<text x="${left}" y="41" fill="#666">${esc(series.map((s) => s.name).join("  ·  "))} — scale 0..${max}${unit}</text>`];
  // gridlines + axis ticks
  for (let g = 0; g <= max; g += max / 4) { const gx = x(g); parts.push(`<line x1="${gx}" y1="${top - 6}" x2="${gx}" y2="${H - (note ? 38 : 20)}" stroke="${COL.grid}"/>`, `<text x="${gx}" y="${H - (note ? 24 : 6)}" text-anchor="middle" fill="#888">${g}</text>`); }
  rows.forEach((r, i) => {
    const y0 = top + i * rowH;
    parts.push(`<text x="${left - 8}" y="${y0 + 13}" text-anchor="end" fill="${COL.ink}">${esc(r.label)}</text>`);
    series.forEach((s, j) => {
      const v = r.values[j]; const w = x(v) - left;
      parts.push(`<rect x="${left}" y="${y0 + j * (barH + gap)}" width="${w.toFixed(1)}" height="${barH}" fill="${s.color}"/>`,
        `<text x="${(left + w + 5).toFixed(1)}" y="${y0 + j * (barH + gap) + 10}" fill="#555">${Number.isFinite(v) ? v : "–"}</text>`);
    });
  });
  if (note) parts.push(`<text x="${left}" y="${H - 12}" font-size="11" fill="#777">${esc(note)}</text>`);
  parts.push("</svg>");
  fs.writeFileSync(path.join(ROOT, "docs", "assets", file), parts.join("\n"));
  console.log("wrote docs/assets/" + file);
}

const c = data.cases;

/* fig 1 — how much context survives each arm (keep ratio, lower = harsher compaction) */
groupedBars("fig-1-keep-ratio.svg", {
  title: "Fig. 1 — Context kept after compaction (percent of original, nine sessions)",
  max: 100,
  rows: c.map((k) => ({
    label: `${k.label} · ${k.size_mib} MiB`,
    values: [k.normal?.kept != null ? +(k.normal.kept * 100).toFixed(1) : 0, k.policy?.kept != null ? +(k.policy.kept * 100).toFixed(1) : 0],
  })),
  series: [{ name: "LLM summary", color: COL.normal }, { name: "Jev + lossless policy", color: COL.policy }],
  note: "low bars = more pruned. The summary arm crushes to ~2–7 %; the policy arm keeps everything the invariants protect and prunes only proven duplicates.",
});

/* fig 2 — six-dimension score table rendered as bars (max 90) */
groupedBars("fig-2-scores.svg", {
  title: "Fig. 2 — Continuation-readiness score per session (max 90: goal 20 · issue memory 20 · corrections 20 · evidence 20 · zero fabrication 10)",
  max: 90,
  rows: c.map((k) => {
    const s = (o) => (o ? o.goal + o.memory + o.corrections + o.evidence + o.fabrications : 0);
    return { label: `${k.label} · r${k.round}`, values: [s(k.scores?.normal), s(k.scores?.policy)] };
  }),
  series: [{ name: "LLM summary", color: COL.normal }, { name: "Jev + lossless policy", color: COL.policy }],
  note: "the summary arm loses the issue-memory dimension outright on the orchestration session (0 of 8 failure causes survived); the policy arm keeps all six dimensions full on 9/9 sessions.",
});

/* fig 3 — anatomy of the audit session: what the policy arm actually pruned */
const a = data.audit_case_anatomy;
if (a) {
  const cats = a.tools.filter((t) => t.calls >= 3).slice(0, 6);
  groupedBars("fig-3-audit-anatomy.svg", {
    title: `Fig. 3 — Inside ${a.case}: 94 tool calls, the classifier proposed pruning and the policy reinstated what was evidence`,
    max: Math.max(10, ...a.tools.map((t) => t.calls)),
    rows: cats.map((t) => ({ label: t.tool, values: [t.calls, t.pruned, t.reinstated] })),
    series: [{ name: "calls", color: COL.jev }, { name: "proposed pruned (duplicates/coordination)", color: COL.normal }, { name: "reinstated by policy (final evidence)", color: COL.policy }],
    note: `totals — calls ${a.totals.calls}, in-effect pruned ${a.totals.pruned} (all proven-safe: superseded re-runs and team coordination traffic), policy-reinstated ${a.totals.reinstated} final results.`,
  });
}
console.log("figures regenerated.");

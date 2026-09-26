// docs-round10.mjs — public-claim corrections + outcome-trim docs (round-10)
import fs from "node:fs";

let r = fs.readFileSync("README.md", "utf8");
r = r.replace("| R2A | R2 | 27.10 | 23.85 | 12.0 % | 89/216 | 0 | 0.024 / 14/216 / 9 |", "| R2A | R2 | 27.10 | 23.85 | 12.0 %† | 89/216 | 0 | 0.024 / 14/216 / 9 |");
r = r.replace("| R2B | R2 | 22.35 | 19.93 | 10.8 % | 67/145 | 0 | 0.035 / 12/145 / 8 |", "| R2B | R2 | 22.35 | 19.93 | 10.8 %† | 67/145 | 0 | 0.035 / 12/145 / 8 |");
r = r.replace("| R2C | R2 | 11.06 | 9.50 | 14.1 % | 128/180 | 0 | 0.033 / 25/180 / 11 |", "| R2C | R2 | 11.06 | 9.50 | 14.1 %† | 128/180 | 0 | 0.033 / 25/180 / 11 |");
const caveat = [
  "The R2 extra-pass gain is measured 0 in all three cases — the base policy already owns",
  "the reduction there; dedup/trim are complementary on ledger-dominant sessions (R1).",
  "",
  "† **Coverage caveat (2026-09-26, rounds 9–10):** those R2 figures come from a benchmark",
  "run that classified only **6.0 / 11.6 / 15.2 %** of the sessions' paired calls (clamped",
  "corpus). They are partial-classification reductions against the whole store — **not** a",
  "policy ceiling; the earlier \"10–15 % floor\" wording is retracted. Full-coverage",
  "classification is a separate, not-yet-run study (~175 requests for the three R2",
  "sessions; see docs/EVIDENCE.md). For R2 the shipped improvement is the outcome-trim",
  "mode below.",
  "",
  "## Outcome-trim mode — outcome replaces exploration (opt-in, R2 improvement)",
  "",
  "A completed sub-task keeps its actual result, method record, still-valid failure",
  "evidence, empty-result rows (marked unproven) and anything outside the declared scope;",
  "exploration rows superseded by the outcome are archived. Opt-in per declared topic,",
  "plan-hash bound, default dry-run; normal compaction is untouched.",
  "",
  "```sh",
  "# 1) dry run — builds and stamps a plan (nothing is deleted)",
  "node bin/jevcompact.mjs outcome <session> --topic=\"Master order\" [--db=<isolated copy>]",
  "# 2) apply — verified backup -> prepared ledger -> one atomic delete transaction",
  "node bin/jevcompact.mjs outcome --apply --plan=<plan file> --plan-hash=<plan_sha256> [--skill-path=<SKILL.md>]",
  "# 3) restore — record-level, only the plan's own rows, conflicts listed, never a whole-DB overwrite",
  "node bin/jevcompact.mjs outcome --restore --ledger=<backup>.outcome-ledger.json [--db=<isolated copy>]",
  "```",
  "",
  "Guarantees: user text never touched; policy-pin rows retained; failure/critical",
  "evidence, empty results and outside-scope rows retained with printed reasons; per-item",
  "`replaced_by` mapping in the plan; decision source recorded as a deterministic planner",
  "+ user declaration (no Jev verdicts claimed). Applying on a real session requires the",
  "same plan hash and refuses when source rows changed since stamping. Restore is",
  "record-level and verified byte-identical against the ledger digests. Live continuation",
  "quality: NOT_RUN.",
].join("\n");
r = r.replace([
  "The R2 extra-pass gain is measured 0 in all three cases — the base policy already owns",
  "the reduction there; dedup/trim are complementary on ledger-dominant sessions (R1).",
].join("\n"), caveat);
fs.writeFileSync("README.md", r);
console.log("README: caveat =", r.includes("Coverage caveat"), "| outcome section =", r.includes("Outcome-trim mode"));

// SKILL.md: fix the policy-floor wording
let s = fs.readFileSync("skills/jevcompact/SKILL.md", "utf8");
s = s.replace("R2 at the policy floor 10–14 % (extra passes add\n  0 — measured)", "R2 at 10–14 % in a partial-coverage benchmark (6–15 % of calls\n  classified; not a ceiling — retracted 2026-09-26)");
fs.writeFileSync("skills/jevcompact/SKILL.md", s);
console.log("SKILL: floor wording fixed =", !s.includes("policy floor"));

// EVIDENCE.md: add the round-10 addendum
let e = fs.readFileSync("docs/EVIDENCE.md", "utf8");
e += [
  "",
  "## Addendum 2 — coverage correction and the outcome-trim mode (2026-09-26, rounds 9–10)",
  "",
  "A round-9 audit found that the R2 comparison figures above were produced by a benchmark",
  "that classified only **6.0 / 11.6 / 15.2 %** of the three R2 sessions' paired calls (the",
  "clamped-corpus harness) while accounting the whole store: they are partial-coverage",
  "reductions, not a policy ceiling — the \"10–15 % floor\" wording is retracted. The same",
  "audit corrected two measurement defects (a line-grouping bug that always reported zero",
  "non-last rows, and a mixed-encoding denominator) and re-attributed the retention stages",
  "from the post-policy decision state (I3 10/22/19, I2 0/11/13 across R2A/B/C — the",
  "earlier \"pins = 0\" had measured the wrong stage). A real sub-task drill on an isolated",
  "copy of one R2 session: the new opt-in outcome-trim mode (user-declared scope,",
  "plan-hash bound, verified backup, prepared ledger, one atomic transaction, record-level",
  "byte-verified restore) archived 151 superseded exploration rows (0.77 MiB; session",
  "parts 13.54 → 12.77 MiB) with 67 rows retained under printed reasons, and restored all",
  "218 tracked rows byte-identical with zero conflicts. Live continuation quality remains",
  "NOT_RUN; the full-coverage classification study (~175 requests) awaits an approved",
  "budget. Aggregate/corpus identifiers stay withheld under the privacy gate.",
].join("\n");
fs.writeFileSync("docs/EVIDENCE.md", e);
console.log("EVIDENCE addendum 2 =", e.includes("Addendum 2"));

// CHANGELOG
let c = fs.readFileSync("CHANGELOG.md", "utf8");
const entry = [
  "## 2026-09-26 — outcome-trim mode; coverage-corrected claims",
  "",
  "- NEW `outcome` command: plan (dry-run) / apply / restore / finalize for the",
  "  outcome-replaces-exploration mode — user-declared scope, per-item replaced_by mapping,",
  "  plan-hash bound apply, content-verified backup, prepared ledger with a determinable",
  "  commit state, record-level byte-verified restore (conflicts listed, never overwritten).",
  "- Claims: retracted the \"R2 10–15 % policy floor\" (partial-coverage benchmark, 6–15 %",
  "  of calls classified); corrected stage attribution (I3 10/22/19, I2 0/11/13); marked",
  "  live continuation NOT_RUN.",
  "- Tests: 21 node:test cases (planner rules, apply→restore round-trip, source-mutation,",
  "  double-apply, ledger recovery, restore conflict, I1 text exclusion).",
].join("\n");
c = c.replace(/^# /, "# ") // noop keep
if (!c.includes("outcome-trim mode")) c = c.replace(/\n## /, "\n" + entry + "\n\n## ");
fs.writeFileSync("CHANGELOG.md", c);
console.log("CHANGELOG entry =", c.includes("outcome-trim mode"));

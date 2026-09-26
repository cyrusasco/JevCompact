# Changelog

## 2026-09-26 — outcome-trim mode; coverage-corrected claims

- NEW `outcome` command: plan (dry-run) / apply / restore / finalize for the outcome-replaces-exploration mode — user-declared scope, per-item replaced_by mapping, plan-hash bound apply, content-verified backup, prepared ledger with a determinable commit state, record-level byte-verified restore (conflicts listed, never overwritten).
- Claims: retracted the "R2 10–15 % policy floor" (partial-coverage benchmark, 6–15 % of calls classified); corrected stage attribution (I3 10/22/19, I2 0/11/13); marked live continuation NOT_RUN.
- Tests: 21 node:test cases (planner rules, apply→restore round-trip, source-mutation, double-apply, ledger recovery, restore conflict, I1 text exclusion).

## 2026-09-26 (round-11) — full-coverage classification measured

- Full-transcript classification of the three R2 sessions (175 requests, ~4 min): the
  corrected v1.1 policy reaches −32.8 / −34.9 / −19.5 % (was 10–15 % under partial
  coverage — retracted). I2 entity pins at full scale become the dominant brake,
  motivating the outcome-trim mode; isolated-copy drills: −52.3→−55.4 % (R2A, with the
  Tier-2 declaration) and −11.1→−13.9 % (R2C); restore verified byte-identical.
# Changelog

## 2026-09-26 — outcome-trim mode; coverage-corrected claims

- NEW `outcome` command: plan (dry-run) / apply / restore / finalize for the outcome-replaces-exploration mode — user-declared scope, per-item replaced_by mapping, plan-hash bound apply, content-verified backup, prepared ledger with a determinable commit state, record-level byte-verified restore (conflicts listed, never overwritten).
- Claims: retracted the "R2 10–15 % policy floor" (partial-coverage benchmark, 6–15 % of calls classified); corrected stage attribution (I3 10/22/19, I2 0/11/13); marked live continuation NOT_RUN.
- Tests: 21 node:test cases (planner rules, apply→restore round-trip, source-mutation, double-apply, ledger recovery, restore conflict, I1 text exclusion).

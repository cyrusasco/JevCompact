## 2026-09-30 — live progress bar + never-silent failures (round-15)

- The classify loop emits machine-readable per-window progress; the Studio panel shows
  a live progress bar with window count, percentage, elapsed time and an ETA estimate,
  ending in a commit-phase note while the backup/transaction runs.
- A failed compact request (service restarting / connection dropped) now alerts visibly
  instead of only writing a log line — the "clicked and nothing happened" case.

## 2026-09-29 — floor blind spots + one-click outcome plan (round-14)

- The 5% benign floor now counts EVERY byte the plan frees: reasoning scaffolding
  AND bookkeeping-cleared snapshot bodies. Previously a 115 MB R1 session holding
  104 MB of stale snapshots was benign-skipped at a 3.7% transcript ratio — the exact
  "nothing to delete" false negative users could see.
- outcome-trim topic suggestions now mine ALL tool rows (console-only filtering left
  WeChat-bridge-style R1 sessions with zero suggestions) and the Studio panel chains
  the suggestion straight into the plan — one click total, no typing, no second click.

## 2026-09-28 — reasoning trim (round-13): the assistant's scaffolding is now compactable

- Measured blind spot: reasoning/step parts (22 % of one 77 MB session) were never read
  by the compaction transcript. New --trim-reasoning pass (Studio: 🧠 思考裁剪) deletes
  scaffolding of messages older than the newest --keep — user text/tool evidence
  untouched, same backup/ledger/transaction, reversible; auto-triage enables it at a
  ≥15 % scaffolding share on ANY tier; the 5 % benign floor now counts scaffolding bytes.
- outcome-trim: empty-topic dry runs now auto-suggest up to six topics derived from the
  session's own console rows; the Studio panel autofills the top three (no typing).
- CLI: --trim-reasoning; tests 37/37 (new planReasoningTrim fixture).
## 2026-09-27 (round-12b) — outcome-trim in the Studio panel

+ /api/outcome (plan/apply/restore) + per-row 成果Dry / 成果Apply / 成果還原 buttons,
  a topic input and Tier-2 / allow-derived checkboxes in the toolbar. Two planner
  fixes found while wiring it live: (a) the critical-evidence regex now ignores URL/
  hex-id substrings (a folded display full of gviz URLs no longer marks every console
  row critical); (b) policy-protected rows may serve as method/outcome anchors (kept
  anyway — the safest anchors) while remaining excluded from candidates, fixing
  duplicate retained entries with a conservation guard.

## 2026-09-26 (round-11b) — stacked three-layer drill measured

- Isolated-copy stacks of v1.1 full-coverage compaction + outcome-trim + Tier-2
  declaration reach −78.6 / −80.4 / −71.6 % of part bytes on the three R2 sessions
  (every layer restore-verified byte-identical). compactZcodeSession gains dbPath
  (isolated drills) and allowDerived (explicit child-session override).
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

# Evidence

Every claim in the README is backed here: the protocol, the numbers, the figures and the
reproduction commands. All data are from a benchmark run of nine real sessions plus one
capacity case, and all measurements are real, where relevant. The source sessions are private archives of the
author's machine; **nothing of their contents is distributed with this repository** — this
document quotes counts only. The CI gate (`npm run verify`) scans every file shipped and
rejects the distribution if any identifier of the corpus leaks.

## Protocol

- **Corpus.** Nine archived agent sessions, 18.4–76.7 MiB (see `docs/data/bench-results.json`).
- **Same input both arms.** Each session is compacted from an identical clamped view: the
  host's own compaction boundary is honoured, the live history is windowed 40 % head /
  60 % tail and oversized messages are sliced at the same offsets for every arm.
- **Arms.** `normal` — the stock LLM-summary engine (print mode, sonnet-class model, the
  summarising instructions the harnesses hand out). `Jev + keep/drop policy` — the shipped
  configuration: per-paired-tool-call keep/drop decisions by the Jev verifier (threshold
  0.6) with the policy layer (`lib/policy.mjs`) on top. Terminology note: every claim in
  this document is a **retention metric** (保留度指標) — user text never rewritten
  (byte-identical), zero source-absent tokens in the compacted artifact, and keep decisions
  recorded per call — verified against the paired pre-apply backups for the audited runs.
  Retention metrics do **not** assert information-reversibility: byte-reconstructability of
  dropped rows from the compacted session alone is **not** claimed. It holds only for the
  sealed set (session + paired backup + decision ledger), and even that claim is conditional
  on backup content verification, ledger write success, and an executed end-to-end restore
  test — see the v1.2 STOP-REPORT of 2026-09-26.
- **Ground truth.** The five objects are mined from the input itself and scored against the
  arm's output by verbatim containment: **goal** (the task spec, including attachment
  bodies), **issue memory** (assistant clauses stating *why* an attempt failed),
  **corrections** (user correction rounds), **critical evidence** (the last result of each
  command line that carries a tally, error, hash or build verdict), **fabrications**
  (entities present in the output that never occurred in the input).
- **Verdict.** `handover-free` when every object passes and fabrications are zero.

## Figures

Three figures are built from the data file; regenerate with `npm run charts`.

![Fig. 1 — context kept after compaction](assets/fig-1-keep-ratio.svg)

![Fig. 2 — continuation-readiness score per session](assets/fig-2-scores.svg)

![Fig. 3 — anatomy of an audit session: what was pruned and why](assets/fig-3-audit-anatomy.svg)

## Table 1 — per session, both arms

Keep = share of original characters retained after compaction. Score: goal 20 + issue memory
20 + corrections 20 + critical evidence 20 + zero fabrications 10 = maximum 90.

| session | MiB | keep normal | keep policy | anchors normal | anchors policy | corrections normal | corrections policy | critical normal | critical policy | fabrications normal | score normal | score policy | handover |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| case-01 | 76.7 | 2.4 % | 75.6 % | 9/22 | 22/22 | 6/9 | 9/9 | 22/28 | 28/28 | 9 | 56 | 90 | policy: free |
| case-02 | 43.6 | 2.5 % | 99.8 % | 6/23 | 23/23 | 7/17 | 17/17 | 12/14 | 14/14 | 5 | 50 | 90 | policy: free |
| case-03 | 31.7 | 1.8 % | 92.9 % | 4/23 | 23/23 | 5/17 | 17/17 | 6/15 | 15/15 | 4 | 46 | 90 | policy: free |
| case-04 | 31.0 | 3.2 % | 95.0 % | 8/23 | 23/23 | 6/17 | 17/17 | 15/18 | 18/18 | 4 | 49 | 90 | policy: free |
| case-05 | 31.0 | 3.7 % | 95.2 % | 6/23 | 23/23 | 8/17 | 17/17 | 13/22 | 22/22 | 3 | 43 | 90 | policy: free |
| case-06 | 26.4 | 3.0 % | 100.0 % | 6/23 | 23/23 | 7/17 | 17/17 | 14/14 | 14/14 | 3 | 43 | 90 | policy: free |
| case-07 | 25.2 | 4.3 % | 99.5 % | 4/23 | 23/23 | 7/19 | 19/19 | 6/10 | 10/10 | 3 | 48 | 90 | policy: free |
| case-08 | 24.4 | 6.8 % | 97.5 % | 6/23 | 23/23 | 8/19 | 19/19 | 5/7 | 7/7 | 8 | 48 | 90 | policy: free |
| case-09 | 18.4 | 3.7 % | 96.2 % | 13/23 | 23/23 | 4/8 | 8/8 | 15/24 | 24/24 | 6 | 36 | 90 | policy: free |

Aggregates (all nine sessions, all measurements real): anchors recalled by the normal arm
62/206 (30 %) against 206/206 (100 %) by the policy arm; corrections retained 58/140 (41 %)
against 140/140; critical evidence 108/152 (71 %) against 152/152; fabrications 45 against
**0**; mean keep ratio 0.035 against 0.946; sessions passing the continuation-readiness
metrics 0/9 against **9/9** — a metric verdict (the five objects above), not a test of
actually restarting the sessions and continuing the work live; no live continuation study
has been run.

## Table 2 — anatomy of case-01 (the 75.6 % that survived still scores)

A reader asked why the policy arm keeps only 75.6 % of an audit session and still scores
full marks. This table is the answer: of the 94 paired tool calls the verifier proposed to
prune, the policy reinstated every final result of each command line (invariant I3) and
every call carrying goal/correction/issue entities (I2); what was actually pruned is
superseded re-runs of identical commands and coordination traffic (waits, messages) —
duplicates whose newest revision is kept, and nothing that a continuation would cite.

| tool category | calls | kept | pruned (duplicates + coordination) |
|---|---|---|---|
| `exec` | 79 | 31 | 48 |
| `wait_agent` | 5 | 0 | 5 |
| `wait` | 4 | 2 | 2 |
| `list_agents` | 3 | 1 | 2 |
| `send_message` | 2 | 0 | 2 |
| `followup_task` | 1 | 0 | 1 |
| **total** | **94** | **34** | **60** |

Of the 34 kept, 31 were reinstated by the policy against the verifier's drop
recommendations. The pruned 60 contained no goal, correction, issue-memory or critical
entity — hence a lower keep share with a higher keep of the things that matter.

## Case 10 — the capacity wall, and windowed compaction

The nine tables above measure *what survives compaction* (the retention dimensions defined
in the protocol — not a proof of strict losslessness; see the terminology note under Arms).
A tenth case
measures *capacity* — how large a session may grow before compaction itself gives up. The
fixture is a frozen, read-only pre-compaction snapshot of a production session (3012
messages, 2680 paired tool calls) whose conversation skeleton alone needs ~162k tokens
while the classifier's per-request state budget is 25k.

| assertion | result |
|---|---|
| unwindowed single-request path | fails exactly as the library documents: `history too large for Jev (~161939 tokens after truncation, limit 25000)` |
| windowed production path | **56/56 windows classified, 0 refused**; 65 requests; per-request state 12468–24647 tokens — every request inside the 25000 budget |
| decision coverage | **2680/2680** paired calls received exactly one keep/drop decision — no dangling, no doubled, no out-of-window decision |
| pass criteria | structural invariants only — the remote verdicts are probabilistic, so asserting exact per-call label reproduction across runs would make the regression flaky |
| plan review | the design was put to the verifier itself before implementation: 7 questions × 3 reps, unanimous (read-only fixture, dry-run only, structural criteria) |

The case runs inside the benchmark harness as `--mega` and is emitted by `npm run data`
into `docs/data/bench-results.json → capacity` (numeric fields only).

## Reproduce

```sh
npm run data    # build docs/data/bench-results.json from the local corpus (never distributed)
npm run charts  # regenerate the three figures from the data file
npm run verify  # privacy gate: scans the distribution for leaked identifiers
```

`npm run data` reads the private corpus through `JEV_BENCH_CASES`; without the corpus it is
a no-op on the published numbers (the committed data file remains the released artifact).

## Privacy — what this repository never contains

- session content, record contents, or excerpts thereof, of any kind;
- session identifiers, local file names, working-copy paths, drive letters;
- git hashes, commits, or tree objects of private repositories;
- project names of the author's private workstreams;
- API keys, bearer tokens — the verifier's blocklist contains their signatures;
  the key is read from the environment, used only for the classification request to the
  user's own TypeSafe endpoint over TLS, and never written to disk by this software.

The `npm run verify` gate exits non-zero on any of the above; the distribution is built
only from a clean scan.

## Addendum — v1.2 `--externalized` evaluated and stopped at P0 (2026-09-26)

The outcome-subsumption idea (drop exploration rows whose fact-value a surviving conclusion
row already covers, or whose conclusion is externalized to a skill) was measured before any
implementation, on the six archived study cases plus an additional sample of three sessions
(one R4-classified session and two R1-classified subagent sessions): under the strict
token-coverage rule the deletable pool is **0.1–3.0 % of store bytes** (independently
recomputed upper bounds agree), far below the pre-registered 30 % go threshold — the plan's
own kill criterion triggered and no code was shipped. Two by-products of the evaluation did
land: the judgement-payload fold now includes `metadata.display` even when `state.output`
is present (previously console-family rows with both fields could hide their display from
the classifier) — within the same 4096-char payload cap; the residual truncation blind spot
(rows whose display full text still does not reach the classifier payload: 154/122/87
across three R2 cases) is recorded as a known limitation. The sealed-set reconstructability
claim is explicitly conditioned on
backup content verification, ledger write success, and an executed end-to-end restore test
(none of which the current build performs — the claim is stated as conditional, not
absolute). Full method and raw figures are withheld locally under the privacy gate.

## Addendum 2 — coverage correction and the outcome-trim mode (2026-09-26, rounds 9–10)

A round-9 audit found that the R2 comparison figures above were produced by a benchmark
that classified only **6.0 / 11.6 / 15.2 %** of the three R2 sessions' paired calls (the
clamped-corpus harness) while accounting the whole store: they are partial-coverage
reductions, not a policy ceiling — the "10–15 % floor" wording is retracted. The same
audit corrected two measurement defects (a line-grouping bug that always reported zero
non-last rows, and a mixed-encoding denominator) and re-attributed the retention stages
from the post-policy decision state (I3 10/22/19, I2 0/11/13 across R2A/B/C — the
earlier "pins = 0" had measured the wrong stage). A real sub-task drill on an isolated
copy of one R2 session: the new opt-in outcome-trim mode (user-declared scope,
plan-hash bound, verified backup, prepared ledger, one atomic transaction, record-level
byte-verified restore) archived 151 superseded exploration rows (0.77 MiB; session
parts 13.54 → 12.77 MiB) with 67 rows retained under printed reasons, and restored all
218 tracked rows byte-identical with zero conflicts. Live continuation quality remains
NOT_RUN; the full-coverage classification study (~175 requests) awaits an approved
budget. Aggregate/corpus identifiers stay withheld under the privacy gate.
## Addendum 3 — full-coverage classification study (2026-09-26, round-11)

The partial-coverage caveat above is now closed by measurement: classifying the FULL
transcripts of the three R2 sessions through the production windowed path (175 requests,
~4 minutes) yields, under the corrected v1.1 policy — **R2A 27.80→18.69 MiB (−32.8 %),
R2B 22.91→14.91 MiB (−34.9 %), R2C 11.43→9.21 MiB (−19.5 %)** — with the policy pinning
I3 148/117/142 and I2 1072/696/726 evidence rows respectively. Two consequences: (a) the
earlier "R2 10–15 %" figures were an artefact of partial coverage, now retracted;
(b) at full coverage the I2 entity-mention pins reinstate hundreds of rows and become
the dominant brake — which is exactly what the opt-in outcome-trim mode addresses (user-
declared scope, per-item replaced_by, verified backup + prepared ledger + atomic
transaction, byte-verified record-level restore). On isolated copies of the same
sessions the outcome-trim mode archived **52.3 %→55.4 %** (R2A, multi-topic declared
scope plus the Tier-2 dead-end declaration) and **11.1 %→13.9 %** (R2C) of part bytes;
the third session is a derived (subagent) session and is refused by design. Restore
verification: all tracked rows byte-identical, zero conflicts; sentinel rows untouched.
Live continuation quality: still NOT_RUN.
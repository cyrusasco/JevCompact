# Evidence

Every claim in the README is backed here: the protocol, the numbers, the figures and the
reproduction commands. All data are from a benchmark run of nine real sessions and all
measurements are real, where relevant. The source sessions are private archives of the
author's machine; **nothing of their contents is distributed with this repository** — this
document quotes counts only. The CI gate (`npm run verify`) scans every file shipped and
rejects the distribution if any identifier of the corpus leaks.

## Protocol

- **Corpus.** Nine archived agent sessions, 18.4–76.7 MiB (see `docs/data/bench-results.json`).
- **Same input both arms.** Each session is compacted from an identical clamped view: the
  host's own compaction boundary is honoured, the live history is windowed 40 % head /
  60 % tail and oversized messages are sliced at the same offsets for every arm.
- **Arms.** `normal` — the stock LLM-summary engine (print mode, sonnet-class model, the
  summarising instructions the harnesses hand out). `Jev + lossless policy` — the shipped
  configuration: per-paired-tool-call keep/drop decisions by the Jev verifier (threshold
  0.6) with the lossless policy (`lib/policy.mjs`) on top.
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
**0**; mean keep ratio 0.035 against 0.946; handover-free verdicts 0/9 against **9/9**.

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

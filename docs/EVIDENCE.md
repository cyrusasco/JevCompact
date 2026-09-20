# Evidence — the three-round arm-to-arm benchmark

## Method

Nine private archived sessions (Codex desktop rollouts, 18–77 MiB; the same corpora are
distributed nowhere with this repository — only their measurements) were compacted three ways
under an identical protocol (bench/bench.mjs, protocol v2):

1. **Same input.** The host's own last `compacted` boundary is honoured; the live history is
   clamped to an identical 40 % head / 60 % tail window, oversized messages sliced at the
   same offsets for every arm.
2. **Arms.**
   *normal* — the stock LLM-summary engine (Claude Code print mode, sonnet-class model, the
   same instructions the harnesses hand out to their summariser);
   *Jev bare* — `compactMessages` (keep-threshold 0.5) without the policy;
   *Jev + policy* — the shipped default: threshold 0.6 + `lib/policy.mjs` (I1/I2/I3,
   `--pin-last=critical`).
3. **Objects of measurement** (scored against the input, not against each other — there is
   no ground truth but the input itself):
   - **anchors** — high-value strings (paths, filenames, hashes, numbers-with-units, CJK task
     sentences) mined from the *user/assistant text* that must survive verbatim;
   - **corrections** — user messages matching the correction patterns (fix|stuck|wrong|fail|
     retry|… | 修正|重試|搞唔掂|…): the rounds of a debug loop;
   - **failure causes** — assistant clauses explaining why an attempt failed
     (because|due to|…|因為|由於|係因為|…);
   - **critical evidence** — the last result of each command line whose output matches the
     critical patterns (test tally, commit hash, error, build result);
   - **fabrications** — entities present in the arm's output but never in the input
     (hallucinations caught, counted);
   - **HANDOVER-FREE** — the verdict: all of the above ≥ 95 % and zero fabrications, i.e. a
     fresh context holding only the pruned session continues without a handover document.

## Results

| # | session | domain | arm | compression | anchors | corrections | critical | fabric. | HANDOVER-FREE |
|---|---|---|---|---|---|---|---|---|---|
| 1 | c1-a0581e 76.7 MiB | delegated-authority audit | normal | 0.024 | 9/22 | 6/9 | 22/28 | 9 | no |
|   |                   |                               | Jev bare | 0.230 | 22/22 | 9/9 | 1/28 | 0 | no |
|   |                   |                               | **policy** | **0.756** | **22/22** | **9/9** | **28/28** | **0** | **YES** |
| 2 | c2-a0831d 43.6 MiB | WhatsApp bridge, final verify | normal | 0.025 | 6/23 | 7/17 | 12/14 | 5 | no |
|   |                   |                               | Jev bare | 0.297 | 23/23 | 17/17 | 1/14 | 0 | no |
|   |                   |                               | **policy** | **0.998** | **23/23** | **17/17** | **14/14** | **0** | **YES** |
| 3 | c3-a0829a 31.7 MiB | ← fork twin of 2 | normal | 0.018 | 4/23 | 5/17 | 6/15 | 4 | no |
|   |                   |                               | Jev bare | 0.315 | 23/23 | 17/17 | 1/15 | 0 | no |
|   |                   |                               | **policy** | **0.929** | **23/23** | **17/17** | **15/15** | **0** | **YES** |
| 4 | d1-a082fe 31.0 MiB | WhatsApp bridge media recovery | normal | 0.032 | 8/23 | 6/17 | 15/18 | 4 | no |
|   |                   |                               | Jev bare | 0.249 | 23/23 | 17/17 | 2/18 | 0 | no |
|   |                   |                               | **policy** | **0.950** | **23/23** | **17/17** | **18/18** | **0** | **YES** |
| 5 | d2-a0831b… 31.0 MiB | ← second run, different ordering | normal | 0.037 | 6/23 | 8/17 | 13/22 | 3 | no |
|   |                   |                               | Jev bare | 0.216 | 23/23 | 17/17 | 1/22 | 0 | no |
|   |                   |                               | **policy** | **0.952** | **23/23** | **17/17** | **22/22** | **0** | **YES** |
| 6 | d3-a061e5 26.4 MiB | parent-lineage session | normal | 0.030 | 6/23 | 7/17 | 14/14 | 3 | no |
|   |                   |                               | Jev bare | 0.364 | 23/23 | 17/17 | 2/14 | 0 | no |
|   |                   |                               | **policy** | **1.000** | **23/23** | **17/17** | **14/14** | **0** | **YES** |
| 7 | e1-a08321 25.2 MiB | WhatsApp bridge fork 3 | normal | 0.043 | 4/23 | 7/19 | 6/10 | 3 | no |
|   |                   |                               | Jev bare | 0.600 | 23/23 | 19/19 | 2/10 | 0 | no |
|   |                   |                               | **policy** | **0.995** | **23/23** | **19/19** | **10/10** | **0** | **YES** |
| 8 | e2-a08323 24.4 MiB | ← fork 4 | normal | 0.068 | 6/23 | 8/19 | 5/7 | 8 | no |
|   |                   |                               | Jev bare | 0.621 | 23/23 | 19/19 | 1/7 | 0 | no |
|   |                   |                               | **policy** | **0.975** | **23/23** | **19/19** | **7/7** | **0** | **YES** |
| 9 | e3-a09f5ba1 18.4 MiB | team of agents (orchestration) | normal | 0.037 | 13/23 | 4/8 | 15/24 | 6 | no |
|   |                   |                               | Jev bare | 0.368 | 23/23 | 8/8 | 3/24 | 0 | no |
|   |                   |                               | **policy** | **0.962** | **23/23** | **8/8** | **24/24** | **0** | **YES** |

### In numbers (means over the nine sessions)

| arm | anchors | corrections | critical | fabrications | compression | HANDOVER-FREE |
|---|---|---|---|---|---|---|
| normal (LLM summary) | 62/206 — 30 % | 58/140 — 41 % | 108/152 — 71 % | 45 | 0.035 | 0/9 |
| Jev bare | 206/206 — 100 % | 140/140 — 100 % | 14/152 — **9 %** | 0 | 0.362 | 0/9 |
| Jev + policy | 206/206 — 100 % | 140/140 — 100 % | 152/152 — 100 % | 0 | 0.946 | **9/9** |

### Reading

- The summariser compresses hard (0.035 kept) and loses in detail: two thirds of the exact
  facts, three fifths of the correction rounds, and it manufactures — from whole cloth — 45
  entities that were never in the source.
- The bare classifier is lossless where it has no choice (it never rewrites) but drops the
  evidence wholesale: 91 % of the critical final results pruned.
- The policy trades ratio: safety first. Compression cost on debug-loop sessions is real
  (0.9+ kept) — the loop *is* the content. Where the session is plain chat, the bare
  arm's ratios still apply and prune freely.

## Reproducing

`node bench/bench.mjs --case <id> --arms both [--policy]` with the corpus under
`bench/cases/` (private; the table above is the distributed record).

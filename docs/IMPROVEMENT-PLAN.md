# Improvement plan

How JevCompact came to be the way it is: the two failure modes the benchmark exposed, the
consultation with the Jev verifier that settled the design, and the policy that answers
them. All measurements are real, where relevant; the nine sessions are described in
`EVIDENCE.md`, and the numbers quoted here are read from the same file.

## 1. The problem

Long agent sessions outgrow the context window. The stock remedy — hand the history to an
LLM and ask for a summary — is lossy in three measurable ways, all demonstrated in the
corpus (Table 1 of `EVIDENCE.md`):

- **loss of detail** — the exact facts go first: commit hashes, test tallies, file paths,
  version strings; the arm recalled 62/206 anchors against 206/206 for the policy arm;
- **loss of the goal** — the task statement survives paraphrased, and the paraphrase drifts:
  on a debug-loop session (case-09) the standing instructions — that the interface must be
  replicated in full — survived only as an aside, and eight failure-cause records
  (why an attempt failed) were wholly dropped, so the next round cannot learn how to avoid
  repeating the fault;
- **invention** — 45 entities (paths, hashes, tallies) appear in the summaries that were
  never in the sessions: the summariser manufactures facts to fill the gaps.

The bare keep/drop classifier fixes the first and third (it never rewrites text), but
leaves the second open: by its own judgement it prunes superseded re-runs and — worse —
the final result of a command line, the very evidence a continuation cites: 108 of 152
critical results were dropped, and the handover document returned.

## 2. The consultation

Eleven questions were put to the Jev verifier, three answers each, the median taken
(`docs/jev-consult.json` carries the raw medians of the shipped configuration run):

| # | proposition | median | verdict |
|---|---|---|---|
| r1 | the goal statement must be preserved verbatim | 0.94 | agreed |
| r2 | user correction rounds are high-value | 0.94 | agreed |
| r3 | failure-cause records are high-value | 0.95 | agreed |
| r4 | dropping a command's last result causes hallucination | 0.81 | agreed |
| r5 | a summary alone suffices to continue a 20-round debugging session | 0.03 | denied |
| r6 | a classifier may rewrite user text to save space | 0.07 | denied |
| r7 | which single measure most raises the chance of no handover | pinEvidence | weak preference, confidence 0.25 |
| r8 | cost of pinning every final result of every command line | 0.95 / 10 | high — gate the pin |
| r9 | a policy over the classifier can make handover unnecessary | 0.86 | agreed |
| r10 | the last-result pin should apply only where the result carries critical evidence | 0.75 | agreed |
| r11 | preferred regime | pinAll | contrary, weak (0.59); r8 and r10 outvote it — ship `critical`, keep `always` behind a flag |

The deliberation: r7 prefers the evidence pins, r8 and r10 caution against pinning every
result of every group, and the decision is recorded in `lib/policy.mjs` as shipped.

## 3. The policy

Three invariants, checked on every run (see the code, and the figures):

- **I1** user text is classified, never rewritten — the byte stream that arrives is the
  byte stream that is kept;
- **I2** a call carrying an entity of the goal, of a correction round, or of a
  failure-cause record is reinstated whatever the classifier proposed — the call is
  entered again in the kept set;
- **I3** of every group of identical calls (the same command line, keyed by tool and
  arguments) the last result is kept where it matches the critical patterns (tallies,
  errors, hashes, build verdicts).

Everything else is left to the verifier's judgement: superseded re-runs of the same probe,
stale progress bars, duplicate listings of a directory that was listed again — the
duplicates are dropped and the originals are retained once, in order.

## 4. The result

Nine sessions, three rounds of the benchmark, both arms measured against the input:
`handover-free` on 9 of 9 for the policy configuration, with all six dimensions at full
marks and zero fabrications; the summarising configuration passes 0 of 9. The price is
the keep ratio (mean 0.946 against 0.035): on sessions dominated by a correction loop the
policy keeps more and prunes less — it keeps what matters, which is the point.

## 5. Read this first

- `EVIDENCE.md` — the measurements, the figures, the reproduction commands;
- `lib/policy.mjs` — the three invariants in 180 lines, dependency-free;
- `skills/jevcompact/SKILL.md` — the agent-facing procedure, dry run before apply;
- `tools/verify-clean.mjs` — the gate that keeps the corpus private: it scans the
  distribution and fails the build if any identifier of the source sessions is found.

# JevCompact

**Lossless session compaction for LLM agents — optimized for Chinese.**

Long agent sessions eventually exceed the model's context window (and the proxy's
request-size limit — 413 "Payload Too Large" is the usual first sign). Every mainstream
harness (Claude Code `/compact`, Codex auto-compaction, ZCode compaction) resolves this the
same way: hand the history to an LLM and ask for a *summary*. The summary compresses ~95 % —
and silently paraphrases, distorts, and drops the facts you were relying on: the commit hash,
the test tally, the goal you set 20 rounds ago, the reason why attempt 17 failed. You then
find yourself maintaining a handover document per session to distribute the details the
summariser lost.

JevCompact takes a different approach: it **never rewrites text**. It asks the TypeSafe *Jev*
verifier one keep/drop decision per *tool call* (the bulk of any session is tool results —
superseded file reads, repeated commands, progress bars), and layers a **lossless policy** on
top that guarantees the parts that matter survive:

| policy rule (lib/policy.mjs) | guarantee |
|---|---|
| **I1** user text is classified, never rewritten | your instructions — in any language — come through byte-identical |
| **I2** calls carrying goal / correction-round / failure-cause evidence are force-kept | a 20-round debug loop keeps its plot |
| **I3** the last result of each command line is kept when it carries critical evidence (test tallies, commit hashes, errors, build results) | the continuation can still cite the evidence |

Measured on nine private archived sessions (details: `docs/EVIDENCE.md`):

| arm | anchors recalled | corrections retained | critical evidence kept | fabrications | mean compression | handover needed |
|---|---|---|---|---|---|---|
| LLM summary (the usual `/compact`) | 30 % | 41 % | 71 % | 45 | 0.035 | **yes, always** |
| Jev, bare classifier | 100 % | 100 % | **9 %** ⚠ | 0 | 0.362 | yes |
| **Jev + lossless policy** | 100 % | 100 % | **100 %** | **0** | 0.946* | **no — 9/9 sessions HANDOVER-FREE** |

\* on debug-loop-dominated sessions the policy keeps more — see
*Limitations and future work*: that is the price of losing nothing.

## Why it is optimized for Chinese

Text compaction by summarisation is lossy *for every* language, but worst for CJK: the
summariser tends to translate Cantonese/Traditional instructions into English and, in doing
so, normalises away the details — "批准套用及重開" becomes "approved to apply and reopen";
the 376/376 PASS is gone. JevCompact cannot paraphrase what it does not rewrite: **the policy
and the classifier only choose which messages to drop, never how to say them.** Its
correction/failure-detection patterns ship with Cantonese and Traditional-Chinese markers
(修改、重試、搞唔掂、錯晒、批准、由於、原因、係因為、導致 …) alongside the English ones, and the
default keep-threshold `0.6` was picked on a Cantonese benchmark corpus. Your 中文 stays
intact — 你啲字、句句保留。

## Install

Requirements: Node ≥ 22 (no runtime dependencies), and a TypeSafe API key
(<https://api.typesafe.ai>) — free tier available.

```sh
git clone https://github.com/cyrusasco/JevCompact.git
cd JevCompact
# key resolution order: --key= > $TYPESAFE_API_KEY > ./.env > ~/.claude/settings.json "env"
node bin/jevcompact.mjs --help
```

### Claude Code

```sh
# 1) the agent-facing skill
mkdir -p ~/.claude/skills && cp -r skills/jevcompact ~/.claude/skills/
# 2) optional: the MCP server (tools compact_messages / compact_jsonl, zero-dependency stdio JSON-RPC)
claude mcp add jevcompact -- node "<path>/JevCompact/lib/mcp-server.mjs"
```

### Codex CLI / Codex desktop

```md
<!-- ~/.codex/AGENTS.md -->
## Compaction — use JevCompact, not /compact
When a session nears the context limit, run:
  node <path>/JevCompact/bin/jevcompact.mjs <rollout.jsonl>            # dry run
  node <path>/JevCompact/bin/jevcompact.mjs <rollout.jsonl> --apply --in-place
Archives live under ~/.codex/archived_sessions; rollouts under ~/.codex/sessions.
Always read the printed decisions before passing --apply. A .pre-jev.bak is kept;
--restore <file> puts it back. Never compact a session whose subagents still run.
```

### ZCode

```sh
mkdir -p ~/.zcode/skills && cp -r skills/jevcompact ~/.zcode/skills/
# register the MCP server in ~/.zcode/cli/config.json → "mcp": { "servers": { "jevcompact": { … } } }
# host-only bonus: compact a live session directly from its database:
node bin/jevcompact.mjs --session <id|prefix|live>          # dry run
node bin/jevcompact.mjs --session <id|prefix|live> --apply  # in-place, verified backup first
node bin/jevcompact.mjs --session live --apply --min-reduction 0.02 --max-state-tokens 25000
# long sessions never fail "history too large": the host partitions the transcript into
# windows that each stay inside --max-state-tokens. A guarded refusal, or a plan whose
# reduction falls below --min-reduction, is a BENIGN skip (exit 0, nothing written) — not a failure.
```

## The local host — Jve Studio (Desktop GUI)

命令行之外，日常最舒服的姿势是用桌面圖示：**Jve Studio** — a zero-dependency local web
server (Node only, bound to `127.0.0.1:50505`, never anything else) that turns the browser
into the compaction control panel: Sync → Dry run → Compact → Restore, with a central
audit Log and a per-session context-window breakdown.

```sh
node bin/jevcompact.mjs studio install-desktop --autostart   # one command: Desktop icon + logon warm-up
node bin/jevcompact.mjs studio                               # or run the host in this terminal
node bin/jevcompact.mjs studio --remove-desktop              # take both back out
```

The icon starts the host **detached** — it outlives your terminal and outlives the agent
app itself, so you can compact an idle long-running session at any time without keeping
anything open. Re-clicking is idempotent (a second server copy exits quietly). Windows
launcher resolution follows the shell API, so a OneDrive-redirected Desktop is placed on
your real Desktop, not on the `%USERPROFILE%` dummy path.

| 步驟 | 圖 |
|---|---|
| 1 install once · 一行裝安裝 | ![install](docs/assets/studio-01-install.svg) |
| 2 double-click · 單擊啟動 | ![icon](docs/assets/studio-02-icon.svg) |
| 3 the panel · 控制面板 | ![panel](docs/assets/studio-03-ui.svg) |
| 4 the pipeline · 安全流水 | ![flow](docs/assets/studio-04-flow.svg) |

Full illustrated manual: **[docs/GUIDE.md](docs/GUIDE.md)** — every press, every
safety net (dry-run default, verified backup before write, liveness guards, benign
skips, windowed compaction for long sessions) explained end to end.

## Usage

```sh
# dry run (default: prints the decisions, writes nothing — safe on live files)
node bin/jevcompact.mjs session.jsonl

# write: canonical pruned form to session.compact.jsonl (input untouched)
node bin/jevcompact.mjs session.jsonl --apply

# rewrite the file in its own format (claude jsonl / codex rollout), backup + verify first
node bin/jevcompact.mjs session.jsonl --apply --in-place
node bin/jevcompact.mjs --restore session.jsonl    # from session.jsonl.pre-jev.bak

# tune the read
node bin/jevcompact.mjs big.jsonl --threshold 0.6 --keep 6 --head 300
node bin/jevcompact.mjs big.jsonl --pin-last always    # report-heavy sessions: max safety
node bin/jevcompact.mjs big.jsonl --no-policy          # bare classifier (see EVIDENCE.md ⚠)
```

Formats read: Claude Code project JSONL, Codex rollouts (session_meta / response_item /
compacted boundary honoured), ZCode model-io rollouts, inline `Message[]` JSON. The library
is in `lib/`; every routine in `bin/jevcompact.mjs` maps back to a documented option.

## v1.1 — opt-in passes, the round-2/3 corrections

Three explicit flags extend the same lossless contract (they only ever turn drop rows;
text is still never rewritten):

| flag | effect |
|---|---|
| `--dedup` | retained rows whose `(tool, normalized result)` collide with a LATER kept row drop out; the newest copy survives. Strong I2: every `policy:pin-*` row (final-state AND goal/correction/cause evidence) is exempt from all extra passes. |
| `--trim-carriers` | a row kept SOLELY as an entity carrier drops when every protected entity it mentions stays carried elsewhere; the carrier-selection scheme (rarity first, recency tie-break) is a SEPARATE, weaker guarantee audited on its own (A3). |
| `--bookkeeping` | clears stale `readFileState.content` bodies (only the newest snapshot per path is ever consulted); path/revisionId/mtime/size stay. Older bodies remain recoverable from the paired pre-apply backup (`.ledger.json` beside it carries the change sets). |

Round-2/3 audit corrections landed with v1.1: all byte accounting is **UTF-8**
(`Buffer.byteLength`) with the metric denominators declared per measure; the judgement
payload folds `metadata.display` (bounded at 4096 chars) so the console-family majority
of the payload is visible to the classifier; `A6` is split into **I2** (every policy pin
kept) and **I3** (last-of-group results kept); `A3` reports the protected-entity total
alongside the uncovered pair; the per-call decision **ledger** (`<backup>.ledger.json`,
schema 1: t ID → callID → part IDs, scores, `prior_reason` trail, SQL change sets, sha256)
is persisted on every new apply — runs predating it are aggregate-only (insufficient); the
reference arm is the **proxy summariser** (`claude -p --model sonnet`), not the platform
`/compact` itself, and its "fabricated" figure is a token-presence count.

Two-arm study, six archived sessions (two rounds, 6/6 guarantees green; store-level, MiB):

| case | class | raw | JevCompact v1.1 | reduction | anchors | fabricated | proxy summariser compression / anchors / fabricated |
|---|---|---|---|---|---|---|---|
| R1A | R1 | 36.02 | 13.88 | 61.5 % | 245/446 | 0 | 0.027 / 29/446 / 15 |
| R1B | R1 | 33.81 | 6.87 | 79.7 % | 363/441 | 0 | 0.038 / 39/441 / 11 |
| R1C | R1 | 12.49 | 4.25 | 66.0 % | 482/539 | 0 | 0.018 / 22/539 / 11 |
| R2A | R2 | 27.10 | 23.85 | 12.0 % | 89/216 | 0 | 0.024 / 14/216 / 9 |
| R2B | R2 | 22.35 | 19.93 | 10.8 % | 67/145 | 0 | 0.035 / 12/145 / 8 |
| R2C | R2 | 11.06 | 9.50 | 14.1 % | 128/180 | 0 | 0.033 / 25/180 / 11 |

The R2 extra-pass gain is measured 0 in all three cases — the base policy already owns
the reduction there; dedup/trim are complementary on ledger-dominant sessions (R1).
Full machine-readable bundles: `JevCompact-sessions-review-20260925-v3.zip`
(SHA-256 `014c175f8ad64ff83da46c3055a1f86780b722f039aa7edfd495c2ca8060aaa9`, 62 files:
10 sessions, 6 case ledgers + decision files + mapping, registry, reversibility check).

## The evidence

Everything the README claims is measured, and the measurement is published: nine archived
sessions (18–77 MiB, the author's own, shipped nowhere), two arms, six dimensions, all
figures from the data.

| document | contents |
|---|---|
| [`docs/EVIDENCE.md`](docs/EVIDENCE.md) | protocol, the nine-session table, the anatomy of the audit session, reproduction commands |
| [`docs/IMPROVEMENT-PLAN.md`](docs/IMPROVEMENT-PLAN.md) | the two failure modes, the eleven-question consultation, the three invariants |
| [`docs/jev-consult.json`](docs/jev-consult.json) | the consultation in full — questions, repetitions, medians |
| [`docs/data/bench-results.json`](docs/data/bench-results.json) | the data file every figure is built from |

![Fig. 1 — context kept after compaction, nine sessions](docs/assets/fig-1-keep-ratio.svg)

![Fig. 2 — continuation-readiness score, max 90](docs/assets/fig-2-scores.svg)

![Fig. 3 — anatomy of the audit session: what was pruned, what the policy reinstated](docs/assets/fig-3-audit-anatomy.svg)

Figures are dependency-free SVG generated from the data file — `npm run data && npm run
charts` regenerates them; `npm run verify` is the gate described below.

## Privacy — what ships, and what never leaves your machine

JevCompact is built so that nothing of your sessions can travel with it:

- **nothing of a session is ever sent anywhere but the classification request.** The only
  network operation in the whole package is the keep/drop query to *your own* TypeSafe
  endpoint over TLS, authenticated by *your own* key (`--key=`, `$TYPESAFE_API_KEY`,
  `.env`, `~/.claude/settings.json`); the key is never logged, never written to disk, never
  echoed in a report. No telemetry, no update checks, no third-party calls.
- **the repository itself is the proof.** The corpus — the nine sessions behind every
  figure — lives on the author's machine and is distributed with nothing. The published
  documents quote counts only. The CI gate `npm run verify` scans the entire distribution
  for identifiers of the corpus (session ids, local paths, drive letters, commit hashes,
  project names, key material, pasted conversation text) and fails the build on its first
  finding — so a leak is not merely discouraged, it is unbuildable.
- **on your machine, compaction is reversible by construction.** Dry run is the default;
  `--apply` never touches the input unless `--in-place`, and `--in-place` keeps a
  verified `.pre-jev.bak` that `--restore` puts back.

## Limitations and future work

- **Compression vs. losslessness.** On sessions dominated by a long correction loop, the
  policy raises the reduction ratio from ~0.36 down to ~0.95 kept: everything the loop is,
  the loop keeps. Plain Q&A sessions still compact hard (~0.2–0.5 kept).
- **Calibration.** The classifier is trained mostly on English agent trajectories; for CJK
  sessions the shipped default `--threshold 0.6` is the sorted order of safety. Run dry
  first, read the decisions.
- **Capacity.** The host path (`--session`) partitions the transcript into windows sized
  under the classifier's per-request state budget, so session length is no longer bounded
  by the 25k-token state wall (measured: case 10 in `docs/EVIDENCE.md`). The file-format
  paths still run against the single-request budget and raise "history too large" beyond it.
- **Roadmap:** session-type detection (auto `--pin-last`), semantic final-report pinning by
  querying the verifier per call, more localization (simplified-Chinese patterns are in the
  repository's issue list, pull requests welcome — see `docs/EVIDENCE.md` for the
  benchmark spec before contributing).

## License

MIT. `lib/dist/` derives from [fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction)
(MIT); see `NOTICE.md` and `lib/dist/LICENSE.upstream`.

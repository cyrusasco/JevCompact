---
name: jevcompact
description: Compact an over-long LLM session without losing information — use when a session nears the model context limit, the API returns 413/Payload Too Large, before handing over a task to a fresh session, or instead of /compact on any long conversation of sessions. Lossless: prunes stale tool results via the Jev verifier plus a policy layer, never rewrites text, Chinese-safe.
---

# Skill: JevCompact — lossless session compaction

When the user asks to compact, shrink, rescue or handover a long session — or a session just
exceeded the context window — run JevCompact instead of the harness's native summarising
compaction. Summarisation is lossy: it drops anchors (paths, hashes, tallies), paraphrases
instructions, and can hallucinate. JevCompact classifies tool traffic and prunes it;
conversation text is classified, never rewritten.

## Where things are (paths)

```
REPO=~     # the cloned JevCompact repository
node $REPO/bin/jevcompact.mjs      # the CLI ("jvc" when npm linked)
node $REPO/lib/mcp-server.mjs      # optional MCP server for the agent itself
```

Formats read: Claude Code JSONL (`~/.claude/projects/*/*.jsonl`), Codex rollouts
(`~/.codex/sessions/**`, `~/.codex/archived_sessions/**`), ZCode model-io rollouts
(`~/.zcode/cli/rollout/*`), inline `Message[]` JSON.

## Standard workflow

1. **Locate the file.** If the harness stores sessions in a database (ZCode), prefer host
   mode: `--session <id|prefix|live>`. Otherwise find the transcript file.
2. **Dry run first — always.** No options write anything until you read the printed
   decisions:
   ```sh
   node $REPO/bin/jevcompact.mjs <file>.jsonl
   ```
   Read the `decisions:` line (keep/drop counts), the `policy pins` (I2 goal/correction/
   cause pins, I3 last-of-group critical pins), and the decision list itself. If the plan
   looks aggressive, raise `--threshold` (0.6 shipped default; 0.7 conservative).
3. **Choose the mode by session type:**
   - plain question-and-answer session → default (`--pin-last=critical`) prunes hard, plays go;
   - debug-loop / audit / report-delivery session → `--pin-last always` (maximum safety;
     the policy keeps the evidence the continuation will cite);
   - never pass `--no-policy` unless the user explicitly asks for the bare classifier.
4. **Apply.** Write to a new file (input left untouched):
   ```sh
   node $REPO/bin/jevcompact.mjs <file>.jsonl --apply
   ```
   or rewrite the live file in its own format (a `.pre-jev.bak` copy is made and verified;
   on any parse error of the output, the backup is restored automatically):
   ```sh
   node $REPO/bin/jevcompact.mjs <file>.jsonl --apply --in-place
   ```
5. **Report to the user** the reduction ratio and the policy pins, then tell them the session
   can continue without a handover document. Verify: ask the continued session to recall
   the task's goal, the last correction, and the latest test tally — all three must be
   quotable verbatim.

## Options (summary)

| option | meaning | default |
|---|---|---|
| `--threshold=T` | keep-probability cutoff for the classifier | `0.6` |
| `--keep=N` | most recent messages always pinned | `6` |
| `--head=N` | characters preserved when a pruned result is truncated | `300` |
| `--pin-last=critical\|always` | I3 pin scope (see policy) | `critical` |
| `--no-policy` | bare classifier (not recommended) | off |
| `--goal=TEXT` | what the session was about, for the classifier | — |
| `--apply` | write output (dry run by default) | dry run |
| `--in-place` | rewrite the input in its own format (+ `.pre-jev.bak`) | canonical copy |
| `--restore=<file>` | restore from `<file>.pre-jev.bak` | — |
| `--key=KEY` | TypeSafe API key (else `$TYPESAFE_API_KEY`, `.env`, `~/.claude/settings.json`) | — |

## Chinese notes (中文说明)

- 压缩器**从不改写任何对话文本**：只分类、只删剪工具记录。粤语／繁体指令与关键证据原样保留，
  「376/376 PASS」「批准套用」「係因為……導致……」之类不会被 paraphrase。
- 策略层内置中文与英文的修订、错误指令模式（修正、重試、搞唔掂、錯晒、批准；
  因為、由於、原因、係因為、導致 …），因此对中文会话同样无损。
- 中文会话请保持 `--threshold 0.6`（默认）或更高，先 dry run 审阅决策，再 `--apply`。
- 出错时可用 `--restore` 从 `.pre-jev.bak` 还原。

## Caveats (read this first)

- Do **not** compact subagent/derived sessions — they belong to their parent; the ZCode
  host mode refuses them by design.
- Do **not** compact a session while its turn is running (the host mode checks this and
  refuses; the file mode cannot).
- The classifier's training is English-heavy; the shipped defaults are sorted for CJK
  safety, not for maximum compression.
- Exit codes: 0 success, 1 usage error, 2 key/API error, 5 host transaction error.

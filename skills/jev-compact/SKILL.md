---
name: jev-compact
description: Compact long LLM agent sessions without losing context — one-click via desktop app or CLI. Reduces context to ~20% while keeping user words, corrections, and critical evidence 100% intact.
---

# JevCompact — Session Compaction Skill

## What it does

Long sessions hit the context window limit (~166K for most models, ~833K for GLM-5.3).
Native auto-compact replaces history with an LLM summary that paraphrases and loses facts.
JevCompact instead: keeps your words verbatim, asks a verifier per tool call what to keep,
and slims the rest. Context drops to ~20-25%. Everything is reversible.

## When to use

- Session context > 50% of the window
- User says "compact this session" / "上下文太長" / "快爆了"
- Before a long task that will generate many tool calls
- After a milestone (archive the exploration, keep the outcome)

## Quick start

### Desktop app (recommended)

```bash
# Start the daemon (keep it running)
node lib/jve-studio-app.mjs &        # macOS/Linux
npm run desktop                       # Windows
```

Then open **http://127.0.0.1:50505**:
1. **🔄 Sync** → lists all sessions
2. Pick a session from the dropdown
3. **🗜 Compact** → confirm → done (~30 seconds)

### CLI (no daemon)

```bash
# See what would be compacted (dry run)
node bin/jevcompact.mjs --session <session-id>

# Actually compact (with context-slim to ~20%)
node bin/jevcompact.mjs --session <session-id> --apply --context-slim

# Compact the most recent session
node bin/jevcompact.mjs --session live --apply --context-slim
```

## What the pipeline does (automatically, in order)

| Stage | What | Guarantee |
|---|---|---|
| 1. Jev classification | Verifier decides keep/drop per tool call | 3-rep median, threshold 0.6 |
| 2. Policy pins | I2: goal/correction/cause evidence force-kept | Your corrections always survive |
| 3. I3 critical | Last result per command line, if CRITICAL | Test results, commits, errors kept |
| 4. Outcome-trim | Declared-scope exploration archived | Method + outcome + limits kept |
| 5. Context-slim | Platform noise → notes; old inputs → signatures | User words 100% untouched |
| 6. Input-slim | Write/Edit/Bash old code → 120-char signatures | Biggest single reduction |

## What is NEVER touched

- **User text** — every word you wrote stays byte-identical
- **Policy-pinned rows** — I2/I3 evidence rows
- **Recent messages** — last 2 messages kept whole
- **Unfinished tasks** — running/pending rows kept

## What IS cleared (recoverable from backup)

- Platform noise (TodoWrite reminders, task notifications, old summaries)
- Old Write file contents (the file is on disk; context doesn't need 20 old versions)
- Old Edit old_string/new_string pairs (superseded diffs)
- Old Bash inline scripts (output already noted; command slimmed to 120 chars)
- Old tool results beyond head-300 (anchor index preserves file paths)

## Restore (undo any compact)

```bash
# Find the ledger
ls ~/.zcode/backups/*.outcome-ledger.json

# Restore from a specific compact
node bin/jevcompact.mjs outcome --restore --ledger=~/.zcode/backups/<name>.outcome-ledger.json
```

Every compact creates a verified backup + decision ledger. Restore is record-level,
byte-verified, and never touches other sessions.

## Key options

```bash
--apply                  # actually write (default is dry run)
--context-slim           # include the ~20% context reduction stage
--dedup                  # collapse identical tool results
--trim-carriers          # release rows kept solely as entity carriers
--bookkeeping            # clear stale file-state snapshots
--trim-reasoning         # delete reasoning scaffolding of old messages
--keep=6                 # keep scaffolding of newest N messages
--threshold=0.6          # Jev keep/drop threshold
--min-reduction=0.05     # skip if reduction below 5%
--max-state-tokens=25000 # per-window budget for long sessions
```

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| "no API key" | Key not in .env | `echo "TYPESAFE_API_KEY=..." > .env` |
| "session looks live" | Session is actively running | Wait 2 min idle, retry |
| "nothing worth compacting" | All rows are policy-pinned | Context-slim still runs (gate fix round-24b) |
| Desktop app won't open | Daemon died | `node lib/jve-studio-app.mjs &` or retry the .bat |
| Context % didn't change | Display shows last request (stale) | Send a new message; or check Size → "→ 壓縮後" |

# Jve Studio — pictorial quick start

The local web GUI that drives JevCompact. One double-click from the Desktop starts a
zero-dependency Node server (bound to `127.0.0.1:50505`, nothing else), and your browser
becomes the control panel for every compaction: **Sync → Dry run → Compact → Restore**.

![install the icon](assets/studio-01-install.svg)

## Prerequisites

- Node ≥ 22 (the `node:sqlite` built-in — same requirement as the CLI host mode).
- A TypeSafe API key, resolved in this order: `$TYPESAFE_API_KEY` → `./.env` →
  `~/.claude/settings.json` (`env` block). The key is read at request time and never
  written to disk by the Studio; nothing ever leaves the machine except the classifier
  requests themselves (the same ones the CLI makes).

## Step 1 — install the Desktop icon (once)

```sh
cd <your JevCompact checkout>
node bin/jevcompact.mjs studio install-desktop            # icon only
node bin/jevcompact.mjs studio install-desktop --autostart  # + hidden server at logon
```

The installer resolves the *real* Desktop (on Windows that includes a OneDrive-redirected
Desktop, discovered through the shell API — not `%USERPROFILE%\Desktop`), and drops:

| platform | artefact | effect |
|---|---|---|
| Windows | `Jve Studio.bat` on the Desktop | double-click → hidden detached server + browser |
| Windows `--autostart` | `JveStudio-Autostart.vbs` in the Startup folder | server is already up when you log in |
| Linux | `jve-studio.desktop` on the Desktop (+ `~/.config/autostart`) | same, via your DE |
| macOS | `Jve Studio.command` on the Desktop | double-click opens a Terminal running the server |

`--remove-desktop` takes every artefact back out. The generator embeds only your own
node binary and your own checkout path — nothing is phoned, nothing is shipped home.

## Step 2 — double-click, any time

![double-click the icon](assets/studio-02-icon.svg)

The server is **detached**: it survives closing the terminal, the agent app, or the
browser. Re-clicking the icon is idempotent — the launcher first probes the canonical
port; if a live server answers it just opens the browser, and if you ever race two
servers the second copy prints `this copy exits quietly` and leaves the port alone.

## Step 3 — the panel

![the panel](assets/studio-03-ui.svg)

1. Pick the **harness** from the dropdown (`zcode` / `claude` / `codex` / `prime`) and press
   **Sync** — the session table fills from your own local stores.
2. Press **Dry run** on a row: the full keep/drop plan is printed in the Log tab, the store
   is **not touched**. This is the default behaviour of every entry point in JevCompact.
3. Press **Compact** when the plan looks right. The button name is the only write path.
4. Press **Restore** on a compacted row to replay its newest verified backup, byte-for-byte.
5. The **Log** tab is the audit trail — every action, every guard, every benign skip, in one
   server-side ring that survives browser refreshes.

Clicking a row's **SIZE** cell opens the context-window breakdown (the same shape as the
agent app's own context panel: tokens, pruned markers, policy pins).

## Step 4 — what protects you

![the pipeline](assets/studio-04-flow.svg)

- **Dry-run by default** — every flow starts with a plan, never with a write.
- **Verified backup before write** — the snapshot is taken online, its integrity is
  checked, only then are rows pruned; the restore index records what belongs to what.
- **Liveness guards** — a session whose turn is still running, or whose rollout log was
  flushed less than two minutes ago, is skipped with a *benign* notice (exit 0). Wait,
  close the tab, retry. This is by design, not an error.
- **Nothing worth compacting** — when the lossless policy decides the session can shed
  less than the `min-reduction` floor, the press is again a *benign* skip: better a fat
  session than a pruned one.
- **Long sessions never fail "history too large"** — the host partitions the transcript
  into classifier-sized windows and remaps every verdict back onto the global rows.
- **Kept text is byte-identical** — the compactor never paraphrases; what survives is
  verbatim, which is why Chinese (and every other language) context survives intact.

## Fallback: no GUI, no problem

```sh
node bin/jevcompact.mjs studio                      # run the server in this terminal
npm run studio                                      # same
npm run desktop                                     # icon only, no autostart
node bin/jevcompact.mjs --session live --apply      # headless compaction of a live session
```

## Troubleshooting

| symptom | cause | remedy |
|---|---|---|
| browser opens but cannot connect | server not up | double-click the icon; check the Log tab of the first window you opened |
| `another copy already listens` in a console | you started the server twice | fine — the second exits quietly; use the first |
| a [Compact] press replies `skipped: … running turn` | liveness guard | wait ~2 minutes or close the session tab, press again |
| a [Compact] press replies `nothing worth compacting` | reduction below the floor | the session is genuinely lean; leave it alone |
| icon does not appear | redirected Desktop | re-run the installer; it resolves the Desktop through the shell API and prints where it wrote |

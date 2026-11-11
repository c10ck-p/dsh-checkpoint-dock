<p align="center">
  <img src="docs/preview-dark.png" width="900" alt="Checkpoint dock preview">
</p>

<h1 align="center">dsh-checkpoint-dock</h1>

<p align="center">
  <a href="README.md">简体中文</a> | <b>English</b>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/dsh-checkpoint-dock"><img alt="npm 0.1.0" src="docs/badge-npm.svg"></a>
  <img alt="DSH >= 0.2.2-rc.1" src="docs/badge-dsh.svg">
  <a href="LICENSE"><img alt="MIT License" src="docs/badge-license.svg"></a>
</p>

An IDE-style checkpoint dock for DeepSeek Harness. Every turn in which the agent changes files gets its own checkpoint above the composer, with **Keep, Undo, Redo, and Revert to here** built in.

DSH's built-in “edited N files” card tells you what a turn produced. This plugin is the part that lets you take it back.

## Highlights

- **Per-turn, per-file checkpoints**: each checkpoint stores only the files that turn actually changed — no conversation copies, no whole-workspace snapshots.
- **A complete undo path**: Keep → Undo → Redo → Revert to here. Accept a turn, go back to before it, reapply it, or roll all the way back to an older turn.
- **See the change in place**: expand a before/after diff inside the dock; file rows still open DSH's changes-review sidebar.
- **Resident, but quiet**: the dock sits above the composer by default. Turn residency off and it appears only while a turn has unhandled file changes.
- **Multiple sessions stay separate**: the overview in Settings groups checkpoints by DSH session title.
- **No git dependency**: no repository, no commit, and `git gc` cannot make old checkpoints unreachable. Writes that bypass DSH's file tools are found by scanning the workspace once at the start and once at the end of a turn — so shell commands, scripts, and editors land in the checkpoint too.
- **Native DSH styling**: buttons, menus, colors, and the settings page use DSH theme tokens.

## How it compares

> Information about similar tools comes from their public docs (as of Nov 2026). This is a mechanism comparison only; it does not evaluate implementations. Current reference implementations: `dsh-checkpoint-rewind` (workspace/config/session snapshots), `dsh-snapshot-manager` (whole-workspace snapshots and conversation rollback), `dsh-checkpoint-diff` (read-only diff on top of rewind). Names only, no links.

| Capability | This plugin | `dsh-checkpoint-rewind` | `dsh-snapshot-manager` | `dsh-checkpoint-diff` |
| --- | --- | --- | --- | --- |
| Scope | Files changed per turn | Workspace + config + session cursor | Whole workspace | No snapshots; reads rewind snapshots |
| Diff | Inline before/after | Tree diff in panel | Snapshot diff in panel | Any two checkpoints |
| Restore | Keep / Undo / Redo / Revert here | `/rewind`, selective restore | File rollback + conversation fork | Rollback (via rewind) |
| Conversation / config restore | No | Yes | Conversation | No |
| Git dependency | None | git or copy mode | None | Inherited from rewind |
| Best for | Day-to-day file edits | Whole three-state rollback | Broad snapshot rollback | Inspecting historical diffs |

Snapshot-style tools are a better fit when you need workspace, config, or session coverage. This plugin takes a different path: **small, fast, and file-focused**. No whole-workspace copy, no conversation fork, no config restore, no git. The trade-off is that it covers file contents only, not session state.

## Install

Requires DSH `>= 0.2.2-rc.1`. Published on npm: [dsh-checkpoint-dock](https://www.npmjs.com/package/dsh-checkpoint-dock).

From npm:

```powershell
dsh plugin --profile desktop add dsh-checkpoint-dock
```

From a local directory:

```powershell
dsh plugin --profile desktop add D:\path\to\dsh-checkpoint-dock
```

You can also pick the local bundle from the Plugins page. Refresh the page afterwards and the dock shows up.

The plugin ships two halves: Host code (`index.mjs`, `lib/`) and client code (`client/index.js`). **Restart DSH once after the first install or an upgrade** so the Host half picks up the new code; a page refresh only reloads the client half. If the dock disappears right after an upgrade, the Host plugin probably failed to import — check `$DSH_HOME/unlag-reload.log` (when dsh-unlag is installed) or the `checkpoint-dock` errors in the DSH log.

Uninstall:

```powershell
dsh plugin --profile desktop remove dsh-checkpoint-dock
```

Uninstalling leaves existing checkpoints in place; the data stays in `$DSH_HOME/edit-checkpoints/` until you delete it yourself.

## Usage

1. Let the agent modify files during a turn.
2. A checkpoint appears above the composer. Expand it to see the files and the diff.
3. Use **Keep / Undo / Redo / Revert to here** to act on that turn.
4. The welcome page shows no dock; once you send the first message the dock keeps a single collapsed row even if the turn changed no files, and expanding it says there are no checkpoints yet. To browse everything, open **Settings → Checkpoints → Overview**.

A turn settles its files when it ends: the workspace is scanned once at the start and once at the end, and every difference between the two scans is recorded — so a file written by a shell command, a script, or an editor shows up in the checkpoint just like one written by DSH's own file tools.

When residency is off, the dock appears only while a turn has unhandled file changes and hides again once they are handled. Settings are stored per browser and shared across DSH ports on the same machine.

Checkpoints are numbered in session order, and the overview groups them by DSH session title, so checkpoints from different conversations never blur together.

## Keep, Undo, and Redo

- Undo N restores the disk state from before the first write of turn N — not the state at the moment you clicked Keep. Keep itself does not modify files.
- Keeping the latest checkpoint also marks every earlier un-reverted checkpoint as kept.
- Once a later checkpoint is kept, earlier checkpoints cannot be undone individually, even if the two turns touched different files. Use **Revert to here** for a whole-range rollback.
- Undo / Redo / Revert verify each file's current hash first. If another tool or a manual edit changed the file, they report a conflict instead of overwriting it.
- Redo only works from the earliest undone checkpoint forward. A newer active checkpoint blocks it.
- Revert undoes every checkpoint after the target. Those records become undone and can be redone in order.

## Data and privacy

- Checkpoint data is stored in plain text under `$DSH_HOME/edit-checkpoints/` and includes the contents of changed files. Do not commit this directory or sync it to an untrusted location.
- `.env*`, private keys, and `.ssh/.aws/.gnupg` are skipped by default. This is a conservative filter, not encryption, and not a replacement for secret management.
- The turn-start/turn-end scan skips `.git`, `node_modules`, `.tmp`, and similar directories, caps a single file at 4 MiB, and stops at 4000 files or 32 MiB in total; a turn that exceeds the budget records only DSH file-tool writes.
- The per-file limit is 4 MiB. Larger files are recorded with approximate line counts and are excluded from safe undo.
- A damaged record file is renamed to `*.corrupt-<timestamp>` and isolated. Only that entry is lost; the rest of the session keeps working.
- Deleting a session in DSH does not delete its checkpoints. Settings → Checkpoints → Storage lists them as deleted-session data and lets you decide when to clean up.
- The Settings → Checkpoints → Config page can enable automatic cleanup and pick how many recent checkpoints to keep (10–200). When enabled, the oldest content is trimmed at the end of any turn that exceeds the limit; pinned checkpoints are never cleaned. The Storage tab only reports: total usage, record count, and a per-session usage pie.

## Limitations

- Only files inside the current workspace are handled.
- External writes are found by scanning the whole workspace, so a very large tree degrades: the turn that exceeds the budget records only DSH file-tool writes.
- Restores file bytes and permission bits; it does not restore mtime, directories, symlink targets, or `.git` metadata.
- Undo / Revert are overwrite-style restores: files created outside the reverted turn are not deleted.
- Cross-session protection is checked on Undo / Redo / Revert, not as a continuous file-edit lock. Two sessions can still write the same file concurrently; if the other session's write lands before this turn is sealed, this turn's after state may already contain it. Fully preventing that requires workspace-level write serialization.
- No whole-workspace snapshots, conversation rollback, or config rollback. Use a dedicated checkpoint/snapshot plugin for those.
- Checkpoints of deleted sessions are not reclaimed automatically; clean them up from Settings → Checkpoints → Storage. The cleanup skips records written in the last hour so a freshly created session is never touched.
- v1 records have no after content, so diff and redo are unavailable for them. There is no automatic migration.

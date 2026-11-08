<p align="center">
  <a href="README.md">中文</a> | <b>English</b>
</p>

<p align="center">
  <img alt="DSH >= 0.2.0" src="https://img.shields.io/badge/DSH-%3E%3D%200.2.0-4B67B4?style=flat-square">
  <a href="LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/license-MIT-4B67B4?style=flat-square"></a>
</p>

# dsh-checkpoint-dock

An IDE-style checkpoint dock for DeepSeek Harness. Every turn in which the agent changes files gets its own checkpoint above the composer, with **Keep, Undo, Redo, and Revert to here** built in.

DSH's built-in “edited N files” card tells you what a turn produced. This plugin is the part that lets you take it back.

## Highlights

- **Per-turn, per-file checkpoints**: each checkpoint stores only the files that turn actually changed — no conversation copies, no whole-workspace snapshots.
- **A complete undo path**: Keep → Undo → Redo → Revert to here. Accept a turn, go back to before it, reapply it, or roll all the way back to an older turn.
- **See the change in place**: expand a before/after diff inside the dock; file rows still open DSH's changes-review sidebar.
- **Resident, but quiet**: the dock sits above the composer by default. Turn residency off and it appears only while a turn has unhandled file changes.
- **Multiple sessions stay separate**: the overview in Settings groups checkpoints by DSH session title.
- **No git dependency**: no repository, no commit, no `git gc` making old checkpoints unreachable.
- **Native DSH styling**: buttons, menus, colors, and the settings page use DSH theme tokens.

## How it compares

> Competitor information comes from each project's official repository README (official docs), as of Nov 2026. This is a feature comparison only, not a judgment of implementation quality.

| Capability | dsh-checkpoint-dock | DSH built-in card | dsh-checkpoint-rewind | dsh-snapshot-manager | dsh-checkpoint-diff |
| --- | --- | --- | --- | --- | --- |
| Scope | Files changed per turn | Displays the current turn | Workspace + config + session cursor | Whole workspace (per-turn incremental) | No snapshots of its own; reads rewind data |
| Diff | Inline before/after | Opens changes-review | Panel diff | Panel diff | Dedicated diff panel |
| Keep / Undo / Redo | Yes | No | Rollback / selective restore | Rollback (files + conversation) | No |
| Revert to a specific turn | Yes | No | Yes | Yes | View / rollback |
| Restore conversation / config | No | No | Session fork + config | Conversation fork | No |
| Git dependency | None | None | Git or copy provider (optional) | None | Inherits rewind |
| Best for | Day-to-day file edits | Confirming a turn's output | Workspace / config / session rollback | Broad snapshot rollback | Read-only review and paired diffs |

Competitor summaries (all from their official READMEs):

- **[dsh-checkpoint-rewind](https://github.com/perrylink/dsh-checkpoint-rewind)**: three-state checkpoints (workspace, config, session cursor), with git or copy providers, `/rewind`, and session forking.
- **[dsh-snapshot-manager](https://github.com/985451842/dsh-snapshot-manager)**: an incremental whole-workspace snapshot at every `turn/start`; rollback restores files and forks the conversation.
- **[dsh-checkpoint-diff](https://github.com/tmpdot/dsh-checkpoint-diff)**: a read-only diff/rollback viewer built on top of rewind; it does not create snapshots itself.

This plugin is not a replacement for snapshot-style plugins. Its strength is being **small, fast, and focused on file changes**: no whole-workspace copy, no conversation fork, no config restore, no git — and old checkpoints are not exposed to `git gc`. The trade-off is that it only covers file contents, not session state.

## Install

Requires DSH `>= 0.2.0`.

From npm:

```powershell
dsh plugin --profile desktop add dsh-checkpoint-dock
```

From a local directory:

```powershell
dsh plugin --profile desktop add D:\path\to\dsh-checkpoint-dock
```

You can also pick the local bundle from the Plugins page. Refresh the page after installing or upgrading; restart DSH once if it asks you to.

## Usage

1. Let the agent modify files during a turn.
2. A checkpoint appears above the composer. Expand it to see the files and the diff.
3. Use **Keep / Undo / Redo / Revert to here** to act on that turn.
4. With no checkpoints, the dock hides itself. To browse history, open **Settings → Checkpoints → Overview**.

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
- Only writes made through DSH file tools are captured. Writes from shells, build scripts, git, or external editors are not checkpointed.
- The per-file limit is 4 MiB. Larger files are recorded with approximate line counts and are excluded from safe undo.

## Limitations

- Only files inside the current workspace are handled.
- Restores file bytes and permission bits; it does not restore mtime, directories, symlink targets, or `.git` metadata.
- Undo / Revert are overwrite-style restores: files created outside the reverted turn are not deleted.
- Cross-session protection is checked on Undo / Redo / Revert, not as a continuous file-edit lock. Two sessions can still write the same file concurrently; if the other session's write lands before this turn is sealed, this turn's after state may already contain it. Fully preventing that requires workspace-level write serialization.
- No whole-workspace snapshots, conversation rollback, or config rollback. Use a dedicated checkpoint/snapshot plugin for those.
- v1 records have no after content, so diff and redo are unavailable for them. There is no automatic migration.

# Changelog

## Unreleased

### Added

- Writes that bypass DSH's file tools — a shell command, a script, an editor — are now recorded too: the workspace is compared when a turn starts and when it ends, and every path that differs is added with its pre-image. A small tree is scanned as a whole; a large one (over 1200 files, or a scan slower than 120 ms) that is a git repository is compared through `git status`, `git cat-file`, and the content of files that were already dirty at turn start, because spawning git costs more than reading a few dozen files. No repository is required either way. The scan is bounded (it skips `.git`, `node_modules`, `.tmp` and similar, caps a file at 4 MiB, and stops at 4000 files / 32 MiB), so a huge tree degrades to file-tool writes for that turn instead of half-reporting.

### Changed

- A file row now expands only that file's patch inside the dock, and collapses it on a second click; the header button reads "View all changes" and expands every file at once. Nothing is handed off to DSH's changes-review sidebar any more: it reads its own snapshot and reports the turn as unviewable when the change came from a shell command, which is exactly the case this plugin now records.

- The dock waits for the conversation to start: the welcome page and a brand-new Session show no dock, and from the first sent message the dock keeps a collapsed row even when the turn changed no files. Expanded, it explains that the session has no checkpoints yet instead of staying hidden.

## 0.1.1

### Changed

- Settings → Checkpoints: the cleanup block now matches the typography of the rows above it, instead of inheriting the container's larger font size.
- The keep-count control is the plugin's own dropdown (the same one the dock uses for its session filter) instead of a native `<select>`, which rendered white-on-white on Windows and ignored the theme.

## 0.1.0

First release.

### Added

- Per-turn, per-file checkpoints with keep, undo, redo, revert, diff, pin, and clean, rendered in a resident dock above the composer.
- Storage page under Settings → Checkpoints: totals and a per-session donut of disk usage, plus the last write failure. Cleanup actions and the automatic-cleanup switch live on the Config tab.
- Deleted sessions: the storage page reports checkpoints whose session no longer exists in DSH and offers a confirmed cleanup. Cleanup skips records written in the last hour so a new session is never mistaken for a deleted one; stale temp files are swept on cleanup.
- The Config page hosts the automatic-cleanup switch and the keep count (10–200). The trim runs at the end of a turn, never mid-turn, and never touches pinned checkpoints. The same setting also controls how many records the manual "clean old content" button keeps.
- `node --test` suite covering atomic recovery, corrupt-record isolation, cross-session blob protection, orphan cleanup, and the settings/auto-clean path.
- Readme now documents install, upgrade, and uninstall (the Host half needs a DSH restart), and carries a self-hosted npm version badge; CI fails when the badge drifts from `package.json`.

### Fixed

- **Recovery is atomic.** `writeAtomic` used to fall back to `copyFile` when `rename` hit `EPERM`/`EEXIST`, which overwrote the real record in place and could truncate it on a crash. It now retries the rename with a short backoff, writes to a short `.dsh-ckpt-<pid>-<n>.tmp` name (safe against `MAX_PATH`), and always removes the temp file in a `finally` block.
- **One corrupt record no longer breaks a whole session.** Unparseable or wrong-version records are renamed to `*.corrupt-<timestamp>` and skipped; a per-file read error skips only that file. `list`, `keep`, `undo`, `redo`, and `revert` keep working for the rest of the session.
- **`clean` and `stats` no longer delete blobs another session still needs.** Blob storage is content-addressed and shared across sessions, so the protection set is now built from every session's records, not just the current one.
- **Write failures are visible** instead of being logged and forgotten.
- **The dock recovers from a missed first load.** Polling continues while the dock is collapsed (slower), and a malformed list answer no longer clears the last good one.

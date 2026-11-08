# Changelog

## 0.2.0

### Fixed

- **Recovery is now atomic.** `writeAtomic` used to fall back to `copyFile` when `rename` hit `EPERM`/`EEXIST`, which overwrote the real record in place and could truncate it on a crash. It now retries the rename with a short backoff, writes to a short `.dsh-ckpt-<pid>-<n>.tmp` name (safe against `MAX_PATH`), and always removes the temp file in a `finally` block.
- **One corrupt record no longer breaks a whole session.** Unparseable or wrong-version records are renamed to `*.corrupt-<timestamp>` and skipped; a per-file read error skips only that file. `list`, `keep`, `undo`, `redo`, and `revert` keep working for the rest of the session.
- **`clean` and `stats` no longer delete blobs another session still needs.** Blob storage is content-addressed and shared across sessions, so the protection set is now built from every session's records, not just the current one.
- **Write failures are visible.** The last failure per session is recorded and shown in the storage panel instead of being logged and forgotten.

### Added

- Deleted sessions: the storage panel reports checkpoints whose session no longer exists in DSH, and offers a confirmed cleanup. Cleanup skips records written in the last hour so a new session is never mistaken for a deleted one. Stale temp files are swept on cleanup.
- `node --test` suite covering atomic recovery, corrupt-record isolation, cross-session blob protection, and orphan cleanup.

## 0.1.0

- First release: per-turn, per-file checkpoints with keep, undo, redo, revert, diff, pin, and clean, rendered in a resident dock.

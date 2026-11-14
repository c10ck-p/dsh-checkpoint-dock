# Changelog

## 0.2.1

### Added

- After an undo, redo or revert the host half puts one context note in front of the agent at its next step: the turn that moved, the files that changed, and a request to re-read them. The dock says "the agent will see this at its next step". The note is a `checkpoint-dock` notice — it never wakes an idle agent, never impersonates a user message, is written in the language the session is already using, and is dropped if unused for 30 minutes. DSH still refuses writes to files that changed since they were read (`FS_STALE_VERSION`), so the two together close the "the model keeps writing from stale bytes" hole. This replaces the earlier "tell the agent" button, which inserted text into the composer and did nothing on inputs that refuse outside insertion.

- Every row in Settings → Checkpoints → Overview shows the disk its checkpoint occupies. Content shared by two checkpoints is charged once, to the earlier one, so the rows add up to at most the storage total.

- Each overview row has its own **Clean** button: two clicks drop just that checkpoint's saved content and keep the row and its counts. Pinned, open and undone rows refuse with a reason.

- The session picker in **Overview** carries a clear button: with "All sessions" selected it empties the whole store; picking one conversation switches it to "Clear this conversation". Both take a second click, and content shared with other sessions is kept.

- A pinned checkpoint now keeps one pre-image per file that changed after it, so "Revert to here" still works after the checkpoints in between have been cleaned. Unpinning releases that anchor and its bytes.

- Config can watch the store size: a warning, on by default at 500 MB (100 MB / 250 MB / 500 MB / 1 GB / 2 GB), shows on the Storage tab and as one line in the dock once checkpoints exceed it. It only reports; nothing is deleted.

- A file row marks changes that came from outside DSH's file tools with a small "external" tag, so a checkpoint written by a shell command or a script is distinguishable at a glance from one the agent made with `write`/`edit`.

- Turning encryption off while sealed blobs are still on disk now shows a notice: the old content keeps opening, but new writes return to plaintext.

### Changed

- Checkpoint actions are off the table while a turn is running: keep, undo, redo, revert, pin and applying an interrupted restore are disabled with a one-line reason, because a restore mid-turn fights the agent's own writes. Read-only actions (view all changes, browse history) stay available.

### Fixed

- An interrupted restore that finds a file edited in the meantime now stops instead of overwriting it: the dock shows a banner naming the file, with "Resume" to apply the recorded pre-images anyway and "Discard" to keep the file as it is. Before this, the next start replayed the journal unconditionally.

- The restore journal records the expected hash of every target before replacing it and is flushed to disk (file, then directory) before the first file is touched, so a crash can neither replay the journal onto a file edited afterwards nor lose an unflushed one.

- A checkpoint whose content was cleaned up no longer offers "Revert to here": the button is disabled and explains that the revert needs content that no longer exists. The host already refused such a revert before touching anything, but the click looked like it should work.

- The "+N −M" on a file row and the patch rendered when expanding it now come from one diff, so they always agree. The row used to count a large file approximately (falling back to the line-count difference once the comparison matrix grew too large) while the panel showed every line between the first and last change — a 127-line edit could read as "+121 −0" on the row and "+2144 −2023" in the patch. The diff is now Myers' algorithm with a bounded depth: a scattered edit is counted by the lines it actually touches, a rewrite too large to align is reported as one coarse block, and records sealed by an older build repair their counts the first time the patch is opened.

- Rename pairing buckets deletions by size and lets each explain at most one new file, instead of comparing every deletion against every creation; above 500 changes in a turn it skips pairing rather than going quadratic.

### Performance

- Stored file contents are compressed before they hit the disk: zstd when the runtime has it, gzip otherwise, and only when that actually saves space (small or already-random files are stored exactly as they are). A blob carries a short `DSKZ` header naming the codec, so blobs written by older builds keep opening without a migration, and packing runs before encryption rather than after — ciphertext has nothing to compress. The backlog is repacked in small batches after each turn; on this machine's existing store the same content went from 7.66 MB to 2.11 MB.

- The turn-start scan reuses the bytes of files whose size and mtime still match the previous scan, so only the handful that changed is read again (9.9 ms → 2.6 ms on a 1 MB tree); the same snapshot now also catches changes made between two turns — a deleted folder, a file edited while the agent was idle — instead of silently absorbing them into the next baseline.

- Storage statistics no longer probe every blob file: one directory walk builds an index, and writes, migrations and deletions keep it current. `stats` went from ~133 ms to ~9 ms with 53 checkpoints and 209 blobs.

- Records are cached by mtime and size instead of being parsed on every poll: `list` went from ~12.6 ms to ~1.1 ms, `listAll` from ~73 ms to ~10 ms.

## 0.2.0

### Added

- A checkpoint now remembers the commit it was taken at: when the turn ends inside a git repository, the dock shows the short HEAD hash next to the turn, so a checkpoint can be matched to a commit later. A repository that never commits simply leaves it empty.

- A renamed file is recorded as a rename, not as a delete plus a create: the dock shows one row with the old path after an arrow, while the record still keeps both sides so undo restores the file where it was. Git reports renames that were staged; for a plain `mv` the pair is matched by identical bytes.

- The storage pie labels rows whose session is archived in DSH. Archiving only files a session away in the sidebar — its directory, and therefore its checkpoints, stay on disk — so the label exists to explain why a session you cannot see still takes up room.

- A revert can be taken back in one click: reverting stamps every checkpoint it undid with one batch id, and the dock shows a row offering to redo them in order. A single manual undo or redo drops that checkpoint from the batch, so the shortcut never replays something you already handled by hand.

- Checkpoint content can now be encrypted. It is off by default, and turning it on seals new blobs immediately while older ones are re-encrypted in small batches on later turns. Each blob names the key that sealed it, keys are only ever added to `$DSH_HOME/checkpoint-keys/`, and a missing key is reported as unreadable content rather than as a crash or an empty file. Rotating the key adds a new one instead of replacing the old, so rotation never strands existing checkpoints.

- Writes that bypass DSH's file tools — a shell command, a script, an editor — are now recorded too: the workspace is compared when a turn starts and when it ends, and every path that differs is added with its pre-image. A small tree is scanned as a whole; a large one (over 1200 files, or a scan slower than 120 ms) that is a git repository is compared through `git status`, one `git cat-file --batch` for every pre-image, and the content of files that were already dirty at turn start, because spawning git costs more than reading a few dozen files. No repository is required either way. The scan is bounded (it skips `.git`, `node_modules`, `.tmp` and similar, caps a file at 4 MiB, and stops at 4000 files / 32 MiB), so a huge tree degrades to file-tool writes for that turn instead of half-reporting.

### Fixed

- Undo, redo and revert are now crash-safe across the files of one operation: the intended end state is written to `pending.json` first, each file is then replaced, and the record is saved last. An interrupted run is finished by the next operation instead of leaving the workspace half restored or a restored file still marked as sealed.

- The git baseline now stops at a budget as well: it keeps the content of at most 2000 already-dirty files or 32 MiB, whichever comes first, instead of reading every file `git status` reports. A turn that trips the budget degrades to file-tool writes like an over-budget scan, rather than spiking memory on a machine with tens of thousands of untracked files.

- Every gateway entry point now rejects a request whose turn is not a whole number and whose session id is not a string. The wire codecs are passthrough, so before this a client could pass a turn like `../x` and make a read resolve `<turn>.json` outside the records directory; the store's own path builder refuses such a turn as a second line of defence.

- The sensitive-path filter now also covers `.npmrc`, `.yarnrc*`, `.pypirc`, `.git-credentials`, `kubeconfig`, `secrets.yaml/json`, `.docker/`, `*.keystore` and `*.kdbx`. A matching file still gets its path and hash recorded, but its contents stay out of the checkpoint.

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

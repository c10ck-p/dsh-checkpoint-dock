// test/store.test.mjs — the paths that must never corrupt a user's files.
//
// These are behavioural tests against a real temp directory: the checks that
// matter (rename fallbacks, quarantine, cross-session blob sharing) only exist
// at the filesystem boundary.

import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import { EditCheckpointStore, hashBytes } from '../lib/store.mjs'

// Some sandboxes deny writes to the OS temp directory, so the tests keep their
// scratch space next to the package and clean it up afterwards.
const SCRATCH = path.join(import.meta.dirname, '..', '.tmp-test')
let sequence = 0

async function tempHome() {
  sequence += 1
  const home = path.join(SCRATCH, `home-${process.pid}-${sequence}`)
  const root = path.join(home, 'edit-checkpoints')
  await fs.rm(home, { recursive: true, force: true })
  await fs.mkdir(root, { recursive: true })
  return { home, root }
}

test.after(async () => {
  await fs.rm(SCRATCH, { recursive: true, force: true })
})

/** @param {string} root @param {string} sessionId */
function recordFileOf(store, sessionId, turn) {
  return store.recordFile(sessionId, turn)
}

test('capture, seal and undo restore the exact bytes', async () => {
  const { home, root } = await tempHome()
  const cwd = path.join(home, 'workspace')
  await fs.mkdir(cwd, { recursive: true })
  const file = path.join(cwd, 'a.txt')
  const before = 'one\ntwo\nthree\n'
  await fs.writeFile(file, before)

  const store = new EditCheckpointStore(root)
  await store.capture({ sessionId: 'session-a', cwd, turn: 1, absolute: file, prompt: 'edit it' })
  await fs.writeFile(file, 'one\ntwo changed\nthree\nfour\n')
  await store.seal('session-a', 1, 7)

  const [record] = await store.loadAll('session-a')
  assert.equal(record.status, 'sealed')
  assert.equal(record.seq, 7)
  assert.equal(record.added, 2)
  assert.equal(record.deleted, 1)

  const undo = await store.undo('session-a', 1)
  assert.equal(undo.ok, true, undo.message)
  assert.equal(await fs.readFile(file, 'utf8'), before)
})

test('a corrupt record is quarantined instead of breaking the session', async () => {
  const { home, root } = await tempHome()
  const cwd = path.join(home, 'workspace')
  await fs.mkdir(cwd, { recursive: true })
  const file = path.join(cwd, 'b.txt')

  const store = new EditCheckpointStore(root)
  for (const turn of [1, 3]) {
    await fs.writeFile(file, `turn ${turn}\n`)
    await store.capture({ sessionId: 'session-b', cwd, turn, absolute: file, prompt: '' })
    await fs.writeFile(file, `turn ${turn} changed\n`)
    await store.seal('session-b', turn, 0)
  }
  const broken = recordFileOf(store, 'session-b', 2)
  await fs.writeFile(broken, '{ this is not json')

  const records = await store.loadAll('session-b')
  assert.deepEqual(records.map((record) => record.turn), [1, 3])

  const names = await fs.readdir(path.dirname(broken))
  assert.ok(names.some((name) => name.startsWith('2.json.corrupt-')), 'the bad file is kept aside')
  assert.ok(!names.includes('2.json'), 'the bad file no longer occupies its turn')

  // The list view still works, and so do the actions on the good records.
  const listed = await store.list('session-b')
  assert.equal(listed.total, 2)
  const kept = await store.keep('session-b', 3)
  assert.equal(kept.ok, true, kept.message)
})

test('clean never removes a blob another session still needs', async () => {
  const { home, root } = await tempHome()
  const cwd = path.join(home, 'workspace')
  await fs.mkdir(cwd, { recursive: true })
  const file = path.join(cwd, 'shared.txt')
  const shared = 'shared bytes\n'
  const sharedHash = hashBytes(Buffer.from(shared))

  const store = new EditCheckpointStore(root)
  await fs.writeFile(file, shared)
  await store.capture({ sessionId: 'session-old', cwd, turn: 1, absolute: file, prompt: '' })
  await fs.writeFile(file, 'shared bytes, edited\n')
  await store.seal('session-old', 1, 0)

  // A second session records the same before bytes; the two must share a blob.
  await fs.writeFile(file, shared)
  await store.capture({ sessionId: 'session-other', cwd, turn: 1, absolute: file, prompt: '' })
  await fs.writeFile(file, 'other edit\n')
  await store.seal('session-other', 1, 0)

  // Push the first record out of the RECENT_KEEP window with 30 newer ones.
  for (let turn = 2; turn <= 32; turn += 1) {
    await fs.writeFile(file, `old ${turn}\n`)
    await store.capture({ sessionId: 'session-old', cwd, turn, absolute: file, prompt: '' })
    await fs.writeFile(file, `old ${turn} changed\n`)
    await store.seal('session-old', turn, 0)
  }

  const stats = await store.stats('session-old')
  assert.ok(stats.cleanable >= 1)

  const cleaned = await store.clean('session-old')
  assert.equal(cleaned.ok, true)
  assert.ok(cleaned.records >= 1)

  // The other session's copy of the shared blob must survive the clean: its
  // diff still has both sides available.
  const blob = await fs.stat(path.join(root, 'blobs', sharedHash.slice(0, 2), sharedHash))
  assert.ok(blob.size > 0)

  const diff = await store.diff('session-other', 1)
  assert.equal(diff.ok, true)
  assert.equal(diff.files[0].available, true)
  assert.ok(diff.files[0].patch.includes('shared bytes'))
})

test('purgeOrphans removes only sessions DSH no longer has', async () => {
  const { home, root } = await tempHome()
  const sessionsRoot = path.join(home, 'sessions', '--workspace--')
  await fs.mkdir(path.join(sessionsRoot, 'session-alive'), { recursive: true })
  const cwd = path.join(home, 'workspace')
  await fs.mkdir(cwd, { recursive: true })
  const file = path.join(cwd, 'c.txt')

  const store = new EditCheckpointStore(root, { sessionLookup: (id) => id === 'session-alive' })
  for (const sessionId of ['session-alive', 'session-dead']) {
    await fs.writeFile(file, 'before\n')
    await store.capture({ sessionId, cwd, turn: 1, absolute: file, prompt: '' })
    await fs.writeFile(file, 'after\n')
    await store.seal(sessionId, 1, 0)
  }

  const report = await store.orphans()
  assert.deepEqual(report.sessions.map((entry) => entry.sessionId), ['session-dead'])
  assert.equal(report.records, 1)

  const purged = await store.purgeOrphans({ minAgeMs: 0 })
  assert.equal(purged.ok, true)
  assert.equal(purged.sessions, 1)
  assert.equal(purged.records, 1)

  assert.deepEqual((await store.loadAll('session-alive')).map((record) => record.turn), [1])
  assert.equal((await store.loadAll('session-dead')).length, 0)
})

test('a fresh session directory keeps its records out of the orphan purge', async () => {
  const { home, root } = await tempHome()
  const cwd = path.join(home, 'workspace')
  await fs.mkdir(cwd, { recursive: true })
  const file = path.join(cwd, 'd.txt')

  const store = new EditCheckpointStore(root)
  await fs.writeFile(file, 'before\n')
  await store.capture({ sessionId: 'session-fresh', cwd, turn: 1, absolute: file, prompt: '' })
  await fs.writeFile(file, 'after\n')
  await store.seal('session-fresh', 1, 0)

  const purged = await store.purgeOrphans({ minAgeMs: 3_600_000 })
  assert.equal(purged.sessions, 0)

  // Once DSH creates the directory, the same session is alive.
  await fs.mkdir(path.join(home, 'sessions', '--workspace--', 'session-fresh'), { recursive: true })
  const report = await store.orphans()
  assert.equal(report.records, 0)
})

test('settings are clamped, persisted and shared by later instances', async () => {
  const { root } = await tempHome()
  const store = new EditCheckpointStore(root)

  // Out-of-range values fall back to the default instead of poisoning the file.
  const fixed = await store.setConfig({ keep: 1, autoClean: 'yes' })
  assert.equal(fixed.ok, true)
  assert.equal(fixed.keep, 30)
  assert.equal(fixed.autoClean, false)

  const saved = await store.setConfig({ keep: 12, autoClean: true })
  assert.equal(saved.keep, 12)
  assert.equal(saved.autoClean, true)

  // A second store (a restarted Host) reads the same answer from disk.
  const reopened = new EditCheckpointStore(root)
  const config = await reopened.readConfig()
  assert.deepEqual(config, { autoClean: true, keep: 12 })

  // The panel reads these back through stats().
  const stats = await reopened.stats('session-empty')
  assert.equal(stats.autoClean, true)
  assert.equal(stats.keepRecent, 12)
})

test('auto clean trims an over-limit session and respects the setting', async () => {
  const { home, root } = await tempHome()
  const cwd = path.join(home, 'workspace')
  await fs.mkdir(cwd, { recursive: true })
  const file = path.join(cwd, 'e.txt')

  const store = new EditCheckpointStore(root)
  for (let turn = 1; turn <= 6; turn += 1) {
    await fs.writeFile(file, `turn ${turn} before\n`)
    await store.capture({ sessionId: 'session-e', cwd, turn, absolute: file, prompt: '' })
    await fs.writeFile(file, `turn ${turn} after\n`)
    await store.seal('session-e', turn, 0)
  }

  // Disabled: nothing happens even though the session is over the limit.
  assert.equal(await store.maybeAutoClean('session-e'), null)
  assert.equal((await store.loadAll('session-e')).filter((r) => r.contentRemoved).length, 0)

  await store.setConfig({ autoClean: true, keep: 5 })
  const result = await store.maybeAutoClean('session-e')
  assert.equal(result.ok, true)
  assert.equal(result.records, 1)
  const records = await store.loadAll('session-e')
  assert.equal(records.length, 6, 'records stay as metadata')
  assert.equal(records.filter((r) => r.contentRemoved).length, 1)
})

test('the whole-store scope reports and cleans every session', async () => {
  const { home, root } = await tempHome()
  const cwd = path.join(home, 'workspace')
  await fs.mkdir(cwd, { recursive: true })
  const store = new EditCheckpointStore(root)
  await store.setConfig({ keep: 5, autoClean: false })

  const write = async (sessionId, turn) => {
    const file = path.join(cwd, `${sessionId}-${turn}.txt`)
    await fs.writeFile(file, `before ${sessionId} ${turn}\\n`)
    await store.capture({ sessionId, cwd, turn, absolute: file, prompt: '' })
    await fs.writeFile(file, `after ${sessionId} ${turn}\\n`)
    await store.seal(sessionId, turn, 0)
  }
  for (let turn = 1; turn <= 6; turn += 1) await write('session-x', turn)
  for (let turn = 1; turn <= 3; turn += 1) await write('session-y', turn)

  // Settings has no session of its own, so `*` is the whole store: every
  // session is counted, and each one keeps its own last 5 records.
  const stats = await store.stats('*')
  assert.equal(stats.records, 9)
  assert.equal(stats.cleanable, 1)

  const cleaned = await store.clean('*')
  assert.equal(cleaned.ok, true)
  assert.equal(cleaned.records, 1)
  assert.equal((await store.loadAll('session-y')).filter((record) => record.contentRemoved).length, 0)
})

test('the pie breakdown covers every session and adds up to the total', async () => {
  const { home, root } = await tempHome()
  const cwd = path.join(home, 'workspace')
  await fs.mkdir(cwd, { recursive: true })
  const store = new EditCheckpointStore(root)

  const write = async (sessionId, turn, body) => {
    const file = path.join(cwd, `${sessionId}-${turn}.txt`)
    await fs.writeFile(file, body)
    await store.capture({ sessionId, cwd, turn, absolute: file, prompt: '' })
    await fs.writeFile(file, `${body} after\n`)
    await store.seal(sessionId, turn, 0)
  }
  await write('session-big', 1, 'x'.repeat(2000))
  await write('session-small', 1, 'y'.repeat(200))

  const stats = await store.stats('*')
  assert.equal(stats.bySession.length, 2)
  // Sorted largest first, and the slices never exceed the reported total.
  assert.equal(stats.bySession[0].sessionId, 'session-big')
  const sum = stats.bySession.reduce((total, entry) => total + entry.bytes, 0)
  assert.ok(sum <= stats.bytes)
  assert.ok(stats.bySession[0].bytes > stats.bySession[1].bytes)
  assert.equal(stats.bySession[0].records, 1)
})

test('a before image handed in from a reverse diff restores like any other', async () => {
  const { home, root } = await tempHome()
  const cwd = path.join(home, 'workspace')
  await fs.mkdir(cwd, { recursive: true })
  const file = path.join(cwd, 'script.txt')
  // A shell command wrote this file: no fs intent ever ran for it, so the
  // caller passes the pre-image it rebuilt from the served comparison.
  await fs.writeFile(file, 'alpha\nbeta\ngamma\n')
  const before = Buffer.from('alpha\nBETA\ngamma\n', 'utf8')

  const store = new EditCheckpointStore(root)
  await store.capture({ sessionId: 'session-x', cwd, turn: 3, absolute: file, prompt: 'run it', before: { exists: true, buffer: before } })
  await store.seal('session-x', 3, 0)

  const [record] = await store.loadAll('session-x')
  assert.equal(record.files.length, 1)
  assert.equal(record.files[0].existedBefore, true)
  assert.equal(record.added, 1)
  assert.equal(record.deleted, 1)

  const undo = await store.undo('session-x', 3)
  assert.equal(undo.ok, true, undo.message)
  assert.equal(await fs.readFile(file, 'utf8'), before.toString('utf8'))
})

test('a path first seen as absent still records an external creation', async () => {
  const { home, root } = await tempHome()
  const cwd = path.join(home, 'workspace')
  await fs.mkdir(cwd, { recursive: true })
  const file = path.join(cwd, 'created-by-shell.txt')
  await fs.writeFile(file, 'brand new\n')

  const store = new EditCheckpointStore(root)
  await store.capture({ sessionId: 'session-y', cwd, turn: 4, absolute: file, prompt: '', before: { exists: false, buffer: null } })
  await store.seal('session-y', 4, 0)

  const [record] = await store.loadAll('session-y')
  assert.equal(record.files[0].existedBefore, false)
  const undo = await store.undo('session-y', 4)
  assert.equal(undo.ok, true, undo.message)
  await assert.rejects(fs.readFile(file, 'utf8'))
})

test('a sealed turn remembers the commit and a rename keeps its old path', async () => {
  const { home, root } = await tempHome()
  const cwd = path.join(home, 'workspace')
  await fs.mkdir(cwd, { recursive: true })
  const older = path.join(cwd, 'a.txt')
  const newer = path.join(cwd, 'b.txt')
  await fs.writeFile(older, 'content\n')

  const store = new EditCheckpointStore(root)
  await store.capture({ sessionId: 'session-c', cwd, turn: 1, absolute: older, prompt: '' })
  await store.capture({ sessionId: 'session-c', cwd, turn: 1, absolute: newer, prompt: '', before: { exists: false, buffer: null }, renamedFrom: older })
  await fs.rm(older)
  await fs.writeFile(newer, 'content\n')
  await store.seal('session-c', 1, 0, 'abcdef1234567890')

  const [record] = await store.loadAll('session-c')
  assert.equal(record.commit, 'abcdef1234567890')
  const moved = record.files.find((file) => file.display === 'b.txt')
  assert.equal(moved.renamedFrom, 'a.txt')

  const undo = await store.undo('session-c', 1)
  assert.equal(undo.ok, true, undo.message)
  assert.equal(await fs.readFile(older, 'utf8'), 'content\n')
  await assert.rejects(fs.readFile(newer, 'utf8'), /ENOENT/)
})

test('the storage view marks checkpoints of archived sessions', async () => {
  const { home, root } = await tempHome()
  const cwd = path.join(home, 'workspace')
  await fs.mkdir(cwd, { recursive: true })
  const file = path.join(cwd, 'kept.txt')
  await fs.writeFile(file, 'one\n')

  const store = new EditCheckpointStore(root, { archivedLookup: () => new Set(['session-d']) })
  await store.capture({ sessionId: 'session-d', cwd, turn: 1, absolute: file, prompt: '' })
  await fs.writeFile(file, 'two\n')
  await store.seal('session-d', 1, 0)

  const stats = await store.stats('*')
  assert.equal(stats.bySession.length, 1)
  assert.equal(stats.bySession[0].archived, true)
})

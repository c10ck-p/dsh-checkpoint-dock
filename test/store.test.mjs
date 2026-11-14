// test/store.test.mjs — the paths that must never corrupt a user's files.
//
// These are behavioural tests against a real temp directory: the checks that
// matter (rename fallbacks, quarantine, cross-session blob sharing) only exist
// at the filesystem boundary.

import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import { EditCheckpointStore, hashBytes, isSensitivePath } from '../lib/store.mjs'

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
  assert.deepEqual(config, {
    autoClean: true,
    keep: 12,
    encrypt: false,
    warn: true,
    warnBytes: 500 * 1024 * 1024,
  })

  // The panel reads these back through stats().
  const stats = await reopened.stats('session-empty')
  assert.equal(stats.autoClean, true)
  assert.equal(stats.keepRecent, 12)
  assert.equal(stats.warn, true)
  assert.equal(stats.warnBytes, 500 * 1024 * 1024)
})

test('the storage warning defaults on and keeps its limit in range', async () => {
  const { root } = await tempHome()
  const store = new EditCheckpointStore(root)

  const defaults = await store.readConfig()
  assert.equal(defaults.warn, true)
  assert.equal(defaults.warnBytes, 500 * 1024 * 1024)

  // A limit outside the accepted range falls back instead of being stored.
  const clamped = await store.setConfig({ warnBytes: 1 })
  assert.equal(clamped.warnBytes, 500 * 1024 * 1024)
  assert.equal(clamped.warn, true)

  const saved = await store.setConfig({ warn: false, warnBytes: 1024 * 1024 * 1024 })
  assert.equal(saved.warn, false)
  assert.equal(saved.warnBytes, 1024 * 1024 * 1024)

  const stats = await store.stats('session-empty')
  assert.equal(stats.warn, false)
  assert.equal(stats.warnBytes, 1024 * 1024 * 1024)

  // An existing config file without the key keeps warnings on.
  const reopened = new EditCheckpointStore(root)
  assert.equal((await reopened.readConfig()).warn, false)
})

test('every listed checkpoint carries the bytes it owns on disk', async () => {
  const { home, root } = await tempHome()
  const cwd = path.join(home, 'workspace')
  await fs.mkdir(cwd, { recursive: true })
  const store = new EditCheckpointStore(root)

  const write = async (turn, body) => {
    const file = path.join(cwd, `turn-${turn}.txt`)
    await fs.writeFile(file, body)
    await store.capture({ sessionId: 'session-list', cwd, turn, absolute: file, prompt: '' })
    await fs.writeFile(file, `${body}
more\n`)
    await store.seal('session-list', turn, 0)
  }
  const digits = (count) => {
    let text = ''
    let seed = 11
    while (text.length < count) {
      seed = (seed * 1103515245 + 12345) % 2147483648
      text += String(seed).padStart(10, '0')
    }
    return text.slice(0, count)
  }
  // The second turn shares the first one's body, so its one and only blob is
  // already claimed — the row must read zero, not count it twice.
  await write(1, digits(1500))
  await write(2, digits(1500))

  const listed = await store.listAll()
  assert.equal(listed.total, 2)
  const first = listed.records.find((record) => record.turn === 1)
  const second = listed.records.find((record) => record.turn === 2)
  assert.ok(first.bytes > 0)
  assert.equal(second.bytes, 0)

  const stats = await store.stats('*')
  const sum = listed.records.reduce((total, record) => total + record.bytes, 0)
  assert.ok(sum <= stats.bytes)
  assert.ok(stats.bytes > 0)
})

test('a cleaned-up checkpoint refuses to be a revert target, and nothing moves', async () => {
  const { home, root } = await tempHome()
  const cwd = path.join(home, 'workspace')
  await fs.mkdir(cwd, { recursive: true })
  const store = new EditCheckpointStore(root)
  const file = path.join(cwd, 'a.txt')

  const write = async (turn, body) => {
    await fs.writeFile(file, body)
    await store.capture({ sessionId: 'session-clean', cwd, turn, absolute: file, prompt: '' })
    await fs.writeFile(file, `${body} after ${turn}\n`)
    await store.seal('session-clean', turn, 0)
  }
  for (let turn = 1; turn <= 6; turn += 1) await write(turn, `body ${turn}\n`)

  // Keep five: only the first turn loses its content.
  const cleaned = await store.clean('session-clean', 5)
  assert.equal(cleaned.ok, true)
  assert.equal(cleaned.records, 1)

  const listed = await store.list('session-clean', { limit: 0 })
  const first = listed.records.find((record) => record.turn === 1)
  assert.equal(first.contentRemoved, true)
  assert.equal(first.files[0].contentRemoved, true)

  const before = await fs.readFile(file, 'utf8')
  const refused = await store.revert('session-clean', 1)
  assert.equal(refused.ok, false)
  assert.equal(refused.code, 'content-removed')
  assert.equal(await fs.readFile(file, 'utf8'), before)
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
  // Digits from a fixed sequence: text, but not repetitive enough to compress
  // to nothing, so the on-disk sizes keep the order of the bodies written.
  const digits = (count) => {
    let text = ''
    let seed = 7
    while (text.length < count) {
      seed = (seed * 1103515245 + 12345) % 2147483648
      text += String(seed).padStart(10, '0')
    }
    return text.slice(0, count)
  }
  await write('session-big', 1, digits(2000))
  await write('session-small', 1, digits(200))

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

test('secret-looking paths never become restorable checkpoints', () => {
  const cwd = path.join('C:', 'proj')
  const sensitive = ['.npmrc', '.git-credentials', 'secrets.yml', 'kubeconfig', '.docker/config.json', '.ssh/config', 'server.pem', 'vault.kdbx']
  for (const name of sensitive) {
    assert.equal(isSensitivePath(cwd, path.join(cwd, ...name.split('/'))), true, name)
  }
  const ordinary = ['package.json', 'config.json', 'src/main.js', '.dockerignore']
  for (const name of ordinary) {
    assert.equal(isSensitivePath(cwd, path.join(cwd, ...name.split('/'))), false, name)
  }
})

test('a turn that is not a whole number never becomes a file path', () => {
  const store = new EditCheckpointStore(path.join(SCRATCH, 'unused'))
  assert.throws(() => store.recordFile('session-a', '../escape'), /invalid checkpoint turn/)
  assert.throws(() => store.recordFile('session-a', -1), /invalid checkpoint turn/)
  assert.throws(() => store.recordFile('session-a', 1.5), /invalid checkpoint turn/)
  assert.match(store.recordFile('session-a', 7), /7\.json$/)
})

test('with encryption on, blobs are sealed and undo still restores', async () => {
  const { home, root } = await tempHome()
  const cwd = path.join(home, 'workspace')
  await fs.mkdir(cwd, { recursive: true })
  const file = path.join(cwd, 'secret.txt')
  const before = 'api_key = "one"\n'
  await fs.writeFile(file, before)

  const store = new EditCheckpointStore(root)
  await store.setConfig({ encrypt: true })
  await store.capture({ sessionId: 'session-e', cwd, turn: 1, absolute: file, prompt: '' })
  await fs.writeFile(file, 'api_key = "two"\n')
  await store.seal('session-e', 1, 0)

  const buckets = await fs.readdir(path.join(root, 'blobs'))
  const names = []
  for (const bucket of buckets) {
    for (const name of await fs.readdir(path.join(root, 'blobs', bucket))) names.push(name)
  }
  assert.equal(names.length > 0, true)
  assert.equal(names.every((name) => name.endsWith('.dsc')), true)

  const undo = await store.undo('session-e', 1)
  assert.equal(undo.ok, true, undo.message)
  assert.equal(await fs.readFile(file, 'utf8'), before)

  const stats = await store.stats('session-e')
  assert.equal(stats.crypto.enabled, true)
  assert.equal(stats.crypto.sealed, stats.crypto.total)
  assert.match(stats.crypto.fingerprint, /^[0-9a-f]{8}$/)
})

test('turning encryption on seals the blobs that were already stored', async () => {
  const { home, root } = await tempHome()
  const cwd = path.join(home, 'workspace')
  await fs.mkdir(cwd, { recursive: true })
  const file = path.join(cwd, 'a.txt')
  await fs.writeFile(file, 'plain\n')

  const store = new EditCheckpointStore(root)
  await store.capture({ sessionId: 'session-f', cwd, turn: 1, absolute: file, prompt: '' })
  await fs.writeFile(file, 'still plain\n')
  await store.seal('session-f', 1, 0)

  const plainBefore = await store.stats('session-f')
  assert.equal(plainBefore.crypto.sealed, 0)
  assert.equal(plainBefore.crypto.total > 0, true)

  await store.setConfig({ encrypt: true })
  const migrated = await store.migrateBlobs(100)
  assert.equal(migrated.sealed > 0, true)

  const after = await store.stats('session-f')
  assert.equal(after.crypto.sealed, after.crypto.total)

  const undo = await store.undo('session-f', 1)
  assert.equal(undo.ok, true, undo.message)
  assert.equal(await fs.readFile(file, 'utf8'), 'plain\n')
})

test('a compressible blob is packed on disk and still restores byte for byte', async () => {
  const { home, root } = await tempHome()
  const cwd = path.join(home, 'workspace')
  await fs.mkdir(cwd, { recursive: true })
  const file = path.join(cwd, 'big.txt')
  let original = ''
  for (let index = 0; index < 300; index += 1) original += `row ${index}: repeated content, on purpose\n`
  await fs.writeFile(file, original)

  const store = new EditCheckpointStore(root)
  await store.capture({ sessionId: 'session-h', cwd, turn: 1, absolute: file, prompt: '' })
  await fs.writeFile(file, `${original}one more line\n`)
  await store.seal('session-h', 1, 0)

  const record = await store.load('session-h', 1)
  assert.notEqual(record.files[0].beforeSha, null)
  const stored = await store.blobSize(record.files[0].beforeSha)
  assert.equal(stored.compressed, true, 'the before image should be packed')
  assert.equal(stored.sealed, false)
  assert.equal(stored.bytes < Buffer.byteLength(original) / 2, true)

  const undo = await store.undo('session-h', 1)
  assert.equal(undo.ok, true, undo.message)
  assert.equal(await fs.readFile(file, 'utf8'), original)
})

test('packed blobs still work with encryption on', async () => {
  const { home, root } = await tempHome()
  const cwd = path.join(home, 'workspace')
  await fs.mkdir(cwd, { recursive: true })
  const file = path.join(cwd, 'big.txt')
  let original = ''
  for (let index = 0; index < 300; index += 1) original += `row ${index}: repeated content, on purpose\n`
  await fs.writeFile(file, original)

  const store = new EditCheckpointStore(root)
  await store.setConfig({ encrypt: true })
  await store.capture({ sessionId: 'session-i', cwd, turn: 1, absolute: file, prompt: '' })
  await fs.writeFile(file, `${original}one more line\n`)
  await store.seal('session-i', 1, 0)

  const record = await store.load('session-i', 1)
  const stored = await store.blobSize(record.files[0].beforeSha)
  assert.equal(stored.sealed, true)

  const undo = await store.undo('session-i', 1)
  assert.equal(undo.ok, true, undo.message)
  assert.equal(await fs.readFile(file, 'utf8'), original)
})

test('the backlog migration packs plaintext blobs and leaves them readable', async () => {
  const { home, root } = await tempHome()
  const cwd = path.join(home, 'workspace')
  await fs.mkdir(cwd, { recursive: true })
  const file = path.join(cwd, 'big.txt')
  let original = ''
  for (let index = 0; index < 300; index += 1) original += `row ${index}: repeated content, on purpose\n`
  await fs.writeFile(file, original)

  const store = new EditCheckpointStore(root)
  await store.capture({ sessionId: 'session-j', cwd, turn: 1, absolute: file, prompt: '' })
  const captured = await store.load('session-j', 1)
  const hash = captured.files[0].beforeSha
  // Pretend this blob came from a build that did not pack: plain file, no .zst.
  const plainPath = store.blobFile(hash)
  await fs.unlink(`${plainPath}.zst`).catch(() => {})
  await fs.writeFile(plainPath, original)

  const moved = await store.migrateBlobs(100)
  assert.equal(moved.packed > 0, true)
  const stat = await fs.stat(`${plainPath}.zst`)
  assert.equal(stat.size < Buffer.byteLength(original) / 2, true)
  assert.equal(await fs.stat(plainPath).then(() => true, () => false), false)
  assert.equal((await store.readBlob(hash)).toString('utf8'), original)
})

test('a lost key makes content unavailable instead of unreadable garbage', async () => {
  const { home, root } = await tempHome()
  const cwd = path.join(home, 'workspace')
  await fs.mkdir(cwd, { recursive: true })
  const file = path.join(cwd, 'a.txt')
  await fs.writeFile(file, 'one\n')

  const store = new EditCheckpointStore(root)
  await store.setConfig({ encrypt: true })
  await store.capture({ sessionId: 'session-g', cwd, turn: 1, absolute: file, prompt: '' })
  await fs.writeFile(file, 'two\n')
  await store.seal('session-g', 1, 0)

  await fs.rm(path.join(home, 'checkpoint-keys'), { recursive: true, force: true })
  const fresh = new EditCheckpointStore(root)
  const undo = await fresh.undo('session-g', 1)
  assert.equal(undo.ok, false)
  assert.match(String(undo.message), /key|密钥|encrypt/i)
  assert.equal(await fs.readFile(file, 'utf8'), 'two\n')
})

test('rotating the key keeps the blobs sealed by the previous one readable', async () => {
  const { home, root } = await tempHome()
  const cwd = path.join(home, 'workspace')
  await fs.mkdir(cwd, { recursive: true })
  const file = path.join(cwd, 'a.txt')
  await fs.writeFile(file, 'first\n')

  const store = new EditCheckpointStore(root)
  await store.setConfig({ encrypt: true })
  await store.capture({ sessionId: 'session-h', cwd, turn: 1, absolute: file, prompt: '' })
  await fs.writeFile(file, 'second\n')
  await store.seal('session-h', 1, 0)
  const before = await store.stats('session-h')

  const rotated = await store.rotateKey()
  assert.equal(rotated.ok, true, rotated.message)
  assert.notEqual(rotated.fingerprint, before.crypto.fingerprint)
  assert.equal(rotated.keys, 2)

  // New content uses the new key; the old blob still opens.
  await store.capture({ sessionId: 'session-h', cwd, turn: 2, absolute: file, prompt: '' })
  await fs.writeFile(file, 'third\n')
  await store.seal('session-h', 2, 0)

  const undoTwo = await store.undo('session-h', 2)
  assert.equal(undoTwo.ok, true, undoTwo.message)
  const undoOne = await store.undo('session-h', 1)
  assert.equal(undoOne.ok, true, undoOne.message)
  assert.equal(await fs.readFile(file, 'utf8'), 'first\n')

  const after = await store.stats('session-h')
  assert.equal(after.crypto.keys, 2)
  assert.equal(after.crypto.fingerprint, rotated.fingerprint)
})

test('a revert can be taken back in one go', async () => {
  const { home, root } = await tempHome()
  const cwd = path.join(home, 'workspace')
  await fs.mkdir(cwd, { recursive: true })
  const file = path.join(cwd, 'a.txt')
  await fs.writeFile(file, 'zero\n')
  const store = new EditCheckpointStore(root)
  for (const turn of [1, 2, 3]) {
    await store.capture({ sessionId: 'session-r', cwd, turn, absolute: file, prompt: `turn ${turn}` })
    await fs.writeFile(file, `turn ${turn}\n`)
    await store.seal('session-r', turn, turn * 10)
  }

  const reverted = await store.revert('session-r', 1)
  assert.equal(reverted.ok, true, reverted.message)
  assert.equal(typeof reverted.batch, 'string')

  const undone = (await store.loadAll('session-r')).filter((record) => record.status === 'undone')
  assert.deepEqual(undone.map((record) => record.turn).sort(), [2, 3])
  for (const record of undone) assert.equal(record.revertBatch, reverted.batch)

  const back = await store.redoBatch(reverted.batch)
  assert.equal(back.ok, true, back.message)
  assert.equal(back.records, 2)
  const restored = await store.loadAll('session-r')
  assert.deepEqual(restored.map((record) => record.status), ['sealed', 'sealed', 'sealed'])
  assert.equal(await fs.readFile(file, 'utf8'), 'turn 3\n')

  const again = await store.redoBatch(reverted.batch)
  assert.equal(again.ok, false)
  assert.match(again.message, /反悔过了/)
})

test('a single redo leaves the revert batch for the rest', async () => {
  const { home, root } = await tempHome()
  const cwd = path.join(home, 'workspace')
  await fs.mkdir(cwd, { recursive: true })
  const file = path.join(cwd, 'b.txt')
  await fs.writeFile(file, 'zero\n')
  const store = new EditCheckpointStore(root)
  for (const turn of [1, 2, 3]) {
    await store.capture({ sessionId: 'session-s', cwd, turn, absolute: file, prompt: `turn ${turn}` })
    await fs.writeFile(file, `turn ${turn}\n`)
    await store.seal('session-s', turn, turn * 10)
  }

  const reverted = await store.revert('session-s', 1)
  assert.equal(reverted.ok, true, reverted.message)

  const single = await store.redo('session-s', 2)
  assert.equal(single.ok, true, single.message)
  const turn2 = (await store.loadAll('session-s')).find((record) => record.turn === 2)
  assert.equal(turn2.status, 'sealed')
  assert.equal(turn2.revertBatch, '')

  const rest = await store.redoBatch(reverted.batch)
  assert.equal(rest.ok, true, rest.message)
  assert.equal(rest.records, 1)
})

test('a restore interrupted by a crash is finished by the next store', async () => {
  const { home, root } = await tempHome()
  const cwd = path.join(home, 'workspace')
  await fs.mkdir(cwd, { recursive: true })
  const file = path.join(cwd, 'a.txt')
  const before = 'original\n'
  await fs.writeFile(file, before)
  const store = new EditCheckpointStore(root)
  await store.capture({ sessionId: 'session-c', cwd, turn: 1, absolute: file, prompt: 'edit' })
  await fs.writeFile(file, 'changed\n')
  await store.seal('session-c', 1, 5)

  const [record] = await store.loadAll('session-c')
  const entry = record.files[0]
  // Simulate a crash right after the journal was written and before any file
  // was touched: the file still holds the after image.
  await fs.writeFile(path.join(root, 'pending.json'), JSON.stringify({
    version: 1,
    time: Date.now(),
    steps: [{ path: file, display: 'a.txt', mode: null, sha: entry.beforeSha }],
    records: [{ sessionId: 'session-c', turn: 1, status: 'undone', undoneFrom: 'sealed', revertBatch: '', actionTime: Date.now() }],
  }, null, 2))
  assert.equal(await fs.readFile(file, 'utf8'), 'changed\n')

  const next = new EditCheckpointStore(root)
  // Any operation takes the lock, and the lock first finishes the journal.
  const undone = await next.undo('session-c', 1)
  assert.equal(undone.ok, true, undone.message)
  assert.equal(await fs.readFile(file, 'utf8'), before)
  assert.equal((await next.loadAll('session-c'))[0].status, 'undone')
  await assert.rejects(fs.stat(path.join(root, 'pending.json')), { code: 'ENOENT' })
})

test('a finished restore leaves no journal behind', async () => {
  const { home, root } = await tempHome()
  const cwd = path.join(home, 'workspace')
  await fs.mkdir(cwd, { recursive: true })
  const file = path.join(cwd, 'b.txt')
  await fs.writeFile(file, 'one\n')
  const store = new EditCheckpointStore(root)
  await store.capture({ sessionId: 'session-j', cwd, turn: 1, absolute: file, prompt: 'edit' })
  await fs.writeFile(file, 'two\n')
  await store.seal('session-j', 1, 1)

  assert.equal((await store.undo('session-j', 1)).ok, true)
  await assert.rejects(fs.stat(path.join(root, 'pending.json')), { code: 'ENOENT' })
  assert.equal((await store.redo('session-j', 1)).ok, true)
  await assert.rejects(fs.stat(path.join(root, 'pending.json')), { code: 'ENOENT' })
})

test('the row counts and the patch counts come from the same diff', async () => {
  const { home, root } = await tempHome()
  const cwd = path.join(home, 'workspace')
  await fs.mkdir(cwd, { recursive: true })
  const file = path.join(cwd, 'big.js')
  const lines = Array.from({ length: 1500 }, (_, index) => `const v${index} = ${index}`)
  await fs.writeFile(file, `${lines.join('\n')}\n`)

  const store = new EditCheckpointStore(root)
  await store.capture({ sessionId: 'session-big', cwd, turn: 1, absolute: file, prompt: 'edit' })
  const next = lines.slice()
  next.splice(10, 1)
  next.splice(200, 0, 'inserted a', 'inserted b')
  await fs.writeFile(file, `${next.join('\n')}\n`)
  await store.seal('session-big', 1, 1)

  const row = (await store.list('session-big')).records[0].files[0]
  assert.equal(row.added, 2, 'a two-line insertion must not be counted as the whole span')
  assert.equal(row.deleted, 1)

  const diff = await store.diff('session-big', 1)
  assert.equal(diff.files[0].added, row.added)
  assert.equal(diff.files[0].deleted, row.deleted)
  assert.ok(diff.files[0].patch.includes('+inserted a'))
})

test('a record with approximate counts is repaired the first time it is opened', async () => {
  const { home, root } = await tempHome()
  const cwd = path.join(home, 'workspace')
  await fs.mkdir(cwd, { recursive: true })
  const file = path.join(cwd, 'wide.txt')
  const lines = Array.from({ length: 400 }, (_, index) => `row ${index}`)
  await fs.writeFile(file, `${lines.join('\n')}\n`)

  const store = new EditCheckpointStore(root)
  await store.capture({ sessionId: 'session-fix', cwd, turn: 1, absolute: file, prompt: 'edit' })
  lines[300] = 'row 300 changed'
  await fs.writeFile(file, `${lines.join('\n')}\n`)
  await store.seal('session-fix', 1, 1)

  // Simulate a record sealed by an older build.
  const recordPath = store.recordFile('session-fix', 1)
  const raw = JSON.parse(await fs.readFile(recordPath, 'utf8'))
  raw.files[0].added = 999
  raw.files[0].deleted = 0
  raw.added = 999
  raw.deleted = 0
  await fs.writeFile(recordPath, JSON.stringify(raw))

  const diff = await store.diff('session-fix', 1)
  assert.deepEqual([diff.files[0].added, diff.files[0].deleted], [1, 1])

  const healed = (await store.list('session-fix')).records[0]
  assert.deepEqual([healed.added, healed.deleted], [1, 1])
})

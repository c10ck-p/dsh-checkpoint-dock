// test/journal.test.mjs — an interrupted restore must never overwrite a file
// the user touched after the crash, and a held journal must be resolvable.

import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import { EditCheckpointStore, hashBytes } from '../lib/store.mjs'

const SCRATCH = path.join(import.meta.dirname, '..', '.tmp-test-journal')
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

async function seedUndoJournal(root, cwd, sessionId) {
  const file = path.join(cwd, 'a.txt')
  await fs.writeFile(file, 'original\n')
  const store = new EditCheckpointStore(root)
  await store.capture({ sessionId, cwd, turn: 1, absolute: file, prompt: 'edit' })
  await fs.writeFile(file, 'changed\n')
  await store.seal(sessionId, 1, 5)
  const [record] = await store.loadAll(sessionId)
  const entry = record.files[0]
  await fs.writeFile(path.join(root, 'pending.json'), JSON.stringify({
    version: 2,
    time: Date.now(),
    steps: [{
      path: file,
      display: 'a.txt',
      mode: null,
      sha: entry.beforeSha,
      expect: hashBytes(Buffer.from('changed\n')),
    }],
    records: [{
      sessionId,
      turn: 1,
      status: 'undone',
      undoneFrom: 'sealed',
      revertBatch: '',
      actionTime: Date.now(),
    }],
  }, null, 2))
  // The user edits the file after the crash but before DSH starts again.
  await fs.writeFile(file, 'hand edit\n')
  return file
}

test('a journal whose file changed meanwhile is held for confirmation', async () => {
  const { home, root } = await tempHome()
  const cwd = path.join(home, 'workspace')
  await fs.mkdir(cwd, { recursive: true })
  const file = await seedUndoJournal(root, cwd, 'session-hold')

  const next = new EditCheckpointStore(root)
  await next.exclusive(async () => {})

  const info = await next.journalInfo()
  assert.equal(info.pending, true)
  assert.equal(info.blocked, true)
  assert.equal(info.conflict, 'a.txt')
  assert.equal(info.steps, 1)
  // Nothing was overwritten while the journal waits.
  assert.equal(await fs.readFile(file, 'utf8'), 'hand edit\n')
  await fs.stat(path.join(root, 'pending.json'))
})

test('resuming a held journal applies it anyway', async () => {
  const { home, root } = await tempHome()
  const cwd = path.join(home, 'workspace')
  await fs.mkdir(cwd, { recursive: true })
  const file = await seedUndoJournal(root, cwd, 'session-resume')

  const next = new EditCheckpointStore(root)
  await next.exclusive(async () => {})

  const resumed = await next.resumeJournal()
  assert.equal(resumed.ok, true, resumed.message)
  assert.equal(resumed.steps, 1)
  assert.equal(await fs.readFile(file, 'utf8'), 'original\n')
  await assert.rejects(fs.stat(path.join(root, 'pending.json')), { code: 'ENOENT' })
  assert.equal((await next.loadAll('session-resume'))[0].status, 'undone')
})

test('discarding a held journal leaves the file alone', async () => {
  const { home, root } = await tempHome()
  const cwd = path.join(home, 'workspace')
  await fs.mkdir(cwd, { recursive: true })
  const file = await seedUndoJournal(root, cwd, 'session-drop')

  const next = new EditCheckpointStore(root)
  await next.exclusive(async () => {})

  const dropped = await next.discardJournal()
  assert.equal(dropped.ok, true, dropped.message)
  assert.equal(dropped.discarded, true)
  assert.equal(await fs.readFile(file, 'utf8'), 'hand edit\n')
  await assert.rejects(fs.stat(path.join(root, 'pending.json')), { code: 'ENOENT' })
  const leftovers = (await fs.readdir(root)).filter((name) => name.startsWith('pending.json.discarded-'))
  assert.equal(leftovers.length, 1)
  assert.equal((await next.journalInfo()).pending, false)
})

test('a file remembers whether a tool or the outside wrote it', async () => {
  const { home, root } = await tempHome()
  const cwd = path.join(home, 'workspace')
  await fs.mkdir(cwd, { recursive: true })
  const inside = path.join(cwd, 'inside.txt')
  const outside = path.join(cwd, 'outside.txt')
  await fs.writeFile(inside, 'a\n')
  await fs.writeFile(outside, 'b\n')

  const store = new EditCheckpointStore(root)
  await store.capture({ sessionId: 'session-o', cwd, turn: 1, absolute: inside, prompt: 'edit', origin: 'tool' })
  await store.capture({ sessionId: 'session-o', cwd, turn: 1, absolute: outside, prompt: 'script', origin: 'external' })
  await fs.writeFile(inside, 'a2\n')
  await fs.writeFile(outside, 'b2\n')
  await store.seal('session-o', 1, 2)

  const record = (await store.list('session-o')).records[0]
  const origins = Object.fromEntries(record.files.map((file) => [file.display, file.origin]))
  assert.deepEqual(origins, { 'inside.txt': 'tool', 'outside.txt': 'external' })
})

// test/baseline.test.mjs — the git-free way to notice a write.
//
// A turn is bracketed by two scans of the workspace. Everything that differs
// between them was written by somebody, whether or not it went through DSH's
// file tools. These tests pin the comparison itself: modified, created and
// deleted files, skipped directories, and the budget that makes the scan give
// up instead of half-reporting.

import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { scanWorkspace, changedSince, pairRenames } from '../lib/baseline.mjs'

// Some sandboxes deny writes to the OS temp directory, so the tests keep their
// scratch space next to the package and clean it up afterwards.
const scratch = path.join(import.meta.dirname, '..', '.tmp-test-baseline')

test.after(async () => {
  await rm(scratch, { recursive: true, force: true })
})

const workspace = async (name) => {
  const root = path.join(scratch, name)
  await mkdir(root, { recursive: true })
  return root
}

test('a modified file shows its before and after content', async () => {
  const root = await workspace('modified')
  await writeFile(path.join(root, 'a.txt'), 'one\n')
  const before = await scanWorkspace(root)
  await writeFile(path.join(root, 'a.txt'), 'two\n')
  const after = await scanWorkspace(root)

  const changes = changedSince(before, after)
  assert.equal(changes.length, 1)
  assert.equal(changes[0].path, 'a.txt')
  assert.equal(changes[0].before.toString('utf8'), 'one\n')
  assert.equal(changes[0].after.toString('utf8'), 'two\n')
})

test('a created file has no before image', async () => {
  const root = await workspace('created')
  await writeFile(path.join(root, 'keep.txt'), 'same\n')
  const before = await scanWorkspace(root)
  await writeFile(path.join(root, 'new.txt'), 'fresh\n')
  const after = await scanWorkspace(root)

  const changes = changedSince(before, after)
  assert.equal(changes.length, 1)
  assert.equal(changes[0].path, 'new.txt')
  assert.equal(changes[0].before, null)
})

test('a deleted file keeps its old content as the before image', async () => {
  const root = await workspace('deleted')
  await writeFile(path.join(root, 'gone.txt'), 'bye\n')
  const before = await scanWorkspace(root)
  await rm(path.join(root, 'gone.txt'))
  const after = await scanWorkspace(root)

  const changes = changedSince(before, after)
  assert.equal(changes.length, 1)
  assert.equal(changes[0].path, 'gone.txt')
  assert.equal(changes[0].before.toString('utf8'), 'bye\n')
  assert.equal(changes[0].after, null)
})

test('nothing changed means nothing is reported', async () => {
  const root = await workspace('stable')
  await writeFile(path.join(root, 'a.txt'), 'a\n')
  await writeFile(path.join(root, 'nested', 'b.txt'), 'b\n').catch(async () => {
    await mkdir(path.join(root, 'nested'))
    await writeFile(path.join(root, 'nested', 'b.txt'), 'b\n')
  })
  const before = await scanWorkspace(root)
  const after = await scanWorkspace(root)
  assert.deepEqual(changedSince(before, after), [])
})

test('dependency and scratch directories stay out of the scan', async () => {
  const root = await workspace('skipped')
  await mkdir(path.join(root, 'node_modules', 'pkg'), { recursive: true })
  await writeFile(path.join(root, 'node_modules', 'pkg', 'index.js'), 'noise\n')
  await mkdir(path.join(root, '.git'))
  await writeFile(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n')
  await writeFile(path.join(root, 'src.js'), 'code\n')

  const scan = await scanWorkspace(root)
  assert.deepEqual([...scan.files.keys()], ['src.js'])
  assert.equal(scan.exceeded, false)
})

test('passing the file budget is reported instead of half-scanning', async () => {
  const root = await workspace('budget')
  for (let index = 0; index < 5; index += 1) {
    await writeFile(path.join(root, `f${index}.txt`), `${index}\n`)
  }
  const scan = await scanWorkspace(root, { maxFiles: 3 })
  assert.equal(scan.exceeded, true)
})

test('a moved file is named as one rename instead of a delete plus a create', () => {
  const changes = pairRenames([
    { absolute: 'D:/w/a.txt', before: Buffer.from('same\n'), after: null },
    { absolute: 'D:/w/b.txt', before: null, after: Buffer.from('same\n') },
    { absolute: 'D:/w/c.txt', before: null, after: Buffer.from('other\n') },
  ])
  assert.equal(changes[1].renamedFrom, 'D:/w/a.txt')
  assert.equal(changes[2].renamedFrom, undefined)
  assert.equal(changes.length, 3, 'the deletion is kept so undo can restore it')
})

test('a moved file whose bytes changed is not called a rename', () => {
  const changes = pairRenames([
    { absolute: 'D:/w/a.txt', before: Buffer.from('old\n'), after: null },
    { absolute: 'D:/w/b.txt', before: null, after: Buffer.from('new\n') },
  ])
  assert.equal(changes[1].renamedFrom, undefined)
})

test('one deleted file explains only one new file', () => {
  const same = Buffer.from('same\n')
  const changes = pairRenames([
    { absolute: 'D:/w/a.txt', before: same, after: null },
    { absolute: 'D:/w/b.txt', before: null, after: same },
    { absolute: 'D:/w/c.txt', before: null, after: same },
  ])
  const sources = changes.filter((change) => change.renamedFrom !== undefined).map((change) => change.renamedFrom)
  assert.equal(sources.length, 1)
  assert.equal(sources[0], 'D:/w/a.txt')
})

test('a large change set skips rename pairing instead of going quadratic', () => {
  const changes = []
  for (let index = 0; index < 300; index += 1) {
    changes.push({ absolute: `D:/w/old-${index}.txt`, before: Buffer.from(`x${index}\n`), after: null })
    changes.push({ absolute: `D:/w/new-${index}.txt`, before: null, after: Buffer.from(`x${index}\n`) })
  }
  assert.equal(changes.length, 600)
  const paired = pairRenames(changes)
  assert.equal(paired.filter((change) => change.renamedFrom !== undefined).length, 0)
})

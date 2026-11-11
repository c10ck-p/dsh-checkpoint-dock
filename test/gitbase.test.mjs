// test/gitbase.test.mjs — the git path of external-write detection.
//
// These run against real repositories: what matters is whether git's answer,
// plus the bytes kept for already-dirty files, names the same changes the
// whole-workspace scan would name.

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

import { takeGitBaseline, gitChanges } from '../lib/gitbase.mjs'

const run = promisify(execFile)

const SCRATCH = path.join(import.meta.dirname, '..', '.tmp-test-gitbase')
let sequence = 0

const git = (cwd, ...args) =>
  run('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', ...args], { cwd })

async function repo() {
  sequence += 1
  const dir = path.join(SCRATCH, `repo-${process.pid}-${sequence}`)
  await fs.rm(dir, { recursive: true, force: true })
  await fs.mkdir(dir, { recursive: true })
  await git(dir, 'init', '-q')
  return dir
}

const read = (dir, name) => fs.readFile(path.join(dir, name), 'utf8')

test.after(async () => {
  await fs.rm(SCRATCH, { recursive: true, force: true })
})

test('a directory outside git has no git baseline', async () => {
  // Deliberately outside the package: this repository is a git work tree, and
  // a nested directory legitimately belongs to it.
  sequence += 1
  const dir = path.join(import.meta.dirname, '..', '..', '.tmp', `nogit-${process.pid}-${sequence}`)
  await fs.rm(dir, { recursive: true, force: true })
  await fs.mkdir(dir, { recursive: true })
  try {
    assert.equal(await takeGitBaseline(dir), null)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('a modified tracked file keeps its committed content as the pre-image', async () => {
  const dir = await repo()
  await fs.writeFile(path.join(dir, 'a.txt'), 'one\n')
  await git(dir, 'add', '-A')
  await git(dir, 'commit', '-q', '-m', 'one')
  const baseline = await takeGitBaseline(dir)
  await fs.writeFile(path.join(dir, 'a.txt'), 'two\n')
  const changes = await gitChanges(baseline)
  assert.equal(changes.length, 1)
  assert.equal(changes[0].absolute, path.join(dir, 'a.txt'))
  assert.equal(changes[0].before.toString(), 'one\n')
})

test('a file created during the turn has no pre-image', async () => {
  const dir = await repo()
  await fs.writeFile(path.join(dir, 'a.txt'), 'one\n')
  await git(dir, 'add', '-A')
  await git(dir, 'commit', '-q', '-m', 'one')
  const baseline = await takeGitBaseline(dir)
  await fs.writeFile(path.join(dir, 'new.txt'), 'fresh\n')
  const changes = await gitChanges(baseline)
  assert.deepEqual(changes.map((change) => path.basename(change.absolute)), ['new.txt'])
  assert.equal(changes[0].before, null)
})

test('a file already dirty at turn start keeps the content it had then', async () => {
  const dir = await repo()
  await fs.writeFile(path.join(dir, 'a.txt'), 'committed\n')
  await git(dir, 'add', '-A')
  await git(dir, 'commit', '-q', '-m', 'base')
  await fs.writeFile(path.join(dir, 'a.txt'), 'dirty before the turn\n')
  const baseline = await takeGitBaseline(dir)
  await fs.writeFile(path.join(dir, 'a.txt'), 'dirty after the turn\n')
  const changes = await gitChanges(baseline)
  assert.equal(changes.length, 1)
  assert.equal(changes[0].before.toString(), 'dirty before the turn\n')
})

test('several modified files all get their committed content', async () => {
  const dir = await repo()
  const names = ['a.txt', 'b.txt', 'c.txt', 'd.txt']
  for (const name of names) await fs.writeFile(path.join(dir, name), `${name} before\n`)
  await git(dir, 'add', '-A')
  await git(dir, 'commit', '-q', '-m', 'base')
  const baseline = await takeGitBaseline(dir)
  for (const name of names) await fs.writeFile(path.join(dir, name), `${name} after\n`)
  const changes = await gitChanges(baseline)
  const byName = new Map(changes.map((change) => [path.basename(change.absolute), change.before.toString()]))
  assert.equal(changes.length, names.length)
  for (const name of names) assert.equal(byName.get(name), `${name} before\n`)
})

test('a deletion is reported with the content it had at turn start', async () => {
  const dir = await repo()
  await fs.writeFile(path.join(dir, 'a.txt'), 'one\n')
  await git(dir, 'add', '-A')
  await git(dir, 'commit', '-q', '-m', 'one')
  const baseline = await takeGitBaseline(dir)
  await fs.rm(path.join(dir, 'a.txt'))
  const changes = await gitChanges(baseline)
  assert.equal(changes.length, 1)
  assert.equal(changes[0].before.toString(), 'one\n')
})

test('a path that ends the turn unchanged is not reported', async () => {
  const dir = await repo()
  await fs.writeFile(path.join(dir, 'a.txt'), 'one\n')
  await git(dir, 'add', '-A')
  await git(dir, 'commit', '-q', '-m', 'one')
  const baseline = await takeGitBaseline(dir)
  await fs.writeFile(path.join(dir, 'a.txt'), 'two\n')
  await fs.writeFile(path.join(dir, 'a.txt'), 'one\n')
  assert.deepEqual(await gitChanges(baseline), [])
})

test('a staged rename names the path it came from', async () => {
  const dir = await repo()
  await fs.writeFile(path.join(dir, 'a.txt'), 'one\n')
  await git(dir, 'add', '-A')
  await git(dir, 'commit', '-q', '-m', 'one')
  const baseline = await takeGitBaseline(dir)
  await git(dir, 'mv', 'a.txt', 'b.txt')

  const changes = await gitChanges(baseline)
  const older = changes.find((change) => change.absolute.endsWith('a.txt'))
  const newer = changes.find((change) => change.absolute.endsWith('b.txt'))
  assert.ok(older !== undefined, 'the deleted path is still reported')
  assert.ok(newer !== undefined, 'the created path is reported')
  assert.equal(newer.renamedFrom, older.absolute)
  assert.equal(older.before.toString(), 'one\n')
})

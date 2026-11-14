// test/textdiff.test.mjs — the row's +/- counts and the expanded patch must be
// the same diff, and that diff must describe the real edit rather than "every
// line between the first and the last change".

import assert from 'node:assert/strict'
import test from 'node:test'

import { diffCounts, diffLines } from '../lib/textdiff.mjs'

const range = (count, prefix = 'line') => Array.from({ length: count }, (_, index) => `${prefix} ${index}`)

test('a scattered edit is counted by its lines, not by its span', () => {
  const before = range(2400)
  const after = before.slice()
  // Six deletions and 127 insertions spread over the file.
  for (let index = 0; index < 6; index += 1) after.splice(index * 400, 1)
  for (let index = 0; index < 127; index += 1) after.splice(index * 18, 0, `new ${index}`)

  const diff = diffLines(before, after)
  assert.equal(diff.added, 127)
  assert.equal(diff.deleted, 6)
  assert.equal(diff.coarse, false)
  assert.ok(diff.hunks.length > 1, 'edits far apart stay in separate hunks')

  const counts = diffCounts(before, after)
  assert.deepEqual([counts.added, counts.deleted], [127, 6])
})

test('hunks carry three lines of context and real line numbers', () => {
  const before = range(50)
  const after = before.slice()
  after[24] = 'changed 24'

  const diff = diffLines(before, after)
  assert.equal(diff.hunks.length, 1)
  const [hunk] = diff.hunks
  assert.equal(hunk.oldStart, 22)
  assert.equal(hunk.oldLines, 7)
  assert.equal(hunk.lines[0], ' line 21')
  assert.equal(hunk.lines[3], '-line 24')
  assert.equal(hunk.lines[4], '+changed 24')
})

test('two edits close together share a hunk, distant ones do not', () => {
  const before = range(200)
  const near = before.slice()
  near[50] = 'a'
  near[55] = 'b'
  assert.equal(diffLines(before, near).hunks.length, 1)

  const far = before.slice()
  far[20] = 'a'
  far[180] = 'b'
  assert.equal(diffLines(before, far).hunks.length, 2)
})

test('no change means no hunk and no counts', () => {
  const lines = range(10)
  const diff = diffLines(lines, lines.slice())
  assert.deepEqual([diff.added, diff.deleted, diff.hunks.length], [0, 0, 0])
})

test('a rewrite too large to align is reported as one coarse block', () => {
  const before = range(12000, 'old')
  const after = range(12000, 'new')
  const diff = diffLines(before, after)
  assert.equal(diff.coarse, true)
  assert.equal(diff.added, 12000)
  assert.equal(diff.deleted, 12000)
  assert.equal(diff.hunks.length, 1)

  const counts = diffCounts(before, after)
  assert.deepEqual([counts.added, counts.deleted, counts.coarse], [12000, 12000, true])
})

test('a pure append keeps the existing file untouched', () => {
  const before = range(100)
  const after = before.concat(['tail a', 'tail b'])
  const diff = diffLines(before, after)
  assert.deepEqual([diff.added, diff.deleted], [2, 0])
  assert.equal(diff.hunks.at(-1).newStart, 98)
})

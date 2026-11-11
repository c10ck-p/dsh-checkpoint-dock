// test/unpatch.test.mjs — rebuilding the text a comparison started from.
//
// The workspace-changes service serves hunks, not the before image. These
// tests pin the cases a shell-written path can be in: a replacement, an
// insertion, a deletion, two hunks in one file, and a hunk that no longer
// describes the file (which must be refused, never guessed at).

import assert from 'node:assert/strict'
import test from 'node:test'

import { revertHunks } from '../lib/unpatch.mjs'

test('a replacement hunk reverses to the removed lines', () => {
  const hunks = [{ oldStart: 1, oldLines: 3, newStart: 1, newLines: 3, lines: [' a', '-b', '+B', ' c'] }]
  assert.equal(revertHunks('a\nB\nc\n', hunks), 'a\nb\nc\n')
})

test('an insertion reverses by dropping the added lines', () => {
  const hunks = [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: [' a', '+b'] }]
  assert.equal(revertHunks('a\nb\n', hunks), 'a\n')
})

test('a deletion reverses from the removed lines alone', () => {
  const hunks = [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 0, lines: ['-a', '-b'] }]
  assert.equal(revertHunks('', hunks), 'a\nb\n')
})

test('two hunks keep the untouched middle text', () => {
  const hunks = [
    { oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, lines: ['-one', '+ONE', ' two'] },
    { oldStart: 3, oldLines: 2, newStart: 3, newLines: 2, lines: [' three', '-four', '+FOUR'] },
  ]
  assert.equal(revertHunks('ONE\ntwo\nthree\nFOUR\n', hunks), 'one\ntwo\nthree\nfour\n')
})

test('a hunk that does not match the file is refused', () => {
  const hunks = [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] }]
  assert.equal(revertHunks('different\n', hunks), null)
})

test('a hunk past the end of the file is refused', () => {
  const hunks = [{ oldStart: 9, oldLines: 1, newStart: 9, newLines: 1, lines: ['-a', '+b'] }]
  assert.equal(revertHunks('b\n', hunks), null)
})

test('shapes that are not hunks are refused', () => {
  assert.equal(revertHunks('x\n', null), null)
  assert.equal(revertHunks('x\n', [{ newStart: 0, newLines: 0, lines: [] }]), null)
  assert.equal(revertHunks('x\n', [{ newStart: 1, newLines: 1, lines: ['?x'] }]), null)
})

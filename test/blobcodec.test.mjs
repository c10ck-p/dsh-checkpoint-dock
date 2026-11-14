// Packing is a storage detail: a blob has to come back byte for byte, and
// anything that does not compress must be stored exactly as it arrived.

import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import { PACK_MIN_BYTES, isPacked, pack, unpack } from '../lib/blobcodec.mjs'

function repetitive(lines) {
  let text = ''
  for (let index = 0; index < lines; index += 1) {
    text += `line ${index}: the same reasonably long sentence, again and again\n`
  }
  return Buffer.from(text, 'utf8')
}

test('a compressible payload survives a round trip', async () => {
  const original = repetitive(200)
  const packed = await pack(original)
  assert.equal(isPacked(packed), true)
  assert.equal(packed.length < original.length / 2, true, `${packed.length} vs ${original.length}`)
  assert.deepEqual(await unpack(packed), original)
})

test('an incompressible payload is stored as it is', async () => {
  const original = randomBytes(4096)
  const packed = await pack(original)
  assert.equal(isPacked(packed), false)
  assert.deepEqual(await unpack(packed), original)
})

test('a payload too small to be worth a header is left alone', async () => {
  const original = Buffer.from('x'.repeat(PACK_MIN_BYTES - 1), 'utf8')
  const packed = await pack(original)
  assert.equal(packed, original)
  assert.equal(isPacked(packed), false)
  assert.deepEqual(await unpack(packed), original)
})

test('a payload without the header is passed through untouched', async () => {
  const original = Buffer.from('plain checkpoint text\n', 'utf8')
  assert.deepEqual(await unpack(original), original)
})

test('an unknown codec version is refused instead of guessed', async () => {
  const packed = await pack(repetitive(200))
  const broken = Buffer.from(packed)
  broken[4] = 9
  await assert.rejects(() => unpack(broken), /unsupported blob codec version 9/)
})

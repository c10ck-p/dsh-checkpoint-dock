// test/vault.test.mjs — encryption must be reversible, and a lost key must
// look like a lost key instead of like an empty file.

import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import { KeyRing, fingerprintText, fingerprintOf, isSealed, seal, unseal } from '../lib/vault.mjs'

const SCRATCH = path.join(import.meta.dirname, '..', '.tmp-test-vault')
let sequence = 0

async function tempDir() {
  sequence += 1
  const dir = path.join(SCRATCH, `keys-${process.pid}-${sequence}`)
  await fs.rm(dir, { recursive: true, force: true })
  return dir
}

test.after(async () => {
  await fs.rm(SCRATCH, { recursive: true, force: true })
})

test('a sealed buffer opens with the key that sealed it', async () => {
  const key = Buffer.alloc(32, 7)
  const plain = Buffer.from('hello checkpoint\n'.repeat(100))
  const sealed = seal(key, plain)
  assert.equal(isSealed(sealed), true)
  assert.equal(isSealed(plain), false)
  assert.notEqual(sealed.length, plain.length)
  assert.deepEqual(unseal(key, sealed), plain)
})

test('the header carries the fingerprint of the key', async () => {
  const key = Buffer.alloc(32, 3)
  const sealed = seal(key, Buffer.from('x'))
  const fingerprint = fingerprintOf(key)
  assert.equal(fingerprintText(fingerprint), fingerprint.toString('hex').slice(0, 8))
  assert.equal(sealed.subarray(5, 13).equals(fingerprint), true)
})

test('a wrong key fails instead of returning garbage', async () => {
  const sealed = seal(Buffer.alloc(32, 1), Buffer.from('secret'))
  assert.throws(() => unseal(Buffer.alloc(32, 2), sealed))
})

test('a missing key reports itself as key-missing', async () => {
  const sealed = seal(Buffer.alloc(32, 1), Buffer.from('secret'))
  assert.throws(() => unseal(null, sealed), (error) => error && error.code === 'key-missing')
})

test('the key ring keeps older keys and mints new ones beside them', async () => {
  const dir = await tempDir()
  const ring = new KeyRing(dir)
  const first = await ring.current()
  assert.equal(typeof first.fingerprint, 'string')
  const second = await ring.create()
  assert.notEqual(second.fingerprint, first.fingerprint)

  const sealedWithFirst = seal(first.key, Buffer.from('old'))
  const sealedWithSecond = seal(second.key, Buffer.from('new'))
  assert.deepEqual(await ring.keyFor(sealedWithFirst), first.key)
  assert.deepEqual(await ring.keyFor(sealedWithSecond), second.key)

  // A fresh instance reads the same ring from disk.
  const again = new KeyRing(dir)
  assert.deepEqual(await again.keyFor(sealedWithFirst), first.key)
  assert.equal((await again.load()).size, 2)
})

test('a key file written by hand is picked up by its fingerprint name', async () => {
  const dir = await tempDir()
  const ring = new KeyRing(dir)
  const key = Buffer.alloc(32, 9)
  const fingerprint = fingerprintText(fingerprintOf(key))
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, `${fingerprint}.key`), key)
  assert.deepEqual(await ring.keyFor(seal(key, Buffer.from('x'))), key)
})

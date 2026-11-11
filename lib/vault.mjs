// lib/vault.mjs — optional encryption for checkpoint blobs.
//
// A checkpoint keeps whole file contents verbatim, so a store copied off the
// machine (a synced folder, a backup) leaks source code. Encryption is off by
// default: an encryption that nobody asked for mostly produces support tickets
// about lost keys. When it is on, every blob is sealed with AES-256-GCM under a
// random key that lives outside the store directory, and blobs that predate the
// switch are re-encrypted in place, one at a time, without touching records.
//
// Key handling is deliberately forgiving: every key ever used stays in the key
// ring, so "reset the key" mints a new one instead of destroying the old one. A
// blob names its key in its header, which means a key restored from a backup
// makes its blobs readable again.

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'

const MAGIC = Buffer.from('DSCK', 'utf8')
const VERSION = 1
const FINGERPRINT_BYTES = 8
const NONCE_BYTES = 12
const TAG_BYTES = 16
const HEADER_BYTES = MAGIC.length + 1 + FINGERPRINT_BYTES + NONCE_BYTES
const KEY_BYTES = 32

/**
 * The first 8 bytes of sha256(key) name the key a blob was sealed with. Short
 * enough to print, long enough that two keys generated here never collide.
 * @param {Buffer} key
 * @returns {Buffer}
 */
export function fingerprintOf(key) {
  return createHash('sha256').update(key).digest().subarray(0, FINGERPRINT_BYTES)
}

/** @param {Buffer} fingerprint */
export function fingerprintText(fingerprint) {
  return fingerprint.toString('hex').slice(0, 8)
}

/**
 * Seal one blob.
 * @param {Buffer} key
 * @param {Buffer} plain
 * @returns {Buffer}
 */
export function seal(key, plain) {
  const nonce = randomBytes(NONCE_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  const body = Buffer.concat([cipher.update(plain), cipher.final()])
  return Buffer.concat([
    MAGIC,
    Buffer.from([VERSION]),
    fingerprintOf(key),
    nonce,
    body,
    cipher.getAuthTag(),
  ])
}

/**
 * Whether a buffer carries our header. A plaintext blob is anything else.
 * @param {Buffer} buffer
 */
export function isSealed(buffer) {
  return buffer.length > HEADER_BYTES + TAG_BYTES &&
    buffer.subarray(0, MAGIC.length).equals(MAGIC) &&
    buffer[MAGIC.length] === VERSION
}

/** @param {Buffer} buffer @returns {Buffer} */
function headerFingerprint(buffer) {
  return buffer.subarray(MAGIC.length + 1, MAGIC.length + 1 + FINGERPRINT_BYTES)
}

/**
 * Open one blob. A missing or wrong key is reported as a `key-missing` error so
 * a reader can say "the content is unavailable" instead of pretending the file
 * was empty.
 * @param {Buffer | null} key
 * @param {Buffer} buffer
 * @returns {Buffer}
 */
export function unseal(key, buffer) {
  if (!isSealed(buffer)) throw new Error('not a sealed blob')
  if (key === null || key === undefined) {
    const error = new Error('checkpoint content is encrypted and its key is missing')
    error.code = 'key-missing'
    throw error
  }
  const start = HEADER_BYTES
  const end = buffer.length - TAG_BYTES
  const nonce = buffer.subarray(start - NONCE_BYTES, start)
  const decipher = createDecipheriv('aes-256-gcm', key, nonce)
  decipher.setAuthTag(buffer.subarray(end))
  return Buffer.concat([decipher.update(buffer.subarray(start, end)), decipher.final()])
}

/**
 * The key ring: every key this store ever used, one file per key, named by the
 * fingerprint that appears in blob headers. Keys are never deleted — retiring a
 * key only stops using it for new blobs.
 */
export class KeyRing {
  /**
   * @param {string} dir
   */
  constructor(dir) {
    this.dir = dir
    /** @type {Map<string, Buffer> | null} */
    this.cache = null
  }

  /** @returns {Promise<Map<string, Buffer>>} */
  async load() {
    if (this.cache !== null) return this.cache
    const keys = new Map()
    const names = await fs.readdir(this.dir).catch((error) => {
      if (error && error.code === 'ENOENT') return []
      throw error
    })
    for (const name of names) {
      if (!name.endsWith('.key')) continue
      try {
        const buffer = await fs.readFile(path.join(this.dir, name))
        if (buffer.length === KEY_BYTES) keys.set(fingerprintText(fingerprintOf(buffer)), buffer)
      } catch {
        // A key file that cannot be read is simply not available; blobs that
        // need it report their content as unavailable.
      }
    }
    this.cache = keys
    return keys
  }

  /**
   * The key new blobs are sealed with: the newest key on disk, or a fresh one
   * when the ring is empty.
   * @returns {Promise<{ key: Buffer, fingerprint: string }>}
   */
  async current() {
    const keys = await this.load()
    if (keys.size === 0) return this.create()
    let newest = null
    for (const [fingerprint, key] of keys) {
      const file = path.join(this.dir, `${fingerprint}.key`)
      const stat = await fs.stat(file).catch(() => null)
      const time = stat === null ? 0 : stat.mtimeMs
      if (newest === null || time > newest.time) newest = { fingerprint, key, time }
    }
    return { key: newest.key, fingerprint: newest.fingerprint }
  }

  /**
   * Mint a key without touching the old ones, so a reset never makes existing
   * blobs unreadable.
   * @param {Buffer} [key]
   * @returns {Promise<{ key: Buffer, fingerprint: string }>}
   */
  async create(key = randomBytes(KEY_BYTES)) {
    if (key.length !== KEY_BYTES) throw new Error('a checkpoint key must be 32 bytes')
    const fingerprint = fingerprintText(fingerprintOf(key))
    await fs.mkdir(this.dir, { recursive: true })
    await fs.chmod(this.dir, 0o700).catch(() => {})
    const file = path.join(this.dir, `${fingerprint}.key`)
    try {
      await fs.writeFile(file, key, { flag: 'wx', mode: 0o600 })
    } catch (error) {
      if (!error || error.code !== 'EEXIST') throw error
    }
    const keys = await this.load()
    keys.set(fingerprint, key)
    return { key, fingerprint }
  }

  /**
   * @param {Buffer} buffer
   * @returns {Promise<Buffer | null>} the key that sealed this buffer, or null
   */
  async keyFor(buffer) {
    const keys = await this.load()
    return keys.get(fingerprintText(headerFingerprint(buffer))) ?? null
  }
}

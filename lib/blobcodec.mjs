// Blob payload codec: compress what compresses, keep the rest exactly as it was.
//
// Checkpoint blobs are file contents keyed by their sha1, so the stored bytes
// must stay recoverable to the last byte. Everything here is a transport
// detail: a packed blob carries a short header naming the codec, and anything
// without that header (including every blob written by an older build) is
// returned untouched, so the format is additive rather than a migration.
//
// Compression happens before encryption, never after: ciphertext does not
// compress, and unpacking after unsealing keeps the two concerns independent.

import { promisify } from 'node:util'
import zlib from 'node:zlib'

const zstdCompress = typeof zlib.zstdCompress === 'function' ? promisify(zlib.zstdCompress) : null
const zstdDecompress = typeof zlib.zstdDecompress === 'function' ? promisify(zlib.zstdDecompress) : null
const gzip = promisify(zlib.gzip)
const gunzip = promisify(zlib.gunzip)

const MAGIC = Buffer.from('DSKZ', 'ascii')
const VERSION = 1
const CODEC_ZSTD = 1
const CODEC_GZIP = 2
const HEADER_BYTES = MAGIC.length + 2

/** Below this a header costs more than the compression can save. */
export const PACK_MIN_BYTES = 128

/** A pack has to win at least this share of the original to be worth it. */
const PACK_MIN_RATIO = 0.92

/**
 * Compress a payload for storage.
 * @param {Buffer} buffer
 * @returns {Promise<Buffer>} the same buffer when packing would not help
 */
export async function pack(buffer) {
  if (buffer.length < PACK_MIN_BYTES) return buffer
  const codec = zstdCompress !== null ? CODEC_ZSTD : CODEC_GZIP
  let body
  try {
    body = zstdCompress !== null ? await zstdCompress(buffer) : await gzip(buffer)
  } catch {
    return buffer
  }
  if (body.length >= buffer.length * PACK_MIN_RATIO) return buffer
  return Buffer.concat([MAGIC, Buffer.from([VERSION, codec]), body])
}

/**
 * @param {Buffer} buffer
 * @returns {boolean} whether this payload was packed by {@link pack}
 */
export function isPacked(buffer) {
  return buffer.length >= HEADER_BYTES && buffer.subarray(0, MAGIC.length).equals(MAGIC)
}

/**
 * Restore a stored payload. Raw payloads pass through unchanged, which is what
 * lets a store written by an older build keep opening.
 * @param {Buffer} buffer
 * @returns {Promise<Buffer>}
 */
export async function unpack(buffer) {
  if (!isPacked(buffer)) return buffer
  const version = buffer[MAGIC.length]
  const codec = buffer[MAGIC.length + 1]
  if (version !== VERSION) throw new Error(`unsupported blob codec version ${version}`)
  const body = buffer.subarray(HEADER_BYTES)
  if (codec === CODEC_ZSTD) {
    if (zstdDecompress === null) throw new Error('this runtime cannot read zstd blobs')
    return zstdDecompress(body)
  }
  if (codec === CODEC_GZIP) return gunzip(body)
  throw new Error(`unknown blob codec ${codec}`)
}

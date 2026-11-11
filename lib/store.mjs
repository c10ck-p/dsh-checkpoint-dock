// lib/store.mjs — capture, seal, keep, undo/redo, and review one turn's edits.
//
// The unit is a (sessionId, turn) record. The first time a file tool is about to
// mutate a path in a turn we read the bytes that are still on disk and store
// them in a content-addressed blob. At turn end we read the settled bytes,
// store the after image as well, count the line delta, and mark the record
// sealed. Undo restores before; redo restores after. Both sides are preflighted
// against the current bytes so nothing is overwritten after an outside edit.

import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { KeyRing, isSealed, seal, unseal } from './vault.mjs'

const MAX_FILE_BYTES = 4 * 1024 * 1024
const MAX_DIFF_CELLS = 4_000_000
const MAX_PATCH_LINES = 4000
const MAX_PATCH_CHARS = 256 * 1024
const RECORD_VERSION = 2
const RECENT_KEEP = 30
const KEEP_MIN = 5
const KEEP_MAX = 500
const DEFAULT_CONFIG = Object.freeze({ autoClean: false, keep: RECENT_KEEP, encrypt: false })
const LOCK_TIMEOUT_MS = 5000
const LOCK_STALE_MS = 120_000

/** @param {Buffer} buffer */
export function hashBytes(buffer) {
  return createHash('sha1').update(buffer).digest('hex')
}

/** @param {Buffer} buffer */
export function isBinary(buffer) {
  return buffer.includes(0)
}

/**
 * Split bytes into diffable lines. CRLF is normalized so a line-ending-only
 * rewrite is not reported as a whole-file change.
 * @param {Buffer | null} buffer
 * @returns {string[]}
 */
function linesOf(buffer) {
  if (buffer === null) return []
  let text = buffer.toString('utf8')
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  text = text.replace(/\r\n/g, '\n')
  if (text.length === 0) return []
  const lines = text.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

/**
 * Line-level add/delete counts from a longest-common-subsequence table.
 * Files over the cell budget get the cheap length delta instead of stalling
 * the Host on a quadratic table.
 * @param {Buffer | null} before
 * @param {Buffer | null} after
 * @returns {{added: number, deleted: number, approximate?: boolean}}
 */
export function diffStat(before, after) {
  if (before === null) return { added: linesOf(after).length, deleted: 0 }
  if (after === null) return { added: 0, deleted: linesOf(before).length }
  const a = linesOf(before)
  const b = linesOf(after)
  if (a.length === 0) return { added: b.length, deleted: 0 }
  if (b.length === 0) return { added: 0, deleted: a.length }
  if (a.length * b.length > MAX_DIFF_CELLS) {
    return {
      added: Math.max(0, b.length - a.length),
      deleted: Math.max(0, a.length - b.length),
      approximate: true,
    }
  }
  let previous = new Uint32Array(b.length + 1)
  let current = new Uint32Array(b.length + 1)
  for (let i = 1; i <= a.length; i += 1) {
    current[0] = 0
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = a[i - 1] === b[j - 1]
        ? previous[j - 1] + 1
        : Math.max(previous[j], current[j - 1])
    }
    const swap = previous
    previous = current
    current = swap
  }
  const lcs = previous[b.length]
  return { added: b.length - lcs, deleted: a.length - lcs }
}

/** @param {string} file */
function pathKey(file) {
  return process.platform === 'win32' ? file.toLowerCase() : file
}

/** @param {string} file */
function modeOf(stat) {
  return process.platform === 'win32' ? null : stat.mode & 0o777
}

/** @param {string} file */
async function readMaybe(file) {
  try {
    const stat = await fs.stat(file)
    if (!stat.isFile()) {
      return { exists: false, buffer: null, oversized: true, unreadable: true, mode: null }
    }
    if (stat.size > MAX_FILE_BYTES) {
      return { exists: true, buffer: null, oversized: true, mode: modeOf(stat) }
    }
    return { exists: true, buffer: await fs.readFile(file), oversized: false, mode: modeOf(stat) }
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return { exists: false, buffer: null, oversized: false, mode: null }
    }
    // An unreadable file is an unknown state, not proof that it was deleted.
    // Treat it like an oversized file: capture skips it and undo refuses it,
    // instead of throwing and leaving the checkpoint stuck open.
    return { exists: false, buffer: null, oversized: true, unreadable: true, mode: null }
  }
}

/**
 * True when every existing component of `file` resolves inside `cwd`, and the
 * file itself is not a symlink. This closes the junction/symlink escape that a
 * lexical `path.relative` check cannot see on Windows.
 * @param {string} cwd
 * @param {string} file
 */
async function isPathWithin(cwd, file) {
  let root
  try {
    root = await fs.realpath(cwd)
  } catch {
    return false
  }
  const prefix = root.endsWith(path.sep) ? root : root + path.sep
  let resolved
  try {
    if ((await fs.lstat(file)).isSymbolicLink()) return false
    resolved = await fs.realpath(file)
  } catch (error) {
    if (!error || error.code !== 'ENOENT') return false
    let dir = path.dirname(file)
    while (true) {
      try {
        const real = await fs.realpath(dir)
        resolved = path.join(real, path.basename(file))
        break
      } catch (inner) {
        if (!inner || inner.code !== 'ENOENT') return false
        const parent = path.dirname(dir)
        if (parent === dir) return false
        dir = parent
      }
    }
  }
  return resolved === root || resolved.startsWith(prefix)
}

const SENSITIVE_NAMES = [
  /^\.env(\..*)?$/i,
  /^id_(rsa|ed25519|ecdsa|dsa)(\.pub)?$/i,
  /^credentials(\..*)?$/i,
  /^\.netrc$/i,
  /^\.npmrc$/i,
  /^\.yarnrc(\.ya?ml)?$/i,
  /^\.pypirc$/i,
  /^\.git-credentials$/i,
  /^kubeconfig$/i,
  /^secrets\.(ya?ml|json)$/i,
]
const SENSITIVE_EXTENSIONS = /\.(pem|key|p12|pfx|jks|keystore|kdbx)$/i
const SENSITIVE_DIRS = new Set(['.ssh', '.aws', '.gnupg', '.docker'])

/**
 * Never put private-key-ish bytes into a checkpoint. This is a default policy,
 * not a security boundary: users can still edit these files, they just cannot
 * restore them through this plugin.
 * @param {string} cwd
 * @param {string} file
 */
export function isSensitivePath(cwd, file) {
  const relative = path.relative(cwd, file)
  if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return false
  }
  const parts = relative.split(path.sep)
  if (parts.some((part) => SENSITIVE_DIRS.has(part.toLowerCase()))) return true
  const base = parts[parts.length - 1]
  return SENSITIVE_NAMES.some((pattern) => pattern.test(base)) || SENSITIVE_EXTENSIONS.test(base)
}

let tempCounter = 0

/** @param {string} file */
function tempPathFor(file) {
  // Same directory as the target, so the rename stays on one volume and stays
  // atomic. The name is short on purpose: appending `.pid.ms.tmp` to an already
  // long Windows path can cross MAX_PATH, and a per-process counter keeps two
  // writers of the same directory apart.
  tempCounter = (tempCounter + 1) % 1_000_000
  return path.join(path.dirname(file), `.dsh-ckpt-${process.pid}-${tempCounter}.tmp`)
}

/**
 * Rename with a short backoff. Windows antivirus and indexers hold handles for
 * a few hundred milliseconds after a write, which turns rename into EPERM.
 * @param {string} from @param {string} to
 */
async function renameWithRetry(from, to) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fs.rename(from, to)
    } catch (error) {
      const busy = error && (error.code === 'EPERM' || error.code === 'EEXIST' || error.code === 'EBUSY')
      if (!busy || attempt >= 6) throw error
      await new Promise((resolve) => setTimeout(resolve, 25 * attempt))
    }
  }
}

/** @param {string} file @param {Buffer} buffer @param {number | null} [mode] */
async function writeAtomic(file, buffer, mode) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const temporary = tempPathFor(file)
  try {
    await fs.writeFile(temporary, buffer)
    // Never fall back to an in-place copy: a crash mid-copy would truncate the
    // user's file. Retrying the rename is the only safe fallback, and a locked
    // destination is reported to the caller instead of being papered over.
    await renameWithRetry(temporary, file)
  } finally {
    await removeMaybe(temporary)
  }
  if (typeof mode === 'number' && process.platform !== 'win32') {
    await fs.chmod(file, mode & 0o777).catch(() => {})
  }
}

/** @param {string} file */
async function removeMaybe(file) {
  try {
    await fs.unlink(file)
  } catch (error) {
    if (!error || error.code !== 'ENOENT') throw error
  }
}

/**
 * A single-hunk patch around the changed middle. This is deliberately simpler
 * than a full LCS backtrack: it is cheap, predictable, and enough to show the
 * lines this plugin captured. Exact +/- counts still come from diffStat().
 * @param {Buffer | null} before
 * @param {Buffer | null} after
 */
function buildPatch(before, after) {
  const a = linesOf(before)
  const b = linesOf(after)
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1
    endB -= 1
  }
  const removed = a.slice(start, endA)
  const added = b.slice(start, endB)
  if (removed.length === 0 && added.length === 0) {
    return { patch: '', added: 0, deleted: 0, truncated: false }
  }
  if (removed.length + added.length > MAX_PATCH_LINES) {
    return { patch: '', added: added.length, deleted: removed.length, truncated: true }
  }
  const contextBefore = a.slice(Math.max(0, start - 3), start)
  const contextAfter = a.slice(endA, Math.min(a.length, endA + 3))
  const oldStart = Math.max(0, start - 3) + 1
  const newStart = Math.max(0, start - 3) + 1
  const oldCount = contextBefore.length + removed.length + contextAfter.length
  const newCount = contextBefore.length + added.length + contextAfter.length
  const lines = [`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`]
  for (const line of contextBefore) lines.push(` ${line}`)
  for (const line of removed) lines.push(`-${line}`)
  for (const line of added) lines.push(`+${line}`)
  for (const line of contextAfter) lines.push(` ${line}`)
  const patch = lines.join('\n')
  if (patch.length > MAX_PATCH_CHARS) {
    return { patch: '', added: added.length, deleted: removed.length, truncated: true }
  }
  return { patch, added: added.length, deleted: removed.length, truncated: false }
}

export class EditCheckpointStore {
  /**
   * @param {string} root
   * @param {{
   *   titleResolver?: (sessionId: string) => string|Promise<string>,
   *   sessionLookup?: (sessionId: string) => boolean,
   *   archivedLookup?: () => Set<string>|null,
   *   logger?: any,
   * }} [options]
   */
  constructor(root, options = {}) {
    this.root = root
    this.chain = Promise.resolve()
    this.titleResolver = typeof options.titleResolver === 'function' ? options.titleResolver : null
    // `ctx.sessions.get` is the authoritative liveness check; `sessionsRoot` is
    // the on-disk fallback for sessions DSH knows but has not loaded.
    this.sessionLookup = typeof options.sessionLookup === 'function' ? options.sessionLookup : null
    // Archiving only adds an id to a registry set; the session and its files
    // stay. The storage view labels those rows instead of hiding them.
    this.archivedLookup = typeof options.archivedLookup === 'function' ? options.archivedLookup : null
    this.sessionsRoot = path.resolve(root, '..', 'sessions')
    this.logger = options.logger || null
    // DSH keeps the generated session title in its projection cache. It is not
    // part of a checkpoint record, so read it lazily when the history view asks
    // for records. The cache is outside the store root by one level.
    this.sessionCacheDir = path.resolve(root, '..', 'storages', 'session_projcache', 'sessions')
    this.sessionTitleCache = new Map()
    // Per-session last-write failure, surfaced by the storage panel. A capture
    // that fails silently is a checkpoint the user thinks exists and does not.
    this.failures = new Map()
    // User settings (auto clean + how many recent checkpoints to keep). Stored
    // next to the records so every DSH workspace shares one answer.
    this.configPath = path.join(root, 'config.json')
    this.configCache = null
    // Optional encryption. Off by default: a lost key turns every checkpoint
    // into unreadable bytes, which is worse than plaintext for most people.
    // Keys live outside the store so copying the store does not copy the key.
    this.keysDir = options.keysDir || path.resolve(root, '..', 'checkpoint-keys')
    this.ring = new KeyRing(this.keysDir)
  }

  /**
   * @param {string} sessionId
   * @param {any} error
   */
  noteFailure(sessionId, error) {
    const id = String(sessionId || '')
    if (id === '') return
    this.failures.set(id, {
      message: error && error.message ? String(error.message) : String(error),
      at: Date.now(),
    })
  }

  /** @param {string} sessionId */
  clearFailure(sessionId) {
    this.failures.delete(String(sessionId || ''))
  }

  /**
   * Record that a write for this session succeeded again, so a stale error does
   * not stick to the panel forever.
   * @param {string} sessionId
   */
  noteSuccess(sessionId) {
    const id = String(sessionId || '')
    const failure = this.failures.get(id)
    if (failure !== undefined) this.failures.delete(id)
  }

  /** @param {string} message */
  warn(message) {
    try {
      if (this.logger && typeof this.logger.warn === 'function') this.logger.warn(message)
    } catch {
      // Logging must never break a checkpoint operation.
    }
  }

  /**
   * Settings, merged over the defaults and clamped, so a hand-edited config
   * file can never ask for "keep 0" or "keep 100000".
   * @param {any} raw
   * @returns {{autoClean: boolean, keep: number, encrypt: boolean}}
   */
  static normalizeConfig(raw) {
    const source = raw && typeof raw === 'object' ? raw : {}
    const keepRaw = Number(source.keep)
    const keep = Number.isFinite(keepRaw) && keepRaw >= KEEP_MIN && keepRaw <= KEEP_MAX
      ? Math.round(keepRaw)
      : DEFAULT_CONFIG.keep
    return {
      autoClean: source.autoClean === true,
      keep,
      encrypt: source.encrypt === true,
    }
  }

  /**
   * Current settings. Cached after the first read; the file is small and the
   * panel asks for it on every poll.
   * @returns {Promise<{autoClean: boolean, keep: number, encrypt: boolean}>}
   */
  async readConfig() {
    if (this.configCache !== null) return this.configCache
    let raw = null
    try {
      raw = JSON.parse(await fs.readFile(this.configPath, 'utf8'))
    } catch (error) {
      if (error && error.code !== 'ENOENT') this.warn(`checkpoint config is unreadable: ${error.message}`)
      raw = null
    }
    this.configCache = EditCheckpointStore.normalizeConfig(raw)
    return this.configCache
  }

  /**
   * Patch the settings. Only known keys are written, so a stale client cannot
   * smuggle extra fields onto disk.
   * @param {any} patch
   * @returns {Promise<{ok: boolean, autoClean?: boolean, keep?: number, encrypt?: boolean, message?: string}>}
   */
  async setConfig(patch) {
    const source = patch && typeof patch === 'object' ? patch : {}
    const current = await this.readConfig()
    const next = EditCheckpointStore.normalizeConfig({
      autoClean: source.autoClean === undefined ? current.autoClean : source.autoClean,
      keep: source.keep === undefined ? current.keep : source.keep,
      encrypt: source.encrypt === undefined ? current.encrypt : source.encrypt,
    })
    try {
      await this.exclusive(async () => {
        await writeAtomic(this.configPath, Buffer.from(JSON.stringify(next, null, 2) + '\n', 'utf8'))
      })
    } catch (error) {
      return { ok: false, message: error && error.message ? String(error.message) : String(error) }
    }
    this.configCache = next
    return { ok: true, ...next }
  }

  /**
   * Automatic cleanup after a checkpoint is sealed: when the session holds more
   * than `keep` records, clean the oldest content down to that number. Pinned
   * records are never touched; per-turn unit is respected by clean().
   * @param {string} sessionId
   * @returns {Promise<null|{ok: boolean, records: number, bytes: number}>}
   */
  async maybeAutoClean(sessionId) {
    const config = await this.readConfig()
    if (config.autoClean !== true) return null
    let records = []
    try {
      records = await this.loadAll(sessionId)
    } catch (error) {
      this.warn(`auto clean skipped: ${error && error.message ? error.message : error}`)
      return null
    }
    if (records.length <= config.keep) return null
    try {
      const result = await this.clean(sessionId, config.keep)
      if (result && (result.records || 0) > 0) {
        this.warn(`auto cleaned ${result.records} checkpoint(s) for ${sessionId}`)
      }
      return result
    } catch (error) {
      this.warn(`auto clean failed: ${error && error.message ? error.message : error}`)
      return null
    }
  }

  /** @param {string} sessionId @returns {Promise<string>} */
  async sessionTitle(sessionId) {
    const id = String(sessionId || '')
    if (!/^session-[A-Za-z0-9-]+$/.test(id)) return ''
    const cached = this.sessionTitleCache.get(id)
    if (cached && Date.now() - cached.at < 15_000) return cached.title
    let title = ''
    // Public path first: the live Session plus the session-title service.
    if (this.titleResolver) {
      try {
        const resolved = await this.titleResolver(id)
        if (typeof resolved === 'string') title = resolved.replace(/\s+/g, ' ').trim()
      } catch {
        title = ''
      }
    }
    if (title === '') {
      try {
        const text = await fs.readFile(path.join(this.sessionCacheDir, `${id}.json`), 'utf8')
        const parsed = JSON.parse(text)
        const row = parsed && parsed.record && parsed.record.rows && parsed.record.rows.title
        const value = row && (row.val !== undefined ? row.val : row.text)
        if (typeof value === 'string') title = value.replace(/\s+/g, ' ').trim()
      } catch {
        title = ''
      }
    }
    if (title === '' && cached) title = cached.title
    this.sessionTitleCache.set(id, { title, at: Date.now() })
    return title
  }

  /** @param {string[]} sessionIds @returns {Promise<Map<string,string>>} */
  async sessionTitles(sessionIds) {
    const unique = Array.from(new Set(sessionIds.map((id) => String(id || '')).filter(Boolean)))
    const pairs = await Promise.all(unique.map(async (id) => [id, await this.sessionTitle(id)]))
    return new Map(pairs)
  }

  /** @template T @param {() => Promise<T>} operation @returns {Promise<T>} */
  queue(operation) {
    const next = this.chain.then(operation, operation)
    this.chain = next.then(() => undefined, () => undefined)
    return next
  }

  /**
   * Serialize in-process work and take the cross-process lock for the actual
   * mutation. Reads do not take the lock.
   * @template T @param {() => Promise<T>} operation @returns {Promise<T>}
   */
  exclusive(operation) {
    return this.queue(async () => {
      const release = await this.acquireLock()
      try {
        return await operation()
      } finally {
        await release()
      }
    })
  }

  /** @returns {Promise<() => Promise<void>>} */
  async acquireLock() {
    await fs.mkdir(this.root, { recursive: true })
    // The store holds verbatim file contents: keep it readable by its owner
    // only. Windows ignores the mode on chmod but honours the ACL that already
    // belongs to the profile directory, so this stays best-effort.
    await fs.chmod(this.root, 0o700).catch(() => {})
    const lockFile = path.join(this.root, '.store.lock')
    const started = Date.now()
    while (true) {
      try {
        const handle = await fs.open(lockFile, 'wx')
        try {
          await handle.writeFile(JSON.stringify({ pid: process.pid, time: Date.now() }))
        } finally {
          await handle.close()
        }
        let released = false
        return async () => {
          if (released) return
          released = true
          await fs.unlink(lockFile).catch(() => {})
        }
      } catch (error) {
        if (!error || (error.code !== 'EEXIST' && error.code !== 'EPERM')) throw error
        let stale = false
        try {
          const stat = await fs.stat(lockFile)
          stale = Date.now() - stat.mtimeMs > LOCK_STALE_MS
        } catch {
          stale = false
        }
        if (stale) {
          await fs.unlink(lockFile).catch(() => {})
          continue
        }
        if (Date.now() - started > LOCK_TIMEOUT_MS) {
          throw new Error('checkpoint store is busy (another DSH process holds the lock)')
        }
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
    }
  }

  /** @param {string} sessionId @param {number} turn */
  recordFile(sessionId, turn) {
    // The turn becomes a file name, so it must be a positive whole number:
    // anything else could climb out of the records directory.
    if (!Number.isSafeInteger(turn) || turn < 0) throw new Error('invalid checkpoint turn')
    const key = createHash('sha1').update(String(sessionId)).digest('hex').slice(0, 24)
    return path.join(this.root, 'records', key, `${turn}.json`)
  }

  /** @param {string} hash */
  blobFile(hash) {
    return path.join(this.root, 'blobs', hash.slice(0, 2), hash)
  }

  /** @param {string} hash */
  sealedFile(hash) {
    return `${this.blobFile(hash)}.dsc`
  }

  /**
   * How large a blob is on disk, whichever way it is stored, or null when it is
   * gone. Sizes drive the storage panel, so a sealed blob must not look empty.
   * @param {string} hash
   * @returns {Promise<null|{bytes: number, sealed: boolean}>}
   */
  async blobSize(hash) {
    for (const [file, sealed] of [[this.sealedFile(hash), true], [this.blobFile(hash), false]]) {
      const stat = await fs.stat(file).catch(() => null)
      if (stat !== null) return { bytes: stat.size, sealed }
    }
    return null
  }

  /**
   * Every file a blob may occupy, sealed first: a sealed copy wins, so enabling
   * encryption can never be silently undone by reading the old plaintext.
   * @param {string} hash
   * @returns {string[]}
   */
  blobFiles(hash) {
    return [this.sealedFile(hash), this.blobFile(hash)]
  }

  /** @param {Buffer} buffer @returns {Promise<string>} */
  async writeBlob(buffer) {
    const hash = hashBytes(buffer)
    const config = await this.readConfig()
    const sealed = config.encrypt === true
    const target = sealed ? this.sealedFile(hash) : this.blobFile(hash)
    const plain = this.blobFile(hash)
    if ((await fs.stat(this.sealedFile(hash)).catch(() => null)) !== null ||
        (await fs.stat(plain).catch(() => null)) !== null) {
      // Content-addressed: an existing copy already holds these exact bytes.
      return hash
    }
    await fs.mkdir(path.dirname(target), { recursive: true })
    let payload = buffer
    if (sealed) {
      const { key } = await this.ring.current()
      payload = seal(key, buffer)
    }
    try {
      await fs.writeFile(target, payload, { flag: 'wx' })
    } catch (error) {
      if (!error || error.code !== 'EEXIST') throw error
    }
    return hash
  }

  /** @param {string} hash @returns {Promise<Buffer>} */
  async readBlob(hash) {
    const sealedBuffer = await fs.readFile(this.sealedFile(hash)).catch(() => null)
    if (sealedBuffer !== null) return unseal(await this.ring.keyFor(sealedBuffer), sealedBuffer)
    return fs.readFile(this.blobFile(hash))
  }

  /**
   * Remove both possible copies of a blob and report what that freed.
   * @param {string} hash
   * @returns {Promise<number>}
   */
  async deleteBlob(hash) {
    let bytes = 0
    for (const file of this.blobFiles(hash)) {
      const stat = await fs.stat(file).catch(() => null)
      if (stat === null) continue
      bytes += stat.size
      await fs.unlink(file).catch(() => {})
    }
    return bytes
  }

  /**
   * Re-encrypt plaintext blobs, newest first is irrelevant here: the store is
   * content addressed, so a blob just moves from `<hash>` to `<hash>.dsc` once.
   * Batched so a large store does not stall a turn.
   * @param {number} [limit]
   * @returns {Promise<{sealed: number, plain: number}>}
   */
  async migrateBlobs(limit = 40) {
    const config = await this.readConfig()
    if (config.encrypt !== true) return { sealed: 0, plain: 0 }
    const dir = path.join(this.root, 'blobs')
    const buckets = await fs.readdir(dir).catch(() => [])
    let sealed = 0
    let plain = 0
    for (const bucket of buckets) {
      if (sealed >= limit) break
      const bucketDir = path.join(dir, bucket)
      const names = await fs.readdir(bucketDir).catch(() => [])
      for (const name of names) {
        if (sealed >= limit) break
        if (name.endsWith('.dsc')) {
          sealed += 1
          continue
        }
        const file = path.join(bucketDir, name)
        const buffer = await fs.readFile(file).catch(() => null)
        if (buffer === null) continue
        plain += 1
        if (isSealed(buffer)) continue
        const { key } = await this.ring.current()
        await fs.writeFile(`${file}.dsc`, seal(key, buffer), { flag: 'wx' }).catch((error) => {
          if (!error || error.code !== 'EEXIST') throw error
        })
        await fs.unlink(file).catch(() => {})
        sealed += 1
        plain -= 1
      }
    }
    return { sealed, plain }
  }

  /** @param {string} sessionId @param {number} turn */
  async load(sessionId, turn) {
    return this.loadFile(this.recordFile(sessionId, turn))
  }

  /**
   * Read one record file. A file that cannot be parsed, or that was written by
   * an incompatible version, is moved aside instead of throwing: one bad file
   * must not take the session's keep/undo/redo/revert down with it.
   * @param {string} file
   * @returns {Promise<any | null>}
   */
  async loadFile(file) {
    let raw
    try {
      raw = await fs.readFile(file, 'utf8')
    } catch (error) {
      if (error && error.code === 'ENOENT') return null
      throw error
    }
    try {
      const record = JSON.parse(raw)
      if (!record || (record.version !== 1 && record.version !== RECORD_VERSION)) {
        throw new Error(`unsupported checkpoint record version ${record && record.version}`)
      }
      return record
    } catch (error) {
      await this.quarantine(file, error)
      return null
    }
  }

  /**
   * Move a corrupt record out of the numbered range so later reads stop hitting
   * it. The bytes are kept, renamed in place, for manual recovery.
   * @param {string} file @param {any} error
   */
  async quarantine(file, error) {
    this.warn(`checkpoint record quarantined: ${path.basename(file)} — ${error && error.message ? error.message : String(error)}`)
    try {
      await fs.rename(file, `${file}.corrupt-${Date.now()}`)
    } catch {
      // Locked or read-only: leaving it in place is still safe, because
      // loadFile() reports null instead of rethrowing on every read.
    }
  }

  /** @param {string} sessionId */
  async loadAll(sessionId) {
    const dir = path.dirname(this.recordFile(sessionId, 0))
    let names
    try {
      names = await fs.readdir(dir)
    } catch (error) {
      if (error && error.code === 'ENOENT') return []
      throw error
    }
    const records = []
    for (const name of names) {
      if (!/^\d+\.json$/.test(name)) continue
      const turn = Number(name.slice(0, -'.json'.length))
      if (!Number.isInteger(turn)) continue
      let record = null
      try {
        record = await this.load(sessionId, turn)
      } catch (error) {
        // Unparsable files are quarantined inside load(); this catch covers real
        // I/O errors on one file. Skip it instead of failing the whole session.
        this.warn(`skipped checkpoint ${sessionId}:${turn} — ${error && error.message ? error.message : String(error)}`)
        continue
      }
      if (record !== null) records.push(record)
    }
    records.sort((left, right) => left.turn - right.turn)
    return records
  }

  /** @param {any} record */
  async save(record) {
    record.version = RECORD_VERSION
    const file = this.recordFile(record.sessionId, record.turn)
    await writeAtomic(file, Buffer.from(JSON.stringify(record, null, 2), 'utf8'), null)
    // A successful write clears the session's last failure: the panel warning
    // should disappear once the store works again.
    this.noteSuccess(record.sessionId)
  }

  /**
   * Capture a path before a file tool mutates it. Only the first mutation of a
   * path in a turn is captured; later writes keep the same before bytes.
   *
   * `before` lets a caller that never saw the pre-image hand one in: the
   * workspace-changes service reports the previous contents of paths written
   * outside the file tools, and its reverse-applied text is the only record of
   * what those paths held. Undefined means "read the file now".
   * @param {{sessionId: string, cwd: string, turn: number, absolute: string, prompt: string, before?: {exists: boolean, buffer: Buffer | null}}} capture
   */
  async capture(capture) {
    return this.exclusive(async () => {
      const { sessionId, cwd, turn, absolute, prompt, before: provided, renamedFrom } = capture
      const record = await this.load(sessionId, turn) ?? {
        version: RECORD_VERSION,
        id: `${sessionId}:${turn}`,
        sessionId,
        turn,
        cwd,
        time: Date.now(),
        prompt,
        status: 'open',
        seq: 0,
        pinned: false,
        files: [],
      }
      // A late write after the turn-end seal must not append entries to a
      // settled record: its before/after state is already final.
      if (record.status !== 'open') return
      if (record.files.some((file) => pathKey(file.path) === pathKey(absolute))) return
      // Junction/symlink targets can live outside the workspace even when the
      // lexical path looks contained; never read or restore through them.
      if (!(await isPathWithin(cwd, absolute))) return
      if (isSensitivePath(cwd, absolute)) return
      const before = provided === undefined ? await readMaybe(absolute) : provided
      if (before.oversized) return
      const beforeSha = before.buffer === null ? null : await this.writeBlob(before.buffer)
      const relative = path.relative(cwd, absolute)
      const display = (relative === '' ? path.basename(absolute) : relative).split(path.sep).join('/')
      record.files.push({
        path: absolute,
        display,
        existedBefore: before.exists,
        beforeSha,
        beforeMode: before.mode ?? null,
        afterSha: null,
        afterMode: null,
        existedAfter: null,
        afterStored: false,
        added: 0,
        deleted: 0,
        binary: before.buffer === null ? false : isBinary(before.buffer),
        oversized: false,
        approximate: false,
        contentRemoved: false,
        renamedFrom: typeof renamedFrom === 'string' && renamedFrom !== ''
          ? relativeDisplay(cwd, renamedFrom)
          : '',
      })
      if (record.prompt === '' && prompt !== '') record.prompt = prompt
      await this.save(record)
    })
  }

  /**
   * Whether a turn's record already covers a path. The file-tool hooks capture
   * a path before the mutation; the workspace-changes pass runs later and must
   * not spend a comparison on a path that is already recorded.
   * @param {string} sessionId
   * @param {number} turn
   * @param {string} absolute
   * @returns {Promise<boolean>}
   */
  async hasFile(sessionId, turn, absolute) {
    const record = await this.load(sessionId, turn)
    if (record === null) return false
    return record.files.some((file) => pathKey(file.path) === pathKey(absolute))
  }

  /**
   * Attach the announcing `workspace/changes` sequence to a record. The event is
   * appended right before `turn/end`, so either listener may run first; this is
   * idempotent and lets the review card address the right snapshot.
   * @param {string} sessionId
   * @param {number} turn
   * @param {number} seq
   */
  async noteSeq(sessionId, turn, seq) {
    if (!Number.isInteger(seq) || seq <= 0) return
    return this.exclusive(async () => {
      const record = await this.load(sessionId, turn)
      if (record === null || record.seq === seq) return
      record.seq = seq
      await this.save(record)
    })
  }

  /**
   * Settle a turn: read every captured file after the turn, store the after
   * image, count the delta, and drop paths whose bytes did not actually change.
   * @param {string} sessionId
   * @param {number} turn
   * @param {number} seq - the announcing event sequence, when known.
   * @param {string} [commit] - HEAD at turn end, when the workspace is a repo.
   */
  async seal(sessionId, turn, seq, commit) {
    return this.exclusive(async () => {
      const record = await this.load(sessionId, turn)
      if (record === null) return
      if (typeof commit === 'string' && commit !== '') record.commit = commit
      await this.sealLoaded(record, seq, false)
    }).then(async (result) => {
      // Re-encrypt a slice of the backlog after each turn instead of stalling
      // the first turn after the switch. Failures only warn: ciphertext is
      // never lost, the plaintext file is simply kept for a later pass.
      const config = await this.readConfig()
      if (config.encrypt === true) {
        await this.migrateBlobs(40).catch((error) => {
          this.warn(`checkpoint encryption backlog: ${error && error.message ? error.message : error}`)
        })
      }
      return result
    })
  }

  /**
   * Seal a record already loaded under the exclusive lock. Shared with
   * recoverOpen(); recovery marks the record so the UI can show that the turn
   * ended abnormally.
   * @param {any} record
   * @param {number} seq
   * @param {boolean} recovered
   */
  async sealLoaded(record, seq, recovered) {
    if (record === null || record.status !== 'open') return
    const files = []
    for (const file of record.files) {
      const after = await readMaybe(file.path)
      const before = file.beforeSha === null ? null : await this.readBlob(file.beforeSha).catch(() => null)
      if (before === null && file.existedBefore) {
        file.oversized = true
        files.push(file)
        continue
      }
      if (after.oversized) {
        file.oversized = true
        files.push(file)
        continue
      }
      if (!file.existedBefore && !after.exists) continue
      if (file.existedBefore && !after.exists) {
        file.afterSha = null
        file.afterMode = null
        file.existedAfter = false
        file.afterStored = false
        file.deleted = linesOf(before).length
        file.added = 0
        files.push(file)
        continue
      }
      const afterSha = hashBytes(after.buffer)
      if (file.existedBefore && afterSha === file.beforeSha) continue
      file.afterSha = await this.writeBlob(after.buffer)
      file.afterMode = after.mode ?? null
      file.existedAfter = true
      file.afterStored = true
      file.binary = isBinary(before ?? after.buffer) || isBinary(after.buffer)
      if (!file.binary) {
        const stat = diffStat(before, after.buffer)
        file.added = stat.added
        file.deleted = stat.deleted
        file.approximate = stat.approximate === true
      }
      files.push(file)
    }
    if (files.length === 0) {
      await removeMaybe(this.recordFile(record.sessionId, record.turn))
      return
    }
    record.files = files
    record.status = 'sealed'
    record.sealedAt = Date.now()
    if (Number.isInteger(seq) && seq > 0) record.seq = seq
    if (recovered === true) {
      record.recovered = true
      record.recoveredAt = Date.now()
    }
    record.added = files.reduce((sum, file) => sum + (file.added || 0), 0)
    record.deleted = files.reduce((sum, file) => sum + (file.deleted || 0), 0)
    await this.save(record)
  }

  /**
   * Seal open records older than the just-started turn. A crash can leave the
   * last record open forever, which used to block keep/revert. The next user
   * message is a natural point to settle it against the current disk.
   * @param {string} sessionId
   * @param {number} beforeTurn
   */
  async recoverOpen(sessionId, beforeTurn) {
    return this.exclusive(async () => {
      const records = await this.loadAll(sessionId)
      for (const record of records) {
        if (record.status !== 'open' || record.turn >= beforeTurn) continue
        await this.sealLoaded(record, record.seq || 0, true)
      }
    })
  }

  /** @param {string} sessionId @param {number} turn */
  async get(sessionId, turn) {
    await this.chain
    const record = await this.load(sessionId, turn)
    return record === null ? null : publicRecord(record)
  }

  /**
   * Every checkpoint this session has recorded, oldest turn first.
   * @param {string} sessionId
   * @param {{limit?: number, offset?: number, filter?: string}} [options]
   */
  async list(sessionId, options = {}) {
    await this.chain
    const all = await this.loadAll(sessionId)
    let filtered = all
    if (options.filter === 'pinned') filtered = all.filter((record) => record.pinned === true)
    else if (options.filter === 'undone') filtered = all.filter((record) => record.status === 'undone')
    else if (options.filter === 'kept') filtered = all.filter((record) => record.status === 'kept')
    const total = filtered.length
    const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : (options.limit === 0 ? 0 : 50)
    const offset = Number.isInteger(options.offset) && options.offset > 0 ? options.offset : 0
    let slice
    if (limit === 0) {
      slice = filtered
    } else {
      const end = Math.max(0, filtered.length - offset)
      const start = Math.max(0, end - limit)
      slice = filtered.slice(start, end)
    }
    return { records: slice.map(publicRecord), total, offset, limit }
  }

  /**
   * Every checkpoint on disk, across sessions, newest first. The Settings
   * history view uses this when the composer dock is hidden.
   */
  async listAll() {
    await this.chain
    const records = await this.readAllRecords()
    const titles = await this.sessionTitles(records.map((record) => record.sessionId))
    return {
      records: records.map((record) => publicRecord(record, titles.get(String(record.sessionId || '')))),
      total: records.length,
    }
  }

  /**
   * Read every record across sessions without taking the lock. Callers inside
   * exclusive() must use this directly; listAll() awaits the queue first.
   */
  async readAllRecords() {
    const root = path.join(this.root, 'records')
    let directories
    try {
      directories = await fs.readdir(root, { withFileTypes: true })
    } catch (error) {
      if (error && error.code === 'ENOENT') return []
      throw error
    }
    const records = []
    for (const directory of directories) {
      if (!directory.isDirectory()) continue
      const dir = path.join(root, directory.name)
      let names
      try {
        names = await fs.readdir(dir)
      } catch (error) {
        if (error && error.code === 'ENOENT') continue
        throw error
      }
      for (const name of names) {
        if (!name.endsWith('.json')) continue
        try {
          const record = await this.loadFile(path.join(dir, name))
          if (record && typeof record.turn === 'number') records.push(record)
        } catch {
          // A record that cannot be read is quarantined or skipped by loadFile;
          // one bad file must not blank the whole Settings page.
        }
      }
    }
    records.sort((left, right) => (right.time || 0) - (left.time || 0))
    return records
  }

  /** @param {string} sessionId @param {number} turn */
  async keep(sessionId, turn) {
    return this.exclusive(async () => {
      const record = await this.load(sessionId, turn)
      if (record === null) return { ok: false, code: 'not-found', message: '这条检查点已不存在。' }
      if (record.status === 'undone') return { ok: false, code: 'undone', message: '这条检查点已经撤销。' }
      if (record.status === 'kept') {
        const kept = await this.keepEarlier(sessionId, turn)
        return { ok: true, record: publicRecord(record), kept }
      }
      if (record.status !== 'sealed') return { ok: false, code: 'not-ready', message: '检查点还在记录中，请稍后再试。' }
      const newer = await this.newerActive(sessionId, turn)
      if (newer !== null) {
        const message = newer.status === 'kept'
          ? `检查点 ${newer.turn} 已保留；只能从最新的一条开始保留。`
          : newer.status === 'open'
            ? `检查点 ${newer.turn} 还在记录中；请等这轮结束后再保留。`
            : `检查点 ${newer.turn} 比这条更新；请先处理更新的检查点。`
        return { ok: false, code: 'newer-checkpoint', turn: newer.turn, message }
      }
      record.status = 'kept'
      record.actionTime = Date.now()
      await this.save(record)
      // Keeping the newest checkpoint accepts everything that came before it.
      const kept = await this.keepEarlier(sessionId, turn)
      return { ok: true, record: publicRecord(record), kept: [turn, ...kept] }
    })
  }

  /**
   * Toggle the storage-protection pin. Pin is independent of keep: it never
   * changes status and never cascades.
   * @param {string} sessionId @param {number} turn
   */
  async pin(sessionId, turn) {
    return this.exclusive(async () => {
      const record = await this.load(sessionId, turn)
      if (record === null) return { ok: false, code: 'not-found', message: '这条检查点已不存在。' }
      if (record.status === 'open') return { ok: false, code: 'not-ready', message: '检查点还在记录中，请稍后再钉住。' }
      if (record.contentRemoved === true) {
        return { ok: false, code: 'content-removed', message: '这条检查点的内容已经清理，无法再保护。' }
      }
      record.pinned = record.pinned !== true
      record.actionTime = Date.now()
      await this.save(record)
      return { ok: true, record: publicRecord(record), pinned: record.pinned }
    })
  }

  /**
   * Mark every earlier sealed checkpoint kept. Called when the newest active
   * checkpoint is kept; older checkpoints are covered by that acceptance.
   * @param {string} sessionId
   * @param {number} turn
   * @returns {Promise<number[]>} turns whose status changed
   */
  async keepEarlier(sessionId, turn) {
    const records = await this.loadAll(sessionId)
    const changed = []
    for (const older of records) {
      if (older.turn >= turn || older.status !== 'sealed') continue
      older.status = 'kept'
      older.actionTime = Date.now()
      await this.save(older)
      changed.push(older.turn)
    }
    return changed
  }

  /**
   * Find the latest later checkpoint that is already kept.
   * @param {string} sessionId
   * @param {number} turn
   */
  async newerKept(sessionId, turn) {
    const records = await this.loadAll(sessionId)
    let latest = null
    for (const record of records) {
      if (record.turn > turn && record.status === 'kept') latest = record
    }
    return latest
  }

  /**
   * Find the latest later checkpoint that is still active.
   * @param {string} sessionId
   * @param {number} turn
   */
  async newerActive(sessionId, turn) {
    const records = await this.loadAll(sessionId)
    let active = null
    for (const record of records) {
      if (record.turn > turn && record.status !== 'undone') active = record
    }
    return active
  }

  /**
   * Find the earliest later checkpoint that still owns a change to one of these
   * paths. An undone later checkpoint no longer blocks; an open or kept one does.
   * @param {string} sessionId
   * @param {number} turn
   * @param {{path: string}[]} files
   */
  async newerOverlap(sessionId, turn, files) {
    const owned = new Set(files.map((file) => pathKey(file.path)))
    const records = await this.loadAll(sessionId)
    for (const record of records) {
      if (record.turn <= turn || record.status === 'undone') continue
      const hit = record.files.find((file) => owned.has(pathKey(file.path)))
      if (hit !== undefined) return { record, file: hit }
    }
    return null
  }

  /**
   * A record from another Session that touched one of these paths after
   * `atTime`, or is still recording one. Restoring this record could overwrite
   * that Session's work, so undo/redo/revert refuse instead of guessing.
   * @param {string} sessionId
   * @param {{path: string}[]} files
   * @param {number} atTime
   */
  async foreignOverlap(sessionId, files, atTime) {
    const owned = new Set(files.map((file) => pathKey(file.path)))
    if (owned.size === 0) return null
    const records = await this.readAllRecords()
    for (const record of records) {
      if (record.sessionId === sessionId || record.status === 'undone') continue
      if (record.contentRemoved === true) continue
      const lastTouch = record.sealedAt || record.time || 0
      const overlapping = record.status === 'open' || lastTouch > (atTime || 0)
      if (!overlapping) continue
      const hit = (record.files || []).find((file) => owned.has(pathKey(file.path)))
      if (hit !== undefined) return { record, file: hit }
    }
    return null
  }

  /** @param {{record: any, file: any}} foreign @param {string} action */
  foreignResult(foreign, action) {
    const short = String(foreign.record.sessionId || '').slice(0, 8) || '?'
    const open = foreign.record.status === 'open'
    return {
      ok: false,
      code: open ? 'foreign-open' : 'foreign-checkpoint',
      sessionId: foreign.record.sessionId,
      turn: foreign.record.turn,
      path: foreign.file.display,
      message: open
        ? `另一个会话 ${short} 正在修改 ${foreign.file.display}；请等它结束后再${action}。`
        : `另一个会话 ${short} 的检查点 ${foreign.record.turn} 在之后也修改了 ${foreign.file.display}；为避免覆盖，已阻止${action}。`,
    }
  }

  /** @param {string} sessionId @param {number} turn @param {{force?: boolean}} [options] */
  async undo(sessionId, turn, options = {}) {
    return this.exclusive(async () => {
      const record = await this.load(sessionId, turn)
      if (record === null) return { ok: false, code: 'not-found', message: '这条检查点已不存在。' }
      if (record.status === 'undone') return { ok: true, record: publicRecord(record) }
      if (record.contentRemoved === true) {
        return { ok: false, code: 'content-removed', message: '这条检查点的内容已经清理，无法撤销。' }
      }
      if (record.status === 'kept' && options.force !== true) {
        return { ok: false, code: 'kept', message: '这条检查点已保留，不能再撤销。' }
      }
      if (record.status !== 'sealed' && !(record.status === 'kept' && options.force === true)) {
        return { ok: false, code: 'not-ready', message: '检查点还在记录中，请稍后再试。' }
      }
      const accepted = await this.newerKept(sessionId, turn)
      if (accepted !== null) {
        return {
          ok: false,
          code: 'accepted',
          turn: accepted.turn,
          message: `检查点 ${accepted.turn} 已保留，它已经接受了之前所有修改；不能再单独撤销更早的检查点。`,
        }
      }

      const foreign = await this.foreignOverlap(sessionId, record.files, record.time)
      if (foreign !== null) return this.foreignResult(foreign, '撤销')

      const newer = await this.newerOverlap(sessionId, turn, record.files)
      if (newer !== null) {
        const message = newer.record.status === 'kept'
          ? `检查点 ${newer.record.turn} 已保留，并且修改了 ${newer.file.display}；不能再撤销更早的检查点。`
          : newer.record.status === 'open'
            ? `当前轮次还在修改 ${newer.file.display}；请等这轮结束后再撤销。`
            : `检查点 ${newer.record.turn} 之后又修改了 ${newer.file.display}；请先撤销检查点 ${newer.record.turn}。`
        return {
          ok: false,
          code: 'newer-checkpoint',
          turn: newer.record.turn,
          path: newer.file.display,
          message,
        }
      }

      const plans = []
      for (const file of record.files) {
        if (!(await isPathWithin(record.cwd, file.path))) {
          return { ok: false, code: 'unsafe-path', path: file.display, message: `路径已链接到工作区外，拒绝撤销：${file.display}` }
        }
        if (file.oversized || file.contentRemoved) {
          return { ok: false, code: 'conflict', path: file.display, message: `文件不可读或内容已清理，无法安全撤销：${file.display}` }
        }
        const current = await readMaybe(file.path)
        if (current.oversized) {
          return { ok: false, code: 'conflict', path: file.display, message: `文件不可读或过大，无法安全撤销：${file.display}` }
        }
        const currentSha = current.exists && current.buffer !== null ? hashBytes(current.buffer) : null
        if (currentSha !== file.afterSha) {
          return { ok: false, code: 'conflict', path: file.display, message: `文件在检查点之后又被修改过：${file.display}` }
        }
        let before = null
        if (file.existedBefore) {
          try {
            before = file.beforeSha === null ? null : await this.readBlob(file.beforeSha)
          } catch (error) {
            if (error && error.code === 'key-missing') {
              return { ok: false, code: 'key-missing', path: file.display, message: `检查点内容已加密，但密钥不在本机：${file.display}` }
            }
            before = null
          }
          if (before === null || hashBytes(before) !== file.beforeSha) {
            return { ok: false, code: 'missing-blob', path: file.display, message: `找不到恢复内容：${file.display}` }
          }
        }
        plans.push({ file, current, before })
      }

      const applied = []
      try {
        for (const plan of plans) {
          if (plan.before !== null) await writeAtomic(plan.file.path, plan.before, plan.file.beforeMode)
          else await removeMaybe(plan.file.path)
          applied.push(plan)
        }
      } catch (error) {
        await this.rollback(applied)
        return { ok: false, code: 'restore-failed', message: `恢复文件失败：${error && error.message ? error.message : String(error)}` }
      }

      record.undoneFrom = record.status
      record.status = 'undone'
      record.actionTime = Date.now()
      await this.save(record)
      return { ok: true, record: publicRecord(record) }
    })
  }

  /**
   * Reapply an undone checkpoint's after image. Only an undone suffix can be
   * redone, oldest first: if a newer active record exists, or an earlier record
   * is still undone, the file state is not the one this record left behind.
   * @param {string} sessionId @param {number} turn
   */
  async redo(sessionId, turn) {
    return this.exclusive(async () => {
      const record = await this.load(sessionId, turn)
      if (record === null) return { ok: false, code: 'not-found', message: '这条检查点已不存在。' }
      if (record.status !== 'undone') {
        return { ok: false, code: 'not-undone', message: '只有已撤销的检查点可以重做。' }
      }
      if (record.contentRemoved === true) {
        return { ok: false, code: 'content-removed', message: '这条检查点的内容已经清理，无法重做。' }
      }
      const records = await this.loadAll(sessionId)
      let lastActiveTurn = -1
      for (const other of records) {
        if (other.status !== 'undone') lastActiveTurn = other.turn
      }
      for (const other of records) {
        if (other.turn > turn && other.status !== 'undone') {
          return { ok: false, code: 'newer-active', turn: other.turn, message: `检查点 ${other.turn} 比这条更新；请先处理更新的检查点。` }
        }
        if (other.turn < turn && other.turn > lastActiveTurn && other.status === 'undone') {
          return { ok: false, code: 'earlier-undone', turn: other.turn, message: `请先重做检查点 ${other.turn}。` }
        }
      }

      const foreign = await this.foreignOverlap(sessionId, record.files, record.time)
      if (foreign !== null) return this.foreignResult(foreign, '重做')

      const plans = []
      for (const file of record.files) {
        if (!(await isPathWithin(record.cwd, file.path))) {
          return { ok: false, code: 'unsafe-path', path: file.display, message: `路径已链接到工作区外，拒绝重做：${file.display}` }
        }
        if (file.oversized || file.contentRemoved) {
          return { ok: false, code: 'conflict', path: file.display, message: `文件不可读或内容已清理，无法安全重做：${file.display}` }
        }
        const current = await readMaybe(file.path)
        if (current.oversized) {
          return { ok: false, code: 'conflict', path: file.display, message: `文件不可读或过大，无法安全重做：${file.display}` }
        }
        if (file.existedBefore) {
          const currentSha = current.exists && current.buffer !== null ? hashBytes(current.buffer) : null
          if (currentSha !== file.beforeSha) {
            return { ok: false, code: 'conflict', path: file.display, message: `文件在撤销之后又被修改过：${file.display}` }
          }
        } else if (current.exists) {
          return { ok: false, code: 'conflict', path: file.display, message: `撤销后 ${file.display} 又被重新创建了，无法重做。` }
        }
        let after = null
        if (file.existedAfter) {
          if (file.afterStored !== true || file.afterSha === null) {
            return { ok: false, code: 'missing-blob', path: file.display, message: `找不到重做内容：${file.display}` }
          }
          after = await this.readBlob(file.afterSha).catch(() => null)
          if (after === null || hashBytes(after) !== file.afterSha) {
            return { ok: false, code: 'missing-blob', path: file.display, message: `找不到重做内容：${file.display}` }
          }
        }
        plans.push({ file, current, after })
      }

      const applied = []
      try {
        for (const plan of plans) {
          if (plan.after !== null) await writeAtomic(plan.file.path, plan.after, plan.file.afterMode)
          else await removeMaybe(plan.file.path)
          applied.push(plan)
        }
      } catch (error) {
        await this.rollback(applied)
        return { ok: false, code: 'restore-failed', message: `重做文件失败：${error && error.message ? error.message : String(error)}` }
      }

      record.status = record.undoneFrom === 'kept' ? 'kept' : 'sealed'
      delete record.undoneFrom
      record.actionTime = Date.now()
      await this.save(record)
      return { ok: true, record: publicRecord(record) }
    })
  }

  /**
   * Revert to the end of `targetTurn` by undoing every newer active checkpoint
   * newest-first. Preflight covers the whole chain before any write, so a
   * conflict in a later checkpoint cannot leave an earlier one half-undone.
   * @param {string} sessionId
   * @param {number} targetTurn
   */
  async revert(sessionId, targetTurn) {
    return this.exclusive(async () => {
      const target = await this.load(sessionId, targetTurn)
      if (target === null) return { ok: false, code: 'not-found', message: '这条检查点已不存在。' }
      if (target.status === 'undone') return { ok: false, code: 'undone', message: '这条检查点已经撤销。' }
      if (target.status !== 'sealed' && target.status !== 'kept') {
        return { ok: false, code: 'not-ready', message: '检查点还在记录中，不能作为回退目标。' }
      }
      if (target.contentRemoved === true) {
        return { ok: false, code: 'content-removed', message: '这条检查点的内容已经清理，不能作为回退目标。' }
      }
      const records = []
      for (const record of await this.loadAll(sessionId)) {
        if (record.turn <= targetTurn || record.status === 'undone') continue
        records.push(record)
      }
      records.sort((left, right) => right.turn - left.turn)
      const open = records.find((record) => record.status === 'open')
      if (open !== undefined) {
        return { ok: false, code: 'newer-open', turn: open.turn, message: `检查点 ${open.turn} 还在记录中，请稍后再回退。` }
      }

      const touched = []
      for (const record of [target, ...records]) {
        for (const file of record.files) touched.push(file)
      }
      const foreign = await this.foreignOverlap(sessionId, touched, target.time)
      if (foreign !== null) return this.foreignResult(foreign, '回退')

      // Simulate the reverse undo chain in memory: verify every after-hash and
      // read every before-blob before the first file write.
      const state = new Map()
      const plans = []
      for (const record of records) {
        const items = []
        for (const file of record.files) {
          if (!(await isPathWithin(record.cwd, file.path))) {
            return { ok: false, code: 'unsafe-path', path: file.display, message: `路径已链接到工作区外，拒绝回退：${file.display}` }
          }
          if (file.oversized || file.contentRemoved) {
            return { ok: false, code: 'conflict', path: file.display, message: `文件不可读或内容已清理，无法安全回退：${file.display}` }
          }
          let current
          if (state.has(pathKey(file.path))) {
            current = state.get(pathKey(file.path))
          } else {
            const read = await readMaybe(file.path)
            current = { exists: read.exists, buffer: read.buffer, oversized: read.oversized, mode: read.mode }
            if (read.oversized) {
              return { ok: false, code: 'conflict', path: file.display, message: `文件不可读或过大，无法安全回退：${file.display}` }
            }
          }
          const currentSha = current.exists && current.buffer !== null ? hashBytes(current.buffer) : null
          if (currentSha !== file.afterSha) {
            return { ok: false, code: 'conflict', path: file.display, message: `文件在检查点之后又被修改过：${file.display}` }
          }
          let before = null
          if (file.existedBefore) {
            try {
              before = file.beforeSha === null ? null : await this.readBlob(file.beforeSha)
            } catch (error) {
              if (error && error.code === 'key-missing') {
                return { ok: false, code: 'key-missing', path: file.display, message: `检查点内容已加密，但密钥不在本机：${file.display}` }
              }
              before = null
            }
            if (before === null || hashBytes(before) !== file.beforeSha) {
              return { ok: false, code: 'missing-blob', path: file.display, message: `找不到恢复内容：${file.display}` }
            }
          }
          const next = before === null ? { exists: false, buffer: null, mode: null } : { exists: true, buffer: before, mode: file.beforeMode }
          state.set(pathKey(file.path), next)
          items.push({ file, current, before })
        }
        plans.push({ record, items })
      }

      for (const file of target.files) {
        if (!(await isPathWithin(target.cwd, file.path))) {
          return { ok: false, code: 'unsafe-path', path: file.display, message: `路径已链接到工作区外，拒绝回退：${file.display}` }
        }
        if (file.oversized || file.contentRemoved) {
          return { ok: false, code: 'conflict', path: file.display, message: `目标检查点包含不可读或已清理的文件：${file.display}` }
        }
        const current = state.has(pathKey(file.path)) ? state.get(pathKey(file.path)) : await readMaybe(file.path)
        const currentSha = current.exists && current.buffer !== null ? hashBytes(current.buffer) : null
        if (currentSha !== file.afterSha) {
          return { ok: false, code: 'conflict', path: file.display, message: `目标检查点之后 ${file.display} 又被修改过，无法回退。` }
        }
      }

      const applied = []
      try {
        for (const plan of plans) {
          for (const item of plan.items) {
            if (item.before !== null) await writeAtomic(item.file.path, item.before, item.file.beforeMode)
            else await removeMaybe(item.file.path)
            applied.push(item)
          }
        }
      } catch (error) {
        await this.rollback(applied)
        return { ok: false, code: 'restore-failed', message: `回退文件失败：${error && error.message ? error.message : String(error)}` }
      }

      for (const plan of plans) {
        plan.record.undoneFrom = plan.record.status
        plan.record.status = 'undone'
        plan.record.actionTime = Date.now()
        await this.save(plan.record)
      }
      return {
        ok: true,
        target: publicRecord(target),
        records: plans.map((plan) => publicRecord(plan.record)),
      }
    })
  }

  /** @param {{file: {path: string}, current: {exists: boolean, buffer: Buffer | null, mode?: number | null}}[]} applied */
  async rollback(applied) {
    for (let index = applied.length - 1; index >= 0; index -= 1) {
      const item = applied[index]
      try {
        if (item.current.exists && item.current.buffer !== null) {
          await writeAtomic(item.file.path, item.current.buffer, item.current.mode ?? null)
        } else {
          await removeMaybe(item.file.path)
        }
      } catch {
        // Best effort: a rollback failure must not mask the original error.
      }
    }
  }

  /**
   * Historical diff for a checkpoint. Old records without after blobs stay
   * readable by counts but return `available:false`; the dock can fall back to
   * the DSH review panel for those.
   * @param {string} sessionId @param {number} turn
   */
  async diff(sessionId, turn) {
    await this.chain
    const record = await this.load(sessionId, turn)
    if (record === null) return { ok: false, code: 'not-found', message: '这条检查点已不存在。' }
    const files = []
    for (const file of record.files) {
      if (file.oversized) {
        files.push(publicDiffFile(file, { available: false, reason: 'oversized' }))
        continue
      }
      if (file.contentRemoved === true) {
        files.push(publicDiffFile(file, { available: false, reason: 'content-removed' }))
        continue
      }
      if (file.binary) {
        files.push(publicDiffFile(file, { available: false, reason: 'binary' }))
        continue
      }
      let before = null
      let after = null
      if (file.existedBefore && file.beforeSha !== null) {
        before = await this.readBlob(file.beforeSha).catch(() => null)
      }
      if (file.existedAfter && file.afterSha !== null && file.afterStored === true) {
        after = await this.readBlob(file.afterSha).catch(() => null)
      }
      if ((file.existedBefore && before === null) || (file.existedAfter && after === null)) {
        files.push(publicDiffFile(file, { available: false, reason: 'missing-blob' }))
        continue
      }
      if (file.existedAfter && file.afterStored !== true) {
        files.push(publicDiffFile(file, { available: false, reason: 'old-record' }))
        continue
      }
      const patch = buildPatch(before, after)
      files.push(publicDiffFile(file, {
        available: true,
        patch: patch.patch,
        added: patch.added,
        deleted: patch.deleted,
        truncated: patch.truncated,
      }))
    }
    return { ok: true, turn: record.turn, seq: record.seq || 0, files }
  }

  /**
   * Storage stats and the manual-clean candidate set. Content for the latest
   * RECENT_KEEP checkpoints and every pinned checkpoint is never a candidate.
   * @param {string} sessionId
   */
  /**
   * Cleanup candidates for one session, or for every session when `scope` is
   * `*` (the Settings storage page has no session of its own).
   * @param {string} scope
   * @param {any[]} allRecords
   * @param {number} keep
   */
  candidatesIn(scope, allRecords, keep) {
    if (scope !== '*') {
      const records = allRecords
        .filter((record) => String(record.sessionId || '') === scope)
        .sort((left, right) => left.turn - right.turn)
      return olderCandidates(records, keep)
    }
    const candidates = []
    for (const records of groupBySessionRecords(allRecords).values()) {
      candidates.push(...olderCandidates(records, keep))
    }
    return candidates
  }

  async stats(sessionId) {
    await this.chain
    const config = await this.readConfig()
    const scope = String(sessionId || '')
    const allRecords = await this.readAllRecords()
    // `*` is the whole store: the Settings page reports every session at once.
    const records = scope === '*'
      ? allRecords
      : allRecords.filter((record) => String(record.sessionId || '') === scope)
    const blobs = new Set()
    for (const record of records) collectBlobs(record, blobs)
    let bytes = 0
    let sealedBlobs = 0
    for (const hash of blobs) {
      const size = await this.blobSize(hash)
      // A missing blob is counted by the records, not the byte total.
      if (size === null) continue
      bytes += size.bytes
      if (size.sealed) sealedBlobs += 1
    }
    const candidates = this.candidatesIn(scope, allRecords, config.keep)
    const candidateKeys = new Set(candidates.map(recordKey))
    // Blobs are content-addressed across every session, so protection is
    // computed from all records: cleaning here must never remove bytes that
    // another session's undo still needs.
    const protectedBlobs = new Set()
    for (const record of allRecords) {
      if (candidateKeys.has(recordKey(record))) continue
      collectBlobs(record, protectedBlobs)
    }
    const candidateBlobs = new Set()
    for (const record of candidates) collectBlobs(record, candidateBlobs)
    let cleanableBytes = 0
    for (const hash of candidateBlobs) {
      if (protectedBlobs.has(hash)) continue
      const size = await this.blobSize(hash)
      if (size !== null) cleanableBytes += size.bytes
    }
    const orphans = await this.orphanSummary(allRecords)
    // Per-session sizes for the pie: a blob shared by two sessions is counted
    // once, for the first session that claims it, so the slices add up to the
    // store total instead of double-counting content-addressed bytes.
    const bySession = []
    const claimedBlobs = new Set()
    const archived = this.archivedSessionIds()
    for (const [groupId, groupRecords] of groupBySessionRecords(records)) {
      const ownBlobs = new Set()
      for (const record of groupRecords) collectBlobs(record, ownBlobs)
      let size = 0
      for (const hash of ownBlobs) {
        if (claimedBlobs.has(hash)) continue
        claimedBlobs.add(hash)
        const found = await this.blobSize(hash)
        if (found !== null) size += found.bytes
      }
      bySession.push({
        sessionId: groupId,
        records: groupRecords.length,
        pinned: groupRecords.filter((record) => record.pinned === true).length,
        bytes: size,
        archived: archived.has(groupId),
      })
    }
    bySession.sort((a, b) => (b.bytes - a.bytes) || (b.records - a.records))
    let failure = null
    if (scope === '*') {
      for (const error of this.failures.values()) {
        failure = error
        break
      }
    } else {
      failure = this.failures.get(scope) || null
    }
    // Key state for the settings row. A key is minted only when encryption is
    // on, so merely opening the panel never creates files in the key ring.
    let cryptoFingerprint = ''
    let cryptoKeys = (await this.ring.load()).size
    if (config.encrypt === true) cryptoFingerprint = (await this.ring.current()).fingerprint
    return {
      records: records.length,
      pinned: records.filter((record) => record.pinned === true).length,
      contentRemoved: records.filter((record) => record.contentRemoved === true).length,
      blobs: blobs.size,
      bytes,
      cleanable: candidates.length,
      cleanableBytes,
      keepRecent: config.keep,
      autoClean: config.autoClean,
      failure,
      bySession,
      crypto: {
        enabled: config.encrypt === true,
        fingerprint: cryptoFingerprint,
        keys: cryptoKeys,
        sealed: sealedBlobs,
        total: blobs.size,
      },
      orphans: { sessions: orphans.sessions.length, records: orphans.records, bytes: orphans.bytes },
    }
  }

  /**
   * Manual GC: only content outside the latest `keep` records and not pinned.
   * Records stay as metadata; blobs still referenced by protected records stay.
   * @param {string} sessionId
   * @param {number} [keep] - how many recent records to keep; defaults to the
   *   user setting.
   */
  async clean(sessionId, keep) {
    const config = await this.readConfig()
    const limit = Number.isFinite(Number(keep)) && Number(keep) >= KEEP_MIN && Number(keep) <= KEEP_MAX
      ? Math.round(Number(keep))
      : config.keep
    const scope = String(sessionId || '')
    return this.exclusive(async () => {
      await this.sweepTempFiles()
      const allRecords = await this.readAllRecords()
      const candidates = this.candidatesIn(scope, allRecords, limit)
      if (candidates.length === 0) {
        return { ok: true, records: 0, blobs: 0, bytes: 0, message: '没有可清理的旧内容。' }
      }
      const candidateKeys = new Set(candidates.map(recordKey))
      const protectedBlobs = new Set()
      for (const record of allRecords) {
        if (candidateKeys.has(recordKey(record))) continue
        collectBlobs(record, protectedBlobs)
      }
      const candidateBlobs = new Set()
      for (const record of candidates) collectBlobs(record, candidateBlobs)
      let removedBlobs = 0
      let bytes = 0
      for (const hash of candidateBlobs) {
        if (protectedBlobs.has(hash)) continue
        const size = await this.blobSize(hash)
        if (size === null) continue
        bytes += size.bytes
        await this.deleteBlob(hash)
        removedBlobs += 1
      }
      for (const record of candidates) {
        record.contentRemoved = true
        record.contentRemovedAt = Date.now()
        for (const file of record.files) {
          file.afterStored = false
          file.contentRemoved = true
        }
        await this.save(record)
      }
      return { ok: true, records: candidates.length, blobs: removedBlobs, bytes }
    })
  }

  /**
   * True when DSH still knows this session: the live registry says so, or its
   * directory still exists under `$DSH_HOME/sessions`. Deleting a session in DSH
   * does not touch this store, so the records otherwise outlive it forever.
   * @param {string} sessionId
   * @returns {Promise<boolean>}
   */
  /**
   * Session ids the user archived. Archiving is a registry flag — the session
   * and its files stay put — so these checkpoints are still live, just filed
   * away in the sidebar.
   * @returns {Set<string>}
   */
  archivedSessionIds() {
    if (this.archivedLookup === null) return new Set()
    try {
      const found = this.archivedLookup()
      if (found instanceof Set) return found
      if (Array.isArray(found)) return new Set(found)
    } catch {
      // A registry that cannot answer is not a reason to fail the statistics.
    }
    return new Set()
  }

  async sessionExists(sessionId) {
    if (this.sessionLookup) {
      try {
        if (this.sessionLookup(sessionId) === true) return true
      } catch {
        // Fall through to the on-disk check.
      }
    }
    let directories
    try {
      directories = await fs.readdir(this.sessionsRoot, { withFileTypes: true })
    } catch {
      return false
    }
    for (const directory of directories) {
      if (!directory.isDirectory()) continue
      try {
        const stat = await fs.stat(path.join(this.sessionsRoot, directory.name, sessionId))
        if (stat.isDirectory()) return true
      } catch {
        // Not in this workspace; keep looking.
      }
    }
    return false
  }

  /**
   * Group records by session with the blob set and newest timestamp each one
   * references. Shared by the orphan report and the orphan purge so both agree.
   * @param {any[]} records
   */
  groupBySession(records) {
    const groups = new Map()
    for (const record of records) {
      const id = String(record.sessionId || '')
      if (id === '') continue
      let group = groups.get(id)
      if (!group) {
        group = { sessionId: id, records: 0, blobs: new Set(), newest: 0 }
        groups.set(id, group)
      }
      group.records += 1
      collectBlobs(record, group.blobs)
      group.newest = Math.max(group.newest, Number(record.time) || 0)
    }
    return groups
  }

  /**
   * Checkpoints whose session no longer exists in DSH. Reported, never deleted
   * on its own: the user decides in Settings when the disk should be reclaimed.
   * @param {any[]} [allRecords]
   */
  async orphanSummary(allRecords) {
    const records = allRecords || await this.readAllRecords()
    const groups = this.groupBySession(records)
    const sessions = []
    let count = 0
    let bytes = 0
    for (const group of groups.values()) {
      if (await this.sessionExists(group.sessionId)) continue
      let size = 0
      for (const hash of group.blobs) {
        const found = await this.blobSize(hash)
        if (found !== null) size += found.bytes
      }
      sessions.push({ sessionId: group.sessionId, records: group.records, bytes: size, newest: group.newest })
      count += group.records
      bytes += size
    }
    return { sessions, records: count, bytes }
  }

  /** @returns {Promise<{sessions: any[], records: number, bytes: number}>} */
  async orphans() {
    await this.chain
    return this.orphanSummary()
  }

  /**
   * Remove every checkpoint of a session that no longer exists, plus the blobs
   * only those records referenced. Records younger than `minAgeMs` are skipped:
   * a session directory can lag a brand-new session by a moment, and this is the
   * one operation that cannot be undone.
   * @param {{minAgeMs?: number}} [options]
   */
  async purgeOrphans(options = {}) {
    const minAge = Number.isFinite(options.minAgeMs) ? options.minAgeMs : 3_600_000
    return this.exclusive(async () => {
      await this.sweepTempFiles()
      const allRecords = await this.readAllRecords()
      const groups = this.groupBySession(allRecords)
      const dead = []
      for (const group of groups.values()) {
        if (await this.sessionExists(group.sessionId)) continue
        if (Date.now() - group.newest < minAge) continue
        dead.push(group)
      }
      if (dead.length === 0) {
        return { ok: true, sessions: 0, records: 0, blobs: 0, bytes: 0, message: '没有可清理的已删除会话。' }
      }
      const deadIds = new Set(dead.map((group) => group.sessionId))
      const protectedBlobs = new Set()
      for (const record of allRecords) {
        if (deadIds.has(String(record.sessionId || ''))) continue
        collectBlobs(record, protectedBlobs)
      }
      let removedBlobs = 0
      let bytes = 0
      for (const group of dead) {
        for (const hash of group.blobs) {
          if (protectedBlobs.has(hash)) continue
          const size = await this.blobSize(hash)
          if (size === null) continue
          bytes += size.bytes
          await this.deleteBlob(hash)
          removedBlobs += 1
        }
      }
      let removedRecords = 0
      for (const group of dead) {
        const dir = path.dirname(this.recordFile(group.sessionId, 0))
        try {
          await fs.rm(dir, { recursive: true, force: true })
          removedRecords += group.records
        } catch (error) {
          this.warn(`could not remove orphaned checkpoint directory ${group.sessionId}: ${error && error.message ? error.message : String(error)}`)
        }
      }
      return { ok: true, sessions: dead.length, records: removedRecords, blobs: removedBlobs, bytes }
    })
  }

  /**
   * Delete temporary files a crashed write left behind. They are never part of
   * the record set, but an abandoned crash loop would otherwise grow the folder
   * without bound. Only called from user-triggered maintenance.
   * @param {number} [maxAgeMs]
   */
  async sweepTempFiles(maxAgeMs = 600_000) {
    const root = path.join(this.root, 'records')
    const directories = await fs.readdir(root, { withFileTypes: true }).catch(() => [])
    for (const directory of directories) {
      if (!directory.isDirectory()) continue
      const dir = path.join(root, directory.name)
      const names = await fs.readdir(dir).catch(() => [])
      for (const name of names) {
        if (!name.startsWith('.dsh-ckpt-')) continue
        const file = path.join(dir, name)
        try {
          const stat = await fs.stat(file)
          if (Date.now() - stat.mtimeMs > maxAgeMs) await fs.unlink(file)
        } catch {
          // Raced with a live writer; leave it alone.
        }
      }
    }
  }
}

/** @param {any} record @param {Set<string>} target */
function collectBlobs(record, target) {
  for (const file of record.files || []) {
    if (typeof file.beforeSha === 'string') target.add(file.beforeSha)
    if (typeof file.afterSha === 'string') target.add(file.afterSha)
  }
}

/** @param {any} record */
function recordKey(record) {
  return String(record.sessionId || '') + ':' + String(record.turn)
}

/**
 * Records a cleanup may touch: everything older than the latest `keep` records
 * of one session, minus pinned, open, and already-cleaned entries.
 * @param {any[]} records - one session, oldest first
 * @param {number} keep
 */
function olderCandidates(records, keep) {
  const keepFrom = Math.max(0, records.length - keep)
  return records.slice(0, keepFrom).filter((record) =>
    record.pinned !== true && record.status !== 'open' && record.contentRemoved !== true)
}

/** Group records by session, each group sorted oldest first. */
function groupBySessionRecords(records) {
  const groups = new Map()
  for (const record of records) {
    const id = String(record.sessionId || '')
    if (!groups.has(id)) groups.set(id, [])
    groups.get(id).push(record)
  }
  for (const list of groups.values()) list.sort((left, right) => left.turn - right.turn)
  return groups
}

/** @param {any} file @param {{available: boolean, reason?: string, patch?: string, added?: number, deleted?: number, truncated?: boolean}} extra */
function publicDiffFile(file, extra) {
  return {
    path: file.display,
    display: file.display,
    added: extra.added === undefined ? file.added || 0 : extra.added,
    deleted: extra.deleted === undefined ? file.deleted || 0 : extra.deleted,
    binary: file.binary === true,
    approximate: file.approximate === true,
    available: extra.available === true,
    reason: extra.reason || '',
    patch: extra.patch || '',
    truncated: extra.truncated === true,
  }
}

/** @param {any} record */
/**
 * Render a path the way the dock shows it: relative to the workspace, forward
 * slashes, bare file name when the path is the workspace itself.
 * @param {string} cwd @param {string} absolute
 */
function relativeDisplay(cwd, absolute) {
  const relative = path.relative(cwd, absolute)
  return (relative === '' ? path.basename(absolute) : relative).split(path.sep).join('/')
}

function publicRecord(record, sessionTitle) {
  const files = (record.files || []).map((file) => ({
    path: file.display,
    display: file.display,
    added: file.added || 0,
    deleted: file.deleted || 0,
    binary: file.binary === true,
    approximate: file.approximate === true,
    afterStored: file.afterStored === true,
    contentRemoved: file.contentRemoved === true,
    renamedFrom: file.renamedFrom || '',
  }))
  return {
    id: record.id,
    sessionId: record.sessionId || '',
    sessionTitle: sessionTitle || '',
    cwd: record.cwd || '',
    turn: record.turn,
    seq: record.seq || 0,
    commit: record.commit || '',
    time: record.time,
    prompt: record.prompt || '',
    status: record.status,
    pinned: record.pinned === true,
    recovered: record.recovered === true,
    contentRemoved: record.contentRemoved === true,
    undoneFrom: record.undoneFrom || '',
    files,
    added: files.reduce((sum, file) => sum + file.added, 0),
    deleted: files.reduce((sum, file) => sum + file.deleted, 0),
  }
}

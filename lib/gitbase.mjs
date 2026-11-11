// lib/gitbase.mjs — a turn's file state, read through git when there is one.
//
// `lib/baseline.mjs` answers "what changed this turn" by keeping the content of
// the whole workspace in memory. That is exact, but it pays for every file the
// turn never touches. Inside a git repository git already knows which paths
// differ from HEAD, so this module asks it and reads only those bytes: the
// dirty files at turn start (their pre-image) and whatever status names at the
// end.
//
// Two things it has to get right:
//   * A file that was already dirty when the turn started has no pre-image in
//     HEAD, so its content is kept at turn start.
//   * A turn may commit. Committed files are no longer "dirty", so paths also
//     come from `git diff <start>..<end>`.
//
// Ignored paths (build output, node_modules) never appear in git status; they
// are out of scope here, exactly like the skip list of the scan.

import { execFile } from 'node:child_process'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { MAX_FILE_BYTES, SKIP_DIRS } from './baseline.mjs'

const GIT_TIMEOUT_MS = 15000
const GIT_MAX_BUFFER = 64 * 1024 * 1024

/**
 * Run git in `cwd`. With `allowFailure` a non-zero exit resolves to null.
 * @param {string} cwd @param {string[]} args @param {boolean} [allowFailure]
 */
const git = (cwd, args, allowFailure = false) =>
  new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER, windowsHide: true },
      (error, stdout) => {
        if (error) {
          if (allowFailure) resolve(null)
          else reject(error)
          return
        }
        resolve(String(stdout))
      })
  })

/** @param {string} root */
const repoTop = async (root) => {
  const out = await git(root, ['rev-parse', '--show-toplevel'], true)
  return out === null ? null : out.trim()
}

/** @param {string} top */
const headOf = async (top) => {
  const out = await git(top, ['rev-parse', 'HEAD'], true)
  return out === null ? null : out.trim()
}

/** @param {string} absolute @param {string} root */
const within = (absolute, root) => {
  const relative = path.relative(root, absolute)
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
}

/** @param {string} absolute */
const skipped = (absolute) => {
  let current = path.dirname(absolute)
  while (current !== '' && current !== path.dirname(current)) {
    if (SKIP_DIRS.has(path.basename(current))) return true
    current = path.dirname(current)
  }
  return false
}

/** @param {string} absolute @returns {Promise<Buffer|null>} */
const readMaybe = async (absolute) => {
  try {
    const info = await stat(absolute)
    if (!info.isFile() || info.size > MAX_FILE_BYTES) return null
    return await readFile(absolute)
  } catch {
    return null
  }
}

/**
 * Absolute paths named by `git status --porcelain -z`, ignored and skipped
 * directories removed.
 * @param {string} top @param {string} root
 * @returns {Promise<string[]>}
 */
const statusPaths = async (top, root) => {
  const out = await git(top, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], true)
  if (out === null) return []
  const parts = out.split('\0')
  const found = []
  for (let index = 0; index < parts.length; index += 1) {
    const entry = parts[index]
    if (entry.length < 4) continue
    const code = entry.slice(0, 2)
    const file = entry.slice(3)
    // Rename and copy entries carry the original path as the next field.
    if (code[0] === 'R' || code[0] === 'C' || code[1] === 'R' || code[1] === 'C') index += 1
    if (file === '') continue
    const absolute = path.join(top, file)
    if (!within(absolute, root) || skipped(absolute)) continue
    found.push(absolute)
  }
  return found
}

/**
 * Read the state a turn starts from. Returns null when `root` is not inside a
 * git work tree or git is unavailable, so the caller can fall back to scanning.
 *
 * `dirty` holds the content of every path that already differed from HEAD at
 * turn start — tracked modifications as well as untracked files, since neither
 * has a usable pre-image in HEAD.
 *
 * @param {string} root
 * @returns {Promise<{kind: 'git', root: string, top: string, head: string|null,
 *   dirty: Map<string, Buffer>} | null>}
 */
export async function takeGitBaseline(root) {
  const top = await repoTop(root)
  if (top === null) return null
  const head = await headOf(top)
  /** @type {Map<string, Buffer>} */
  const dirty = new Map()
  for (const absolute of await statusPaths(top, root)) {
    const content = await readMaybe(absolute)
    if (content !== null) dirty.set(absolute, content)
  }
  return { kind: 'git', root, top, head, dirty }
}

/**
 * The content the given paths had at `head`, read through one `cat-file
 * --batch` process. Asking per file costs ~30 ms on Windows — a turn that
 * touches twenty files would spend half a second in process startup alone.
 *
 * @param {string} top @param {string} head @param {string[]} absolutes
 * @returns {Promise<Map<string, Buffer|null>>} null for a path that did not exist
 */
const contentsAtHead = (top, head, absolutes) => new Promise((resolve) => {
  /** @type {Map<string, Buffer|null>} */
  const result = new Map()
  if (absolutes.length === 0) return resolve(result)
  const specs = absolutes.map((absolute) => ({
    absolute,
    spec: `${head}:${path.relative(top, absolute).split(path.sep).join('/')}`,
  }))
  const child = execFile('git', ['cat-file', '--batch'],
    { cwd: top, timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER, windowsHide: true, encoding: 'buffer' },
    (error, stdout) => {
      if (error || !stdout) {
        for (const entry of specs) result.set(entry.absolute, null)
        resolve(result)
        return
      }
      let offset = 0
      for (const entry of specs) {
        const newline = stdout.indexOf(10, offset)
        if (newline < 0) {
          result.set(entry.absolute, null)
          continue
        }
        const header = stdout.toString('utf8', offset, newline)
        offset = newline + 1
        if (header.endsWith(' missing')) {
          result.set(entry.absolute, null)
          continue
        }
        const size = Number(header.split(' ')[2])
        if (!Number.isFinite(size) || size > MAX_FILE_BYTES || offset + size > stdout.length) {
          result.set(entry.absolute, null)
          offset = Math.min(offset + (Number.isFinite(size) ? size + 1 : 0), stdout.length)
          continue
        }
        result.set(entry.absolute, Buffer.from(stdout.subarray(offset, offset + size)))
        offset += size + 1
      }
      resolve(result)
    })
  child.stdin.end(specs.map((entry) => entry.spec).join('\n') + '\n')
})

/** @param {Buffer|null} left @param {Buffer|null} right */
const same = (left, right) => {
  if (left === null && right === null) return true
  if (left === null || right === null) return false
  return left.equals(right)
}

/**
 * Compare the workspace against a git baseline.
 *
 * @param {NonNullable<Awaited<ReturnType<typeof takeGitBaseline>>>} baseline
 * @returns {Promise<{absolute: string, before: Buffer|null}[]>} only paths whose
 *   bytes actually differ from the turn start; `before` is null for a path that
 *   did not exist then
 */
export async function gitChanges(baseline) {
  const { root, top } = baseline
  const head = await headOf(top)
  /** @type {Set<string>} */
  const candidates = new Set(baseline.dirty.keys())
  for (const absolute of await statusPaths(top, root)) candidates.add(absolute)
  // A turn may commit; those paths are clean now but still changed.
  if (baseline.head !== null && head !== null && head !== baseline.head) {
    const out = await git(top, ['diff', '--name-only', '-z', baseline.head, head], true)
    if (out !== null) {
      for (const file of out.split('\0')) {
        if (file === '') continue
        const absolute = path.join(top, file)
        if (within(absolute, root) && !skipped(absolute)) candidates.add(absolute)
      }
    }
  }

  const observed = []
  for (const absolute of candidates) {
    observed.push({ absolute, after: await readMaybe(absolute) })
  }
  const needHead = observed
    .filter((entry) => !baseline.dirty.has(entry.absolute))
    .map((entry) => entry.absolute)
  const heads = baseline.head === null
    ? new Map()
    : await contentsAtHead(top, baseline.head, needHead)

  const changes = []
  for (const { absolute, after } of observed) {
    const before = baseline.dirty.has(absolute)
      ? baseline.dirty.get(absolute)
      : heads.get(absolute) ?? null
    if (same(before, after)) continue
    changes.push({ absolute, before })
  }
  return changes
}

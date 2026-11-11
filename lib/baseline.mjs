// lib/baseline.mjs — a turn's file state, read without git.
//
// The fs hooks only see writes made through DSH's own file tools. A shell
// command, a script, or an editor bypasses them, so the only way to notice
// those writes afterwards is to compare the workspace against what it looked
// like when the turn started. That is what this module does: a bounded scan
// keeps the content of the files a turn could plausibly touch, and the diff
// between two scans names everything that changed, whoever changed it.
//
// The scan is deliberately small and predictable: skipped directories, a file
// size cap, and a total byte budget. When a workspace exceeds the budget the
// turn records nothing extra rather than silently half-working.

import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'

/** Directories that never hold a checkpoint-worthy file edit. */
export const SKIP_DIRS = new Set([
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  '.npm-cache',
  '.backups',
  '.tmp',
  '.tmp-test',
  'dist',
  'build',
  'out',
  '.next',
  '.nuxt',
  '.venv',
  'venv',
  '__pycache__',
  '.cache',
])

/** A single file larger than this is left out of the comparison. */
export const MAX_FILE_BYTES = 4 * 1024 * 1024

/** Defaults keep a scan well under a second on an ordinary source tree. */
export const DEFAULT_LIMITS = { maxFiles: 4000, maxBytes: 32 * 1024 * 1024 }

/**
 * Read the workspace under `root` into a map of `relative path -> content`.
 *
 * The result also carries `exceeded`: true when the tree passed a budget, in
 * which case the caller must not trust the map for a comparison.
 *
 * @param {string} root
 * @param {{maxFiles?: number, maxBytes?: number, maxFileBytes?: number}} [limits]
 * @returns {Promise<{files: Map<string, Buffer>, exceeded: boolean, truncated: number}>}
 */
export async function scanWorkspace(root, limits = {}) {
  const maxFiles = limits.maxFiles ?? DEFAULT_LIMITS.maxFiles
  const maxBytes = limits.maxBytes ?? DEFAULT_LIMITS.maxBytes
  const maxFileBytes = limits.maxFileBytes ?? MAX_FILE_BYTES
  /** @type {Map<string, Buffer>} */
  const files = new Map()
  let total = 0
  let exceeded = false
  let truncated = 0

  const walk = async (directory) => {
    if (exceeded) return
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (exceeded) return
      if (entry.isSymbolicLink()) continue
      const absolute = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue
        await walk(absolute)
        continue
      }
      if (!entry.isFile()) continue
      if (files.size >= maxFiles) {
        exceeded = true
        return
      }
      let buffer
      try {
        buffer = await readFile(absolute)
      } catch {
        truncated += 1
        continue
      }
      if (buffer.length > maxFileBytes) {
        truncated += 1
        continue
      }
      total += buffer.length
      if (total > maxBytes) {
        exceeded = true
        return
      }
      files.set(path.relative(root, absolute), buffer)
    }
  }

  await walk(root)
  return { files, exceeded, truncated }
}

/**
 * Paths whose content differs between two scans, including created and
 * deleted ones. Both scans must be complete.
 *
 * @param {{files: Map<string, Buffer>, exceeded: boolean}} before
 * @param {{files: Map<string, Buffer>, exceeded: boolean}} after
 * @returns {Array<{path: string, before: Buffer | null, after: Buffer | null}>}
 */
export function changedSince(before, after) {
  /** @type {Array<{path: string, before: Buffer | null, after: Buffer | null}>} */
  const changes = []
  for (const [file, content] of after.files) {
    const old = before.files.get(file)
    if (old === undefined) {
      changes.push({ path: file, before: null, after: content })
      continue
    }
    if (!old.equals(content)) changes.push({ path: file, before: old, after: content })
  }
  for (const [file, content] of before.files) {
    if (!after.files.has(file)) changes.push({ path: file, before: content, after: null })
  }
  return changes
}

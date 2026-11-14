// lib/textdiff.mjs — one line diff for both the file row and the patch panel.
//
// The row shows how many lines a checkpoint added and removed; expanding it
// shows the patch. Both must come from the same algorithm, or a scattered edit
// reads as "+121 −0" in the row and "+2144 −2023" in the panel.
//
// This is Myers' O(ND) algorithm with a bounded search depth. A diff that is
// still not resolved once the depth cap is reached falls back to "everything
// between the common prefix and suffix changed": that is what the old patch
// builder always did, and both call sites report it the same way (`coarse`).

const MAX_LINES = 20_000
const MAX_DEPTH = 1_500
const DEFAULT_CONTEXT = 3

/**
 * @typedef {{ type: 'equal' | 'delete' | 'insert', line: string }} DiffOp
 * @typedef {{ oldStart: number, oldLines: number, newStart: number, newLines: number, lines: string[] }} DiffHunk
 * @typedef {{ added: number, deleted: number, hunks: DiffHunk[], coarse: boolean }} LineDiff
 */

/**
 * Diff two line arrays.
 * @param {string[]} a before
 * @param {string[]} b after
 * @param {{ context?: number }} [options]
 * @returns {LineDiff}
 */
export function diffLines(a, b, options = {}) {
  const context = Number.isInteger(options.context) && options.context >= 0 ? options.context : DEFAULT_CONTEXT
  if (a.length === 0 && b.length === 0) return { added: 0, deleted: 0, hunks: [], coarse: false }
  const ops = diffOps(a, b)
  if (ops === null) return coarseDiff(a, b, context)
  const added = ops.reduce((sum, op) => sum + (op.type === 'insert' ? 1 : 0), 0)
  const deleted = ops.reduce((sum, op) => sum + (op.type === 'delete' ? 1 : 0), 0)
  if (added === 0 && deleted === 0) return { added: 0, deleted: 0, hunks: [], coarse: false }
  return { added, deleted, hunks: buildHunks(ops, context), coarse: false }
}

/**
 * Counts only, without building hunks. Used when a record is sealed.
 * @param {string[]} a
 * @param {string[]} b
 */
export function diffCounts(a, b) {
  if (a.length === 0 && b.length === 0) return { added: 0, deleted: 0, coarse: false }
  const ops = diffOps(a, b)
  if (ops === null) {
    const trimmed = trimCommon(a, b)
    return { added: trimmed.b.length, deleted: trimmed.a.length, coarse: true }
  }
  const added = ops.reduce((sum, op) => sum + (op.type === 'insert' ? 1 : 0), 0)
  const deleted = ops.reduce((sum, op) => sum + (op.type === 'delete' ? 1 : 0), 0)
  return { added, deleted, coarse: false }
}

/**
 * @param {string[]} a
 * @param {string[]} b
 * @returns {DiffOp[] | null} null when the search gave up.
 */
function diffOps(a, b) {
  const n = a.length
  const m = b.length
  const max = n + m
  if (max === 0) return []
  if (max > MAX_LINES) return null
  const offset = max + 1
  const width = 2 * max + 3
  const v = new Int32Array(width)
  /** @type {Int32Array[]} */
  const trace = []
  const limit = Math.min(max, MAX_DEPTH)
  for (let d = 0; d <= limit; d += 1) {
    for (let k = -d; k <= d; k += 2) {
      const index = offset + k
      let x
      if (k === -d || (k !== d && v[index - 1] < v[index + 1])) x = v[index + 1]
      else x = v[index - 1] + 1
      let y = x - k
      while (x < n && y < m && a[x] === b[y]) {
        x += 1
        y += 1
      }
      v[index] = x
      if (x >= n && y >= m) {
        trace.push(v.slice())
        return backtrack(trace, a, b, offset)
      }
    }
    trace.push(v.slice())
  }
  return null
}

/**
 * @param {Int32Array[]} trace
 * @param {string[]} a
 * @param {string[]} b
 * @param {number} offset
 * @returns {DiffOp[]}
 */
function backtrack(trace, a, b, offset) {
  /** @type {DiffOp[]} */
  const ops = []
  let x = a.length
  let y = b.length
  for (let d = trace.length - 1; d >= 0; d -= 1) {
    const v = trace[d]
    const k = x - y
    const index = offset + k
    let previousK
    if (k === -d || (k !== d && v[index - 1] < v[index + 1])) previousK = k + 1
    else previousK = k - 1
    const previousX = v[offset + previousK]
    const previousY = previousX - previousK
    while (x > previousX && y > previousY) {
      ops.push({ type: 'equal', line: a[x - 1] })
      x -= 1
      y -= 1
    }
    if (d === 0) break
    if (x === previousX) {
      ops.push({ type: 'insert', line: b[previousY] })
    } else {
      ops.push({ type: 'delete', line: a[previousX] })
    }
    x = previousX
    y = previousY
  }
  ops.reverse()
  return ops
}

/**
 * @param {string[]} a
 * @param {string[]} b
 * @returns {{ a: string[], b: string[] }}
 */
function trimCommon(a, b) {
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1
    endB -= 1
  }
  return { a: a.slice(start, endA), b: b.slice(start, endB) }
}

/**
 * @param {string[]} a
 * @param {string[]} b
 * @param {number} context
 * @returns {LineDiff}
 */
function coarseDiff(a, b, context) {
  const trimmed = trimCommon(a, b)
  if (trimmed.a.length === 0 && trimmed.b.length === 0) {
    return { added: 0, deleted: 0, hunks: [], coarse: false }
  }
  const offset = a.length - trimmed.a.length
  const lines = []
  for (const line of trimmed.a) lines.push(`-${line}`)
  for (const line of trimmed.b) lines.push(`+${line}`)
  return {
    added: trimmed.b.length,
    deleted: trimmed.a.length,
    hunks: [{
      oldStart: offset + 1,
      oldLines: trimmed.a.length,
      newStart: offset + 1,
      newLines: trimmed.b.length,
      lines,
    }],
    coarse: true,
  }
}

/**
 * @param {DiffOp[]} ops
 * @param {number} context
 * @returns {DiffHunk[]}
 */
function buildHunks(ops, context) {
  /** @type {number[]} */
  const changes = []
  ops.forEach((op, index) => {
    if (op.type !== 'equal') changes.push(index)
  })
  if (changes.length === 0) return []

  /** @type {Array<[number, number]>} */
  const groups = []
  let first = changes[0]
  let last = changes[0]
  for (const index of changes.slice(1)) {
    if (index - last <= context * 2) last = index
    else {
      groups.push([first, last])
      first = index
      last = index
    }
  }
  groups.push([first, last])

  const oldAt = new Int32Array(ops.length + 1)
  const newAt = new Int32Array(ops.length + 1)
  let oldLine = 1
  let newLine = 1
  for (let index = 0; index < ops.length; index += 1) {
    oldAt[index] = oldLine
    newAt[index] = newLine
    if (ops[index].type === 'equal') {
      oldLine += 1
      newLine += 1
    } else if (ops[index].type === 'delete') {
      oldLine += 1
    } else {
      newLine += 1
    }
  }
  oldAt[ops.length] = oldLine
  newAt[ops.length] = newLine

  return groups.map(([fromChange, toChange]) => {
    const from = Math.max(0, fromChange - context)
    const to = Math.min(ops.length, toChange + 1 + context)
    const lines = []
    let oldLines = 0
    let newLines = 0
    for (let index = from; index < to; index += 1) {
      const op = ops[index]
      if (op.type === 'equal') {
        lines.push(` ${op.line}`)
        oldLines += 1
        newLines += 1
      } else if (op.type === 'delete') {
        lines.push(`-${op.line}`)
        oldLines += 1
      } else {
        lines.push(`+${op.line}`)
        newLines += 1
      }
    }
    return { oldStart: oldAt[from], oldLines, newStart: newAt[from], newLines, lines }
  })
}

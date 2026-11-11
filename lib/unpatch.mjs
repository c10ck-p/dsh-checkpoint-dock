// Reverse a published line comparison back into the text it started from.
//
// The workspace-changes service hands us hunks, not the before image. For a
// path the file tools never touched — a shell script, a formatter, an editor —
// that is the only description of the previous contents, so undo has to rebuild
// it. A hunk applies cleanly or not at all: a context mismatch means the served
// comparison no longer describes this file, and the caller drops the path
// rather than restoring something it cannot vouch for.

/**
 * Lines of a text, with the trailing newline treated as a terminator rather
 * than a final empty line. This matches how the comparison side splits text.
 * @param {string} text
 * @returns {string[]}
 */
function linesOf(text) {
  if (text === '') return []
  return (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n')
}

/**
 * Rebuild the text a set of hunks started from, given the text it ended on.
 * @param {string} afterText - current contents.
 * @param {Array<{newStart: number, newLines: number, lines: string[]}>} hunks
 * @returns {string | null} the previous text, or null when a hunk does not apply.
 */
export function revertHunks(afterText, hunks) {
  if (typeof afterText !== 'string') return null
  if (!Array.isArray(hunks)) return null
  const after = linesOf(afterText)
  /** @type {string[]} */
  const out = []
  let cursor = 0
  for (const hunk of hunks) {
    if (hunk === null || typeof hunk !== 'object') return null
    const start = hunk.newStart - 1
    if (!Number.isInteger(start) || start < cursor || start > after.length) return null
    /** @type {string[]} */
    const side = []
    /** @type {string[]} */
    const original = []
    for (const line of hunk.lines ?? []) {
      if (typeof line !== 'string' || line.length === 0) return null
      const tag = line.slice(0, 1)
      const body = line.slice(1)
      if (tag === ' ') {
        side.push(body)
        original.push(body)
      } else if (tag === '+') {
        side.push(body)
      } else if (tag === '-') {
        original.push(body)
      } else if (tag !== '\\') {
        return null
      }
      // A "\ No newline at end of file" marker carries no text.
    }
    if (side.length !== hunk.newLines) return null
    if (start + side.length > after.length) return null
    for (let index = 0; index < side.length; index += 1) {
      if (after[start + index] !== side[index]) return null
    }
    for (let index = cursor; index < start; index += 1) out.push(after[index])
    out.push(...original)
    cursor = start + side.length
  }
  for (let index = cursor; index < after.length; index += 1) out.push(after[index])
  return out.length === 0 ? '' : `${out.join('\n')}\n`
}

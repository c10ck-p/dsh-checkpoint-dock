// dsh-checkpoint-dock — Host half.
//
// Listens to the filesystem-intent waterfall, remembers the bytes each file had
// before a turn's first write, and seals one record per turn. The conversation
// card reads that record through the Typert Remote service in lib/service.mjs.

import os from 'node:os'
import path from 'node:path'
import { scanWorkspace, changedSince } from './lib/baseline.mjs'
import { takeGitBaseline, gitChanges } from './lib/gitbase.mjs'
import { EditCheckpointService } from './lib/service.mjs'
import { EditCheckpointStore } from './lib/store.mjs'

export const name = 'dsh-checkpoint-dock'
export const inject = ['fs', 'sessions']

const MAX_PROMPT = 160

/** @param {any} session */
function sessionEvents(session) {
  if (typeof session.snapshotEvents === 'function') return session.snapshotEvents()
  return Array.isArray(session.events) ? session.events : []
}

/** @param {any} session @returns {number | undefined} */
function openTurn(session) {
  let turn
  for (const event of sessionEvents(session)) {
    if (event.type === 'turn/start') turn = event.data.turn
    else if (event.type === 'turn/end' && event.data.turn === turn) turn = undefined
  }
  return turn
}

/** @param {any} message @returns {string} */
function messageText(message) {
  if (message === null || typeof message !== 'object') return ''
  if (typeof message.text === 'string') return message.text
  if (!Array.isArray(message.content)) return ''
  return message.content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join(' ')
    .trim()
}

/** @param {any} session @returns {string} */
function latestPrompt(session) {
  const events = sessionEvents(session)
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event.type !== 'user/message') continue
    const source = event.data && event.data.source
    // Ignore runtime reminders, skill catalogs, and other injected messages;
    // only a real user turn may label a checkpoint.
    if (!source || source.kind !== 'user') continue
    const text = messageText(event.data).replace(/\s+/g, ' ').trim()
    if (text === '') continue
    return text.slice(0, MAX_PROMPT)
  }
  return ''
}

/** @param {string} root @param {string} file */
function isInside(root, file) {
  const relative = path.relative(root, file)
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

/** @param {string} root @param {string} file */
function isGitMetadata(root, file) {
  const relative = path.relative(root, file)
  if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return false
  return relative.split(path.sep).some((part) => part.toLowerCase() === '.git')
}

/** @param {any} ctx @param {string} sessionId @returns {string} */
function sessionTitleFromServices(ctx, sessionId) {
  try {
    const session = typeof ctx.sessions?.get === 'function' ? ctx.sessions.get(sessionId) : undefined
    if (!session) return ''
    // `sessionTitle` is an optional sibling service; `ctx.get` keeps this
    // plugin loadable on hosts that do not ship it.
    const titles = typeof ctx.get === 'function' ? ctx.get('sessionTitle') : undefined
    const snapshot = titles && typeof titles.get === 'function' ? titles.get(session) : undefined
    return snapshot && typeof snapshot.title === 'string' ? snapshot.title : ''
  } catch {
    return ''
  }
}

/** @param {any} ctx @param {any} config */
export async function apply(ctx, config) {
  void config
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  const root = path.join(home, 'edit-checkpoints')
  const store = new EditCheckpointStore(root, {
    titleResolver: (sessionId) => sessionTitleFromServices(ctx, sessionId),
    // Liveness for the orphan report: a session is gone only when the live
    // registry does not know it and its directory under $DSH_HOME/sessions is
    // gone too (the store checks the directory itself).
    sessionLookup: (sessionId) => {
      try {
        return typeof ctx.sessions?.get === 'function' && ctx.sessions.get(sessionId) !== undefined
      } catch {
        return false
      }
    },
    logger: ctx.logger,
  })
  /** @type {WeakMap<any, Map<number, number>>} */
  const announcedSeq = new WeakMap()

  const warn = (error) => {
    try {
      ctx.logger?.warn?.(`dsh-checkpoint-dock: ${error && error.message ? error.message : String(error)}`)
    } catch {
      // Logging must never break a write.
    }
  }

  /**
   * Log a background write failure and keep it for the session's storage panel.
   * @param {any} session
   */
  const warnSession = (session) => (error) => {
    warn(error)
    store.noteFailure(session?.id, error)
  }

  /**
   * Turn-start snapshots, keyed by session and turn. Inside a git work tree the
   * snapshot is git's own status plus the content of the paths that were
   * already dirty; elsewhere the workspace is scanned. Either way it holds what
   * the files looked like before the turn wrote anything — the only way to name
   * a write that never passed a `fs/*-intent` hook.
   * @type {Map<string, Promise<
   *   {kind: 'git', root: string, top: string, head: string|null, dirty: Map<string, Buffer>} |
   *   {kind: 'scan', scan: {files: Map<string, Buffer>, exceeded: boolean}} |
   *   undefined>>}
   */
  const baselines = new Map()

  /** @param {string} sessionId @param {number} turn */
  const baselineKey = (sessionId, turn) => `${sessionId}:${turn}`

  /**
   * Read the workspace before the turn writes. Git is preferred because it
   * already knows which paths differ from HEAD, so only those bytes are read;
   * without git the whole workspace is scanned under a budget. A failed
   * snapshot is not an error: that turn then records file-tool writes only, as
   * it always did, instead of attributing unrelated diffs to the agent.
   * @param {any} session @param {number} turn
   */
  const takeBaseline = (session, turn) => {
    const cwd = session.header?.cwd
    if (typeof cwd !== 'string' || cwd === '') return
    const snapshot = takeGitBaseline(cwd)
      .then((git) => (git === null ? scanWorkspace(cwd).then((scan) => ({ kind: 'scan', scan })) : git))
      .catch((error) => {
        warn(error)
        return undefined
      })
    baselines.set(baselineKey(session.id, turn), snapshot)
  }

  /**
   * Record the paths a turn changed outside the file tools by comparing the
   * workspace now against the turn-start snapshot. Both sides must be complete;
   * a path the file tools already recorded is left alone.
   * @param {any} session @param {number} turn
   */
  const captureExternal = async (session, turn) => {
    const key = baselineKey(session.id, turn)
    const pending = baselines.get(key)
    if (pending === undefined) return
    baselines.delete(key)
    const before = await pending
    if (before === undefined) return
    if (before.kind === 'scan' && before.scan.exceeded) return
    const cwd = session.header?.cwd
    if (typeof cwd !== 'string' || cwd === '') return
    /** @type {{absolute: string, before: Buffer|null}[]} */
    const changes = before.kind === 'git'
      ? await gitChanges(before).catch(() => [])
      : await (async () => {
          const after = await scanWorkspace(cwd).catch(() => undefined)
          if (after === undefined || after.exceeded) return []
          return changedSince(before.scan, after).map((change) => ({
            absolute: path.join(cwd, change.path),
            before: change.before,
          }))
        })()
    for (const change of changes) {
      if (isGitMetadata(cwd, change.absolute)) continue
      if (await store.hasFile(session.id, turn, change.absolute)) continue
      await store.capture({
        sessionId: session.id,
        cwd,
        turn,
        absolute: change.absolute,
        prompt: latestPrompt(session),
        before: change.before === null ? { exists: false, buffer: null } : { exists: true, buffer: change.before },
      })
    }
  }

  const captureIntent = async (target, actor, next) => {
    const intent = await next()
    try {
      const session = actor?.agent?.session
      if (!session) return intent
      const turn = openTurn(session)
      if (turn === undefined) return intent
      const cwd = session.header?.cwd
      if (typeof cwd !== 'string' || cwd === '') return intent
      const absolute = ctx.fs.processPath(target)
      if (!isInside(cwd, absolute)) return intent
      // Never checkpoint Git's own metadata: restoring .git/index or refs would
      // fight the repository, and the plugin has no business touching it.
      if (isGitMetadata(cwd, absolute)) return intent
      await store.capture({
        sessionId: session.id,
        cwd,
        turn,
        absolute,
        prompt: latestPrompt(session),
      })
    } catch (error) {
      warn(error)
      // A capture that failed is a checkpoint the user thinks exists; keep the
      // reason for the storage panel instead of only the host log.
      store.noteFailure(actor?.agent?.session?.id, error)
    }
    return intent
  }

  ctx.on('fs/write-intent', captureIntent, { prepend: true })
  ctx.on('fs/edit-intent', captureIntent, { prepend: true })
  ctx.on('fs/delete-intent', captureIntent, { prepend: true })

  /** Turns settling right now, so the two announcing events cannot seal twice. */
  const settling = new WeakMap()

  /**
   * Run the end-of-turn work once: tag the record, capture the paths the file
   * tools missed, seal it against the disk, then apply the cleanup policy.
   * @param {any} session @param {number} turn @param {number} seq
   */
  const settle = (session, turn, seq) => {
    let byTurn = settling.get(session)
    if (byTurn === undefined) {
      byTurn = new Map()
      settling.set(session, byTurn)
    }
    const running = byTurn.get(turn)
    if (running !== undefined) return running
    const work = (async () => {
      await store.noteSeq(session.id, turn, seq)
      await captureExternal(session, turn)
      await store.seal(session.id, turn, seq)
      // Cleanup runs at the turn boundary, never mid-turn: the user's "keep N"
      // setting is applied once the record is sealed and nothing is being
      // written into it any more.
      await store.maybeAutoClean(session.id)
    })()
      .catch(warnSession(session))
      .finally(() => {
        byTurn.delete(turn)
      })
    byTurn.set(turn, work)
    return work
  }

  ctx.on('session/event', (session, event) => {
    try {
      if (event.type === 'turn/start') {
        // A crash before turn/end leaves the previous record open. Settle it
        // against the current disk before this new turn starts capturing, so a
        // stale open record cannot block keep/revert forever.
        void store.recoverOpen(session.id, event.data.turn).catch(warnSession(session))
        takeBaseline(session, event.data.turn)
        return
      }
      if (event.type === 'workspace/changes') {
        const turn = event.data.turn
        let map = announcedSeq.get(session)
        if (map === undefined) {
          map = new Map()
          announcedSeq.set(session, map)
        }
        map.set(turn, event.seq)
        void settle(session, turn, event.seq)
        return
      }
      if (event.type !== 'turn/end') return
      const turn = event.data.turn
      void settle(session, turn, announcedSeq.get(session)?.get(turn) ?? event.seq)
    } catch (error) {
      warn(error)
    }
  })

  ctx.on('session/disposed', (session) => {
    announcedSeq.delete(session)
    const prefix = `${session.id}:`
    for (const key of [...baselines.keys()]) {
      if (key.startsWith(prefix)) baselines.delete(key)
    }
  })

  await ctx.plugin(EditCheckpointService, { store })
}

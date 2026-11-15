// lib/service.mjs — the Typert Remote namespace the conversation card calls.

import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { SERVICE } from './wire.mjs'

// Settings ride an already-registered route (see the sentinel comment below):
// the payload travels in the sessionId string, because the gateway only ever
// passes (sessionId, turn).
const CONFIG_PREFIX = 'config:'
const CONFIG_TURN = -999997

// The light poll and the two read-only previews ride `get` as well, because the
// gateway's method table is fixed at boot. A preview folds its target turn into
// the sentinel: -1_000_000 - turn for an undo, -2_000_000 - turn for a revert.
// These are checked before the diff route, which owns every other negative turn.
const LITE_TURN = -999990
const PREVIEW_UNDO_BASE = 1_000_000
const PREVIEW_REVERT_BASE = 2_000_000

/**
 * The wire codecs are passthrough (see lib/wire.mjs), so anything a client
 * sends arrives here unchanged. Every route validates before the values reach
 * a file path: a turn is joined into `<turn>.json`, so a string like `../x`
 * must never get that far.
 * @param {unknown} value
 * @returns {value is string}
 */
function isSessionId(value) {
  return typeof value === 'string' && value.length > 0
}

/** @param {unknown} value @returns {value is number} */
function isTurn(value) {
  return Number.isSafeInteger(value)
}

export class EditCheckpointService extends TypertRemoteService {
  /**
   * @param {import('@deepseek-ai/cordis').Context} ctx
   * @param {{store: import('./store.mjs').EditCheckpointStore}} deps
   */
  constructor(ctx, deps) {
    super(ctx, SERVICE)
    this._deps = deps
  }

  /**
   * @param {string} sessionId
   * @param {number} turn
   */
  async get(sessionId, turn) {
    if (!isSessionId(sessionId) || !isTurn(turn)) return null
    // Members are advertised by the boot-time Typert manifest. A method added
    // after boot has no gateway route until DSH restarts, so the new reads
    // reuse this already-registered route with sentinel turn values.
    if (typeof sessionId === 'string' && sessionId.startsWith(CONFIG_PREFIX) && turn === CONFIG_TURN) {
      return await this._deps.store.readConfig()
    }
    if (sessionId === '*' && turn === 0) return await this._deps.store.listAll()
    // Journal state for the recovery banner rides get with its own sentinel.
    if (sessionId === 'journal' && turn === -999992) return await this._deps.store.journalInfo()
    // A preview changes nothing on disk: it is the same preflight the real
    // action runs, stopped before the first write.
    if (turn <= -PREVIEW_REVERT_BASE) return await this._deps.store.previewRevert(sessionId, -PREVIEW_REVERT_BASE - turn)
    if (turn <= -PREVIEW_UNDO_BASE) return await this._deps.store.previewUndo(sessionId, -PREVIEW_UNDO_BASE - turn)
    if (turn === LITE_TURN) return await this._deps.store.listLite(sessionId)
    if (turn === 0) return await this._deps.store.list(sessionId, { limit: 0 })
    if (turn === -999999) return await this._deps.store.stats(sessionId)
    if (turn < 0) return await this._deps.store.diff(sessionId, -turn)
    return this._deps.store.get(sessionId, turn)
  }

  /**
   * @param {string} sessionId
   * @param {number} turn
   */
  async keep(sessionId, turn) {
    if (!isSessionId(sessionId) || !isTurn(turn)) return { ok: false, message: 'invalid checkpoint request' }
    // A negative turn toggles the storage pin. The gate has only get/keep/undo
    // routes until DSH restarts, so pin rides the keep route.
    if (turn < 0) return this._deps.store.pin(sessionId, -turn)
    return this._deps.store.keep(sessionId, turn)
  }

  /**
   * A negative turn means "revert to the checkpoint named by the absolute
   * value": undo every newer active checkpoint newest-first in one Host-side
   * preflight/apply pass. A positive turn is the ordinary single undo.
   * @param {string} sessionId
   * @param {number} turn
   */
  async undo(sessionId, turn) {
    if (!isSessionId(sessionId) || !isTurn(turn)) return { ok: false, message: 'invalid checkpoint request' }
    // Settings write, same sentinel trick: the JSON patch rides sessionId.
    if (typeof sessionId === 'string' && sessionId.startsWith(CONFIG_PREFIX) && turn === CONFIG_TURN) {
      let patch
      try {
        patch = JSON.parse(sessionId.slice(CONFIG_PREFIX.length))
      } catch {
        return { ok: false, message: 'invalid settings payload' }
      }
      return this._deps.store.setConfig(patch)
    }
    if (turn === -999999) return this._deps.store.clean(sessionId)
    // Second sentinel: drop the checkpoints of sessions DSH no longer has.
    if (turn === -999998) return this._deps.store.purgeOrphans()
    // Third sentinel: mint a fresh encryption key. Old keys stay on disk, so
    // rotating never makes existing content unreadable.
    if (turn === -999995) return this._deps.store.rotateKey()
    // Fourth sentinel: take one revert back. The batch id rides sessionId.
    if (typeof sessionId === 'string' && sessionId.startsWith('batch:') && turn === -999994) {
      return this._deps.store.redoBatch(sessionId.slice('batch:'.length))
    }
    // Fifth sentinel: a restore that was interrupted by a crash. Applying it is
    // always a user decision, so both directions ride explicit sentinels.
    // Sixth: drop one checkpoint's content by hand. The session rides a
    // "clean:" prefix, the turn stays a real turn number.
    if (typeof sessionId === 'string' && sessionId.startsWith('clean:') && turn > 0) {
      return this._deps.store.cleanRecord(sessionId.slice('clean:'.length), turn)
    }
    // Seventh: delete every checkpoint of one session. The id rides the prefix.
    if (typeof sessionId === 'string' && sessionId.startsWith('purge:') && turn === -999993) {
      const target = sessionId.slice('purge:'.length)
      if (target === '*') return this._deps.store.purgeAll()
      return this._deps.store.purgeSession(target)
    }
    if (sessionId === 'journal:resume' && turn === -999992) return this._deps.store.resumeJournal()
    if (sessionId === 'journal:discard' && turn === -999991) return this._deps.store.discardJournal()
    if (turn < 0) return this._deps.store.revert(sessionId, -turn)
    // Positive turn: an undone record redoes; everything else undoes. The
    // client does not need a second route to know which direction to take.
    const record = await this._deps.store.get(sessionId, turn)
    if (record !== null && record.status === 'undone') return this._deps.store.redo(sessionId, turn)
    return this._deps.store.undo(sessionId, turn)
  }
}

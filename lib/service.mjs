// lib/service.mjs — the Typert Remote namespace the conversation card calls.

import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { SERVICE } from './wire.mjs'

// Settings ride an already-registered route (see the sentinel comment below):
// the payload travels in the sessionId string, because the gateway only ever
// passes (sessionId, turn).
const CONFIG_PREFIX = 'config:'
const CONFIG_TURN = -999997

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
    if (turn < 0) return this._deps.store.revert(sessionId, -turn)
    // Positive turn: an undone record redoes; everything else undoes. The
    // client does not need a second route to know which direction to take.
    const record = await this._deps.store.get(sessionId, turn)
    if (record !== null && record.status === 'undone') return this._deps.store.redo(sessionId, turn)
    return this._deps.store.undo(sessionId, turn)
  }
}

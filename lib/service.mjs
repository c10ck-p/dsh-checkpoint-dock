// lib/service.mjs — the Typert Remote namespace the conversation card calls.

import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { SERVICE } from './wire.mjs'

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
    // Members are advertised by the boot-time Typert manifest. A method added
    // after boot has no gateway route until DSH restarts, so the new reads
    // reuse this already-registered route with sentinel turn values.
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

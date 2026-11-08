// lib/wire.mjs — Typert Remote contract shared by the Host manifest and the
// browser client. The values crossing this boundary are plain JSON that the
// Host itself produced, so the codecs are shape-preserving; the Host service
// validates and sanitizes before returning.

export const PACKAGE = 'dsh-checkpoint-dock'
export const SERVICE = 'editCheckpoints'

const SOURCE_LOCATION = Object.freeze({ file: 'lib/wire.mjs', line: 1, column: 1 })

/**
 * A Typert strict codec whose parser returns the value unchanged. The gateway
 * consumes `codec.create().parse(value)`; the Host service is the authority for
 * the actual shape.
 * @param {string} typeSymbol - wire type name.
 * @returns {{mode: 'strict', typeSymbol: string, create: () => {parse: (value: unknown) => unknown}}}
 */
function passthroughCodec(typeSymbol) {
  return {
    mode: 'strict',
    typeSymbol,
    create: () => ({ parse: (value) => value }),
  }
}

const sessionIdSchema = passthroughCodec(`${PACKAGE}/types#SessionId`)
const turnSchema = passthroughCodec(`${PACKAGE}/types#Turn`)
const recordSchema = passthroughCodec(`${PACKAGE}/types#EditCheckpoint`)
const actionSchema = passthroughCodec(`${PACKAGE}/types#EditCheckpointAction`)

function parameter(name, codec) {
  return Object.freeze({ name, wire: name, source: 'json', codec })
}

export const GET_DESCRIPTOR = Object.freeze({
  id: `${PACKAGE}#${SERVICE}/get`,
  service: SERVICE,
  namespace: SERVICE,
  method: 'get',
  invocation: Object.freeze({ kind: 'direct' }),
  parameters: Object.freeze([
    parameter('sessionId', sessionIdSchema),
    parameter('turn', turnSchema),
  ]),
  result: recordSchema,
  sourceLocation: SOURCE_LOCATION,
})

export const KEEP_DESCRIPTOR = Object.freeze({
  id: `${PACKAGE}#${SERVICE}/keep`,
  service: SERVICE,
  namespace: SERVICE,
  method: 'keep',
  invocation: Object.freeze({ kind: 'direct' }),
  parameters: Object.freeze([
    parameter('sessionId', sessionIdSchema),
    parameter('turn', turnSchema),
  ]),
  result: actionSchema,
  sourceLocation: SOURCE_LOCATION,
})

export const UNDO_DESCRIPTOR = Object.freeze({
  id: `${PACKAGE}#${SERVICE}/undo`,
  service: SERVICE,
  namespace: SERVICE,
  method: 'undo',
  invocation: Object.freeze({ kind: 'direct' }),
  parameters: Object.freeze([
    parameter('sessionId', sessionIdSchema),
    parameter('turn', turnSchema),
  ]),
  result: actionSchema,
  sourceLocation: SOURCE_LOCATION,
})

export const EDIT_CHECKPOINT_INVOCATIONS = Object.freeze([
  GET_DESCRIPTOR,
  KEEP_DESCRIPTOR,
  UNDO_DESCRIPTOR,
])

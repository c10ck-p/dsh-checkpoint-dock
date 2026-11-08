// typert.host.mjs — Host manifest consumed by the Typert Gateway.

import { EDIT_CHECKPOINT_INVOCATIONS, PACKAGE } from './lib/wire.mjs'

export const TYPERT = Object.freeze({
  package: PACKAGE,
  face: 'host',
  schemas: Object.freeze([]),
  invocations: EDIT_CHECKPOINT_INVOCATIONS,
  model: Object.freeze({ services: [], events: [], objects: [] }),
})

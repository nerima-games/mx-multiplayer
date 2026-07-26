import { describe, expect, it } from '@effect/vitest'
import { Effect } from 'effect'
import * as multiplayer from '../index'
import { decodeFrame, encodeFrame } from '../domain/codec'
import { MESSAGE_TAGS, PROTOCOL_VERSION } from '../domain/protocol'

describe('public API surface', () => {
  // The barrel is what mc-compose imports. A re-export dropped here is
  // invisible to every other test in this repository but breaks the composition
  // repository, so it is pinned explicitly.
  it.effect('re-exports every value a consumer is expected to import', () =>
    Effect.sync(() => {
      const expected = [
        // protocol
        'PROTOCOL_VERSION',
        'PlayerId',
        'PlayerName',
        'WorldId',
        'Vec3',
        'BlockPos',
        'Orientation',
        'NetworkMessage',
        'MESSAGE_TAGS',
        'Frame',
        // codec
        'encodeFrame',
        'encodeFrameAsVersion',
        'decodeFrame',
        // errors
        'ProtocolError',
        'TransportError',
        // connection
        'initialConnectionState',
        'transition',
        'runTransitions',
        'canSend',
        'isSettled',
        // transport
        'TransportPort',
        'sendMessage',
        'receiveMessage',
        'makeLoopbackPair',
        'LoopbackTransportLayer',
        'disconnectedTransport',
      ]

      for (const name of expected) {
        expect(Object.keys(multiplayer)).toContain(name)
      }
    }),
  )

  it.effect('exposes the same implementations through the barrel as through the modules', () =>
    Effect.sync(() => {
      expect(multiplayer.encodeFrame).toBe(encodeFrame)
      expect(multiplayer.decodeFrame).toBe(decodeFrame)
      expect(multiplayer.MESSAGE_TAGS).toBe(MESSAGE_TAGS)
      expect(multiplayer.PROTOCOL_VERSION).toBe(PROTOCOL_VERSION)
    }),
  )

  // REGRESSION: plan.md §3.14 — "transport and protocol only". A renderer, a
  // DOM node or a screen component appearing in this barrel means the mx-ui
  // boundary has been crossed. This is a weak check (a name test), and it is
  // here to make the intent visible at the place a new export gets added.
  it.effect('exports nothing that sounds like a screen, a view or a renderer', () =>
    Effect.sync(() => {
      const forbidden = /screen|menu|hud|render|dom|element|widget|overlay/iu
      const offenders = Object.keys(multiplayer).filter((name) => forbidden.test(name))
      expect(offenders).toStrictEqual([])
    }),
  )

  // REGRESSION: the protocol version is part of the published contract. Bumping
  // it is a deliberate act that has to be paired with a compatibility note in
  // docs/versioning.md, not something that happens by accident.
  it.effect('pins the protocol version, so a bump is always an explicit edit', () =>
    Effect.sync(() => {
      expect(PROTOCOL_VERSION).toBe(1)
    }),
  )
})

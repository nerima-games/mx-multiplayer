import { describe, expect, it } from '@effect/vitest'
import { Effect } from 'effect'
import * as multiplayer from '../src/index'
import { decodeFrame, encodeFrame } from '../src/domain/codec'
import { MESSAGE_TAGS, PROTOCOL_VERSION } from '../src/domain/protocol'

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
        // authoritative resync admission
        'AuthoritativeRevisionTracker',
        // transport
        'TransportPort',
        'connectionGatedTransport',
        'sendMessage',
        'receiveMessage',
        'makeLoopbackPair',
        'LoopbackTransportLayer',
        'disconnectedTransport',
        // deterministic client-side snapshot interpolation
        'SnapshotInterpolator',
        // stages — what mc-compose merges and what a consumer names
        'MULTIPLAYER_STAGE_IDS',
        'UPSTREAM_STAGE_IDS',
        'EXPERIENCE_MODULE_STAGE_PREFIXES',
        'OWN_STAGE_PREFIX',
        'multiplayerModule',
        'multiplayerStages',
        'makeMultiplayerStages',
        'makeMultiplayerStagesForPreview',
        'makeMultiplayerFrameState',
        'NO_NETWORK_FRAMES',
      ]

      for (const name of expected) {
        expect(Object.keys(multiplayer)).toContain(name)
      }
    }),
  )

  // REGRESSION: `domain/frame-contract.ts` is a stand-in for mc-kernel and
  // carries a deletion date. Re-exporting it would put `StageId`,
  // `DeltaTimeSecs` and `StageRegistration` into THIS package's published
  // surface, so a consumer would still be importing them from here on the day
  // the file is deleted — and two `StageId` brands with one name are one type to
  // TypeScript however differently they validate. mx-gameplay and mx-redstone
  // make the same call; this pins it.
  it.effect('does not re-export the local mc-kernel stand-in', () =>
    Effect.sync(() => {
      for (const name of ['StageId', 'DeltaTimeSecs', 'StageRegistration', 'GameModule']) {
        expect(Object.keys(multiplayer)).not.toContain(name)
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

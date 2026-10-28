import { describe, expect, it } from '@effect/vitest'
import { expectTypeOf } from 'vitest'
import { Effect } from 'effect'
import * as multiplayer from '../src/index'
import { decodeFrame, encodeFrame } from '../src/domain/codec'
import { MESSAGE_TAGS, PROTOCOL_VERSION } from '../src/domain/protocol'
import type {
  AreaOfInterest,
  AreaOfInterestInputErrorReason,
  BrowserTransportFault,
  BrowserWebSocketTransport,
  BrowserWebSocketTransportOptions,
  ChunkCoordinate,
  ChunkInterestKey,
  CommandApplicationFailure,
  CommandApplicationOutcome,
  CommandDecision,
  CommandNotWritable,
  ChunkInterest,
  ConnectionRateLimitConfig,
  ConnectionRateLimitConfigField,
  ConnectionRateLimitFailure,
  ConnectionRateLimiter,
  DeltaProjectionErrorReason,
  DeltaProjectionOutcome,
  DeltaProjectionRecipient,
  FrameTag,
  HungerIntent,
  HungerRejectionReason,
  InboundFrameInspection,
  NonNegativeSafeInteger,
  PositiveSafeInteger,
  RateLimitConfigurationErrorReason,
  RateLimitExceededReason,
  RateLimitInputErrorReason,
  ServerConnectionIdentity,
  SurvivalAuthorityResult,
  SurvivalCommandResult,
  SurvivalIntent,
  TransportService,
  WireText,
} from '../src/index'

type NewPublicTypes = {
  area: AreaOfInterest
  areaErrorReason: AreaOfInterestInputErrorReason
  browserTransportFault: BrowserTransportFault
  browserWebSocketTransport: BrowserWebSocketTransport
  browserWebSocketTransportOptions: BrowserWebSocketTransportOptions
  chunkCoordinate: ChunkCoordinate
  chunkInterestKey: ChunkInterestKey
  chunk: ChunkInterest
  commandApplicationFailure: CommandApplicationFailure
  commandApplicationOutcome: CommandApplicationOutcome
  commandDecision: CommandDecision
  commandNotWritable: CommandNotWritable
  connectionIdentity: ServerConnectionIdentity
  hungerIntent: HungerIntent
  hungerRejectionReason: HungerRejectionReason
  frameTag: FrameTag
  inboundFrameInspection: InboundFrameInspection
  limitConfig: ConnectionRateLimitConfig
  limitConfigField: ConnectionRateLimitConfigField
  limitFailure: ConnectionRateLimitFailure
  limiter: ConnectionRateLimiter
  nonNegativeSafeInteger: NonNegativeSafeInteger
  positiveSafeInteger: PositiveSafeInteger
  projectionErrorReason: DeltaProjectionErrorReason
  projectionOutcome: DeltaProjectionOutcome
  projectionRecipient: DeltaProjectionRecipient
  rateConfigurationErrorReason: RateLimitConfigurationErrorReason
  rateExceededReason: RateLimitExceededReason
  rateInputErrorReason: RateLimitInputErrorReason
  survivalAuthorityResult: SurvivalAuthorityResult
  survivalCommandResult: SurvivalCommandResult
  survivalIntent: SurvivalIntent
  transportService: TransportService
  wireText: WireText
}

describe('public API surface', () => {
  // The barrel is what mc-compose imports. A re-export dropped here is
  // Invisible to every other test in this repository but breaks the composition
  // Repository, so it is pinned explicitly.
  it.effect('re-exports every value a consumer is expected to import', () =>
    Effect.sync(() => {
      const expected = [
        // Per-recipient scale projection
        'AreaOfInterestInputError',
        'chunkInterestKeyForBlockChange',
        'createAreaOfInterest',
        'isAreaOfInterest',
        'areaOfInterestIncludesOwner',
        'areaOfInterestIncludesChunkKey',
        'areaOfInterestIncludesBlockChange',
        'areaOfInterestExpanded',
        'MAX_C4_DELTA_FRAME_BYTES',
        'DeltaProjectionError',
        'projectReplicatedWorldDelta',
        'CONNECTION_RATE_LIMITS',
        'RateLimitConfigurationError',
        'RateLimitInputError',
        'RateLimitExceeded',
        'createConnectionRateLimiter',
        // Transport safety and liveness
        'makeBrowserWebSocketTransport',
        'validateMultiplayerUrl',
        'frameTag',
        'inspectInboundFrame',
        // Protocol
        'PROTOCOL_VERSION',
        'PlayerId',
        'PlayerName',
        'WorldId',
        'Vec3',
        'BlockPos',
        'Orientation',
        'PoweredRailSnapshot',
        'EndPortalUseCommand',
        'ThrowEyeOfEnderCommand',
        'EyeOfEnderThrown',
        'LightningStrikeDelta',
        'InsertEyeIntoEndPortalFrameCommand',
        'NetherPortalUseCommand',
        'RealmTransferSnapshot',
        'NetworkMessage',
        'MESSAGE_TAGS',
        'Frame',
        'NonNegativeSafeIntegerSchema',
        'PositiveSafeIntegerSchema',
        'ReplicatedOwnerStateBoundsSchema',
        'ReplicatedOwnerRegistryLimitsSchema',
        'SnapshotTransferLimitsSchema',
        'ReplicatedBlockKeySchema',
        'ReplicatedWorldDeltaMessage',
        'ReplicatedWorldSnapshot',
        'ReplicatedWorldSnapshotStart',
        'ReplicatedWorldSnapshotChunk',
        'ReplicatedWorldSnapshotEnd',
        'TransferIdSchema',
        'Base64Schema',
        'LowercaseHexSha256Schema',
        // Codec
        'encodeFrame',
        'encodeFrameAsVersion',
        'decodeFrame',
        'decodeTransferredSnapshotFrame',
        'encodeTransferredSnapshotFrame',
        'createReplicatedOwnerRegistry',
        'inspectReplicatedFrameTag',
        'wireFrameByteLength',
        // Errors
        'ProtocolError',
        'TransportError',
        'SnapshotInterpolationConfigError',
        'SnapshotTransferConfigError',
        // Connection
        'initialConnectionState',
        'transition',
        'runTransitions',
        'canSend',
        'isSettled',
        // C4 client synchronization and bounded snapshot transfer
        'SnapshotTransferReceiver',
        'AuthoritativeClientState',
        'applyReplicatedWorldSnapshot',
        'applyReplicatedWorldDelta',
        'decodeTransferredSnapshot',
        'decodeUtf8Frame',
        'sha256Hex',
        // Authoritative resync admission
        'AuthoritativeRevisionTracker',
        // Transport
        'TransportPort',
        'connectionGatedTransport',
        'sendMessage',
        'receiveMessage',
        'makeLoopbackPair',
        'LoopbackTransportLayer',
        'disconnectedTransport',
        // Deterministic client-side snapshot interpolation
        'SnapshotInterpolator',
        // Stages — what mc-compose merges and what a consumer names
        'MULTIPLAYER_STAGE_IDS',
        'UPSTREAM_STAGE_IDS',
        'EXPERIENCE_MODULE_STAGE_PREFIXES',
        'OWN_STAGE_PREFIX',
        'multiplayerModule',
        'multiplayerStages',
        'makeMultiplayerStages',
        'makeMultiplayerStagesForPreview',
        'makeMultiplayerStagesForClientPreview',
        'makeMultiplayerHostWithClientSync',
        'makeMultiplayerFrameState',
        'NO_NETWORK_FRAMES',
      ]

      for (const name of expected) {
        expect(Object.keys(multiplayer)).toContain(name)
      }
    }),
  )

  // REGRESSION: `StageId`, `DeltaTimeSecs`, `StageRegistration` and `GameModule`
  // come from @nerima-games/mc-kernel. Re-exporting them would put kernel's own
  // types into THIS package's published surface, so a consumer would be
  // depending on this package for kernel's types rather than on kernel itself.
  // mx-gameplay and mx-redstone make the same call; this pins it.
  it.effect('does not re-export the mc-kernel frame contract types', () =>
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
  // Boundary has been crossed. This is a weak check (a name test), and it is
  // Here to make the intent visible at the place a new export gets added.
  it.effect('exports nothing that sounds like a screen, a view or a renderer', () =>
    Effect.sync(() => {
      const forbidden = /screen|menu|hud|render|dom|element|widget|overlay/iu
      const offenders = Object.keys(multiplayer).filter((name) => forbidden.test(name))
      expect(offenders).toStrictEqual([])
    }),
  )

  // REGRESSION: the protocol version is part of the published contract. Bumping
  // It is a deliberate act that has to be paired with a compatibility note in
  // Docs/versioning.md, not something that happens by accident.
  it.effect('pins the protocol version, so a bump is always an explicit edit', () =>
    Effect.sync(() => {
      expect(PROTOCOL_VERSION).toBe(10)
    }),
  )

  it.effect('keeps the public type surface concrete', () =>
    Effect.sync(() => {
      expectTypeOf<NewPublicTypes>().toBeObject()
    }),
  )
})

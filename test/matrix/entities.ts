import type { CommandUnsupportedReason } from '../../src/application/server/command-application.js'
import type { MatrixCell, MatrixRow, TestReference } from './index.js'

const reference = (file: `test/${string}`, line: number, testName: string): TestReference => ({ file, line, testName })

const codecRoundTrip = reference(
  'test/codec.test.ts',
  1233,
  'every message decodes back to a value strictly equal to the one encoded',
)
const entitiesWireShape = reference(
  'test/scenarios/entities.test.ts',
  21,
  'decodes every entities tag and rejects malformed fishing state',
)
const entitiesAuthority = reference(
  'test/scenarios/entities.test.ts',
  42,
  'records supported and unsupported entities command authority outcomes',
)
const entitiesUnauthorized = reference(
  'test/scenarios/entities.test.ts',
  64,
  'rejects entity command identity spoofing and accepts a valid control',
)
const legacyWireFixture = reference(
  'test/wire-fixtures.test.ts',
  124,
  'pins current golden bytes and version rejection for every representative family',
)

const covered = (...tests: [TestReference, ...TestReference[]]): MatrixCell => ({ status: 'covered', tests })
const a1 = covered(codecRoundTrip, entitiesWireShape)
const authorityOutcome = covered(entitiesAuthority)
const unauthorizedCommand = covered(entitiesUnauthorized)
const excluded = (reason: string): MatrixCell => ({ status: 'excluded', reason })
const gap = (reason: string, evidence: readonly string[]): MatrixCell => ({ status: 'gap', reason, evidence })
const legacyWireCompatibility = covered(legacyWireFixture)
const noLegacyWireFixture = excluded(
  'X2 freezes representative legacy frames by family, but this tag has no tag-specific v0.11.0 or v0.12.0 frame fixture (test/wire-fixtures.test.ts:124).',
)
const unsupported = (reason: CommandUnsupportedReason): MatrixCell => ({
  status: 'covered',
  tests: [entitiesAuthority],
  unsupportedCommandReason: reason,
})

const notAnAuthoritativeCommand = excluded(
  'This authoritative state or event delta is not a client command, so A2 does not apply (src/domain/protocol.ts:767-792,1102-1147).',
)
const noClientStateApplication = gap(
  'A3 requires comparing client snapshots and post-delta state. This runtime records non-command G5 messages as decoded without applying or broadcasting them.',
  ['apps/debug-ui/entrypoints/scenarios/scenario-runtime.ts:760', 'apps/debug-ui/entrypoints/scenarios/scenario-runtime.ts:772'],
)
const noCommandStateApplication = gap(
  'A3 requires comparing client snapshots after an authoritative state change. Accepted G5 commands produce a canonical intent, but this runtime does not apply game state or emit a delta.',
  ['apps/debug-ui/entrypoints/scenarios/scenario-runtime.ts:767', 'apps/debug-ui/entrypoints/scenarios/scenario-runtime.ts:815'],
)
const noServerDirectionRejection = gap(
  'A7 applies because a client can submit a server-authoritative G5 delta or event, but the runtime records decoded non-command messages instead of rejecting the wrong direction.',
  ['src/domain/protocol.ts:767-794', 'apps/debug-ui/entrypoints/scenarios/scenario-runtime.ts:760', 'apps/debug-ui/entrypoints/scenarios/scenario-runtime.ts:772-774'],
)
const entityAttackStateGap = gap(
  'A3 requires comparing client state after an entity attack. mc-sim MeleeAttack carries no target EntityId, so mx-multiplayer cannot apply or project the resulting target state.',
  ['src/application/server/command-application.ts:202-210', 'apps/debug-ui/entrypoints/scenarios/scenario-runtime.ts:813-819', 'node_modules/@nerima-games/mc-sim/dist/application/intent-queue.d.ts:56-58,128-130'],
)
const noDeltaOrderingAndResync = gap(
  'A4 requires observing G5 state after loss, duplication, reordering, delay, and resync. The scenario runtime only decodes non-command G5 messages and has no receiver for their applied state.',
  ['apps/debug-ui/entrypoints/scenarios/scenario-runtime.ts:727', 'apps/debug-ui/entrypoints/scenarios/scenario-runtime.ts:760', 'apps/debug-ui/entrypoints/scenarios/scenario-runtime.ts:772', 'scenarios/types.ts:87', 'scenarios/types.ts:104'],
)
const noCommandOrderingAndResync = gap(
  'A4 requires observing resulting G5 state after faults and AuthoritativeResyncRequest. The command path accepts an intent without applying or broadcasting its result.',
  ['apps/debug-ui/entrypoints/scenarios/scenario-runtime.ts:767', 'apps/debug-ui/entrypoints/scenarios/scenario-runtime.ts:815', 'scenarios/types.ts:87'],
)
const noDeltaReconnectSnapshot = gap(
  'A5 requires a G5 delta receiver and authoritative snapshot on reconnect. The current runtime resets its connections and creates fresh clients without applying a G5 snapshot.',
  ['apps/debug-ui/entrypoints/scenarios/scenario-runtime.ts:337', 'apps/debug-ui/entrypoints/scenarios/scenario-runtime.ts:382', 'apps/debug-ui/entrypoints/scenarios/scenario-runtime.ts:407', 'apps/debug-ui/entrypoints/scenarios/scenario-runtime.ts:760'],
)
const noCommandReconnectResult = gap(
  'A5 requires comparing G5 state before and after reconnect. This command is accepted as a C2 intent, but the runtime has no G5 state result or snapshot to restore.',
  ['apps/debug-ui/entrypoints/scenarios/scenario-runtime.ts:337', 'apps/debug-ui/entrypoints/scenarios/scenario-runtime.ts:382', 'apps/debug-ui/entrypoints/scenarios/scenario-runtime.ts:815'],
)
const noDeltaVisibilityProjection = gap(
  'A6 requires G5 recipient filtering and update-load checks. The current AOI scenario projects ReplicatedWorldDelta block changes, while this runtime has no G5 broadcaster.',
  ['scenarios/visibility-load.ts:83', 'scenarios/visibility-load.ts:105', 'scenarios/visibility-load.ts:195', 'apps/debug-ui/entrypoints/scenarios/scenario-runtime.ts:772'],
)
const noCommandVisibilityProjection = gap(
  'A6 requires observing G5 state publication under recipient filtering and load. This tag enters the authority as a command and the current runtime does not produce its G5 delta.',
  ['apps/debug-ui/entrypoints/scenarios/scenario-runtime.ts:767', 'apps/debug-ui/entrypoints/scenarios/scenario-runtime.ts:815', 'scenarios/visibility-load.ts:195'],
)
const lightningHasNoPersistentConvergence = excluded(
  'LightningStrikeDelta is a short-lived rendered impact rather than persistent entity state, so A3 snapshot convergence does not apply (src/domain/protocol.ts:743-749).',
)
const lightningHasNoReconnectReplay = excluded(
  'LightningStrikeDelta is a short-lived rendered impact and is not state to replay in a reconnect snapshot (src/domain/protocol.ts:743-749).',
)
const deltaRow = (
  A1: MatrixCell,
  A3: MatrixCell = noClientStateApplication,
  A5: MatrixCell = noDeltaReconnectSnapshot,
  A8: MatrixCell = noLegacyWireFixture,
): MatrixRow => ({
  A1,
  A2: notAnAuthoritativeCommand,
  A3,
  A4: noDeltaOrderingAndResync,
  A5,
  A6: noDeltaVisibilityProjection,
  A7: noServerDirectionRejection,
  A8,
})

const commandRow = (
  A1: MatrixCell,
  A2: MatrixCell,
  A3: MatrixCell = noCommandStateApplication,
  A7: MatrixCell = unauthorizedCommand,
): MatrixRow => ({
  A1,
  A2,
  A3,
  A4: noCommandOrderingAndResync,
  A5: noCommandReconnectResult,
  A6: noCommandVisibilityProjection,
  A7,
  A8: noLegacyWireFixture,
})

const noMatchingIntent: CommandUnsupportedReason = 'no-matching-c2-intent-payload'
const intentDoesNotPreserveCommand: CommandUnsupportedReason = 'intent-payload-does-not-preserve-command'

export const entities: Record<
  | 'PlayerFishingDelta'
  | 'WorldTimeWeatherDelta'
  | 'EntitySpawnDelta'
  | 'EntityUpdateDelta'
  | 'EntityDespawnDelta'
  | 'LightningStrikeDelta'
  | 'WorldTimeWeatherCommand'
  | 'EntityAttackCommand'
  | 'EntityPickupCommand'
  | 'BowUseCommand'
  | 'IgniteTntCommand'
  | 'EnderPearlCommand'
  | 'BucketUseCommand'
  | 'VehicleUseCommand'
  | 'FishingCommand'
  | 'VehicleCommand',
  MatrixRow
> = {
  PlayerFishingDelta: deltaRow(a1),
  WorldTimeWeatherDelta: deltaRow(a1),
  EntitySpawnDelta: deltaRow(a1),
  EntityUpdateDelta: deltaRow(a1),
  EntityDespawnDelta: deltaRow(a1, noClientStateApplication, noDeltaReconnectSnapshot, legacyWireCompatibility),
  LightningStrikeDelta: deltaRow(a1, lightningHasNoPersistentConvergence, lightningHasNoReconnectReplay),
  WorldTimeWeatherCommand: commandRow(a1, unsupported(noMatchingIntent)),
  EntityAttackCommand: commandRow(a1, unsupported(intentDoesNotPreserveCommand), entityAttackStateGap),
  EntityPickupCommand: commandRow(a1, unsupported(noMatchingIntent)),
  BowUseCommand: commandRow(a1, authorityOutcome),
  IgniteTntCommand: commandRow(a1, unsupported(noMatchingIntent)),
  EnderPearlCommand: commandRow(a1, unsupported(intentDoesNotPreserveCommand)),
  BucketUseCommand: commandRow(a1, unsupported(noMatchingIntent)),
  VehicleUseCommand: commandRow(a1, unsupported(noMatchingIntent)),
  FishingCommand: commandRow(a1, authorityOutcome),
  VehicleCommand: commandRow(a1, authorityOutcome),
}

import type { CommandUnsupportedReason } from '../../src/application/server/command-application.js'
import type { MatrixCell, MatrixRow, TestReference } from './index.js'

const reference = (file: `test/${string}`, line: number, testName: string): TestReference => ({ file, line, testName })

const roundTrip = reference(
  'test/codec.test.ts',
  1241,
  'every message decodes back to a value strictly equal to the one encoded',
)
const malformedPortal = reference(
  'test/codec.test.ts',
  3028,
  'rejects client-selected portal transfer state with strict parse options',
)
const malformedDragon = reference('test/codec.test.ts', 2953, 'rejects malformed ender-dragon payloads')
const malformedWither = reference('test/codec.test.ts', 2976, 'rejects malformed wither payloads')
const typedUnsupportedCommand = reference(
  'test/command-application.test.ts',
  192,
  'returns a typed unsupported result only when no C2 payload preserves the command',
)
const authorityScenario = reference(
  'test/scenarios/dimensions-bosses.test.ts',
  24,
  'records authority decisions for portal, eye, and lever commands under A2',
)
const unauthorizedScenario = reference(
  'test/scenarios/dimensions-bosses.test.ts',
  49,
  'rejects forged player IDs before the authorized unsupported-action control under A7',
)
const legacyWireFixture = reference(
  'test/wire-fixtures.test.ts',
  124,
  'rejects old golden bytes and checks the protocol-11 envelope for each representative family',
)

const covered = (...tests: [TestReference, ...TestReference[]]): MatrixCell => ({ status: 'covered', tests })
const excluded = (reason: string): MatrixCell => ({ status: 'excluded', reason })
const gap = (reason: string, ...evidence: string[]): MatrixCell => ({ status: 'gap', reason, evidence })
const legacyWireCompatibility = covered(legacyWireFixture)
const noLegacyWireFixture = excluded(
  'X2 freezes representative legacy frames by family, but this tag has no tag-specific v0.11.0 or v0.12.0 frame fixture (test/wire-fixtures.test.ts:124).',
)
const unsupported = (reason: CommandUnsupportedReason): MatrixCell => ({
  status: 'covered',
  tests: [typedUnsupportedCommand, authorityScenario],
  unsupportedCommandReason: reason,
})

const notAuthorityOperation = excluded(
  'This server-derived event, command result, or snapshot is not a client command whose application A2 checks.',
)
const bossCommandAuthorityGap = gap(
  'unsupported by AuthoritativeCommand; not replicated by mx-multiplayer',
  'src/domain/protocol.ts:1240-1277',
  'src/domain/protocol/ender-dragon.ts:51-56',
  'src/domain/protocol/wither.ts:148-176',
  'apps/debug-ui/entrypoints/scenarios/scenario-runtime.ts:760-774',
)
const noStateForUnsupportedCommand = excluded(
  'The A2 scenario verifies an explicit CommandUnsupported result for this command, so it produces no post-delta state for A3 to compare (test/scenarios/dimensions-bosses.test.ts:24; src/application/server/command-application.ts:180-187).',
)
const noPersistentStateForEyeEvent = excluded(
  'EyeOfEnderThrown is a short-lived rendering event, not persistent entity state or an authoritative snapshot, so A3 has no post-delta state to compare (src/domain/protocol.ts:751-765).',
)
const noStateInCommandResult = excluded(
  'This command result carries an outcome and revision, not an authoritative snapshot or post-delta state for A3 (src/domain/protocol/ender-dragon.ts:67-98; src/domain/protocol/wither.ts:198-230).',
)
const bossCommandConvergenceGap = gap(
  'A3 applies to boss commands because their state changes must converge, but this runtime has no application or boss-state projection path.',
  'src/domain/protocol.ts:1439',
  'apps/debug-ui/entrypoints/scenarios/scenario-runtime.ts:760',
  'apps/debug-ui/entrypoints/scenarios/scenario-runtime.ts:761',
)
const bossSnapshotConvergenceGap = gap(
  'A3 applies to authoritative boss snapshots, but this runtime only decodes non-command messages and does not apply or broadcast their state.',
  'src/domain/protocol/ender-dragon.ts:91',
  'src/domain/protocol/wither.ts:223',
  'apps/debug-ui/entrypoints/scenarios/scenario-runtime.ts:760',
  'apps/debug-ui/entrypoints/scenarios/scenario-runtime.ts:761',
)
const commandOrderingGap = gap(
  'A4 applies to these client commands, but G6 has no ordering/resync scenario and the fault model has no duplicate case.',
  'scenarios/types.ts:76',
  'scenarios/dimensions-bosses.ts:110',
  'scenarios/dimensions-bosses.ts:140',
)
const serverMessageOrderingGap = gap(
  'A4 applies to delivery of this server event, result, or snapshot, but the scenario runtime has no server-to-client receive path and its fault model lacks duplication.',
  'scenarios/types.ts:76',
  'scenarios/types.ts:104',
  'apps/debug-ui/entrypoints/scenarios/scenario-runtime.ts:727',
)
const noJoinLifecycleTag = excluded(
  'This transient server event or command result carries neither reconnect credentials nor persistent state to restore, so it does not exercise A5 lifecycle behavior.',
)
const bossSnapshotReconnectGap = gap(
  'A5 needs the authoritative boss snapshot on join or reconnect, but this runtime has no G6 snapshot receiver or restoration path.',
  'src/domain/protocol/ender-dragon.ts:91',
  'src/domain/protocol/wither.ts:223',
  'apps/debug-ui/entrypoints/scenarios/scenario-runtime.ts:337',
  'apps/debug-ui/entrypoints/scenarios/scenario-runtime.ts:407',
)
const clientCommandReconnectGap = gap(
  'A5 applies to reauthenticating player-scoped commands after disconnect; G6 has no reconnect authentication or command-after-reconnect scenario, and boss commands also lack state restoration.',
  'scenarios/types.ts:43',
  'src/domain/protocol.ts:796',
  'src/domain/protocol/ender-dragon.ts:51',
  'src/domain/protocol/ender-dragon.ts:91',
  'src/domain/protocol/wither.ts:148',
  'src/domain/protocol/wither.ts:223',
  'apps/debug-ui/entrypoints/scenarios/scenario-runtime.ts:337',
  'apps/debug-ui/entrypoints/scenarios/scenario-runtime.ts:382',
  'apps/debug-ui/entrypoints/scenarios/scenario-runtime.ts:407',
  'scenarios/dimensions-bosses.ts:110',
  'scenarios/dimensions-bosses.ts:140',
)
const noSpatialUpdateInCommand = excluded(
  'This client-to-authority command is a request, not a spatial recipient projection or server update, so the A6 visibility angle does not apply to the request tag.',
)
const serverUpdateVisibilityGap = gap(
  'A6 applies to this server event, command result, or boss snapshot because recipient filtering and update delivery under load matter, but G6 has no client receive, broadcaster, or AOI projection path.',
  'src/domain/protocol.ts:751',
  'src/domain/protocol/ender-dragon.ts:67',
  'src/domain/protocol/ender-dragon.ts:76',
  'src/domain/protocol/ender-dragon.ts:91',
  'src/domain/protocol/wither.ts:198',
  'src/domain/protocol/wither.ts:207',
  'src/domain/protocol/wither.ts:223',
  'scenarios/visibility-load.ts:83',
  'scenarios/visibility-load.ts:195',
  'apps/debug-ui/entrypoints/scenarios/scenario-runtime.ts:772',
)
const bossCommandAuthorizationGap = gap(
  'unsupported by AuthoritativeCommand; not replicated by mx-multiplayer',
  'src/domain/protocol.ts:1240-1277',
  'src/domain/protocol/ender-dragon.ts:51-56',
  'src/domain/protocol/wither.ts:148-176',
  'apps/debug-ui/entrypoints/scenarios/scenario-runtime.ts:760-774',
)
const serverMessageDirectionGap = gap(
  'A7 applies because an untrusted client can submit this server-originated tag, but the runtime records non-command messages as decoded instead of rejecting the wrong direction.',
  'scenarios/types.ts:104',
  'apps/debug-ui/entrypoints/scenarios/scenario-runtime.ts:760',
  'apps/debug-ui/entrypoints/scenarios/scenario-runtime.ts:772',
)
const row = (
  A1: MatrixCell,
  A2: MatrixCell,
  A3: MatrixCell,
  A4: MatrixCell,
  A5: MatrixCell,
  A6: MatrixCell,
  A7: MatrixCell,
  A8: MatrixCell = noLegacyWireFixture,
): MatrixRow => ({ A1, A2, A3, A4, A5, A6, A7, A8 })

const noMatchingIntent: CommandUnsupportedReason = 'no-matching-c2-intent-payload'

export const dimensionsBosses: Record<
  | 'EyeOfEnderThrown'
  | 'EndPortalUseCommand'
  | 'ThrowEyeOfEnderCommand'
  | 'InsertEyeIntoEndPortalFrameCommand'
  | 'NetherPortalUseCommand'
  | 'ToggleLeverCommand'
  | 'DamageEnderDragonCommand'
  | 'DamageEnderDragonCommandAccepted'
  | 'DamageEnderDragonCommandRejected'
  | 'EnderDragonSnapshotDelta'
  | 'SummonWitherCommand'
  | 'DamageWitherCommand'
  | 'WitherCommandAccepted'
  | 'WitherCommandRejected'
  | 'WitherSnapshotDelta',
  MatrixRow
> = {
  EyeOfEnderThrown: row(
    covered(roundTrip),
    notAuthorityOperation,
    noPersistentStateForEyeEvent,
    serverMessageOrderingGap,
    noJoinLifecycleTag,
    serverUpdateVisibilityGap,
    serverMessageDirectionGap,
  ),
  EndPortalUseCommand: row(
    covered(roundTrip, malformedPortal),
    unsupported(noMatchingIntent),
    noStateForUnsupportedCommand,
    commandOrderingGap,
    clientCommandReconnectGap,
    noSpatialUpdateInCommand,
    covered(unauthorizedScenario),
  ),
  ThrowEyeOfEnderCommand: row(
    covered(roundTrip),
    unsupported(noMatchingIntent),
    noStateForUnsupportedCommand,
    commandOrderingGap,
    clientCommandReconnectGap,
    noSpatialUpdateInCommand,
    covered(unauthorizedScenario),
  ),
  InsertEyeIntoEndPortalFrameCommand: row(
    covered(roundTrip),
    unsupported(noMatchingIntent),
    noStateForUnsupportedCommand,
    commandOrderingGap,
    clientCommandReconnectGap,
    noSpatialUpdateInCommand,
    covered(unauthorizedScenario),
  ),
  NetherPortalUseCommand: row(
    covered(roundTrip, malformedPortal),
    unsupported(noMatchingIntent),
    noStateForUnsupportedCommand,
    commandOrderingGap,
    clientCommandReconnectGap,
    noSpatialUpdateInCommand,
    covered(unauthorizedScenario),
  ),
  ToggleLeverCommand: row(
    covered(roundTrip),
    unsupported(noMatchingIntent),
    noStateForUnsupportedCommand,
    commandOrderingGap,
    clientCommandReconnectGap,
    noSpatialUpdateInCommand,
    covered(unauthorizedScenario),
    legacyWireCompatibility,
  ),
  DamageEnderDragonCommand: row(
    covered(roundTrip),
    bossCommandAuthorityGap,
    bossCommandConvergenceGap,
    commandOrderingGap,
    clientCommandReconnectGap,
    noSpatialUpdateInCommand,
    bossCommandAuthorizationGap,
  ),
  DamageEnderDragonCommandAccepted: row(
    covered(roundTrip),
    notAuthorityOperation,
    noStateInCommandResult,
    serverMessageOrderingGap,
    noJoinLifecycleTag,
    serverUpdateVisibilityGap,
    serverMessageDirectionGap,
  ),
  DamageEnderDragonCommandRejected: row(
    covered(roundTrip, malformedDragon),
    notAuthorityOperation,
    noStateInCommandResult,
    serverMessageOrderingGap,
    noJoinLifecycleTag,
    serverUpdateVisibilityGap,
    serverMessageDirectionGap,
  ),
  EnderDragonSnapshotDelta: row(
    covered(roundTrip, malformedDragon),
    notAuthorityOperation,
    bossSnapshotConvergenceGap,
    serverMessageOrderingGap,
    bossSnapshotReconnectGap,
    serverUpdateVisibilityGap,
    serverMessageDirectionGap,
  ),
  SummonWitherCommand: row(
    covered(roundTrip),
    bossCommandAuthorityGap,
    bossCommandConvergenceGap,
    commandOrderingGap,
    clientCommandReconnectGap,
    noSpatialUpdateInCommand,
    bossCommandAuthorizationGap,
  ),
  DamageWitherCommand: row(
    covered(roundTrip, malformedWither),
    bossCommandAuthorityGap,
    bossCommandConvergenceGap,
    commandOrderingGap,
    clientCommandReconnectGap,
    noSpatialUpdateInCommand,
    bossCommandAuthorizationGap,
  ),
  WitherCommandAccepted: row(
    covered(roundTrip),
    notAuthorityOperation,
    noStateInCommandResult,
    serverMessageOrderingGap,
    noJoinLifecycleTag,
    serverUpdateVisibilityGap,
    serverMessageDirectionGap,
  ),
  WitherCommandRejected: row(
    covered(roundTrip),
    notAuthorityOperation,
    noStateInCommandResult,
    serverMessageOrderingGap,
    noJoinLifecycleTag,
    serverUpdateVisibilityGap,
    serverMessageDirectionGap,
  ),
  WitherSnapshotDelta: row(
    covered(roundTrip, malformedWither),
    notAuthorityOperation,
    bossSnapshotConvergenceGap,
    serverMessageOrderingGap,
    bossSnapshotReconnectGap,
    serverUpdateVisibilityGap,
    serverMessageDirectionGap,
  ),
}

import type { MatrixCell, MatrixRow, TestReference } from './index.js'

const reference = (file: `test/${string}`, line: number, testName: string): TestReference => ({ file, line, testName })

const messageRoundTrip = reference(
  'test/codec.test.ts',
  1241,
  'every message decodes back to a value strictly equal to the one encoded',
)
const legacyWireFixture = reference(
  'test/wire-fixtures.test.ts',
  124,
  'rejects old golden bytes and checks the protocol-11 envelope for each representative family',
)
const malformedInventoryAction = reference(
  'test/codec.test.ts',
  2704,
  'rejects command actions whose discriminant and payload cannot be executed',
)
const malformedInventoryDelta = reference(
  'test/codec.test.ts',
  2777,
  'rejects malformed gameplay extension payloads',
)
const malformedDamage = reference(
  'test/codec.test.ts',
  2803,
  'rejects malformed anvil, crafting and player-damage payloads',
)
const malformedStatusEffects = reference(
  'test/codec.test.ts',
  2832,
  'rejects malformed brewing and status-effect payloads',
)
const malformedVitalsAndDamageResults = reference(
  'test/scenarios/player-state.test.ts',
  88,
  'rejects malformed vitals and damage-result frames while decoding valid controls',
)
const playerStateAuthority = reference(
  'test/scenarios/player-state.test.ts',
  102,
  'observes inventory and vitals application or unsupported outcomes under A2',
)
const inventoryUnsupportedReason = reference(
  'test/command-application.test.ts',
  192,
  'returns a typed unsupported result only when no C2 payload preserves the command',
)
const inventoryUnauthorized = reference(
  'test/scenarios/player-state.test.ts',
  118,
  'rejects a forged player ID before the authorized unsupported-action control under A7',
)
const vitalsUnauthorized = reference(
  'test/scenarios/survival.test.ts',
  133,
  "rejects another player's command under A7",
)
const inventoryReconnect = reference(
  'test/authoritative-session.test.ts',
  264,
  'requires a WCC revision and a restored snapshot after connection and disconnect',
)
const vitalsReconnect = reference(
  'test/scenarios/player-state.test.ts',
  132,
  'requires a restored player-vitals snapshot after reconnecting',
)

const covered = (...tests: [TestReference, ...TestReference[]]): MatrixCell => ({ status: 'covered', tests })
const a1 = (...malformed: TestReference[]): MatrixCell => covered(messageRoundTrip, ...malformed)
const unsupportedInventory: MatrixCell = {
  status: 'covered',
  tests: [playerStateAuthority, inventoryUnsupportedReason],
  unsupportedCommandReason: 'no-matching-c2-intent-payload',
}
const excluded = (reason: string): MatrixCell => ({ status: 'excluded', reason })
const gap = (reason: string, ...evidence: string[]): MatrixCell => ({ status: 'gap', reason, evidence })
const legacyWireCompatibility = covered(legacyWireFixture)
const noLegacyWireFixture = excluded(
  'X2 freezes representative legacy frames by family, but this tag has no tag-specific v0.11.0 or v0.12.0 frame fixture (test/wire-fixtures.test.ts:124).',
)
const notAnAuthoritativeCommand = excluded('This server-to-client state or result message is not an authoritative command, so authority application does not apply to this tag.')
const noResultState = excluded(
  'This command result carries an outcome and revision, not an authoritative snapshot or post-delta state for A3 to compare.',
)
const noCommandConvergencePath = gap(
  'A3 applies to player-state commands because their state changes must converge, but the authority returns C2 intents without applying game rules or projecting player-state deltas.',
  'scenarios/types.ts:34',
  'src/application/server/command-application.ts:204',
  'apps/debug-ui/entrypoints/scenarios/scenario-runtime.ts:767',
  'apps/debug-ui/entrypoints/scenarios/scenario-runtime.ts:772',
)
const noPlayerStateOrderingPath = gap(
  'A4 applies to player-state ordering and resync, but no scenario path applies player-state deltas or handles AuthoritativeResyncRequest; the authority returns C2 intents without game-state writes.',
  'scenarios/types.ts:38',
  'src/application/server/command-application.ts:204',
  'apps/debug-ui/entrypoints/scenarios/scenario-runtime.ts:760',
  'apps/debug-ui/entrypoints/scenarios/scenario-runtime.ts:772',
)
const playerCommandOrderingGap = gap(
  'A4 applies to player-state commands, but the scenario runtime does not commit their game state or request player-state resync after transport faults.',
  'scenarios/types.ts:38',
  'scenarios/types.ts:76-91',
  'src/application/server/command-application.ts:204',
  'apps/debug-ui/entrypoints/scenarios/scenario-runtime.ts:163-172',
  'scenarios/player-state.ts:46-89',
)
const noResultDeliveryPath = gap(
  'A4 applies to accepted and rejected command result delivery, but the scenario runtime has no server-to-client result receiver.',
  'scenarios/types.ts:38',
  'apps/debug-ui/entrypoints/scenarios/scenario-runtime.ts:755',
  'apps/debug-ui/entrypoints/scenarios/scenario-runtime.ts:772',
)
const noDeltaConvergencePath = gap(
  'A3 applies to player-state deltas, but no client path applies PlayerInventoryDelta, PlayerVitalsDelta, or PlayerStatusEffectsDelta to comparable projections; runtime records non-command messages only.',
  'scenarios/types.ts:34',
  'apps/debug-ui/entrypoints/scenarios/scenario-runtime.ts:760',
  'apps/debug-ui/entrypoints/scenarios/scenario-runtime.ts:772',
)
const noDeltaReconnectPath = gap(
  'A5 applies to player-state snapshot restoration after reconnect, but the runtime has no player-state delta receiver or reconnect snapshot-transfer path.',
  'scenarios/types.ts:42',
  'apps/debug-ui/entrypoints/scenarios/scenario-runtime.ts:760',
  'apps/debug-ui/entrypoints/scenarios/scenario-runtime.ts:772',
)
const noPlayerStateVisibilityPath = gap(
  'A6 applies to player-state visibility and load, but no player-state recipient projection exists; the current projector filters ReplicatedWorldDelta block changes.',
  'scenarios/types.ts:46',
  'scenarios/visibility-load.ts:177',
  'scenarios/visibility-load.ts:180',
)
const noCommandVisibilityPath = gap(
  'A6 applies to player-state commands because their resulting updates need recipient filtering and load coverage, but the current projector only filters ReplicatedWorldDelta block changes and the runtime has no player-state broadcaster.',
  'scenarios/types.ts:46',
  'scenarios/visibility-load.ts:177',
  'scenarios/visibility-load.ts:180',
  'apps/debug-ui/entrypoints/scenarios/scenario-runtime.ts:767',
  'apps/debug-ui/entrypoints/scenarios/scenario-runtime.ts:772',
)
const noResultAoi = excluded(
  'This targeted command result is not an area-of-interest projection or a player-state update.',
)
const noReconnectCommandPath = excluded(
  'This result message does not establish join, reconnect authentication, snapshot restoration, or player-leave cleanup.',
)
const serverMessageDirectionGap = gap(
  'A7 applies because an untrusted client can submit these server-originated player-state tags, but the runtime records non-command messages as decoded instead of rejecting wrong-direction input.',
  'scenarios/types.ts:51',
  'src/domain/protocol.ts:654-669',
  'src/domain/protocol.ts:767-792',
  'src/domain/protocol.ts:1420-1434',
  'src/domain/protocol/player-damage.ts:56-73',
  'src/domain/protocol/brewing.ts:197-206',
  'apps/debug-ui/entrypoints/scenarios/scenario-runtime.ts:760',
  'apps/debug-ui/entrypoints/scenarios/scenario-runtime.ts:772',
)
const playerDamageAuthorityGap = gap(
  'unsupported by AuthoritativeCommand; not replicated by mx-multiplayer',
  'src/domain/protocol/player-damage.ts:30-54',
  'src/domain/protocol.ts:1240-1277',
  'apps/debug-ui/entrypoints/scenarios/scenario-runtime.ts:760-774',
)
const playerDamageOrderingGap = gap(
  'A4 applies to PlayerDamageCommand, but it is outside the authority path and has no authority result or player-state resync path.',
  'scenarios/types.ts:38',
  'src/domain/protocol.ts:1109-1154',
  'apps/debug-ui/entrypoints/scenarios/scenario-runtime.ts:760',
  'apps/debug-ui/entrypoints/scenarios/scenario-runtime.ts:772',
)
const playerDamageReconnectGap = gap(
  'PlayerDamageCommand has no current authority/session handler, so it cannot test authenticated reconnect or snapshot gating; see the counterexample recorded for its A2/A7 cells.',
  'scenarios/types.ts:42',
  'src/domain/protocol/player-damage.ts:2',
  'src/domain/protocol.ts:1109-1154',
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

export const playerState: Record<
  | 'PlayerInventoryDelta'
  | 'PlayerVitalsDelta'
  | 'PlayerInventoryCommand'
  | 'PlayerVitalsCommand'
  | 'PlayerDamageCommand'
  | 'PlayerDamageCommandAccepted'
  | 'PlayerDamageCommandRejected'
  | 'PlayerStatusEffectsDelta',
  MatrixRow
> = {
  PlayerInventoryDelta: row(a1(malformedInventoryDelta), notAnAuthoritativeCommand, noDeltaConvergencePath, noPlayerStateOrderingPath, noDeltaReconnectPath, noPlayerStateVisibilityPath, serverMessageDirectionGap, legacyWireCompatibility),
  PlayerVitalsDelta: row(a1(malformedVitalsAndDamageResults), notAnAuthoritativeCommand, noDeltaConvergencePath, noPlayerStateOrderingPath, noDeltaReconnectPath, noPlayerStateVisibilityPath, serverMessageDirectionGap),
  PlayerInventoryCommand: row(
    a1(malformedInventoryAction),
    unsupportedInventory,
    noCommandConvergencePath,
    playerCommandOrderingGap,
    covered(inventoryReconnect),
    noCommandVisibilityPath,
    covered(inventoryUnauthorized),
  ),
  PlayerVitalsCommand: row(
    a1(malformedVitalsAndDamageResults),
    covered(playerStateAuthority),
    noCommandConvergencePath,
    playerCommandOrderingGap,
    covered(vitalsReconnect),
    noCommandVisibilityPath,
    covered(vitalsUnauthorized),
  ),
  PlayerDamageCommand: row(a1(malformedDamage), playerDamageAuthorityGap, noCommandConvergencePath, playerDamageOrderingGap, playerDamageReconnectGap, noCommandVisibilityPath, playerDamageAuthorityGap),
  PlayerDamageCommandAccepted: row(a1(malformedVitalsAndDamageResults), notAnAuthoritativeCommand, noResultState, noResultDeliveryPath, noReconnectCommandPath, noResultAoi, serverMessageDirectionGap),
  PlayerDamageCommandRejected: row(a1(malformedVitalsAndDamageResults), notAnAuthoritativeCommand, noResultState, noResultDeliveryPath, noReconnectCommandPath, noResultAoi, serverMessageDirectionGap),
  PlayerStatusEffectsDelta: row(a1(malformedStatusEffects), notAnAuthoritativeCommand, noDeltaConvergencePath, noPlayerStateOrderingPath, noDeltaReconnectPath, noPlayerStateVisibilityPath, serverMessageDirectionGap),
}

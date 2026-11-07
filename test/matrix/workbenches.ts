import type { MatrixCell, MatrixRow, TestReference } from './index.js'

const roundTrip: TestReference = {
  file: 'test/codec.test.ts',
  line: 1233,
  testName: 'every message decodes back to a value strictly equal to the one encoded',
}
const wireShape: TestReference = {
  file: 'test/scenarios/workbenches.test.ts',
  line: 12,
  testName: 'decodes every workbench tag and rejects an invalid anvil slot',
}

const malformedAnvilCrafting: TestReference = {
  file: 'test/codec.test.ts',
  line: 2720,
  testName: 'rejects malformed anvil, crafting and player-damage payloads',
}
const malformedBrewing: TestReference = {
  file: 'test/codec.test.ts',
  line: 2749,
  testName: 'rejects malformed brewing and status-effect payloads',
}
const malformedEnchanting: TestReference = {
  file: 'test/codec.test.ts',
  line: 2818,
  testName: 'rejects malformed enchanting payloads',
}

const covered = (...tests: [TestReference, ...TestReference[]]): MatrixCell => ({ status: 'covered', tests })
const excluded = (reason: string): MatrixCell => ({ status: 'excluded', reason })
const gap = (reason: string, ...evidence: string[]): MatrixCell => ({ status: 'gap', reason, evidence })
const wireOnly = covered(roundTrip, wireShape)
const wireOnlyAnvilCrafting = covered(roundTrip, wireShape, malformedAnvilCrafting)
const wireOnlyBrewing = covered(roundTrip, wireShape, malformedBrewing)
const wireOnlyEnchanting = covered(roundTrip, wireShape, malformedEnchanting)
const legacyWireFixture: TestReference = {
  file: 'test/wire-fixtures.test.ts',
  line: 124,
  testName: 'pins current golden bytes and version rejection for every representative family',
}
const legacyWireCompatibility = covered(legacyWireFixture)
const noLegacyWireFixture = excluded(
  'X2 freezes representative legacy frames by family, but this tag has no tag-specific v0.11.0 or v0.12.0 frame fixture (test/wire-fixtures.test.ts:124).',
)

const notAnAuthoritativeCommand = excluded(
  'This server-to-client result or state message is not a client command handled by the authoritative command path.',
)
const authorityPathGap = gap(
  'unsupported by AuthoritativeCommand; not replicated by mx-multiplayer',
  'src/domain/protocol.ts:1240-1277',
  'src/domain/protocol/anvil.ts:35-45',
  'src/domain/protocol/crafting.ts:51-60',
  'src/domain/protocol/brewing.ts:131-141',
  'src/domain/protocol/enchanting.ts:77-87',
  'apps/debug-ui/entrypoints/scenarios/scenario-runtime.ts:760-774',
  'test/scenarios/workbenches.test.ts:24',
)
const noMessageState = excluded(
  'This request or command result carries no authoritative snapshot or post-delta state to compare between clients.',
)
const noWorkbenchDeltaReceiver = gap(
  'A3/A4 are relevant to these state deltas, but the scenario runtime has no workbench delta receiver or client projection path. The current wire scenario proves decoding only; see .reinloom/reports/mx-multiplayer-g4.md.',
  'apps/debug-ui/entrypoints/scenarios/scenario-runtime.ts:760',
  'apps/debug-ui/entrypoints/scenarios/scenario-runtime.ts:761',
  'apps/debug-ui/entrypoints/scenarios/scenario-runtime.ts:772',
  'test/scenarios/workbenches.test.ts:24',
)
const noCommandOrderingPath = gap(
  'Ordering and replay are relevant to this command, but the scenario runtime does not apply workbench commands, track their revisions, or request resync. This records an mx-multiplayer coverage gap; see .reinloom/reports/mx-multiplayer-g4.md.',
  'scenarios/types.ts:39',
  'scenarios/types.ts:76',
  'scenarios/types.ts:89',
  'scenarios/types.ts:91',
  'apps/debug-ui/entrypoints/scenarios/scenario-runtime.ts:760',
  'apps/debug-ui/entrypoints/scenarios/scenario-runtime.ts:761',
  'apps/debug-ui/entrypoints/scenarios/scenario-runtime.ts:772',
  'test/scenarios/workbenches.test.ts:24',
)
const noResultOrderingPath = excluded(
  'This result message does not mutate state or carry a client-side resync transition, and the scenario runtime has no server-to-client result receiver.',
)
const noWorkbenchReconnectPath = gap(
  'Reconnect convergence is relevant to this state delta, but the scenario runtime has no workbench delta receiver or reconnect snapshot path. This records an mx-multiplayer coverage gap; see .reinloom/reports/mx-multiplayer-g4.md.',
  'scenarios/types.ts:43',
  'apps/debug-ui/entrypoints/scenarios/scenario-runtime.ts:337',
  'apps/debug-ui/entrypoints/scenarios/scenario-runtime.ts:341',
  'apps/debug-ui/entrypoints/scenarios/scenario-runtime.ts:760',
  'apps/debug-ui/entrypoints/scenarios/scenario-runtime.ts:772',
  'test/scenarios/workbenches.test.ts:24',
)
const noLifecycleSemantics = excluded(
  'This individual workbench request or result does not establish join, reconnect authentication, snapshot restoration, or player-leave cleanup.',
)
const noRequestAoi = excluded(
  'This client-to-authority request is not a spatial visibility projection or a server-to-client state update.',
)
const noResultAoi = excluded(
  'This targeted command result is not an area-of-interest state projection or a workbench state update.',
)
const noWorkbenchAoiPath = gap(
  'Visibility and load are relevant to this state delta, but the scenario runtime has no workbench state broadcaster or AOI projection path. This records an mx-multiplayer coverage gap; see .reinloom/reports/mx-multiplayer-g4.md.',
  'scenarios/types.ts:47',
  'scenarios/visibility-load.ts:185',
  'scenarios/visibility-load.ts:187',
  'scenarios/visibility-load.ts:225',
  'apps/debug-ui/entrypoints/scenarios/scenario-runtime.ts:772',
  'test/scenarios/workbenches.test.ts:24',
)
const noUntrustedCommandPath = gap(
  'unsupported by AuthoritativeCommand; not replicated by mx-multiplayer',
  'src/domain/protocol.ts:1240-1277',
  'src/domain/protocol/anvil.ts:35-45',
  'src/domain/protocol/crafting.ts:51-60',
  'src/domain/protocol/brewing.ts:131-141',
  'src/domain/protocol/enchanting.ts:77-87',
  'apps/debug-ui/entrypoints/scenarios/scenario-runtime.ts:760-774',
  'test/scenarios/workbenches.test.ts:32',
)
const notAnUntrustedOperation = excluded(
  'This server-to-client result or state message does not represent an operation submitted by an untrusted client.',
)
type WorkbenchTag =
  | 'AnvilCommand'
  | 'AnvilCommandAccepted'
  | 'AnvilCommandRejected'
  | 'PlayerAnvilNamesDelta'
  | 'CraftingCommand'
  | 'CraftingCommandAccepted'
  | 'CraftingCommandRejected'
  | 'BrewingCommand'
  | 'BrewingCommandAccepted'
  | 'BrewingCommandRejected'
  | 'BrewingStandDelta'
  | 'EnchantingCommand'
  | 'EnchantingCommandAccepted'
  | 'EnchantingCommandRejected'
  | 'PlayerEnchantmentsDelta'

const row = (
  a1: MatrixCell,
  a2: MatrixCell,
  a3: MatrixCell,
  a4: MatrixCell,
  a5: MatrixCell,
  a6: MatrixCell,
  a7: MatrixCell,
  a8: MatrixCell = noLegacyWireFixture,
): MatrixRow => ({
  A1: a1,
  A2: a2,
  A3: a3,
  A4: a4,
  A5: a5,
  A6: a6,
  A7: a7,
  A8: a8,
})

const commandRow = (a1: MatrixCell, a8?: MatrixCell): MatrixRow => row(
  a1,
  authorityPathGap,
  noMessageState,
  noCommandOrderingPath,
  noLifecycleSemantics,
  noRequestAoi,
  noUntrustedCommandPath,
  a8,
)

const resultRow = (a1: MatrixCell): MatrixRow => row(
  a1,
  notAnAuthoritativeCommand,
  noMessageState,
  noResultOrderingPath,
  noLifecycleSemantics,
  noResultAoi,
  notAnUntrustedOperation,
)

const deltaRow = (a1: MatrixCell): MatrixRow => row(
  a1,
  notAnAuthoritativeCommand,
  noWorkbenchDeltaReceiver,
  noWorkbenchDeltaReceiver,
  noWorkbenchReconnectPath,
  noWorkbenchAoiPath,
  notAnUntrustedOperation,
)

export const workbenches: Record<WorkbenchTag, MatrixRow> = {
  AnvilCommand: commandRow(wireOnlyAnvilCrafting, legacyWireCompatibility),
  AnvilCommandAccepted: resultRow(wireOnly),
  AnvilCommandRejected: resultRow(wireOnly),
  PlayerAnvilNamesDelta: deltaRow(wireOnlyAnvilCrafting),
  CraftingCommand: commandRow(wireOnlyAnvilCrafting),
  CraftingCommandAccepted: resultRow(wireOnly),
  CraftingCommandRejected: resultRow(wireOnly),
  BrewingCommand: commandRow(wireOnlyBrewing),
  BrewingCommandAccepted: resultRow(wireOnly),
  BrewingCommandRejected: resultRow(wireOnly),
  BrewingStandDelta: deltaRow(wireOnlyBrewing),
  EnchantingCommand: commandRow(wireOnlyEnchanting),
  EnchantingCommandAccepted: resultRow(wireOnly),
  EnchantingCommandRejected: resultRow(wireOnly),
  PlayerEnchantmentsDelta: deltaRow(wireOnlyEnchanting),
}

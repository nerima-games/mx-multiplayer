import type { MatrixCell, MatrixRow, TestReference } from './index.js'

const roundTrip: TestReference = {
  file: 'test/codec.test.ts',
  line: 1241,
  testName: 'every message decodes back to a value strictly equal to the one encoded',
}
const legacyWireFixture: TestReference = {
  file: 'test/wire-fixtures.test.ts',
  line: 124,
  testName: 'rejects old golden bytes and checks the protocol-11 envelope for each representative family',
}
const containerShapes: TestReference = {
  file: 'test/scenarios/containers.test.ts',
  line: 137,
  testName: 'accepts valid controls and rejects malformed frames for every container tag',
}
const authorityDecisions: TestReference = {
  file: 'test/scenarios/containers.test.ts',
  line: 154,
  testName: 'records the available container, furnace, and villager trade authority decisions',
}
const spoofedCommands: TestReference = {
  file: 'test/scenarios/containers.test.ts',
  line: 173,
  testName: 'rejects player-spoofed container commands while preserving valid trade authority',
}
const redeliveredCommands: TestReference = {
  file: 'test/scenarios/containers.test.ts',
  line: 193,
  testName: 'preserves command outcomes across loss, duplication, reordering, delay, and resync',
}
const resyncAfterGap: TestReference = {
  file: 'test/scenarios/authority.test.ts',
  line: 91,
  testName: 'rejects a revision gap and preserves the prior client projection',
}

const coveredShape: MatrixCell = { status: 'covered', tests: [roundTrip, containerShapes] }
const deltaNotCommand: MatrixCell = {
  status: 'excluded',
  reason: 'This server-authored state message is not a command, so A2 command application or CommandUnsupported does not apply (src/domain/protocol.ts:701-721).',
}
const deltaNotUntrustedOperation: MatrixCell = {
  status: 'excluded',
  reason: 'The delta carries world, revision, and state but no player identity or client operation, so A7 command spoof checks do not apply (src/domain/protocol.ts:701-721).',
}
const containerDeltaReconnectGap: MatrixCell = {
  status: 'gap',
  reason: 'A5 applies because container state must be restored after a mid-session join or reconnect. AuthoritativeSnapshot includes containers, but the scenario runtime has no ContainerDelta receive or reconnect restore path.',
  evidence: ['scenarios/types.ts:42', 'src/domain/protocol.ts:701', 'src/domain/protocol.ts:603-627', 'apps/debug-ui/entrypoints/scenarios/scenario-runtime.ts:337-416', 'apps/debug-ui/entrypoints/scenarios/scenario-runtime.ts:760-774'],
}
const furnaceDeltaReconnectGap: MatrixCell = {
  status: 'gap',
  reason: 'A5 applies because furnace state must be restored after a mid-session join or reconnect. AuthoritativeSnapshot includes furnaces, but the scenario runtime has no FurnaceDelta receive or reconnect restore path.',
  evidence: ['scenarios/types.ts:42', 'src/domain/protocol.ts:708', 'src/domain/protocol.ts:603-627', 'apps/debug-ui/entrypoints/scenarios/scenario-runtime.ts:337-416', 'apps/debug-ui/entrypoints/scenarios/scenario-runtime.ts:760-774'],
}
const villagerTradeDeltaReconnectGap: MatrixCell = {
  status: 'gap',
  reason: 'A5 applies because villager trade state must be restored after a mid-session join or reconnect. AuthoritativeSnapshot includes villager trades, but the scenario runtime has no VillagerTradeDelta receive or reconnect restore path.',
  evidence: ['scenarios/types.ts:42', 'src/domain/protocol.ts:715', 'src/domain/protocol.ts:603-627', 'apps/debug-ui/entrypoints/scenarios/scenario-runtime.ts:337-416', 'apps/debug-ui/entrypoints/scenarios/scenario-runtime.ts:760-774'],
}
const noStateAfterUnsupportedCommand: MatrixCell = {
  status: 'excluded',
  reason: 'The scenario verifies an explicit CommandUnsupported result for ContainerCommand and FurnaceCommand, so these requests produce no post-delta state for A3 convergence or A5 reconnect restoration to compare (test/scenarios/containers.test.ts:154; src/application/server/command-application.ts:202-210).',
}
const commandNotVisibilityUpdate: MatrixCell = {
  status: 'excluded',
  reason: 'These client-to-authority requests do not carry recipient-projected state updates; A6 concerns AOI leakage and delivery of server updates (apps/debug-ui/entrypoints/scenarios/scenario-runtime.ts:629-632; src/application/server/command-application.ts:202-210).',
}
const optionalCompatibility: MatrixCell = {
  status: 'excluded',
  reason: 'X2 freezes representative legacy frames by family, but this tag has no tag-specific v0.11.0 or v0.12.0 frame fixture (test/wire-fixtures.test.ts:124).',
}
const legacyWireCompatibility: MatrixCell = { status: 'covered', tests: [legacyWireFixture] }
const commandRedelivery: MatrixCell = {
  status: 'covered',
  tests: [redeliveredCommands, resyncAfterGap],
}
const unauthorizedCommand: MatrixCell = { status: 'covered', tests: [spoofedCommands] }
const tradeApplicationGap: MatrixCell = {
  status: 'gap',
  reason: 'A2 requires game-state application, but applyAuthoritativeCommand only returns a canonical intent and mx-multiplayer has no TradeVillager execution path.',
  evidence: ['src/application/server/command-application.ts:202-210', 'apps/debug-ui/entrypoints/scenarios/scenario-runtime.ts:813-819', 'node_modules/@nerima-games/mc-sim/dist/application/intent-queue.d.ts:68-72'],
}
const tradeConvergenceGap: MatrixCell = {
  status: 'gap',
  reason: 'A3 requires the resulting trade state on both clients, but mx-multiplayer only accepts the canonical intent and does not produce game state.',
  evidence: ['src/application/server/command-application.ts:202-210', 'apps/debug-ui/entrypoints/scenarios/scenario-runtime.ts:813-819', 'node_modules/@nerima-games/mc-sim/dist/application/intent-queue.d.ts:68-72'],
}
const tradeReconnectGap: MatrixCell = {
  status: 'gap',
  reason: 'A5 requires the resulting trade state to be restored after reconnect, but mx-multiplayer does not produce trade state for a snapshot.',
  evidence: ['src/application/server/command-application.ts:202-210', 'apps/debug-ui/entrypoints/scenarios/scenario-runtime.ts:813-819', 'src/domain/protocol.ts:603-627', 'node_modules/@nerima-games/mc-sim/dist/application/intent-queue.d.ts:68-72'],
}
const unsupportedCommand = (): MatrixCell => ({
  status: 'covered',
  tests: [authorityDecisions],
  unsupportedCommandReason: 'no-matching-c2-intent-payload',
})
const containerDeltaA3: MatrixCell = {
  status: 'gap',
  reason: 'No client-side path converts ContainerDelta into authoritative post-delta state, so two-client convergence cannot be checked.',
  evidence: ['apps/debug-ui/entrypoints/scenarios/scenario-runtime.ts:772', 'src/domain/authoritative-sync.ts:1293', 'src/domain/protocol.ts:701'],
}
const containerDeltaA4: MatrixCell = {
  status: 'gap',
  reason: 'No revision, ordering, or resync path applies ContainerDelta; the client cache only applies the generic replicated world messages.',
  evidence: ['src/domain/authoritative-sync.ts:1313', 'apps/debug-ui/entrypoints/scenarios/scenario-runtime.ts:772', 'src/domain/protocol.ts:701'],
}
const containerDeltaA6: MatrixCell = {
  status: 'gap',
  reason: 'No recipient projection path handles ContainerDelta; the current AOI projector accepts only ReplicatedWorldDelta and the container state has no position.',
  evidence: ['src/domain/chunk-delta.ts:370', 'src/domain/protocol.ts:432', 'apps/debug-ui/entrypoints/scenarios/scenario-runtime.ts:772'],
}
const furnaceDeltaA3: MatrixCell = {
  status: 'gap',
  reason: 'No client-side path converts FurnaceDelta into authoritative post-delta state, so two-client convergence cannot be checked.',
  evidence: ['apps/debug-ui/entrypoints/scenarios/scenario-runtime.ts:772', 'src/domain/authoritative-sync.ts:1293', 'src/domain/protocol.ts:708'],
}
const furnaceDeltaA4: MatrixCell = {
  status: 'gap',
  reason: 'No revision, ordering, or resync path applies FurnaceDelta; the client cache only applies the generic replicated world messages.',
  evidence: ['src/domain/authoritative-sync.ts:1313', 'apps/debug-ui/entrypoints/scenarios/scenario-runtime.ts:772', 'src/domain/protocol.ts:708'],
}
const furnaceDeltaA6: MatrixCell = {
  status: 'gap',
  reason: 'No recipient projection path handles FurnaceDelta; the current AOI projector accepts only ReplicatedWorldDelta and the furnace state has no position.',
  evidence: ['src/domain/chunk-delta.ts:370', 'src/domain/protocol.ts:442', 'apps/debug-ui/entrypoints/scenarios/scenario-runtime.ts:772'],
}
const villagerTradeDeltaA3: MatrixCell = {
  status: 'gap',
  reason: 'No client-side path converts VillagerTradeDelta into authoritative post-delta state, so two-client convergence cannot be checked.',
  evidence: ['apps/debug-ui/entrypoints/scenarios/scenario-runtime.ts:772', 'src/domain/authoritative-sync.ts:1293', 'src/domain/protocol.ts:715'],
}
const villagerTradeDeltaA4: MatrixCell = {
  status: 'gap',
  reason: 'No revision, ordering, or resync path applies VillagerTradeDelta; the client cache only applies the generic replicated world messages.',
  evidence: ['src/domain/authoritative-sync.ts:1313', 'apps/debug-ui/entrypoints/scenarios/scenario-runtime.ts:772', 'src/domain/protocol.ts:715'],
}
const villagerTradeDeltaA6: MatrixCell = {
  status: 'gap',
  reason: 'No recipient projection path handles VillagerTradeDelta; the current AOI projector accepts only ReplicatedWorldDelta and the trade state has no position.',
  evidence: ['src/domain/chunk-delta.ts:370', 'src/domain/protocol.ts:458', 'apps/debug-ui/entrypoints/scenarios/scenario-runtime.ts:772'],
}

const deltaRow = (a3: MatrixCell, a4: MatrixCell, a5: MatrixCell, a6: MatrixCell, a8: MatrixCell = optionalCompatibility): MatrixRow => ({
  A1: coveredShape,
  A2: deltaNotCommand,
  A3: a3,
  A4: a4,
  A5: a5,
  A6: a6,
  A7: deltaNotUntrustedOperation,
  A8: a8,
})

const commandRow = (a2: MatrixCell, a3: MatrixCell, a5: MatrixCell): MatrixRow => ({
  A1: coveredShape,
  A2: a2,
  A3: a3,
  A4: commandRedelivery,
  A5: a5,
  A6: commandNotVisibilityUpdate,
  A7: unauthorizedCommand,
  A8: optionalCompatibility,
})

export const containers: Record<
  'ContainerDelta' | 'FurnaceDelta' | 'VillagerTradeDelta' | 'ContainerCommand' | 'FurnaceCommand' | 'VillagerTradeCommand',
  MatrixRow
> = {
  ContainerDelta: deltaRow(containerDeltaA3, containerDeltaA4, containerDeltaReconnectGap, containerDeltaA6, legacyWireCompatibility),
  FurnaceDelta: deltaRow(furnaceDeltaA3, furnaceDeltaA4, furnaceDeltaReconnectGap, furnaceDeltaA6),
  VillagerTradeDelta: deltaRow(villagerTradeDeltaA3, villagerTradeDeltaA4, villagerTradeDeltaReconnectGap, villagerTradeDeltaA6),
  ContainerCommand: commandRow(unsupportedCommand(), noStateAfterUnsupportedCommand, noStateAfterUnsupportedCommand),
  FurnaceCommand: commandRow(unsupportedCommand(), noStateAfterUnsupportedCommand, noStateAfterUnsupportedCommand),
  VillagerTradeCommand: commandRow(tradeApplicationGap, tradeConvergenceGap, tradeReconnectGap),
}

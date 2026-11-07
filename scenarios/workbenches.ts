import { CommandId, type NetworkMessage, PROTOCOL_VERSION, PlayerId, WorldId } from '../src/domain/protocol.js'
import type { ScenarioAction, ScenarioClientId, ScenarioDefinition } from './types.js'

const ZERO = 0
const ONE = 1
const TWO = 2
const PLAYER = PlayerId.make('g4-workbench-player')
const WORLD = WorldId.make('overworld')

const commandHeader = (commandId: string) => ({
  commandId: CommandId.make(commandId),
  expectedRevision: ZERO,
  player: PLAYER,
  world: WORLD,
})

const ANVIL_COMMAND: Extract<NetworkMessage, { readonly _tag: 'AnvilCommand' }> = {
  _tag: 'AnvilCommand',
  ...commandHeader('g4-anvil'),
  name: 'Excalibur',
  slot: ZERO,
}

const clientFor = (index: number): ScenarioClientId => {
  if (index % TWO === ZERO) {
    return 'client-a'
  }
  return 'client-b'
}
const messageAction = (message: NetworkMessage, index: number): ScenarioAction => ({
  clientId: clientFor(index),
  kind: 'message',
  message,
})

export const WORKBENCH_TAGS = [
  'AnvilCommand',
  'AnvilCommandAccepted',
  'AnvilCommandRejected',
  'PlayerAnvilNamesDelta',
  'CraftingCommand',
  'CraftingCommandAccepted',
  'CraftingCommandRejected',
  'BrewingCommand',
  'BrewingCommandAccepted',
  'BrewingCommandRejected',
  'BrewingStandDelta',
  'EnchantingCommand',
  'EnchantingCommandAccepted',
  'EnchantingCommandRejected',
  'PlayerEnchantmentsDelta',
] as const

const WORKBENCH_MESSAGES: ReadonlyArray<NetworkMessage> = [
  ANVIL_COMMAND,
  { _tag: 'AnvilCommandAccepted', commandId: CommandId.make('g4-anvil'), revision: ONE },
  { _tag: 'AnvilCommandRejected', commandId: CommandId.make('g4-anvil'), reason: 'missing-iron', revision: ZERO },
  { _tag: 'PlayerAnvilNamesDelta', names: [{ name: 'Excalibur', slot: ZERO }], player: PLAYER, revision: ONE, world: WORLD },
  {
    _tag: 'CraftingCommand',
    ...commandHeader('g4-crafting'),
    grid: { cells: ['stone', null, null, null], height: 2, width: 2 },
  },
  { _tag: 'CraftingCommandAccepted', commandId: CommandId.make('g4-crafting'), revision: ONE },
  { _tag: 'CraftingCommandRejected', commandId: CommandId.make('g4-crafting'), reason: 'no-match', revision: ZERO },
  { _tag: 'BrewingCommand', ...commandHeader('g4-brewing'), action: { _tag: 'insert', slot: ZERO }, at: { x: 1, y: 64, z: 1 } },
  { _tag: 'BrewingCommandAccepted', commandId: CommandId.make('g4-brewing'), revision: ONE },
  { _tag: 'BrewingCommandRejected', commandId: CommandId.make('g4-brewing'), reason: 'missing-ingredients', revision: ZERO },
  {
    _tag: 'BrewingStandDelta',
    at: { x: 1, y: 64, z: 1 },
    revision: ONE,
    state: { bottle: 'water_bottle', brewing: { output: 'awkward', remainingSecs: 12 }, fuelUnits: 4, ingredient: 'nether_wart' },
    world: WORLD,
  },
  { _tag: 'EnchantingCommand', ...commandHeader('g4-enchanting'), offer: ONE, slot: ZERO },
  { _tag: 'EnchantingCommandAccepted', commandId: CommandId.make('g4-enchanting'), revision: ONE },
  { _tag: 'EnchantingCommandRejected', commandId: CommandId.make('g4-enchanting'), reason: 'insufficient-lapis', revision: ZERO },
  {
    _tag: 'PlayerEnchantmentsDelta',
    items: [{
      item: { durability: { current: 40, max: 250 }, enchantments: [{ id: 'sharpness', level: 3 }], item: 'iron_sword' },
      slot: ZERO,
    }],
    player: PLAYER,
    revision: ONE,
    seed: 42,
    world: WORLD,
  },
]

const MALFORMED_ANVIL_FRAME = JSON.stringify({
  message: { ...ANVIL_COMMAND, slot: 36 },
  protocolVersion: PROTOCOL_VERSION,
})

export const workbenchWireScenario: ScenarioDefinition = {
  actions: () => [
    ...WORKBENCH_MESSAGES.map(messageAction),
    { clientId: 'client-a', kind: 'raw', text: MALFORMED_ANVIL_FRAME },
  ],
  angle: 'A1',
  description: 'All workbench message tags decode at the wire boundary and an invalid anvil slot is rejected.',
  evaluate: ({ clients, wireLog }) => {
    const validEntries = wireLog.slice(ZERO, WORKBENCH_TAGS.length)
    const malformedEntry = wireLog[WORKBENCH_TAGS.length]
    const decodedTagsMatch = validEntries.length === WORKBENCH_TAGS.length
      && validEntries.every((entry, index) => entry.tag === WORKBENCH_TAGS[index]
        && entry.outcome === 'delivered'
        && entry.result === `decoded ${WORKBENCH_TAGS[index]}`)
    const malformedRejected = malformedEntry?.tag === '?'
      && malformedEntry.outcome === 'rejected'
      && malformedEntry.result === 'decode rejected: malformed-frame'
    const allMessagesReceived = clients.reduce((received, client) => received + client.received, ZERO) === WORKBENCH_TAGS.length
      && clients.reduce((rejected, client) => rejected + client.rejected, ZERO) === ONE
    const passed = wireLog.length === WORKBENCH_TAGS.length + ONE && decodedTagsMatch && malformedRejected && allMessagesReceived
    if (passed) {
      return { status: 'pass', summary: 'all workbench tags decoded and malformed anvil input was rejected' }
    }
    return { status: 'fail', summary: 'workbench wire decoding or malformed-input rejection failed' }
  },
  group: 'protocol',
  id: 'workbenches.wire-shape',
  title: 'Workbench wire shape (A1)',
}

import { CommandId, type NetworkMessage, PlayerId, WorldId } from '../src/domain/protocol.js'
import type {
  ScenarioAction,
  ScenarioClientId,
  ScenarioDefinition,
  ScenarioEvaluationInput,
  ScenarioVerdict,
  ScenarioWireLogEntry,
} from './types.js'

const WORLD = WorldId.make('overworld')
const PLAYER_A = PlayerId.make('scenario-player-a')
const PLAYER_B = PlayerId.make('scenario-player-b')
const ZERO = 0
const ONE = 1
const TWO = 2
const THREE = 3
const COMMAND_FRAME = ONE
const NO_MATCHING_INTENT = 'no-matching-c2-intent-payload'
const CANONICAL_INTENT_ACCEPTED = 'authority accepted canonical intent; world state was not applied'
const COMMAND_UNSUPPORTED = `authority marked command unsupported: ${NO_MATCHING_INTENT}`
const UNAUTHORIZED = 'authority rejected command: unauthorized-player'
const CONTAINER_GROUP_COMMAND_TAGS: ReadonlySet<string> = new Set([
  'ContainerCommand',
  'FurnaceCommand',
  'VillagerTradeCommand',
])

type ExpectedDecision = Pick<ScenarioWireLogEntry, 'outcome' | 'result' | 'tag'>

type ContainerCommand = Extract<NetworkMessage, { readonly _tag: 'ContainerCommand' }>
type FurnaceCommand = Extract<NetworkMessage, { readonly _tag: 'FurnaceCommand' }>
type VillagerTradeCommand = Extract<NetworkMessage, { readonly _tag: 'VillagerTradeCommand' }>

const commandHeader = (commandId: string, player: typeof PLAYER_A | typeof PLAYER_B = PLAYER_A) => ({
  commandId: CommandId.make(commandId),
  expectedRevision: ZERO,
  player,
  world: WORLD,
})

const containerCommand = (commandId: string, player = PLAYER_A): ContainerCommand => ({
  ...commandHeader(commandId, player),
  _tag: 'ContainerCommand',
  action: { _tag: 'open' },
  containerId: 'scenario-chest',
})

const furnaceCommand = (commandId: string, player = PLAYER_A): FurnaceCommand => ({
  ...commandHeader(commandId, player),
  _tag: 'FurnaceCommand',
  action: {
    _tag: 'take-output',
    count: ONE,
    destination: { _tag: 'player-slot', slot: ZERO },
    source: { _tag: 'furnace-slot', slot: 'output' },
  },
  furnaceId: 'scenario-furnace',
})

const villagerTradeCommand = (commandId: string, player = PLAYER_A): VillagerTradeCommand => ({
  ...commandHeader(commandId, player),
  _tag: 'VillagerTradeCommand',
  action: 'execute-trade',
  offerId: 'scenario-offer',
  villagerId: 'scenario-villager',
})

const messageAction = (clientId: ScenarioClientId, message: NetworkMessage): ScenarioAction => ({
  clientId,
  kind: 'message',
  message,
})

const pass = (summary: string): ScenarioVerdict => ({ status: 'pass', summary })
const fail = (summary: string): ScenarioVerdict => ({ status: 'fail', summary })
const incomplete = (summary: string): ScenarioVerdict => ({ status: 'incomplete', summary })

const decisionsMatch = (
  actual: ReadonlyArray<ScenarioWireLogEntry>,
  expected: ReadonlyArray<ExpectedDecision>,
): boolean => actual.length === expected.length && expected.every((decision, index) => {
  const entry = actual[index]
  return entry !== undefined
    && entry.tag === decision.tag
    && entry.outcome === decision.outcome
    && entry.result === decision.result
})

const authorityActions = (frame: number, seed: number): ReadonlyArray<ScenarioAction> => {
  if (frame !== COMMAND_FRAME) {
    return []
  }
  const prefix = `g3-${String(seed)}-authority`
  return [
    messageAction('client-a', containerCommand(`${prefix}-container`)),
    messageAction('client-a', furnaceCommand(`${prefix}-furnace`)),
    messageAction('client-a', villagerTradeCommand(`${prefix}-trade`)),
  ]
}

const evaluateAuthority = ({ frame, clients, authority, wireLog }: ScenarioEvaluationInput): ScenarioVerdict => {
  if (frame < COMMAND_FRAME) {
    return incomplete('waiting for the three container-group command decisions')
  }
  const entries = wireLog.filter((entry) => CONTAINER_GROUP_COMMAND_TAGS.has(entry.tag))
  const clientA = clients.find((client) => client.id === 'client-a')
  const expected: ReadonlyArray<ExpectedDecision> = [
    { outcome: 'rejected', result: COMMAND_UNSUPPORTED, tag: 'ContainerCommand' },
    { outcome: 'rejected', result: COMMAND_UNSUPPORTED, tag: 'FurnaceCommand' },
    { outcome: 'accepted', result: CANONICAL_INTENT_ACCEPTED, tag: 'VillagerTradeCommand' },
  ]
  const passed = decisionsMatch(entries, expected)
    && clientA?.accepted === ONE
    && clientA.rejected === TWO
    && authority.acceptedCommands === ONE
    && authority.rejectedCommands === TWO
  if (passed) {
    return pass('container and furnace commands remain unsupported while villager trade produces a canonical intent')
  }
  return fail('container-group command authority outcomes changed')
}

const unauthorizedActions = (frame: number, seed: number): ReadonlyArray<ScenarioAction> => {
  if (frame !== COMMAND_FRAME) {
    return []
  }
  const prefix = `g3-${String(seed)}-unauthorized`
  return [
    messageAction('client-b', villagerTradeCommand(`${prefix}-control`, PLAYER_B)),
    messageAction('client-a', containerCommand(`${prefix}-container`, PLAYER_B)),
    messageAction('client-a', furnaceCommand(`${prefix}-furnace`, PLAYER_B)),
    messageAction('client-a', villagerTradeCommand(`${prefix}-trade`, PLAYER_B)),
  ]
}

const redeliveryActions = (frame: number, seed: number): ReadonlyArray<ScenarioAction> => {
  if (frame === COMMAND_FRAME) {
    return authorityActions(COMMAND_FRAME, seed)
  }
  if (frame === TWO) {
    return authorityActions(COMMAND_FRAME, seed)
  }
  return []
}

const evaluateUnauthorized = ({ frame, clients, authority, wireLog }: ScenarioEvaluationInput): ScenarioVerdict => {
  if (frame < COMMAND_FRAME) {
    return incomplete('waiting for the valid control and three spoofed command decisions')
  }
  const entries = wireLog.filter((entry) => CONTAINER_GROUP_COMMAND_TAGS.has(entry.tag))
  const clientA = clients.find((client) => client.id === 'client-a')
  const clientB = clients.find((client) => client.id === 'client-b')
  const expected: ReadonlyArray<ExpectedDecision> = [
    { outcome: 'accepted', result: CANONICAL_INTENT_ACCEPTED, tag: 'VillagerTradeCommand' },
    { outcome: 'rejected', result: UNAUTHORIZED, tag: 'ContainerCommand' },
    { outcome: 'rejected', result: UNAUTHORIZED, tag: 'FurnaceCommand' },
    { outcome: 'rejected', result: UNAUTHORIZED, tag: 'VillagerTradeCommand' },
  ]
  const passed = decisionsMatch(entries, expected)
    && clientA?.accepted === ZERO
    && clientA.rejected === THREE
    && clientB?.accepted === ONE
    && authority.acceptedCommands === ONE
    && authority.rejectedCommands === THREE
  if (passed) {
    return pass('the valid trade control is accepted and all three player-spoofed commands are rejected')
  }
  return fail('a spoofed container-group command was accepted or the valid control was rejected')
}

const redeliveryDecisionsMatch = (wireLog: ReadonlyArray<ScenarioWireLogEntry>): boolean => {
  const delivered = wireLog.filter((entry) => CONTAINER_GROUP_COMMAND_TAGS.has(entry.tag) && entry.outcome !== 'dropped')
  const containerDecisions = delivered.filter((entry) => entry.tag === 'ContainerCommand')
  const furnaceDecisions = delivered.filter((entry) => entry.tag === 'FurnaceCommand')
  const tradeDecisions = delivered.filter((entry) => entry.tag === 'VillagerTradeCommand')
  return containerDecisions.length > ZERO
    && containerDecisions.every((entry) => entry.outcome === 'rejected' && entry.result === COMMAND_UNSUPPORTED)
    && furnaceDecisions.length > ZERO
    && furnaceDecisions.every((entry) => entry.outcome === 'rejected' && entry.result === COMMAND_UNSUPPORTED)
    && tradeDecisions.some((entry) => entry.outcome === 'accepted' && entry.result === CANONICAL_INTENT_ACCEPTED)
    && tradeDecisions.every((entry) => entry.result === CANONICAL_INTENT_ACCEPTED || entry.result === 'authority acknowledged accepted intent replay')
}

const evaluateRedelivery = ({ frame, clients, authority, wireLog }: ScenarioEvaluationInput): ScenarioVerdict => {
  if (frame < TWO) {
    return incomplete('waiting for the retried container-group command decisions')
  }
  const clientA = clients.find((client) => client.id === 'client-a')
  if (redeliveryDecisionsMatch(wireLog) && clientA?.accepted === ONE && authority.acceptedCommands === ONE && clientA.rejected === authority.rejectedCommands) {
    return pass('retry and duplicate delivery preserve each container-group command decision')
  }
  return fail('retry or duplicate delivery changed a container-group command decision')
}

export const CONTAINER_AUTHORITY_SCENARIO: ScenarioDefinition = {
  actions: ({ frame, seed }) => authorityActions(frame, seed),
  angle: 'A2',
  description: 'Container and furnace commands are explicitly unsupported, while villager trade maps to a canonical intent.',
  evaluate: evaluateAuthority,
  group: 'authority',
  id: 'containers.authority-outcomes',
  title: 'Container command authority outcomes',
}

export const CONTAINER_UNAUTHORIZED_SCENARIO: ScenarioDefinition = {
  actions: ({ frame, seed }) => unauthorizedActions(frame, seed),
  angle: 'A7',
  description: 'The authority rejects container-group commands that claim another client identity.',
  evaluate: evaluateUnauthorized,
  group: 'authority',
  id: 'containers.unauthorized-player',
  title: 'Container command player authorization',
}

export const CONTAINER_REDELIVERY_SCENARIO: ScenarioDefinition = {
  actions: ({ frame, seed }) => redeliveryActions(frame, seed),
  angle: 'A4',
  description: 'Dropped, delayed, reordered, and repeated container-group commands preserve their authority decisions.',
  evaluate: evaluateRedelivery,
  group: 'authority',
  id: 'containers.command-redelivery',
  title: 'Container command redelivery',
}

export const CONTAINER_SCENARIOS: ReadonlyArray<ScenarioDefinition> = [
  CONTAINER_AUTHORITY_SCENARIO,
  CONTAINER_UNAUTHORIZED_SCENARIO,
  CONTAINER_REDELIVERY_SCENARIO,
]

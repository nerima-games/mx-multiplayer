import { CommandId, EntityId, type NetworkMessage, PROTOCOL_VERSION, PlayerId, WorldId } from '../src/domain/protocol.js'
import type { ScenarioAction, ScenarioClientId, ScenarioDefinition, ScenarioEvaluationInput, ScenarioVerdict, ScenarioWireLogEntry } from './types.js'
import { VISIBILITY_LOAD_OWNER_REGISTRY } from './visibility-load.js'

const ZERO = 0
const ONE = 1
const TWO = 2
const THREE = 3
const UNSUPPORTED_COMMAND_COUNT = 7
const WORLD = WorldId.make('overworld')
const PLAYER_A = PlayerId.make('scenario-player-a')
const PLAYER_B = PlayerId.make('scenario-player-b')
const ENTITY = EntityId.make('entity:scenario-mob')
const VEHICLE = EntityId.make('entity:scenario-boat')
const COMMAND_UNSUPPORTED = 'authority marked command unsupported: '
const CANONICAL_INTENT_ACCEPTED = 'authority accepted canonical intent; world state was not applied'
const UNAUTHORIZED = 'authority rejected command: unauthorized-player'

export const ENTITIES_MESSAGE_TAGS = [
  'PlayerFishingDelta',
  'WorldTimeWeatherDelta',
  'EntitySpawnDelta',
  'EntityUpdateDelta',
  'EntityDespawnDelta',
  'LightningStrikeDelta',
  'WorldTimeWeatherCommand',
  'EntityAttackCommand',
  'EntityPickupCommand',
  'BowUseCommand',
  'IgniteTntCommand',
  'EnderPearlCommand',
  'BucketUseCommand',
  'VehicleUseCommand',
  'FishingCommand',
  'VehicleCommand',
] as const

export const ENTITIES_COMMAND_TAGS = [
  'WorldTimeWeatherCommand',
  'EntityAttackCommand',
  'EntityPickupCommand',
  'BowUseCommand',
  'IgniteTntCommand',
  'EnderPearlCommand',
  'BucketUseCommand',
  'VehicleUseCommand',
  'FishingCommand',
  'VehicleCommand',
] as const
const ENTITY_COMMAND_COUNT = ENTITIES_COMMAND_TAGS.length

type ExpectedDecision = Pick<ScenarioWireLogEntry, 'outcome' | 'result' | 'tag'>
type EntityCommand = Extract<NetworkMessage, { readonly _tag: (typeof ENTITIES_COMMAND_TAGS)[number] }>

const commandHeader = (commandId: string, player: typeof PLAYER_A | typeof PLAYER_B = PLAYER_A) => ({
  commandId: CommandId.make(commandId),
  expectedRevision: ZERO,
  player,
  world: WORLD,
})

const commands = (prefix: string, player = PLAYER_A): ReadonlyArray<EntityCommand> => [
  { ...commandHeader(`${prefix}-weather`, player), _tag: 'WorldTimeWeatherCommand', action: { _tag: 'set-weather', weather: 'rain' } },
  { ...commandHeader(`${prefix}-attack`, player), _tag: 'EntityAttackCommand', entityId: ENTITY },
  { ...commandHeader(`${prefix}-pickup`, player), _tag: 'EntityPickupCommand', entityId: ENTITY },
  { ...commandHeader(`${prefix}-bow`, player), _tag: 'BowUseCommand', action: 'start' },
  { ...commandHeader(`${prefix}-tnt`, player), _tag: 'IgniteTntCommand', at: { x: ONE, y: 64, z: TWO } },
  { ...commandHeader(`${prefix}-pearl`, player), _tag: 'EnderPearlCommand' },
  { ...commandHeader(`${prefix}-bucket`, player), _tag: 'BucketUseCommand' },
  { ...commandHeader(`${prefix}-vehicle-use`, player), _tag: 'VehicleUseCommand' },
  { ...commandHeader(`${prefix}-fishing`, player), _tag: 'FishingCommand', action: 'cast' },
  { ...commandHeader(`${prefix}-vehicle`, player), _tag: 'VehicleCommand', action: 'mount', entityId: VEHICLE },
]

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

const wireMessages: ReadonlyArray<NetworkMessage> = [
  { _tag: 'PlayerFishingDelta', player: PLAYER_A, revision: ONE, state: { phase: 'waiting', result: 'cast' }, world: WORLD },
  { _tag: 'WorldTimeWeatherDelta', revision: ONE, state: { timeOfDay: 6000, weather: 'rain' }, world: WORLD },
  { _tag: 'EntitySpawnDelta', entity: { _tag: 'living', at: { x: ONE, y: 64, z: TWO }, entityId: ENTITY, entityType: 'zombie', health: 20, maxHealth: 20 }, revision: ONE, world: WORLD },
  { _tag: 'EntityUpdateDelta', entity: { _tag: 'living', at: { x: TWO, y: 64, z: TWO }, entityId: ENTITY, entityType: 'zombie', health: 19, maxHealth: 20 }, revision: TWO, world: WORLD },
  { _tag: 'EntityDespawnDelta', entityId: ENTITY, revision: THREE, world: WORLD },
  { _tag: 'LightningStrikeDelta', at: { x: ONE, y: 64, z: TWO }, revision: ONE, world: WORLD },
  ...commands('g5-wire'),
]

const malformedFishingFrame = JSON.stringify({
  message: {
    _tag: 'PlayerFishingDelta',
    player: PLAYER_A,
    revision: ONE,
    state: { phase: 'bite', result: 'cast' },
    world: WORLD,
  },
  protocolVersion: PROTOCOL_VERSION,
})

export const entitiesWireScenario: ScenarioDefinition = {
  actions: ({ frame }) => {
    if (frame !== ONE) {
      return []
    }
    return [
      ...wireMessages.map((message) => {
        const action = { clientId: 'client-a' as const, kind: 'message' as const, message }
        if (message._tag === 'EntitySpawnDelta' || message._tag === 'EntityUpdateDelta') {
          return { ...action, owners: VISIBILITY_LOAD_OWNER_REGISTRY }
        }
        return action
      }),
      { clientId: 'client-a', kind: 'raw', text: malformedFishingFrame },
    ]
  },
  angle: 'A1',
  description: 'All entities-group tags cross the wire codec and malformed fishing state is rejected.',
  evaluate: ({ clients, frame, wireLog }) => {
    if (frame < ONE) {
      return incomplete('waiting for all entities-group wire tags')
    }
    const messages = wireLog.slice(ZERO, ENTITIES_MESSAGE_TAGS.length)
    const malformed = wireLog[ENTITIES_MESSAGE_TAGS.length]
    const received = clients.reduce((count, client) => count + client.received, ZERO)
    const validMessagesDecoded = messages.length === ENTITIES_MESSAGE_TAGS.length
      && messages.every((entry, index) => entry.tag === ENTITIES_MESSAGE_TAGS[index] && entry.text.length > ZERO)
    const malformedRejected = malformed?.tag === '?'
      && malformed.outcome === 'rejected'
      && malformed.result === 'decode rejected: malformed-frame'
    if (wireLog.length === ENTITIES_MESSAGE_TAGS.length + ONE && validMessagesDecoded && malformedRejected
      && received === ENTITIES_MESSAGE_TAGS.length) {
      return pass('all entities-group tags decoded and malformed fishing state was rejected')
    }
    return fail('entities-group wire decoding or malformed-input rejection failed')
  },
  group: 'protocol',
  id: 'entities.wire-shape',
  title: 'Entities and combat wire shape',
}

const authorityActions = (frame: number): ReadonlyArray<ScenarioAction> => {
  if (frame !== ONE) {
    return []
  }
  return commands('g5-authority').map((message) => messageAction('client-a', message))
}

const evaluateAuthority = ({ authority, clients, frame, wireLog }: ScenarioEvaluationInput): ScenarioVerdict => {
  if (frame < ONE) {
    return incomplete('waiting for all ten command authority decisions')
  }
  const entries = wireLog.filter((entry) => ENTITIES_COMMAND_TAGS.includes(entry.tag as typeof ENTITIES_COMMAND_TAGS[number]))
  const expected: ReadonlyArray<ExpectedDecision> = [
    { outcome: 'rejected', result: `${COMMAND_UNSUPPORTED}no-matching-c2-intent-payload`, tag: 'WorldTimeWeatherCommand' },
    { outcome: 'rejected', result: `${COMMAND_UNSUPPORTED}intent-payload-does-not-preserve-command`, tag: 'EntityAttackCommand' },
    { outcome: 'rejected', result: `${COMMAND_UNSUPPORTED}no-matching-c2-intent-payload`, tag: 'EntityPickupCommand' },
    { outcome: 'accepted', result: CANONICAL_INTENT_ACCEPTED, tag: 'BowUseCommand' },
    { outcome: 'rejected', result: `${COMMAND_UNSUPPORTED}no-matching-c2-intent-payload`, tag: 'IgniteTntCommand' },
    { outcome: 'rejected', result: `${COMMAND_UNSUPPORTED}intent-payload-does-not-preserve-command`, tag: 'EnderPearlCommand' },
    { outcome: 'rejected', result: `${COMMAND_UNSUPPORTED}no-matching-c2-intent-payload`, tag: 'BucketUseCommand' },
    { outcome: 'rejected', result: `${COMMAND_UNSUPPORTED}no-matching-c2-intent-payload`, tag: 'VehicleUseCommand' },
    { outcome: 'accepted', result: CANONICAL_INTENT_ACCEPTED, tag: 'FishingCommand' },
    { outcome: 'accepted', result: CANONICAL_INTENT_ACCEPTED, tag: 'VehicleCommand' },
  ]
  const accepted = clients.reduce((count, client) => count + client.accepted, ZERO)
  const rejected = clients.reduce((count, client) => count + client.rejected, ZERO)
  if (decisionsMatch(entries, expected) && accepted === THREE && rejected === UNSUPPORTED_COMMAND_COUNT
    && authority.acceptedCommands === THREE && authority.rejectedCommands === UNSUPPORTED_COMMAND_COUNT) {
    return pass('three representable commands produced canonical intents and seven unsupported commands were rejected')
  }
  return fail('entities-group command authority outcomes changed')
}

export const entitiesAuthorityScenario: ScenarioDefinition = {
  actions: ({ frame }) => authorityActions(frame),
  angle: 'A2',
  description: 'Entity, bow, fishing, vehicle, weather, pearl, bucket, and TNT commands produce their current authoritative decision.',
  evaluate: evaluateAuthority,
  group: 'authority',
  id: 'entities.authority-outcomes',
  title: 'Entities and combat authority outcomes',
}

const unauthorizedActions = (frame: number): ReadonlyArray<ScenarioAction> => {
  if (frame !== ONE) {
    return []
  }
  const spoofed = commands('g5-spoofed', PLAYER_B)
  const control: EntityCommand = { ...commandHeader('g5-valid-control', PLAYER_B), _tag: 'BowUseCommand', action: 'start' }
  return [
    messageAction('client-b', control),
    ...spoofed.map((message) => messageAction('client-a', message)),
  ]
}

const evaluateUnauthorized = ({ authority, clients, frame, wireLog }: ScenarioEvaluationInput): ScenarioVerdict => {
  if (frame < ONE) {
    return incomplete('waiting for the valid control and ten spoofed command decisions')
  }
  const entries = wireLog.filter((entry) => ENTITIES_COMMAND_TAGS.includes(entry.tag as typeof ENTITIES_COMMAND_TAGS[number]))
  const expected: ReadonlyArray<ExpectedDecision> = [
    { outcome: 'accepted', result: CANONICAL_INTENT_ACCEPTED, tag: 'BowUseCommand' },
    ...ENTITIES_COMMAND_TAGS.map((tag) => ({
      outcome: 'rejected' as const,
      result: UNAUTHORIZED,
      tag,
    })),
  ]
  const accepted = clients.reduce((count, client) => count + client.accepted, ZERO)
  const rejected = clients.reduce((count, client) => count + client.rejected, ZERO)
  if (decisionsMatch(entries, expected) && accepted === ONE && rejected === ENTITY_COMMAND_COUNT
    && authority.acceptedCommands === ONE && authority.rejectedCommands === ENTITY_COMMAND_COUNT) {
    return pass('the valid client control was accepted and all spoofed entity commands were rejected')
  }
  return fail('an entity command identity spoof was accepted or the valid control was rejected')
}

export const entitiesUnauthorizedScenario: ScenarioDefinition = {
  actions: ({ frame }) => unauthorizedActions(frame),
  angle: 'A7',
  description: 'The authority rejects entity-group commands that claim the other client identity.',
  evaluate: evaluateUnauthorized,
  group: 'authority',
  id: 'entities.unauthorized-player',
  title: 'Entities and combat player authorization',
}

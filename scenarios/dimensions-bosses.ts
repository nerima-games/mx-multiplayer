import { type AuthoritativeCommand, CommandId, PlayerId, WorldId } from '../src/domain/protocol.js'
import type { ScenarioAction, ScenarioClientId, ScenarioDefinition, ScenarioStepContext, ScenarioWireLogEntry } from './types.js'

const ZERO = 0
const ONE = 1
const SIXTY_FOUR = 64
const WORLD = WorldId.make('overworld')
const NO_MATCHING_INTENT = 'authority marked command unsupported: no-matching-c2-intent-payload'
const UNAUTHORIZED_PLAYER = 'authority rejected command: unauthorized-player'
const ACCEPTED_CONTROL = 'authority accepted canonical intent; world state was not applied'

type ExpectedOutcome = {
  readonly from: ScenarioWireLogEntry['from']
  readonly tag: string
  readonly outcome: ScenarioWireLogEntry['outcome']
  readonly result: string
}

const unsupportedTags = [
  'EndPortalUseCommand',
  'ThrowEyeOfEnderCommand',
  'InsertEyeIntoEndPortalFrameCommand',
  'NetherPortalUseCommand',
  'ToggleLeverCommand',
] as const

const commandId = (seed: number, suffix: string, tag: string) =>
  CommandId.make(`g6-dimensions-bosses-${String(seed)}-${suffix}-${tag}`)

const playerForClientA = (clients: ScenarioStepContext['clients']): PlayerId => {
  const clientA = clients.find((client) => client.id === 'client-a')
  if (clientA === undefined) {
    throw new Error('dimensions and bosses scenarios require client-a')
  }
  return PlayerId.make(clientA.player)
}

const commandsFor = (
  seed: number,
  suffix: string,
  player: PlayerId,
): ReadonlyArray<AuthoritativeCommand> => {
  const header = (tag: string) => ({
    commandId: commandId(seed, suffix, tag),
    expectedRevision: ZERO,
    player,
    world: WORLD,
  })
  const portal = { x: ZERO, y: SIXTY_FOUR, z: ZERO }

  return [
    { ...header('EndPortalUseCommand'), _tag: 'EndPortalUseCommand', portal },
    { ...header('ThrowEyeOfEnderCommand'), _tag: 'ThrowEyeOfEnderCommand' },
    { ...header('InsertEyeIntoEndPortalFrameCommand'), _tag: 'InsertEyeIntoEndPortalFrameCommand', frame: portal },
    { ...header('NetherPortalUseCommand'), _tag: 'NetherPortalUseCommand', portal },
    { ...header('ToggleLeverCommand'), _tag: 'ToggleLeverCommand', lever: portal },
  ]
}

const actionsFor = (
  clientId: ScenarioClientId,
  commands: ReadonlyArray<AuthoritativeCommand>,
): ReadonlyArray<ScenarioAction> => commands.map((message) => ({ clientId, kind: 'message', message }))

const matchesOutcomes = (
  wireLog: ReadonlyArray<ScenarioWireLogEntry>,
  expected: ReadonlyArray<ExpectedOutcome>,
): boolean => {
  const actual = wireLog.filter((entry) => entry.frame === ONE)
  return actual.length === expected.length && expected.every((wanted, index) => {
    const entry = actual[index]
    return entry !== undefined
      && entry.from === wanted.from
      && entry.tag === wanted.tag
      && entry.outcome === wanted.outcome
      && entry.result === wanted.result
  })
}

const authorityOutcomes: ReadonlyArray<ExpectedOutcome> = [
  ...unsupportedTags.map((tag) => ({
    from: 'client-a' as const,
    outcome: 'rejected' as const,
    result: NO_MATCHING_INTENT,
    tag,
  })),
  {
    from: 'client-a',
    outcome: 'accepted',
    result: ACCEPTED_CONTROL,
    tag: 'BowUseCommand',
  },
]

const unauthorizedOutcomes: ReadonlyArray<ExpectedOutcome> = [
  ...unsupportedTags.map((tag) => ({
    from: 'client-b' as const,
    outcome: 'rejected' as const,
    result: UNAUTHORIZED_PLAYER,
    tag,
  })),
  {
    from: 'client-a',
    outcome: 'rejected',
    result: NO_MATCHING_INTENT,
    tag: 'ToggleLeverCommand',
  },
]

export const dimensionsBossesAuthorityScenario: ScenarioDefinition = {
  actions: ({ clients, frame, seed }) => {
    if (frame !== ONE) {
      return []
    }
    const player = playerForClientA(clients)
    const commands = commandsFor(seed, 'authority', player)
    const bow = {
      _tag: 'BowUseCommand' as const,
      action: 'start' as const,
      commandId: commandId(seed, 'control', 'BowUseCommand'),
      expectedRevision: ZERO,
      player,
      world: WORLD,
    }
    return [...actionsFor('client-a', commands), ...actionsFor('client-a', [bow])]
  },
  angle: 'A2',
  description: 'Checks explicit authority decisions for portal, eye, and lever commands with an accepted command control.',
  evaluate: ({ wireLog }) => {
    if (matchesOutcomes(wireLog, authorityOutcomes)) {
      return { status: 'pass', summary: 'All five dimensions and bosses commands receive their typed unsupported result.' }
    }
    return { status: 'incomplete', summary: 'Waiting for the five unsupported decisions and the accepted authority control.' }
  },
  group: 'authority',
  id: 'g6.dimensions-bosses.authority',
  title: 'Dimensions and bosses authority decisions',
}

export const dimensionsBossesUnauthorizedScenario: ScenarioDefinition = {
  actions: ({ clients, frame, seed }) => {
    if (frame !== ONE) {
      return []
    }
    const claimedPlayer = playerForClientA(clients)
    const forgedCommands = commandsFor(seed, 'forged', claimedPlayer)
    const [, , , , control] = commandsFor(seed, 'control', claimedPlayer)
    if (control === undefined) {
      return []
    }
    return [
      ...actionsFor('client-b', forgedCommands),
      ...actionsFor('client-a', [control]),
    ]
  },
  angle: 'A7',
  description: 'Checks that portal, eye, and lever commands cannot claim another connected player identity.',
  evaluate: ({ wireLog }) => {
    if (matchesOutcomes(wireLog, unauthorizedOutcomes)) {
      return { status: 'pass', summary: 'The authority rejects every forged player ID before the valid control reaches unsupported handling.' }
    }
    return { status: 'incomplete', summary: 'Waiting for the forged-ID rejections and authorized unsupported control.' }
  },
  group: 'authority',
  id: 'g6.dimensions-bosses.unauthorized',
  title: 'Dimensions and bosses command identity checks',
}

export const DIMENSIONS_BOSSES_SCENARIO_FRAME_COUNT: number = ONE

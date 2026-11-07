import { CommandId, PlayerId, WorldId } from '../src/domain/protocol.js'
import type { ScenarioDefinition } from './types.js'

const WORLD = WorldId.make('overworld')
const ZERO = 0
const ONE = 1
// These IDs match the fixed clientPlayer mapping in scenarios/runtime.ts.
const PLAYER_A = PlayerId.make('scenario-player-a')
const PLAYER_B = PlayerId.make('scenario-player-b')
const AUTHORITY_LAST_FRAME = 4
const UNAUTHORIZED_LAST_FRAME = 2
const INVENTORY_FRAME = ONE
const EAT_FRAME = 2
const RESPAWN_FRAME = 3
const ACTIVITY_FRAME = 4
const UNAUTHORIZED_FRAME = ONE
const AUTHORIZED_CONTROL_FRAME = 2
const AUTHORITY_ACCEPTED = 'authority accepted canonical intent; world state was not applied'
const NO_MATCHING_INTENT = 'authority marked command unsupported: no-matching-c2-intent-payload'
const INTENT_NOT_PRESERVED = 'authority marked command unsupported: intent-payload-does-not-preserve-command'
const UNAUTHORIZED_PLAYER = 'authority rejected command: unauthorized-player'

const commandId = (seed: number, frame: number) => CommandId.make(`g2-player-state-${String(seed)}-${String(frame)}`)

const PLAYER_STATE_AUTHORITY_OUTCOMES = [
  { frame: INVENTORY_FRAME, outcome: 'rejected', result: NO_MATCHING_INTENT, tag: 'PlayerInventoryCommand' },
  { frame: EAT_FRAME, outcome: 'accepted', result: AUTHORITY_ACCEPTED, tag: 'PlayerVitalsCommand' },
  { frame: RESPAWN_FRAME, outcome: 'rejected', result: NO_MATCHING_INTENT, tag: 'PlayerVitalsCommand' },
  { frame: ACTIVITY_FRAME, outcome: 'rejected', result: INTENT_NOT_PRESERVED, tag: 'PlayerVitalsCommand' },
] as const

const PLAYER_STATE_UNAUTHORIZED_OUTCOMES = [
  { frame: UNAUTHORIZED_FRAME, outcome: 'rejected', result: UNAUTHORIZED_PLAYER, tag: 'PlayerInventoryCommand' },
  { frame: AUTHORIZED_CONTROL_FRAME, outcome: 'rejected', result: NO_MATCHING_INTENT, tag: 'PlayerInventoryCommand' },
] as const

const outcomesMatch = (
  wireLog: ReadonlyArray<{ readonly frame: number; readonly outcome: string; readonly result: string; readonly tag: string }>,
  expected: ReadonlyArray<{ readonly frame: number; readonly outcome: string; readonly result: string; readonly tag: string }>,
): boolean => expected.every((wanted) => wireLog.some((entry) =>
  entry.frame === wanted.frame
    && entry.tag === wanted.tag
    && entry.outcome === wanted.outcome
    && entry.result === wanted.result))

export const playerStateAuthorityScenario: ScenarioDefinition = {
  actions: ({ frame, seed }) => {
    const header = { commandId: commandId(seed, frame), expectedRevision: ZERO, player: PLAYER_A, world: WORLD }
    switch (frame) {
      case INVENTORY_FRAME:
        return [{
          clientId: 'client-a',
          kind: 'message',
          message: { ...header, _tag: 'PlayerInventoryCommand', action: { _tag: 'select-slot', slot: ONE } },
        }]
      case EAT_FRAME:
        return [{
          clientId: 'client-a',
          kind: 'message',
          message: { ...header, _tag: 'PlayerVitalsCommand', action: { _tag: 'eat', item: 'apple' } },
        }]
      case RESPAWN_FRAME:
        return [{
          clientId: 'client-a',
          kind: 'message',
          message: { ...header, _tag: 'PlayerVitalsCommand', action: 'respawn' },
        }]
      case ACTIVITY_FRAME:
        return [{
          clientId: 'client-a',
          kind: 'message',
          message: { ...header, _tag: 'PlayerVitalsCommand', action: { _tag: 'activity', activity: 'walk', amount: ONE } },
        }]
      default:
        return []
    }
  },
  angle: 'A2',
  description: 'Exercises player inventory and vitals commands through the authenticated authority path with fixed frame-derived command IDs.',
  evaluate: ({ wireLog }) => {
    if (!outcomesMatch(wireLog, PLAYER_STATE_AUTHORITY_OUTCOMES)) {
      return { status: 'incomplete', summary: 'Waiting for all player inventory and vitals authority decisions.' }
    }
    return { status: 'pass', summary: 'Inventory and vitals commands receive their expected authority decisions.' }
  },
  group: 'authority',
  id: 'g2-player-state-authority',
  title: 'Player state authority decisions',
}

export const playerStateUnauthorizedScenario: ScenarioDefinition = {
  actions: ({ frame, seed }) => {
    if (frame !== UNAUTHORIZED_FRAME && frame !== AUTHORIZED_CONTROL_FRAME) {
      return []
    }
    let player = PLAYER_A
    if (frame === UNAUTHORIZED_FRAME) {
      player = PLAYER_B
    }
    const header = {
      commandId: commandId(seed, frame),
      expectedRevision: ZERO,
      player,
      world: WORLD,
    }
    return [{
      clientId: 'client-a',
      kind: 'message',
      message: { ...header, _tag: 'PlayerInventoryCommand', action: { _tag: 'select-slot', slot: ONE } },
    }]
  },
  angle: 'A7',
  description: 'Compares a forged player ID with the same inventory action under the authenticated owner ID.',
  evaluate: ({ wireLog }) => {
    if (!outcomesMatch(wireLog, PLAYER_STATE_UNAUTHORIZED_OUTCOMES)) {
      return { status: 'incomplete', summary: 'Waiting for the forged-ID rejection and authorized negative control.' }
    }
    return { status: 'pass', summary: 'The authority rejects the forged player ID before reporting the unsupported inventory action.' }
  },
  group: 'authority',
  id: 'g2-player-state-unauthorized',
  title: 'Player state command identity checks',
}

export const PLAYER_STATE_AUTHORITY_SCENARIO_FRAME_COUNT: number = AUTHORITY_LAST_FRAME
export const PLAYER_STATE_UNAUTHORIZED_SCENARIO_FRAME_COUNT: number = UNAUTHORIZED_LAST_FRAME

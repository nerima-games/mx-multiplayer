import { CommandId, type CommandRejectionReason, PlayerId, WorldId } from '../src/domain/protocol.js'
import type { ScenarioAction, ScenarioDefinition } from './types.js'
import type { CommandUnsupportedReason } from '../src/application/server/command-application.js'
import type { HungerRejectionReason } from '../src/domain/hunger-authority.js'
import type { PlayerDamageRejectionReason } from '../src/domain/protocol/player-damage.js'
import type { SurvivalRejectionReason } from '../src/domain/survival-authority.js'

const WORLD = WorldId.make('overworld')
const ZERO = 0
const ONE = 1
const RESPAWN_FRAME = ONE
const ACTIVITY_FRAME = 2
const STALE_REVISION_FRAME = 3
const UNAUTHORIZED_FRAME = ONE
const ACCEPT_EAT_FRAME = 4
const INVALID_REPLAY_FRAME = 5
const LAST_FRAME = INVALID_REPLAY_FRAME
const ACCEPTED_REVISION = ZERO
const STALE_REVISION = ONE

type ReasonCoverage = {
  readonly status: 'scenario' | 'unreachable'
  readonly details: string
  readonly evidence: ReadonlyArray<string>
}

const scenarioEvidence = (details: string, ...evidence: Array<string>): ReasonCoverage => ({
  details,
  evidence,
  status: 'scenario',
})

const unreachableEvidence = (details: string, ...evidence: Array<string>): ReasonCoverage => ({
  details,
  evidence,
  status: 'unreachable',
})

const commandGameRuleUnreachable = unreachableEvidence(
  'The command application returns a C2 intent and does not apply game rules or world state.',
  'src/application/server/command-application.ts:204-216',
  'scenarios/runtime.ts:152-163',
)
const damageRejectionUnreachable = unreachableEvidence(
  'PlayerDamageCommand has no authoritative-command handler in this runtime.',
  'src/domain/protocol/player-damage.ts:30-54',
  'src/domain/protocol.ts:1102-1147',
  'scenarios/runtime.ts:678-696',
)
const survivalStateUnreachable = unreachableEvidence(
  'The current authority validates and maps command payloads without reading owner state.',
  'src/domain/survival-authority.ts:18-28,131-208',
)
const hungerStateUnreachable = unreachableEvidence(
  'The current authority maps intents without storing command, inventory, or hunger state.',
  'src/domain/hunger-authority.ts:10-11,61-117',
)

export const survivalRejectionCoverage: {
  readonly command: Readonly<Record<CommandRejectionReason, ReasonCoverage>>
  readonly commandUnsupported: Readonly<Record<CommandUnsupportedReason, ReasonCoverage>>
  readonly hungerAuthority: Readonly<Record<HungerRejectionReason, ReasonCoverage>>
  readonly playerDamage: Readonly<Record<PlayerDamageRejectionReason, ReasonCoverage>>
  readonly survivalAuthority: Readonly<Record<SurvivalRejectionReason, ReasonCoverage>>
} = {
  command: {
    'entity-dead': commandGameRuleUnreachable,
    'insufficient-items': commandGameRuleUnreachable,
    'invalid-command': scenarioEvidence(
      `PlayerVitalsCommand eat with a reused commandId and changed payload at frame ${String(INVALID_REPLAY_FRAME)}`,
      'src/domain/authoritative-session.ts:148-159',
    ),
    'not-mounted': commandGameRuleUnreachable,
    'offer-exhausted': commandGameRuleUnreachable,
    'out-of-range': commandGameRuleUnreachable,
    'resource-not-found': commandGameRuleUnreachable,
    'snapshot-required': unreachableEvidence(
      'The runtime restores the overworld snapshot before connecting either client.',
      'src/domain/authoritative-session.ts:349-361',
      'scenarios/runtime.ts:355-363',
    ),
    'stale-revision': scenarioEvidence(
      `PlayerVitalsCommand eat with expectedRevision ${String(STALE_REVISION)} at frame ${String(STALE_REVISION_FRAME)}`,
      'src/domain/authoritative-session.ts:364-390',
    ),
    'unauthorized-player': scenarioEvidence(
      `PlayerVitalsCommand eat with another player in survivalUnauthorizedScenario at frame ${String(UNAUTHORIZED_FRAME)}`,
      'src/domain/authoritative-session.ts:273-287',
    ),
    'vehicle-occupied': commandGameRuleUnreachable,
  },
  commandUnsupported: {
    'intent-payload-does-not-preserve-command': scenarioEvidence(
      `PlayerVitalsCommand activity at frame ${String(ACTIVITY_FRAME)}`,
      'src/application/server/command-application.ts:94-109',
    ),
    'no-matching-c2-intent-payload': scenarioEvidence(
      `PlayerVitalsCommand respawn at frame ${String(RESPAWN_FRAME)}`,
      'src/application/server/command-application.ts:94-109',
    ),
  },
  hungerAuthority: {
    'authority-boundary-unsupported': scenarioEvidence(
      'Valid activity passed to HungerAuthority.execute.',
      'src/domain/hunger-authority.ts:87-103',
    ),
    'cannot-eat': hungerStateUnreachable,
    'duplicate-command': hungerStateUnreachable,
    'insufficient-items': hungerStateUnreachable,
    'invalid-command': scenarioEvidence(
      'Activity amount zero passed to HungerAuthority.execute.',
      'src/domain/hunger-authority.ts:87-99',
    ),
    'invalid-elapsed-time': scenarioEvidence(
      'Negative elapsed time passed to HungerAuthority.tick.',
      'src/domain/hunger-authority.ts:79-84',
    ),
    'session-mismatch': hungerStateUnreachable,
    'stale-revision': hungerStateUnreachable,
    'unauthorized-player': hungerStateUnreachable,
  },
  playerDamage: {
    'invalid-command': damageRejectionUnreachable,
    'stale-revision': damageRejectionUnreachable,
    'unauthorized-player': damageRejectionUnreachable,
    'wrong-world': damageRejectionUnreachable,
  },
  survivalAuthority: {
    'actor-dead': survivalStateUnreachable,
    'already-sleeping': survivalStateUnreachable,
    'authority-boundary-unsupported': scenarioEvidence(
      'Valid Respawn command passed to SurvivalAuthority.execute.',
      'src/domain/survival-authority.ts:166-193',
    ),
    'cooldown-active': survivalStateUnreachable,
    'duplicate-request': survivalStateUnreachable,
    'insufficient-items': survivalStateUnreachable,
    'invalid-bed': survivalStateUnreachable,
    'invalid-command': scenarioEvidence(
      'Malformed command header passed to SurvivalAuthority.execute.',
      'src/domain/survival-authority.ts:166-168',
    ),
    'invalid-game-mode': survivalStateUnreachable,
    'missing-block': survivalStateUnreachable,
    'not-sleep-time': survivalStateUnreachable,
    'not-sleeping': survivalStateUnreachable,
    occupied: survivalStateUnreachable,
    'out-of-reach': survivalStateUnreachable,
    'session-mismatch': survivalStateUnreachable,
    'sleep-unsafe': survivalStateUnreachable,
    'stale-revision': survivalStateUnreachable,
    'target-alive': survivalStateUnreachable,
    'target-dead': survivalStateUnreachable,
    'target-not-found': survivalStateUnreachable,
    'unauthorized-actor': survivalStateUnreachable,
  },
}

type VitalsAction =
  | 'respawn'
  | { readonly _tag: 'activity'; readonly activity: 'walk'; readonly amount: number }
  | { readonly _tag: 'eat'; readonly item: string }

type VitalsActionInput = {
  readonly action: VitalsAction
  readonly frame: number
  readonly options?: { readonly commandId?: string; readonly expectedRevision?: number; readonly player?: PlayerId }
  readonly seed: number
}

const playerForClient = (clientId: 'client-a' | 'client-b'): PlayerId => {
  if (clientId === 'client-a') {
    return PlayerId.make('scenario-player-a')
  }
  return PlayerId.make('scenario-player-b')
}

const vitalsAction = ({ action, frame, options = {}, seed }: VitalsActionInput): ScenarioAction => ({
  clientId: 'client-a',
  kind: 'message',
  message: {
    _tag: 'PlayerVitalsCommand',
    action,
    commandId: CommandId.make(options.commandId ?? `s6-vitals-${String(seed)}-${String(frame)}`),
    expectedRevision: options.expectedRevision ?? ACCEPTED_REVISION,
    player: options.player ?? playerForClient('client-a'),
    world: WORLD,
  },
})

const actionsForFrame = (seed: number, frame: number): ReadonlyArray<ScenarioAction> => {
  switch (frame) {
    case RESPAWN_FRAME:
      return [vitalsAction({ action: 'respawn', frame, seed })]
    case ACTIVITY_FRAME:
      return [vitalsAction({ action: { _tag: 'activity', activity: 'walk', amount: ONE }, frame, seed })]
    case STALE_REVISION_FRAME:
      return [vitalsAction({
        action: { _tag: 'eat', item: 'apple' },
        frame,
        options: { expectedRevision: STALE_REVISION },
        seed,
      })]
    case ACCEPT_EAT_FRAME:
      return [vitalsAction({
        action: { _tag: 'eat', item: 'apple' },
        frame,
        options: { commandId: `s6-replay-${String(seed)}` },
        seed,
      })]
    case INVALID_REPLAY_FRAME:
      return [vitalsAction({
        action: { _tag: 'eat', item: 'bread' },
        frame,
        options: { commandId: `s6-replay-${String(seed)}` },
        seed,
      })]
    default:
      return []
  }
}

const expectedWireResults: ReadonlyArray<{ readonly frame: number; readonly outcome: string; readonly result: string }> = [
  { frame: RESPAWN_FRAME, outcome: 'rejected', result: 'authority marked command unsupported: no-matching-c2-intent-payload' },
  { frame: ACTIVITY_FRAME, outcome: 'rejected', result: 'authority marked command unsupported: intent-payload-does-not-preserve-command' },
  { frame: STALE_REVISION_FRAME, outcome: 'rejected', result: 'authority rejected command: stale-revision' },
  { frame: ACCEPT_EAT_FRAME, outcome: 'accepted', result: 'authority accepted canonical intent; world state was not applied' },
  { frame: INVALID_REPLAY_FRAME, outcome: 'rejected', result: 'authority rejected command: invalid-command' },
]

export const survivalScenario: ScenarioDefinition = {
  actions: ({ frame, seed }) => actionsForFrame(seed, frame),
  angle: 'A2',
  description: 'Exercises PlayerVitalsCommand acceptance and authority rejection reasons.',
  evaluate: ({ wireLog }) => {
    const complete = expectedWireResults.every((expected) => wireLog.some((entry) =>
      entry.frame === expected.frame && entry.outcome === expected.outcome && entry.result === expected.result))
    if (!complete) {
      return { status: 'incomplete', summary: 'Waiting for the survival and hunger rejection commands to run.' }
    }
    return { status: 'pass', summary: 'The expected survival and hunger authority outcomes were observed.' }
  },
  group: 'survival',
  id: 's6.survival.rejection-reasons',
  title: 'Survival and hunger rejection reasons',
}

export const SURVIVAL_SCENARIO_FRAME_COUNT: number = LAST_FRAME

const unauthorizedPlayerResults: ReadonlyArray<{ readonly frame: number; readonly outcome: string; readonly result: string }> = [
  { frame: UNAUTHORIZED_FRAME, outcome: 'rejected', result: 'authority rejected command: unauthorized-player' },
]

export const survivalUnauthorizedScenario: ScenarioDefinition = {
  actions: ({ frame, seed }) => {
    if (frame !== UNAUTHORIZED_FRAME) {
      return []
    }
    return [vitalsAction({
      action: { _tag: 'eat', item: 'apple' },
      frame,
      options: { player: playerForClient('client-b') },
      seed,
    })]
  },
  angle: 'A7',
  description: "Rejects a PlayerVitalsCommand that names another client's player.",
  evaluate: ({ wireLog }) => {
    const complete = unauthorizedPlayerResults.every((expected) => wireLog.some((entry) =>
      entry.frame === expected.frame && entry.outcome === expected.outcome && entry.result === expected.result))
    if (!complete) {
      return { status: 'incomplete', summary: 'Waiting for the unauthorized player command to be rejected.' }
    }
    return { status: 'pass', summary: 'The authority rejected the command for another player.' }
  },
  group: 'survival',
  id: 's6.survival.unauthorized-player',
  title: "Reject another player's vitals command",
}

export const SURVIVAL_UNAUTHORIZED_SCENARIO_FRAME_COUNT: number = UNAUTHORIZED_FRAME

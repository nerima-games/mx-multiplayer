import type { BlockId, DimensionRevision, SimulationTick } from '@nerima-games/mc-kernel'
import type { PlayerId, WorldId } from './protocol.js'
import type { DimensionId } from '@nerima-games/mc-kernel/domain/shared-vocabulary'
import type { Intent } from '@nerima-games/mc-sim'
import { decodeC2Intent } from './c2-intent.js'

export type SurvivalGameMode = 'survival' | 'creative' | 'spectator'
export type SurvivalPosition = { readonly x: number; readonly y: number; readonly z: number }
export type SurvivalItemStack = { readonly item: string; readonly count: number }
export type SurvivalSleepState = { readonly dimension: string; readonly bed: SurvivalPosition }
export type SurvivalActorState = {
  readonly player: PlayerId
  readonly session: string
  readonly position: SurvivalPosition
  readonly gameMode: SurvivalGameMode
  readonly inventory: ReadonlyArray<SurvivalItemStack | null>
  readonly health: number
  readonly spawn: SurvivalPosition
  readonly lastActionTick: number
  readonly sleeping?: SurvivalSleepState
}
// Compatibility data shape only; SurvivalAuthority does not read or retain this owner state.
export type SurvivalSnapshot = {
  readonly world: WorldId
  readonly revision: number
  readonly actors: ReadonlyArray<SurvivalActorState>
  readonly blocks: Readonly<Record<string, string>>
  readonly drops: ReadonlyArray<{ readonly item: string; readonly count: number; readonly at: SurvivalPosition }>
}
type CommandHeader = {
  readonly actor: PlayerId
  readonly session: string
  readonly requestId: string
  readonly expectedRevision: number
  readonly expectedDimensionRevision: DimensionRevision
}
export type SurvivalCommand = CommandHeader & (
  | { readonly _tag: 'PlaceBlock'; readonly dimension: DimensionId; readonly at: SurvivalPosition; readonly block: BlockId }
  | { readonly _tag: 'BreakBlock'; readonly dimension: DimensionId; readonly at: SurvivalPosition }
  | { readonly _tag: 'Attack'; readonly target: PlayerId }
  | { readonly _tag: 'Respawn' }
  | { readonly _tag: 'EnterSleep'; readonly bed: SurvivalPosition }
  | { readonly _tag: 'LeaveSleep' }
)

export type SurvivalEvent =
  | { readonly _tag: 'InventoryChanged'; readonly actor: PlayerId; readonly slot: number; readonly stack: SurvivalItemStack | null }
  | { readonly _tag: 'BlockChanged'; readonly at: SurvivalPosition; readonly block: string | null }
  | { readonly _tag: 'ActorDamaged'; readonly actor: PlayerId; readonly health: number; readonly source: PlayerId }
  | { readonly _tag: 'ActorDied'; readonly actor: PlayerId; readonly killer: PlayerId }
  | { readonly _tag: 'ItemDropped'; readonly item: string; readonly count: number; readonly at: SurvivalPosition }
  | { readonly _tag: 'ActorRespawned'; readonly actor: PlayerId; readonly at: SurvivalPosition; readonly health: number }
  | { readonly _tag: 'ActorSleepChanged'; readonly actor: PlayerId; readonly sleeping: SurvivalSleepState | null }
  | { readonly _tag: 'SleepProgress'; readonly sleeping: number; readonly required: number; readonly connected: number; readonly ready: boolean }
  | { readonly _tag: 'NightSkipped'; readonly sleeping: number; readonly required: number }
export type SurvivalRejectionReason =
  | 'duplicate-request'
  | 'stale-revision'
  | 'unauthorized-actor'
  | 'session-mismatch'
  | 'invalid-command'
  | 'invalid-game-mode'
  | 'out-of-reach'
  | 'insufficient-items'
  | 'cooldown-active'
  | 'occupied'
  | 'missing-block'
  | 'target-not-found'
  | 'target-dead'
  | 'actor-dead'
  | 'target-alive'
  | 'invalid-bed'
  | 'not-sleep-time'
  | 'sleep-unsafe'
  | 'already-sleeping'
  | 'not-sleeping'
  | 'authority-boundary-unsupported'
export type SurvivalSleepValidation = {
  readonly dimension: string
  readonly bedValid: boolean
  readonly nightOrThunder: boolean
  readonly safe: boolean
}
export type SurvivalSleepValidationInput = {
  readonly actor: SurvivalActorState
  readonly bed: SurvivalPosition
  readonly snapshot: SurvivalSnapshot
}
export type SurvivalAuthorityResult = { readonly accepted: false; readonly reason: SurvivalRejectionReason }
export type SurvivalCommandResult =
  | (SurvivalAuthorityResult & { readonly requestId: string })
  | { readonly accepted: true; readonly intent: Intent; readonly requestId: string }
export type SurvivalAuthorityOptions = {
  readonly reach?: number
  readonly attackReach?: number
  readonly cooldownTicks?: number
  readonly maximumHealth?: number
  readonly attackDamage?: number
  readonly blockDrop?: (block: string) => SurvivalItemStack | null
  readonly sleepPercentage?: number
  readonly validateSleep?: (input: SurvivalSleepValidationInput) => SurvivalSleepValidation
}

const MINIMUM_EXPECTED_REVISION = 0
const MINIMUM_NON_EMPTY_LENGTH = 0

const validPosition = (position: SurvivalPosition): boolean =>
  Number.isInteger(position.x) && Number.isInteger(position.y) && Number.isInteger(position.z)

const validHeader = (command: SurvivalCommand): boolean =>
  command.session.length > MINIMUM_NON_EMPTY_LENGTH &&
  command.requestId.length > MINIMUM_NON_EMPTY_LENGTH &&
  Number.isSafeInteger(command.expectedRevision) &&
  command.expectedRevision >= MINIMUM_EXPECTED_REVISION &&
  Number.isSafeInteger(command.expectedDimensionRevision) &&
  command.expectedDimensionRevision >= MINIMUM_EXPECTED_REVISION

const validCommandPayload = (command: SurvivalCommand): boolean => {
  switch (command._tag) {
    case 'PlaceBlock':
      return validPosition(command.at) && Number.isSafeInteger(command.block)
    case 'BreakBlock':
      return validPosition(command.at)
    case 'Attack':
      return typeof command.target === 'string' && command.target.length > MINIMUM_NON_EMPTY_LENGTH
    case 'EnterSleep':
      return validPosition(command.bed)
    case 'Respawn':
    case 'LeaveSleep':
      return true
    default:
      return false
  }
}

const validCommand = (command: SurvivalCommand): boolean => validHeader(command) && validCommandPayload(command)

const commandFailure = (requestId: string, reason: SurvivalRejectionReason): SurvivalCommandResult => ({
  accepted: false,
  reason,
  requestId,
})

export class SurvivalAuthority {
  readonly rejoin: (
    actor: PlayerId,
    previousSession: string,
    nextSession: string,
  ) => SurvivalAuthorityResult
  readonly disconnect: (actor: PlayerId) => SurvivalAuthorityResult
  readonly reconcileSleep: () => SurvivalAuthorityResult
  readonly execute: (command: SurvivalCommand, targetTick: SimulationTick) => SurvivalCommandResult

  constructor() {
    this.rejoin = (_actor, previousSession, nextSession) => {
      if (
        previousSession.length === MINIMUM_NON_EMPTY_LENGTH ||
        nextSession.length === MINIMUM_NON_EMPTY_LENGTH
      ) {
        return { accepted: false, reason: 'invalid-command' }
      }
      return { accepted: false, reason: 'authority-boundary-unsupported' }
    }
    this.disconnect = (_actor) => ({ accepted: false, reason: 'authority-boundary-unsupported' })
    this.reconcileSleep = () => ({ accepted: false, reason: 'authority-boundary-unsupported' })
    this.execute = (command, targetTick) => {
      if (!validCommand(command) || !Number.isSafeInteger(targetTick) || targetTick < MINIMUM_EXPECTED_REVISION) {
        return commandFailure(command.requestId, 'invalid-command')
      }

      let payload: unknown = undefined
      switch (command._tag) {
        case 'BreakBlock':
          payload = {
            _tag: 'BreakBlock',
            actor: command.actor,
            address: { dimension: command.dimension, position: command.at },
          }
          break
        case 'PlaceBlock':
          payload = {
              _tag: 'PlaceBlock',
              actor: command.actor,
              address: { dimension: command.dimension, position: command.at },
              block: command.block,
            }
          break
        case 'LeaveSleep':
          payload = { _tag: 'LeaveSleep', actor: command.actor }
          break
        default:
          return commandFailure(command.requestId, 'authority-boundary-unsupported')
      }

      const intent = decodeC2Intent({
        expectedDimensionRevision: command.expectedDimensionRevision,
        expectedRevision: command.expectedRevision,
        id: command.requestId,
        payload,
        source: 'network',
        targetTick,
      })

      if (intent === undefined) {
        return commandFailure(command.requestId, 'invalid-command')
      }
      return { accepted: true, intent, requestId: command.requestId }
    }
  }
}

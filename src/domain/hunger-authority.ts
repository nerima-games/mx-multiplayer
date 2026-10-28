import type { PlayerId, WorldId } from './protocol.js'

export type HungerDifficulty = 'peaceful' | 'easy' | 'normal' | 'hard'
export type HungerActivity = 'walk' | 'swim' | 'jump' | 'attack' | 'mine'
export type HungerState = { readonly food: number; readonly saturation: number; readonly exhaustion: number; readonly health: number }
export type HungerActor = { readonly player: PlayerId; readonly session: string; readonly state: HungerState; readonly food: Readonly<Record<string, number>> }
// Compatibility data shape only; HungerAuthority does not read or retain this owner state.
export type HungerSnapshot = { readonly world: WorldId; readonly revision: number; readonly difficulty: HungerDifficulty; readonly actors: ReadonlyArray<HungerActor>; readonly tickRemainderMs: number }
type Header = { readonly player: PlayerId; readonly session: string; readonly commandId: string; readonly expectedRevision: number }
export type HungerCommand = Header & (
  | { readonly _tag: 'Activity'; readonly activity: HungerActivity; readonly amount: number }
  | { readonly _tag: 'Eat'; readonly item: string }
  | { readonly _tag: 'Respawn' }
)
export type HungerEvent =
  | { readonly _tag: 'HungerChanged'; readonly player: PlayerId; readonly state: HungerState }
  | { readonly _tag: 'FoodConsumed'; readonly player: PlayerId; readonly item: string; readonly remaining: number }
  | { readonly _tag: 'HungerDeath'; readonly player: PlayerId }
export type HungerRejectionReason =
  | 'duplicate-command'
  | 'stale-revision'
  | 'unauthorized-player'
  | 'session-mismatch'
  | 'invalid-command'
  | 'insufficient-items'
  | 'cannot-eat'
  | 'invalid-elapsed-time'
  | 'authority-boundary-unsupported'
export type HungerResult = { readonly accepted: false; readonly reason: HungerRejectionReason }
export type HungerAuthorityOptions = {
  readonly foods?: Readonly<Record<string, { readonly food: number; readonly saturation: number }>>
  readonly maximumActivityAmount?: number
}

const MINIMUM_EXPECTED_REVISION = 0
const MINIMUM_ACTIVITY_AMOUNT = 0
const MINIMUM_ELAPSED_MS = 0
const MINIMUM_NON_EMPTY_LENGTH = 0
const DEFAULT_MAXIMUM_ACTIVITY_AMOUNT = 100

const validHeader = (command: HungerCommand): boolean =>
  command.session.length > MINIMUM_NON_EMPTY_LENGTH &&
  command.commandId.length > MINIMUM_NON_EMPTY_LENGTH &&
  Number.isSafeInteger(command.expectedRevision) &&
  command.expectedRevision >= MINIMUM_EXPECTED_REVISION

export class HungerAuthority {
  readonly #maximumActivityAmount: number
  readonly rejoin: (player: PlayerId, previousSession: string, nextSession: string) => HungerResult
  readonly disconnect: (player: PlayerId) => HungerResult
  readonly tick: (elapsedMs: number) => HungerResult

  constructor(options: HungerAuthorityOptions = {}) {
    this.#maximumActivityAmount = options.maximumActivityAmount ?? DEFAULT_MAXIMUM_ACTIVITY_AMOUNT
    this.rejoin = (_player, previousSession, nextSession) => {
      if (
        previousSession.length === MINIMUM_NON_EMPTY_LENGTH ||
        nextSession.length === MINIMUM_NON_EMPTY_LENGTH
      ) {
        return { accepted: false, reason: 'invalid-command' }
      }
      return { accepted: false, reason: 'authority-boundary-unsupported' }
    }
    this.disconnect = () => ({ accepted: false, reason: 'authority-boundary-unsupported' })
    this.tick = (elapsedMs) => {
      if (!Number.isFinite(elapsedMs) || elapsedMs < MINIMUM_ELAPSED_MS) {
        return { accepted: false, reason: 'invalid-elapsed-time' }
      }
      return { accepted: false, reason: 'authority-boundary-unsupported' }
    }
  }

  execute(command: HungerCommand): HungerResult {
    if (!validHeader(command)) {
      return { accepted: false, reason: 'invalid-command' }
    }
    if (
      command._tag === 'Activity' &&
      (!Number.isFinite(command.amount) ||
        command.amount <= MINIMUM_ACTIVITY_AMOUNT ||
        !Number.isFinite(this.#maximumActivityAmount) ||
        this.#maximumActivityAmount <= MINIMUM_ACTIVITY_AMOUNT ||
        command.amount > this.#maximumActivityAmount)
    ) {
      return { accepted: false, reason: 'invalid-command' }
    }
    if (command._tag === 'Eat' && command.item.length === MINIMUM_NON_EMPTY_LENGTH) {
      return { accepted: false, reason: 'invalid-command' }
    }

    // Mc-sim 0.6 service mutations cannot submit an atomic WCC-owned hunger update.
    return { accepted: false, reason: 'authority-boundary-unsupported' }
  }

}

export const createHungerAuthority = (options?: HungerAuthorityOptions): HungerAuthority => new HungerAuthority(options)

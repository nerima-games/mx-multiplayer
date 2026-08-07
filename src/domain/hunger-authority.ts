/* eslint-disable curly, id-length, max-statements, no-magic-numbers, no-nested-ternary, no-ternary, no-undefined, no-underscore-dangle, prefer-destructuring, sort-keys -- Hunger transitions intentionally mirror Minecraft's compact state machine. */
import type { PlayerId, WorldId } from './protocol'

export type HungerDifficulty = 'peaceful' | 'easy' | 'normal' | 'hard'
export type HungerActivity = 'walk' | 'swim' | 'jump' | 'attack' | 'mine'
export type HungerState = { readonly food: number; readonly saturation: number; readonly exhaustion: number; readonly health: number }
export type HungerActor = { readonly player: PlayerId; readonly session: string; readonly state: HungerState; readonly food: Readonly<Record<string, number>> }
export type HungerSnapshot = { readonly world: WorldId; readonly revision: number; readonly difficulty: HungerDifficulty; readonly actors: ReadonlyArray<HungerActor>; readonly tickRemainderMs: number }
type Header = { readonly player: PlayerId; readonly session: string; readonly commandId: string; readonly expectedRevision: number }
export type HungerCommand = Header & ({ readonly _tag: 'Activity'; readonly activity: HungerActivity; readonly amount: number } | { readonly _tag: 'Eat'; readonly item: string } | { readonly _tag: 'Respawn' })
export type HungerEvent = { readonly _tag: 'HungerChanged'; readonly player: PlayerId; readonly state: HungerState } | { readonly _tag: 'FoodConsumed'; readonly player: PlayerId; readonly item: string; readonly remaining: number } | { readonly _tag: 'HungerDeath'; readonly player: PlayerId }
export type HungerResult = { readonly accepted: true; readonly revision: number; readonly events: ReadonlyArray<HungerEvent> } | { readonly accepted: false; readonly revision: number; readonly reason: 'duplicate-command' | 'stale-revision' | 'unauthorized-player' | 'session-mismatch' | 'invalid-command' | 'insufficient-items' | 'cannot-eat' }
type HungerRejectionReason = Extract<HungerResult, { readonly accepted: false }>['reason']
export type HungerAuthorityOptions = { readonly foods?: Readonly<Record<string, { readonly food: number; readonly saturation: number }>>; readonly maximumActivityAmount?: number }

const costs: Readonly<Record<HungerActivity, number>> = { walk: 0.01, swim: 0.01, jump: 0.2, attack: 0.1, mine: 0.005 }
const defaults = { apple: { food: 4, saturation: 2.4 }, bread: { food: 5, saturation: 6 }, potato: { food: 1, saturation: 0.6 } }
const copy = (snapshot: HungerSnapshot): HungerSnapshot => ({ ...snapshot, actors: snapshot.actors.map((actor) => ({ ...actor, state: { ...actor.state }, food: { ...actor.food } })) })
const clamp = (value: number, maximum: number): number => Math.max(0, Math.min(maximum, value))

export class HungerAuthority {
  readonly #foods: Readonly<Record<string, { readonly food: number; readonly saturation: number }>>
  readonly #maximumActivityAmount: number
  readonly #seen = new Set<string>()
  #snapshot: HungerSnapshot

  constructor(snapshot: HungerSnapshot, options: HungerAuthorityOptions = {}) {
    this.#snapshot = copy(snapshot)
    this.#foods = options.foods ?? defaults
    this.#maximumActivityAmount = options.maximumActivityAmount ?? 100
  }

  snapshot(): HungerSnapshot { return copy(this.#snapshot) }

  rejoin(player: PlayerId, previousSession: string, nextSession: string): boolean {
    if (nextSession.length === 0) return false
    const actor = this.#snapshot.actors.find((value) => value.player === player)
    if (actor === undefined || actor.session !== previousSession) return false
    this.#snapshot = { ...this.#snapshot, actors: this.#snapshot.actors.map((value) => value.player === player ? { ...value, session: nextSession } : value) }
    return true
  }

  disconnect(player: PlayerId): void {
    if (!this.#snapshot.actors.some((actor) => actor.player === player)) return
    this.#snapshot = { ...this.#snapshot, revision: this.#snapshot.revision + 1, actors: this.#snapshot.actors.filter((actor) => actor.player !== player) }
  }

  execute(command: HungerCommand): HungerResult {
    const key = `${command.session}\u0000${command.commandId}`
    const reject = (reason: HungerRejectionReason): HungerResult => ({ accepted: false, revision: this.#snapshot.revision, reason })
    if (this.#seen.has(key)) return reject('duplicate-command')
    this.#seen.add(key)
    if (command.commandId.length === 0 || command.session.length === 0) return reject('invalid-command')
    if (command.expectedRevision !== this.#snapshot.revision) return reject('stale-revision')
    const index = this.#snapshot.actors.findIndex((actor) => actor.player === command.player)
    const actor = this.#snapshot.actors[index]
    if (actor === undefined) return reject('unauthorized-player')
    if (actor.session !== command.session) return reject('session-mismatch')
    if (actor.state.health <= 0 && command._tag !== 'Respawn') return reject('invalid-command')
    let next = actor
    const events: HungerEvent[] = []
    if (command._tag === 'Respawn') {
      next = { ...actor, state: { food: 20, saturation: 5, exhaustion: 0, health: 20 } }
    } else if (command._tag === 'Activity') {
      if (!Number.isFinite(command.amount) || command.amount <= 0 || command.amount > this.#maximumActivityAmount) return reject('invalid-command')
      next = { ...actor, state: { ...actor.state, exhaustion: actor.state.exhaustion + costs[command.activity] * command.amount } }
    } else {
      const food = this.#foods[command.item]
      const count = actor.food[command.item] ?? 0
      if (food === undefined || count < 1) return reject('insufficient-items')
      if (actor.state.food >= 20) return reject('cannot-eat')
      const remaining = count - 1
      next = { ...actor, food: { ...actor.food, [command.item]: remaining }, state: { ...actor.state, food: clamp(actor.state.food + food.food, 20), saturation: clamp(actor.state.saturation + food.saturation, 20) } }
      events.push({ _tag: 'FoodConsumed', player: actor.player, item: command.item, remaining })
    }
    events.push({ _tag: 'HungerChanged', player: actor.player, state: { ...next.state } })
    this.#snapshot = { ...this.#snapshot, revision: this.#snapshot.revision + 1, actors: this.#snapshot.actors.map((value, actorIndex) => actorIndex === index ? next : value) }
    return { accepted: true, revision: this.#snapshot.revision, events }
  }

  tick(elapsedMs: number): ReadonlyArray<HungerEvent> {
    if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return []
    const total = this.#snapshot.tickRemainderMs + elapsedMs
    const ticks = Math.floor(total / 4000)
    if (ticks === 0) { this.#snapshot = { ...this.#snapshot, tickRemainderMs: total }; return [] }
    const events: HungerEvent[] = []
    let actors = this.#snapshot.actors
    for (let tick = 0; tick < ticks; tick += 1) actors = actors.map((actor) => this.#tickActor(actor, events))
    this.#snapshot = { ...this.#snapshot, revision: this.#snapshot.revision + 1, actors, tickRemainderMs: total % 4000 }
    return events
  }

  #tickActor(actor: HungerActor, events: HungerEvent[]): HungerActor {
    if (actor.state.health <= 0) return actor
    let { food, saturation, exhaustion, health } = actor.state
    while (exhaustion >= 4) { exhaustion -= 4; if (saturation > 0) saturation = Math.max(0, saturation - 1); else food = Math.max(0, food - 1) }
    if (food >= 18 && health < 20) { health = Math.min(20, health + 1); exhaustion += 6 }
    if (food === 0 && this.#snapshot.difficulty !== 'peaceful') {
      const floor = this.#snapshot.difficulty === 'easy' ? 10 : this.#snapshot.difficulty === 'normal' ? 1 : 0
      health = Math.max(floor, health - 1)
    }
    const next = { food, saturation, exhaustion, health }
    const unchanged = next.food === actor.state.food && next.saturation === actor.state.saturation && next.exhaustion === actor.state.exhaustion && next.health === actor.state.health
    if (unchanged) return actor
    events.push({ _tag: 'HungerChanged', player: actor.player, state: next })
    if (health === 0) events.push({ _tag: 'HungerDeath', player: actor.player })
    return { ...actor, state: next }
  }
}

export const createHungerAuthority = (snapshot: HungerSnapshot, options?: HungerAuthorityOptions): HungerAuthority => new HungerAuthority(snapshot, options)

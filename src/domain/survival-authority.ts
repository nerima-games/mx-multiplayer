/* eslint-disable class-methods-use-this, curly, id-length, max-statements, no-continue, no-magic-numbers, no-ternary, no-undefined, no-underscore-dangle, sort-keys -- Authority validation is intentionally linear and command tags follow the public protocol. */
import type { PlayerId, WorldId } from './protocol.js'

export type SurvivalGameMode = 'survival' | 'creative' | 'spectator'
export type SurvivalPosition = { readonly x: number; readonly y: number; readonly z: number }
export type SurvivalItemStack = { readonly item: string; readonly count: number }
export type SurvivalSleepState = {
  readonly dimension: string
  readonly bed: SurvivalPosition
}
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
  readonly clientTick: number
}

export type SurvivalCommand = CommandHeader &
  (
    | { readonly _tag: 'PlaceBlock'; readonly at: SurvivalPosition; readonly slot: number; readonly block: string }
    | { readonly _tag: 'BreakBlock'; readonly at: SurvivalPosition }
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

export type SurvivalCommandResult =
  | { readonly accepted: true; readonly requestId: string; readonly revision: number; readonly events: ReadonlyArray<SurvivalEvent> }
  | { readonly accepted: false; readonly requestId: string; readonly revision: number; readonly reason: SurvivalRejectionReason }

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

const positionKey = ({ x, y, z }: SurvivalPosition): string => `${x},${y},${z}`
const distanceSquared = (left: SurvivalPosition, right: SurvivalPosition): number =>
  (left.x - right.x) ** 2 + (left.y - right.y) ** 2 + (left.z - right.z) ** 2
const validPosition = (position: SurvivalPosition): boolean =>
  Number.isInteger(position.x) && Number.isInteger(position.y) && Number.isInteger(position.z)
const copyActor = (actor: SurvivalActorState): SurvivalActorState => ({
  ...actor,
  inventory: actor.inventory.map((stack) => (stack === null ? null : { ...stack })),
  position: { ...actor.position },
  spawn: { ...actor.spawn },
  ...(actor.sleeping === undefined ? {} : { sleeping: { ...actor.sleeping, bed: { ...actor.sleeping.bed } } }),
})

/** Deterministic, synchronous authority boundary. Each accepted command commits one atomic revision. */
export class SurvivalAuthority {
  readonly #reach: number
  readonly #attackReach: number
  readonly #cooldownTicks: number
  readonly #maximumHealth: number
  readonly #attackDamage: number
  readonly #blockDrop: (block: string) => SurvivalItemStack | null
  readonly #sleepRatio: number
  readonly #validateSleep: (input: SurvivalSleepValidationInput) => SurvivalSleepValidation
  readonly #results = new Map<string, SurvivalCommandResult>()
  #state: SurvivalSnapshot

  constructor(snapshot: SurvivalSnapshot, options: SurvivalAuthorityOptions = {}) {
    this.#reach = options.reach ?? 5
    this.#attackReach = options.attackReach ?? 3
    this.#cooldownTicks = options.cooldownTicks ?? 5
    this.#maximumHealth = options.maximumHealth ?? 20
    this.#attackDamage = options.attackDamage ?? 4
    this.#blockDrop = options.blockDrop ?? ((block) => ({ item: block, count: 1 }))
    const sleepPercentage = options.sleepPercentage ?? 100
    this.#sleepRatio = Number.isFinite(sleepPercentage) ? Math.min(1, Math.max(0, sleepPercentage / 100)) : 1
    this.#validateSleep = options.validateSleep ?? (() => ({ dimension: 'overworld', bedValid: false, nightOrThunder: false, safe: false }))
    this.#state = this.#copySnapshot(snapshot)
  }

  snapshot(): SurvivalSnapshot {
    return this.#copySnapshot(this.#state)
  }

  /** Rejoin replaces only the authenticated session token; world state and revision remain unchanged. */
  rejoin(actor: PlayerId, previousSession: string, nextSession: string): boolean {
    if (nextSession.length === 0) return false
    const index = this.#state.actors.findIndex((candidate) => candidate.player === actor)
    const current = this.#state.actors[index]
    if (current === undefined || current.session !== previousSession) return false
    const actors = this.#state.actors.map((candidate, actorIndex) =>
      actorIndex === index ? { ...candidate, session: nextSession } : candidate,
    )
    this.#state = { ...this.#state, actors }
    return true
  }

  /** Removes a disconnected actor and re-evaluates the authoritative threshold. */
  disconnect(actor: PlayerId): ReadonlyArray<SurvivalEvent> {
    const index = this.#state.actors.findIndex((candidate) => candidate.player === actor)
    if (index < 0) return []
    const wasSleeping = this.#state.actors[index]?.sleeping !== undefined
    this.#state = { ...this.#state, actors: this.#state.actors.filter((candidate) => candidate.player !== actor), revision: this.#state.revision + 1 }
    return this.#sleepEvents(wasSleeping ? [{ _tag: 'ActorSleepChanged', actor, sleeping: null }] : [])
  }

  /** Revalidates sleeping actors after dimension or bed state changes. */
  reconcileSleep(): ReadonlyArray<SurvivalEvent> {
    const removed: SurvivalEvent[] = []
    const actors = this.#state.actors.map((actor) => {
      if (actor.sleeping === undefined) return actor
      const validation = this.#validateSleep({ actor: copyActor(actor), bed: actor.sleeping.bed, snapshot: this.snapshot() })
      if (validation.bedValid && validation.dimension === actor.sleeping.dimension && actor.health > 0 && actor.gameMode === 'survival') return actor
      removed.push({ _tag: 'ActorSleepChanged', actor: actor.player, sleeping: null })
      const { sleeping: _sleeping, ...awake } = actor
      return awake
    })
    if (removed.length === 0) return []
    this.#state = { ...this.#state, actors, revision: this.#state.revision + 1 }
    return this.#sleepEvents(removed)
  }

  execute(command: SurvivalCommand): SurvivalCommandResult {
    const ledgerKey = `${command.session}\u0000${command.requestId}`
    if (this.#results.has(ledgerKey)) {
      return { accepted: false, requestId: command.requestId, revision: this.#state.revision, reason: 'duplicate-request' }
    }
    const reject = (reason: SurvivalRejectionReason): SurvivalCommandResult => {
      const result = { accepted: false, requestId: command.requestId, revision: this.#state.revision, reason } as const
      this.#results.set(ledgerKey, result)
      return result
    }
    if (command.requestId.length === 0 || command.session.length === 0) return reject('invalid-command')
    if (command.expectedRevision !== this.#state.revision) return reject('stale-revision')
    const actorIndex = this.#state.actors.findIndex((candidate) => candidate.player === command.actor)
    const actor = this.#state.actors[actorIndex]
    if (actor === undefined) return reject('unauthorized-actor')
    if (actor.session !== command.session) return reject('session-mismatch')

    const applied = this.#apply(command, actorIndex, actor)
    if (!applied.accepted) return reject(applied.reason)
    const revision = this.#state.revision + 1
    this.#state = { ...applied.state, revision }
    const result = { accepted: true, requestId: command.requestId, revision, events: applied.events } as const
    this.#results.set(ledgerKey, result)
    return result
  }

  #apply(command: SurvivalCommand, actorIndex: number, actor: SurvivalActorState):
    | { readonly accepted: false; readonly reason: SurvivalRejectionReason }
    | { readonly accepted: true; readonly state: SurvivalSnapshot; readonly events: ReadonlyArray<SurvivalEvent> } {
    if (command._tag === 'Respawn') return this.#respawn(command, actorIndex, actor)
    if (command._tag === 'LeaveSleep') return this.#leaveSleep(actorIndex, actor)
    if (actor.health <= 0) return { accepted: false, reason: 'actor-dead' }
    if (actor.gameMode !== 'survival') return { accepted: false, reason: 'invalid-game-mode' }
    if (!Number.isInteger(command.clientTick) || command.clientTick - actor.lastActionTick < this.#cooldownTicks) {
      return { accepted: false, reason: 'cooldown-active' }
    }
    if (command._tag === 'EnterSleep') return this.#enterSleep(command, actorIndex, actor)
    if (command._tag === 'Attack') return this.#attack(command, actorIndex, actor)
    return this.#mutateBlock(command, actorIndex, actor)
  }

  #mutateBlock(command: Extract<SurvivalCommand, { readonly _tag: 'PlaceBlock' | 'BreakBlock' }>, actorIndex: number, actor: SurvivalActorState) {
    if (!validPosition(command.at)) return { accepted: false as const, reason: 'invalid-command' as const }
    if (distanceSquared(actor.position, command.at) > this.#reach ** 2) return { accepted: false as const, reason: 'out-of-reach' as const }
    const key = positionKey(command.at)
    const blocks = { ...this.#state.blocks }
    const inventory = actor.inventory.map((stack) => (stack === null ? null : { ...stack }))
    const events: SurvivalEvent[] = []
    if (command._tag === 'PlaceBlock') {
      if (blocks[key] !== undefined) return { accepted: false as const, reason: 'occupied' as const }
      const stack = inventory[command.slot]
      if (stack === undefined || stack === null || stack.item !== command.block || stack.count < 1) {
        return { accepted: false as const, reason: 'insufficient-items' as const }
      }
      inventory[command.slot] = stack.count === 1 ? null : { ...stack, count: stack.count - 1 }
      blocks[key] = command.block
      events.push({ _tag: 'InventoryChanged', actor: actor.player, slot: command.slot, stack: inventory[command.slot] ?? null })
      events.push({ _tag: 'BlockChanged', at: { ...command.at }, block: command.block })
    } else {
      const block = blocks[key]
      if (block === undefined) return { accepted: false as const, reason: 'missing-block' as const }
      delete blocks[key]
      events.push({ _tag: 'BlockChanged', at: { ...command.at }, block: null })
      const drop = this.#blockDrop(block)
      if (drop !== null) events.push({ _tag: 'ItemDropped', ...drop, at: { ...command.at } })
    }
    const nextActor = { ...actor, inventory, lastActionTick: command.clientTick }
    const actors = this.#state.actors.map((candidate, index) => (index === actorIndex ? nextActor : candidate))
    const drops = [...this.#state.drops, ...events.filter((event): event is Extract<SurvivalEvent, { _tag: 'ItemDropped' }> => event._tag === 'ItemDropped').map(({ item, count, at }) => ({ item, count, at }))]
    return { accepted: true as const, state: { ...this.#state, actors, blocks, drops }, events }
  }

  #attack(command: Extract<SurvivalCommand, { readonly _tag: 'Attack' }>, actorIndex: number, actor: SurvivalActorState) {
    const targetIndex = this.#state.actors.findIndex((candidate) => candidate.player === command.target)
    const target = this.#state.actors[targetIndex]
    if (target === undefined) return { accepted: false as const, reason: 'target-not-found' as const }
    if (target.health <= 0) return { accepted: false as const, reason: 'target-dead' as const }
    if (distanceSquared(actor.position, target.position) > this.#attackReach ** 2) return { accepted: false as const, reason: 'out-of-reach' as const }
    const health = Math.max(0, target.health - this.#attackDamage)
    const events: SurvivalEvent[] = [{ _tag: 'ActorDamaged', actor: target.player, health, source: actor.player }]
    const drops = [...this.#state.drops]
    if (health === 0) {
      events.push({ _tag: 'ActorDied', actor: target.player, killer: actor.player })
      for (const stack of target.inventory) {
        if (stack === null) continue
        events.push({ _tag: 'ItemDropped', item: stack.item, count: stack.count, at: { ...target.position } })
        drops.push({ item: stack.item, count: stack.count, at: { ...target.position } })
      }
    }
    const actors = this.#state.actors.map((candidate, index) => {
      if (index === actorIndex) return { ...candidate, lastActionTick: command.clientTick }
      if (index === targetIndex) {
        const next = { ...candidate, health, inventory: health === 0 ? candidate.inventory.map(() => null) : candidate.inventory }
        if (health > 0 || candidate.sleeping === undefined) return next
        const { sleeping: _sleeping, ...awake } = next
        return awake
      }
      return candidate
    })
    if (health === 0 && target.sleeping !== undefined) {
      events.push({ _tag: 'ActorSleepChanged', actor: target.player, sleeping: null })
      return { accepted: true as const, state: { ...this.#state, actors, drops }, events: this.#sleepEvents(events, actors) }
    }
    return { accepted: true as const, state: { ...this.#state, actors, drops }, events }
  }

  #enterSleep(command: Extract<SurvivalCommand, { readonly _tag: 'EnterSleep' }>, actorIndex: number, actor: SurvivalActorState) {
    if (!validPosition(command.bed)) return { accepted: false as const, reason: 'invalid-command' as const }
    if (actor.sleeping !== undefined) return { accepted: false as const, reason: 'already-sleeping' as const }
    if (distanceSquared(actor.position, command.bed) > this.#reach ** 2) return { accepted: false as const, reason: 'out-of-reach' as const }
    const validation = this.#validateSleep({ actor: copyActor(actor), bed: { ...command.bed }, snapshot: this.snapshot() })
    if (!validation.bedValid) return { accepted: false as const, reason: 'invalid-bed' as const }
    if (!validation.nightOrThunder) return { accepted: false as const, reason: 'not-sleep-time' as const }
    if (!validation.safe) return { accepted: false as const, reason: 'sleep-unsafe' as const }
    const sleeping = { dimension: validation.dimension, bed: { ...command.bed } }
    const actors = this.#state.actors.map((candidate, index) => index === actorIndex ? { ...candidate, sleeping, lastActionTick: command.clientTick } : candidate)
    const events: SurvivalEvent[] = [{ _tag: 'ActorSleepChanged', actor: actor.player, sleeping }]
    return { accepted: true as const, state: { ...this.#state, actors }, events: this.#sleepEvents(events, actors) }
  }

  #leaveSleep(actorIndex: number, actor: SurvivalActorState) {
    if (actor.sleeping === undefined) return { accepted: false as const, reason: 'not-sleeping' as const }
    const { sleeping: _sleeping, ...awake } = actor
    const actors = this.#state.actors.map((candidate, index) => index === actorIndex ? awake : candidate)
    const events: SurvivalEvent[] = [{ _tag: 'ActorSleepChanged', actor: actor.player, sleeping: null }]
    return { accepted: true as const, state: { ...this.#state, actors }, events: this.#sleepEvents(events, actors) }
  }

  #sleepEvents(prefix: ReadonlyArray<SurvivalEvent>, actors = this.#state.actors): ReadonlyArray<SurvivalEvent> {
    const connected = actors.filter((actor) => actor.gameMode === 'survival').length
    const sleeping = actors.filter((actor) => actor.gameMode === 'survival' && actor.health > 0 && actor.sleeping !== undefined).length
    const required = connected === 0 ? 0 : Math.max(1, Math.ceil(connected * this.#sleepRatio))
    const ready = required > 0 && sleeping >= required
    const progress: SurvivalEvent = { _tag: 'SleepProgress', sleeping, required, connected, ready }
    if (!ready) return [...prefix, progress]
    for (const actor of actors) {
      if (actor.sleeping === undefined) continue
      const { sleeping: _sleeping, ...awake } = actor
      Object.assign(actor, awake)
      delete (actor as { sleeping?: SurvivalSleepState }).sleeping
    }
    return [...prefix, progress, { _tag: 'NightSkipped', sleeping, required }]
  }

  #respawn(command: Extract<SurvivalCommand, { readonly _tag: 'Respawn' }>, actorIndex: number, actor: SurvivalActorState) {
    if (actor.health > 0) return { accepted: false as const, reason: 'target-alive' as const }
    const next = { ...actor, health: this.#maximumHealth, position: { ...actor.spawn }, lastActionTick: command.clientTick }
    const actors = this.#state.actors.map((candidate, index) => (index === actorIndex ? next : candidate))
    const event: SurvivalEvent = { _tag: 'ActorRespawned', actor: actor.player, at: { ...actor.spawn }, health: this.#maximumHealth }
    return { accepted: true as const, state: { ...this.#state, actors }, events: [event] }
  }

  #copySnapshot(snapshot: SurvivalSnapshot): SurvivalSnapshot {
    return {
      ...snapshot,
      actors: snapshot.actors.map(copyActor),
      blocks: { ...snapshot.blocks },
      drops: snapshot.drops.map((drop) => ({ ...drop, at: { ...drop.at } })),
    }
  }
}

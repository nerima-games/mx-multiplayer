import { describe, expect, it } from '@effect/vitest'
import { Effect } from 'effect'
import {
  EntityKind,
  InventoryService,
  makeEntityManager,
  makeHotbarService,
  makeInventoryService,
  makeVitalsService,
  OccupantId,
  VehicleId,
  type HotbarServiceApi,
  type InventoryServiceApi,
  type SpawnRequest,
  type Vehicle,
  type VehicleServiceApi,
  type VitalsServiceApi,
} from '@nerima-games/mc-sim'
import { position } from '@nerima-games/mc-kernel'
import {
  applyAuthoritativeCommand,
  AuthoritativeSession,
  type AuthoritativeCommand,
  type AuthoritativeSnapshot,
  type WorldWriteServices,
  CommandId,
  EntityId,
  PlayerId,
  WorldId,
} from '../src/index'

const world = WorldId.make('overworld')
const alice = PlayerId.make('alice')
const bob = PlayerId.make('bob')

const baseSnapshot: AuthoritativeSnapshot = {
  _tag: 'AuthoritativeSnapshot',
  containers: [],
  furnaces: [],
  inventories: [],
  revision: 0,
  timeWeather: { timeOfDay: 0, weather: 'clear' },
  villagerTrades: [],
  vitals: [],
  world,
}

/** Behaviour type stub — this file never reads it, only mc-sim's `find`/`despawn` do, and neither depends on it. */
type NoBehaviour = { readonly _tag: 'None' }

const zombie = (feetX: number): SpawnRequest<NoBehaviour> => ({
  behaviour: { _tag: 'None' },
  feetPosition: position(feetX, 64, 0),
  healthPoints: 20,
  kind: EntityKind('zombie'),
})

const pickup = (commandId: string, entityId: string, expectedRevision: number, player = alice): AuthoritativeCommand => ({
  _tag: 'EntityPickupCommand',
  commandId: CommandId.make(commandId),
  entityId: EntityId.make(entityId),
  expectedRevision,
  player,
  world,
})

const activity = (commandId: string, amount: number, expectedRevision: number, player = alice): AuthoritativeCommand => ({
  _tag: 'PlayerVitalsCommand',
  action: { _tag: 'activity', activity: 'attack', amount },
  commandId: CommandId.make(commandId),
  expectedRevision,
  player,
  world,
})

const respawn = (commandId: string, expectedRevision: number, player = alice): AuthoritativeCommand => ({
  _tag: 'PlayerVitalsCommand',
  action: 'respawn',
  commandId: CommandId.make(commandId),
  expectedRevision,
  player,
  world,
})

const eat = (commandId: string, expectedRevision: number, player = alice): AuthoritativeCommand => ({
  _tag: 'PlayerVitalsCommand',
  action: { _tag: 'eat', item: 'apple' },
  commandId: CommandId.make(commandId),
  expectedRevision,
  player,
  world,
})

const inventorySelect = (commandId: string, slot: number, expectedRevision: number, player = alice): AuthoritativeCommand => ({
  _tag: 'PlayerInventoryCommand',
  action: { _tag: 'select-slot', slot },
  commandId: CommandId.make(commandId),
  expectedRevision,
  player,
  world,
})

const bowUse = (commandId: string, expectedRevision: number, player = alice): AuthoritativeCommand => ({
  _tag: 'BowUseCommand',
  action: 'start',
  commandId: CommandId.make(commandId),
  expectedRevision,
  player,
  world,
})

const inventoryMove = (commandId: string, expectedRevision: number, player = alice): AuthoritativeCommand => ({
  _tag: 'PlayerInventoryCommand',
  action: { _tag: 'move-item', count: 1, destination: 1, source: 0 },
  commandId: CommandId.make(commandId),
  expectedRevision,
  player,
  world,
})

const inventoryDrop = (commandId: string, expectedRevision: number, player = alice): AuthoritativeCommand => ({
  _tag: 'PlayerInventoryCommand',
  action: { _tag: 'drop-item', count: 1, destination: 'world', source: 0 },
  commandId: CommandId.make(commandId),
  expectedRevision,
  player,
  world,
})

const inventorySwap = (
  commandId: string,
  source: number,
  destination: number,
  expectedRevision: number,
  player = alice,
): AuthoritativeCommand => ({
  _tag: 'PlayerInventoryCommand',
  action: { _tag: 'swap-items', destination, source },
  commandId: CommandId.make(commandId),
  expectedRevision,
  player,
  world,
})

const inventoryEquip = (commandId: string, expectedRevision: number, player = alice): AuthoritativeCommand => ({
  _tag: 'PlayerInventoryCommand',
  action: { _tag: 'equip-item', equipmentSlot: 'head', source: 0 },
  commandId: CommandId.make(commandId),
  expectedRevision,
  player,
  world,
})

const inventoryUnequip = (commandId: string, expectedRevision: number, player = alice): AuthoritativeCommand => ({
  _tag: 'PlayerInventoryCommand',
  action: { _tag: 'unequip-item', destination: 0, equipmentSlot: 'head' },
  commandId: CommandId.make(commandId),
  expectedRevision,
  player,
  world,
})

/** Delegates to the real service so its own domain logic still runs, and records every call this file makes. */
const countingInventory = (
  real: InventoryServiceApi,
  calls: Array<string>,
): Pick<InventoryServiceApi, 'equipFromInventory' | 'moveStack' | 'unequipToInventory'> => ({
  equipFromInventory: (inventorySlot, equipmentSlot) => {
    calls.push(`equip:${inventorySlot}:${equipmentSlot}`)
    return real.equipFromInventory(inventorySlot, equipmentSlot)
  },
  moveStack: (sourceIndex, targetIndex) => {
    calls.push(`move:${sourceIndex}:${targetIndex}`)
    return real.moveStack(sourceIndex, targetIndex)
  },
  unequipToInventory: (equipmentSlot, inventorySlot) => {
    calls.push(`unequip:${equipmentSlot}:${inventorySlot}`)
    return real.unequipToInventory(equipmentSlot, inventorySlot)
  },
})

/** Delegates to the real service so its own domain logic (index clamping) still runs, and records every call this file makes. */
const countingHotbar = (real: HotbarServiceApi, calls: Array<string>): Pick<HotbarServiceApi, 'setSelectedSlot'> => ({
  setSelectedSlot: (slot) => {
    calls.push(`select:${slot}`)
    return real.setSelectedSlot(slot)
  },
})

const vehicleMount = (commandId: string, entityId: string, expectedRevision: number, player = alice): AuthoritativeCommand => ({
  _tag: 'VehicleCommand',
  action: 'mount',
  commandId: CommandId.make(commandId),
  entityId: EntityId.make(entityId),
  expectedRevision,
  player,
  world,
})

const vehicleDismount = (commandId: string, entityId: string, expectedRevision: number, player = alice): AuthoritativeCommand => ({
  _tag: 'VehicleCommand',
  action: 'dismount',
  commandId: CommandId.make(commandId),
  entityId: EntityId.make(entityId),
  expectedRevision,
  player,
  world,
})

const vehicleMove = (commandId: string, entityId: string, expectedRevision: number, player = alice): AuthoritativeCommand => ({
  _tag: 'VehicleCommand',
  action: { _tag: 'move', direction: 'forward' },
  commandId: CommandId.make(commandId),
  entityId: EntityId.make(entityId),
  expectedRevision,
  player,
  world,
})

const emptyBoat = (id: string): Vehicle => ({
  dimension: 'overworld',
  id: VehicleId(id),
  occupant: undefined,
  position: position(0, 64, 0),
  type: 'boat',
  velocity: { x: 0, y: 0, z: 0 },
  yawRadians: 0,
})

const occupiedBoat = (id: string, occupant: string): Vehicle => ({
  ...emptyBoat(id),
  occupant: OccupantId(occupant),
})

/** A fake `VehicleServiceApi` slice: a fixed roster plus call recorders, so a test can assert exactly-once writes without mc-sim's own Ref machinery. */
const fakeVehicles = (
  initial: ReadonlyArray<Vehicle>,
  mountCalls: Array<string> = [],
  dismountCalls: Array<string> = [],
): Pick<VehicleServiceApi, 'dismount' | 'mount' | 'vehicles'> => ({
  dismount: (id, occupant) => {
    dismountCalls.push(`dismount:${id}:${occupant}`)
    return Effect.succeed(undefined)
  },
  mount: (id, occupant) => {
    mountCalls.push(`mount:${id}:${occupant}`)
    return Effect.succeed(undefined)
  },
  vehicles: Effect.succeed(initial),
})

describe('applyAuthoritativeCommand — writing through to mc-sim', () => {
  describe('EntityPickupCommand — the contested-pickup case', () => {
    it.effect('two peers racing for the same entity within one tick: the loser gets stale-revision, the entity is removed exactly once', () =>
      Effect.gen(function* () {
        const entities = yield* makeEntityManager<NoBehaviour>()
        const target = yield* entities.spawn(zombie(1))
        const session = new AuthoritativeSession()
        session.restore(baseSnapshot)
        const services: WorldWriteServices<NoBehaviour> = {
          entities,
          hotbarFor: () => undefined,
          inventoryFor: () => undefined,
          vehiclesFor: () => undefined,
          vitalsFor: () => undefined,
        }
        const apply = applyAuthoritativeCommand(session, services)

        // Both peers last saw revision 0 — the realistic shape of "raced within one tick."
        const winner = yield* apply(pickup('alice-pickup', target.id, 0, alice))
        const loser = yield* apply(pickup('bob-pickup', target.id, 0, bob))

        expect(winner).toMatchObject({ _tag: 'AuthoritativeCommandAccepted', revision: 1 })
        expect(loser).toMatchObject({ _tag: 'AuthoritativeCommandRejected', reason: 'stale-revision' })
        // The loser's decide closure never ran (ledger rejected before decide), so despawn was
        // never attempted for it — the roster reflects exactly one removal.
        expect(yield* entities.count).toBe(0)
      }),
    )

    it.effect('a pickup for an entity that has already despawned is rejected, not silently accepted', () =>
      Effect.gen(function* () {
        const entities = yield* makeEntityManager<NoBehaviour>()
        const target = yield* entities.spawn(zombie(1))
        yield* entities.despawn(target.id)
        const session = new AuthoritativeSession()
        session.restore(baseSnapshot)
        const services: WorldWriteServices<NoBehaviour> = {
          entities,
          hotbarFor: () => undefined,
          inventoryFor: () => undefined,
          vehiclesFor: () => undefined,
          vitalsFor: () => undefined,
        }
        const apply = applyAuthoritativeCommand(session, services)

        const result = yield* apply(pickup('late-pickup', target.id, 0))

        expect(result).toMatchObject({ _tag: 'AuthoritativeCommandRejected', reason: 'entity-dead' })
        // Ledger still advances on a domain rejection? No — only on accept. Confirm no phantom despawn ran.
        expect(yield* entities.count).toBe(0)
      }),
    )

    it.effect('a pickup for an entity that never existed is rejected the same way', () =>
      Effect.gen(function* () {
        const entities = yield* makeEntityManager<NoBehaviour>()
        const session = new AuthoritativeSession()
        session.restore(baseSnapshot)
        const services: WorldWriteServices<NoBehaviour> = {
          entities,
          hotbarFor: () => undefined,
          inventoryFor: () => undefined,
          vehiclesFor: () => undefined,
          vitalsFor: () => undefined,
        }
        const apply = applyAuthoritativeCommand(session, services)

        const result = yield* apply(pickup('nonexistent-pickup', 'never-spawned', 0))

        expect(result).toMatchObject({ _tag: 'AuthoritativeCommandRejected', reason: 'entity-dead' })
      }),
    )

    it.effect('replaying the same accepted commandId returns the cached result without despawning again', () =>
      Effect.gen(function* () {
        const entities = yield* makeEntityManager<NoBehaviour>()
        const target = yield* entities.spawn(zombie(1))
        const session = new AuthoritativeSession()
        session.restore(baseSnapshot)
        const services: WorldWriteServices<NoBehaviour> = {
          entities,
          hotbarFor: () => undefined,
          inventoryFor: () => undefined,
          vehiclesFor: () => undefined,
          vitalsFor: () => undefined,
        }
        const apply = applyAuthoritativeCommand(session, services)

        const first = yield* apply(pickup('retry-me', target.id, 0))
        const replay = yield* apply(pickup('retry-me', target.id, 0))

        expect(first).toMatchObject({ _tag: 'AuthoritativeCommandAccepted' })
        expect(replay).toStrictEqual(first)
        expect(yield* entities.count).toBe(0)
      }),
    )
  })

  describe("PlayerVitalsCommand — 'respawn' and 'activity' write through, 'eat' does not", () => {
    const withAlice = (vitals: VitalsServiceApi): WorldWriteServices<NoBehaviour> => ({
      entities: { despawn: () => Effect.succeed(false), find: () => Effect.succeed(undefined) },
      hotbarFor: () => undefined,
      inventoryFor: () => undefined,
      vehiclesFor: () => undefined,
      vitalsFor: (player) => (player === alice ? vitals : undefined),
    })

    it.effect('an unauthorized player is rejected without any mc-sim write', () =>
      Effect.gen(function* () {
        const vitals = yield* makeVitalsService()
        const session = new AuthoritativeSession()
        session.restore(baseSnapshot)
        const apply = applyAuthoritativeCommand(session, withAlice(vitals))

        const result = yield* apply(activity('nobody', 10, 0, bob))

        expect(result).toMatchObject({ _tag: 'AuthoritativeCommandRejected', reason: 'unauthorized-player' })
        expect((yield* vitals.snapshot).exhaustion).toBe(0)
      }),
    )

    it.effect("'eat' reports CommandNotWritable — mc-sim has no item→food-value table to write through", () =>
      Effect.gen(function* () {
        const vitals = yield* makeVitalsService()
        const session = new AuthoritativeSession()
        session.restore(baseSnapshot)
        const apply = applyAuthoritativeCommand(session, withAlice(vitals))

        const result = yield* apply(eat('apple-1', 0))

        expect(result).toMatchObject({ _tag: 'CommandNotWritable', commandTag: 'PlayerVitalsCommand' })
        if (result._tag !== 'CommandNotWritable') {
          throw new Error('expected CommandNotWritable')
        }
        expect(result.reason.length).toBeGreaterThan(0)
      }),
    )

    it.effect('replaying the same activity commandId charges exhaustion exactly once, not twice', () =>
      Effect.gen(function* () {
        const vitals = yield* makeVitalsService()
        const session = new AuthoritativeSession()
        session.restore(baseSnapshot)
        const apply = applyAuthoritativeCommand(session, withAlice(vitals))

        const first = yield* apply(activity('swing-1', 10, 0))
        const replay = yield* apply(activity('swing-1', 10, 0))
        const afterOne = (yield* vitals.snapshot).exhaustion

        expect(first).toMatchObject({ _tag: 'AuthoritativeCommandAccepted' })
        expect(replay).toStrictEqual(first)
        // Not 10: mc-sim's exhaustion cascades in EXHAUSTION_PER_POINT (4) chunks into
        // saturation/hunger loss as it is charged, so 10 charged ONCE leaves a remainder
        // of 2 — the exact value a second, un-guarded charge would NOT reproduce (a
        // double charge of 10 would cascade differently, not simply double this number).
        expect(afterOne).toBe(2)
      }),
    )

    it.effect('a genuinely new activity command after the first still charges again — replay protection is per commandId, not per action', () =>
      Effect.gen(function* () {
        const vitals = yield* makeVitalsService()
        const session = new AuthoritativeSession()
        session.restore(baseSnapshot)
        const apply = applyAuthoritativeCommand(session, withAlice(vitals))

        yield* apply(activity('swing-1', 10, 0))
        yield* apply(activity('swing-2', 5, 1))

        // 10 cascades to a remainder of 2 (see the replay test above); +5 more cascades
        // 7 down to a remainder of 3. This is mc-sim's own cascade, exercised twice.
        expect((yield* vitals.snapshot).exhaustion).toBe(3)
      }),
    )

    it.effect('respawn is naturally idempotent: applying it twice leaves vitals identical to applying it once', () =>
      Effect.gen(function* () {
        const vitals = yield* makeVitalsService()
        yield* vitals.damage({ amount: 15, cause: 'test' })
        const session = new AuthoritativeSession()
        session.restore(baseSnapshot)
        const apply = applyAuthoritativeCommand(session, withAlice(vitals))

        const first = yield* apply(respawn('respawn-1', 0))
        const afterFirst = yield* vitals.snapshot
        const second = yield* apply(respawn('respawn-2', 1))
        const afterSecond = yield* vitals.snapshot

        expect(first).toMatchObject({ _tag: 'AuthoritativeCommandAccepted' })
        expect(second).toMatchObject({ _tag: 'AuthoritativeCommandAccepted' })
        expect(afterFirst.healthPoints).toBe(afterFirst.maxHealthPoints)
        expect(afterSecond).toStrictEqual(afterFirst)
      }),
    )

    it.effect('a stale-revision resubmit is rejected by the ledger before decide runs, and a fresh-id resubmit then converges to the in-order result', () =>
      Effect.gen(function* () {
        const vitals = yield* makeVitalsService()
        const session = new AuthoritativeSession()
        session.restore(baseSnapshot)
        const apply = applyAuthoritativeCommand(session, withAlice(vitals))

        // "revision 1" arrives before "revision 0" has been accepted — out of order.
        const early = yield* apply(activity('second', 5, 1))
        expect(early).toMatchObject({ reason: 'stale-revision' })
        expect((yield* vitals.snapshot).exhaustion).toBe(0)

        const inOrderFirst = yield* apply(activity('first', 10, 0))
        // A RESEND under the SAME commandId ('second') would return the cached
        // rejection forever — AuthoritativeSession caches domain rejections per
        // commandId, not only accepts (see authoritative-session.test.ts, "caches
        // domain rejections without advancing the revision"). A client whose command
        // was rejected for being early has to mint a NEW commandId once it re-sends
        // at the now-current revision; reusing the old id is a replay of the SAME
        // attempt, not a new one, and the ledger treats it that way on purpose.
        const retrySecond = yield* apply(activity('second-retry', 5, 1))

        expect(inOrderFirst).toMatchObject({ _tag: 'AuthoritativeCommandAccepted', revision: 1 })
        expect(retrySecond).toMatchObject({ _tag: 'AuthoritativeCommandAccepted', revision: 2 })
        // Same total exhaustion cascade as the in-order test above (10 then 5).
        expect((yield* vitals.snapshot).exhaustion).toBe(3)
      }),
    )
  })

  describe('every command tag or action this file still cannot write through reports CommandNotWritable rather than reaching into a rules module', () => {
    it.effect("PlayerInventoryCommand 'move-item' — InventoryServiceApi.moveStack has no partial count", () =>
      Effect.gen(function* () {
        const inventory = yield* makeInventoryService()
        const session = new AuthoritativeSession()
        session.restore(baseSnapshot)
        const services: WorldWriteServices<NoBehaviour> = {
          entities: { despawn: () => Effect.succeed(false), find: () => Effect.succeed(undefined) },
          hotbarFor: () => undefined,
          inventoryFor: (player) => (player === alice ? inventory : undefined),
          vehiclesFor: () => undefined,
          vitalsFor: () => undefined,
        }
        const apply = applyAuthoritativeCommand(session, services)

        const result = yield* apply(inventoryMove('move', 0))

        expect(result).toMatchObject({ _tag: 'CommandNotWritable', commandTag: 'PlayerInventoryCommand' })
        expect(session.revision(world)).toBe(0)
      }),
    )

    it.effect("PlayerInventoryCommand 'drop-item' — no entity-spawn service for a dropped stack", () =>
      Effect.gen(function* () {
        const inventory = yield* makeInventoryService()
        const session = new AuthoritativeSession()
        session.restore(baseSnapshot)
        const services: WorldWriteServices<NoBehaviour> = {
          entities: { despawn: () => Effect.succeed(false), find: () => Effect.succeed(undefined) },
          hotbarFor: () => undefined,
          inventoryFor: (player) => (player === alice ? inventory : undefined),
          vehiclesFor: () => undefined,
          vitalsFor: () => undefined,
        }
        const apply = applyAuthoritativeCommand(session, services)

        const result = yield* apply(inventoryDrop('drop', 0))

        expect(result).toMatchObject({ _tag: 'CommandNotWritable', commandTag: 'PlayerInventoryCommand' })
        expect(session.revision(world)).toBe(0)
      }),
    )

    it.effect("VehicleCommand 'move' — turning a direction into a velocity needs vehicle-physics constants this file does not own", () =>
      Effect.gen(function* () {
        const session = new AuthoritativeSession()
        session.restore(baseSnapshot)
        const services: WorldWriteServices<NoBehaviour> = {
          entities: { despawn: () => Effect.succeed(false), find: () => Effect.succeed(undefined) },
          hotbarFor: () => undefined,
          inventoryFor: () => undefined,
          vehiclesFor: () => fakeVehicles([]),
          vitalsFor: () => undefined,
        }
        const apply = applyAuthoritativeCommand(session, services)

        const result = yield* apply(vehicleMove('vmove', 'boat-1', 0))

        expect(result).toMatchObject({ _tag: 'CommandNotWritable', commandTag: 'VehicleCommand' })
        expect(session.revision(world)).toBe(0)
      }),
    )

    it.effect("BowUseCommand — a whole tag with no mc-sim service at all, resolved through UNAVAILABLE_REASONS' default case", () =>
      Effect.gen(function* () {
        const session = new AuthoritativeSession()
        session.restore(baseSnapshot)
        const services: WorldWriteServices<NoBehaviour> = {
          entities: { despawn: () => Effect.succeed(false), find: () => Effect.succeed(undefined) },
          hotbarFor: () => undefined,
          inventoryFor: () => undefined,
          vehiclesFor: () => undefined,
          vitalsFor: () => undefined,
        }
        const apply = applyAuthoritativeCommand(session, services)

        const result = yield* apply(bowUse('bow-1', 0))

        expect(result).toMatchObject({ _tag: 'CommandNotWritable', commandTag: 'BowUseCommand' })
        if (result._tag !== 'CommandNotWritable') {
          throw new Error('expected CommandNotWritable')
        }
        expect(result.reason.length).toBeGreaterThan(0)
        expect(session.revision(world)).toBe(0)
      }),
    )
  })

  describe("PlayerInventoryCommand — 'swap-items', 'equip-item' and 'unequip-item' write through, replay does not double-apply", () => {
    it.effect('swap-items calls InventoryServiceApi.moveStack exactly once, even on replay', () =>
      Effect.gen(function* () {
        const inventory = yield* makeInventoryService()
        const calls: Array<string> = []
        const session = new AuthoritativeSession()
        session.restore(baseSnapshot)
        const services: WorldWriteServices<NoBehaviour> = {
          entities: { despawn: () => Effect.succeed(false), find: () => Effect.succeed(undefined) },
          hotbarFor: () => undefined,
          inventoryFor: (player) => (player === alice ? countingInventory(inventory, calls) : undefined),
          vehiclesFor: () => undefined,
          vitalsFor: () => undefined,
        }
        const apply = applyAuthoritativeCommand(session, services)

        const first = yield* apply(inventorySwap('swap-1', 0, 1, 0))
        const replay = yield* apply(inventorySwap('swap-1', 0, 1, 0))

        expect(first).toMatchObject({ _tag: 'AuthoritativeCommandAccepted' })
        expect(replay).toStrictEqual(first)
        // The replay's decide closure never ran (ledger returned the cached result), so
        // moveStack was never called for it — exactly one call reaches mc-sim.
        expect(calls).toStrictEqual(['move:0:1'])
      }),
    )

    it.effect('a genuinely new swap-items command after the first still moves — replay protection is per commandId, not per action', () =>
      Effect.gen(function* () {
        const inventory = yield* makeInventoryService()
        const calls: Array<string> = []
        const session = new AuthoritativeSession()
        session.restore(baseSnapshot)
        const services: WorldWriteServices<NoBehaviour> = {
          entities: { despawn: () => Effect.succeed(false), find: () => Effect.succeed(undefined) },
          hotbarFor: () => undefined,
          inventoryFor: (player) => (player === alice ? countingInventory(inventory, calls) : undefined),
          vehiclesFor: () => undefined,
          vitalsFor: () => undefined,
        }
        const apply = applyAuthoritativeCommand(session, services)

        yield* apply(inventorySwap('swap-a', 0, 1, 0))
        yield* apply(inventorySwap('swap-b', 1, 2, 1))

        expect(calls).toStrictEqual(['move:0:1', 'move:1:2'])
      }),
    )

    it.effect('equip-item calls InventoryServiceApi.equipFromInventory exactly once, even on replay', () =>
      Effect.gen(function* () {
        const inventory = yield* makeInventoryService()
        const calls: Array<string> = []
        const session = new AuthoritativeSession()
        session.restore(baseSnapshot)
        const services: WorldWriteServices<NoBehaviour> = {
          entities: { despawn: () => Effect.succeed(false), find: () => Effect.succeed(undefined) },
          hotbarFor: () => undefined,
          inventoryFor: (player) => (player === alice ? countingInventory(inventory, calls) : undefined),
          vehiclesFor: () => undefined,
          vitalsFor: () => undefined,
        }
        const apply = applyAuthoritativeCommand(session, services)

        const first = yield* apply(inventoryEquip('equip-1', 0))
        const replay = yield* apply(inventoryEquip('equip-1', 0))

        expect(first).toMatchObject({ _tag: 'AuthoritativeCommandAccepted' })
        expect(replay).toStrictEqual(first)
        expect(calls).toStrictEqual(['equip:0:head'])
      }),
    )

    it.effect('unequip-item calls InventoryServiceApi.unequipToInventory exactly once, even on replay', () =>
      Effect.gen(function* () {
        const inventory = yield* makeInventoryService()
        const calls: Array<string> = []
        const session = new AuthoritativeSession()
        session.restore(baseSnapshot)
        const services: WorldWriteServices<NoBehaviour> = {
          entities: { despawn: () => Effect.succeed(false), find: () => Effect.succeed(undefined) },
          hotbarFor: () => undefined,
          inventoryFor: (player) => (player === alice ? countingInventory(inventory, calls) : undefined),
          vehiclesFor: () => undefined,
          vitalsFor: () => undefined,
        }
        const apply = applyAuthoritativeCommand(session, services)

        const first = yield* apply(inventoryUnequip('unequip-1', 0))
        const replay = yield* apply(inventoryUnequip('unequip-1', 0))

        expect(first).toMatchObject({ _tag: 'AuthoritativeCommandAccepted' })
        expect(replay).toStrictEqual(first)
        expect(calls).toStrictEqual(['unequip:head:0'])
      }),
    )

    it.effect('an unauthorized player is rejected without any mc-sim write', () =>
      Effect.gen(function* () {
        const inventory = yield* makeInventoryService()
        const calls: Array<string> = []
        const session = new AuthoritativeSession()
        session.restore(baseSnapshot)
        const services: WorldWriteServices<NoBehaviour> = {
          entities: { despawn: () => Effect.succeed(false), find: () => Effect.succeed(undefined) },
          hotbarFor: () => undefined,
          inventoryFor: (player) => (player === alice ? countingInventory(inventory, calls) : undefined),
          vehiclesFor: () => undefined,
          vitalsFor: () => undefined,
        }
        const apply = applyAuthoritativeCommand(session, services)

        const result = yield* apply(inventorySwap('nobody', 0, 1, 0, bob))

        expect(result).toMatchObject({ _tag: 'AuthoritativeCommandRejected', reason: 'unauthorized-player' })
        expect(calls).toStrictEqual([])
      }),
    )
  })

  describe("PlayerInventoryCommand — 'select-slot' writes through HotbarServiceApi, replay does not double-apply", () => {
    const withHotbar = (hotbar: Pick<HotbarServiceApi, 'setSelectedSlot'>): WorldWriteServices<NoBehaviour> => ({
      entities: { despawn: () => Effect.succeed(false), find: () => Effect.succeed(undefined) },
      hotbarFor: (player) => (player === alice ? hotbar : undefined),
      inventoryFor: () => undefined,
      vehiclesFor: () => undefined,
      vitalsFor: () => undefined,
    })

    it.effect('select-slot calls HotbarServiceApi.setSelectedSlot exactly once, even on replay', () =>
      Effect.gen(function* () {
        const inventory = yield* makeInventoryService()
        const hotbar = yield* makeHotbarService().pipe(Effect.provideService(InventoryService, inventory))
        const calls: Array<string> = []
        const session = new AuthoritativeSession()
        session.restore(baseSnapshot)
        const apply = applyAuthoritativeCommand(session, withHotbar(countingHotbar(hotbar, calls)))

        const first = yield* apply(inventorySelect('select-1', 3, 0))
        const replay = yield* apply(inventorySelect('select-1', 3, 0))

        expect(first).toMatchObject({ _tag: 'AuthoritativeCommandAccepted' })
        expect(replay).toStrictEqual(first)
        // The replay's decide closure never ran (ledger returned the cached result), so
        // setSelectedSlot was never called for it — exactly one call reaches mc-sim.
        expect(calls).toStrictEqual(['select:3'])
      }),
    )

    it.effect('a genuinely new select-slot command after the first still writes — replay protection is per commandId, not per action', () =>
      Effect.gen(function* () {
        const inventory = yield* makeInventoryService()
        const hotbar = yield* makeHotbarService().pipe(Effect.provideService(InventoryService, inventory))
        const calls: Array<string> = []
        const session = new AuthoritativeSession()
        session.restore(baseSnapshot)
        const apply = applyAuthoritativeCommand(session, withHotbar(countingHotbar(hotbar, calls)))

        yield* apply(inventorySelect('select-a', 2, 0))
        yield* apply(inventorySelect('select-b', 5, 1))

        expect(calls).toStrictEqual(['select:2', 'select:5'])
      }),
    )

    it.effect('an unauthorized player is rejected without any mc-sim write', () =>
      Effect.gen(function* () {
        const inventory = yield* makeInventoryService()
        const hotbar = yield* makeHotbarService().pipe(Effect.provideService(InventoryService, inventory))
        const calls: Array<string> = []
        const session = new AuthoritativeSession()
        session.restore(baseSnapshot)
        const apply = applyAuthoritativeCommand(session, withHotbar(countingHotbar(hotbar, calls)))

        const result = yield* apply(inventorySelect('nobody', 1, 0, bob))

        expect(result).toMatchObject({ _tag: 'AuthoritativeCommandRejected', reason: 'unauthorized-player' })
        expect(calls).toStrictEqual([])
      }),
    )
  })

  describe("VehicleCommand — 'mount' and 'dismount' write through, replay does not double-apply", () => {
    it.effect('mount is accepted and calls VehicleServiceApi.mount exactly once, even on replay', () =>
      Effect.gen(function* () {
        const mountCalls: Array<string> = []
        const vehicles = fakeVehicles([emptyBoat('boat-1')], mountCalls)
        const session = new AuthoritativeSession()
        session.restore(baseSnapshot)
        const services: WorldWriteServices<NoBehaviour> = {
          entities: { despawn: () => Effect.succeed(false), find: () => Effect.succeed(undefined) },
          hotbarFor: () => undefined,
          inventoryFor: () => undefined,
          vehiclesFor: (player) => (player === alice ? vehicles : undefined),
          vitalsFor: () => undefined,
        }
        const apply = applyAuthoritativeCommand(session, services)

        const first = yield* apply(vehicleMount('mount-1', 'boat-1', 0))
        const replay = yield* apply(vehicleMount('mount-1', 'boat-1', 0))

        expect(first).toMatchObject({ _tag: 'AuthoritativeCommandAccepted' })
        expect(replay).toStrictEqual(first)
        // The replay's decide closure never ran (ledger returned the cached result), so
        // mount was never called for it — exactly one call reaches mc-sim.
        expect(mountCalls).toStrictEqual(['mount:boat-1:alice'])
      }),
    )

    it.effect('mounting an already-occupied vehicle is rejected as vehicle-occupied, without calling mount', () =>
      Effect.gen(function* () {
        const mountCalls: Array<string> = []
        const vehicles = fakeVehicles([occupiedBoat('boat-1', 'bob')], mountCalls)
        const session = new AuthoritativeSession()
        session.restore(baseSnapshot)
        const services: WorldWriteServices<NoBehaviour> = {
          entities: { despawn: () => Effect.succeed(false), find: () => Effect.succeed(undefined) },
          hotbarFor: () => undefined,
          inventoryFor: () => undefined,
          vehiclesFor: (player) => (player === alice ? vehicles : undefined),
          vitalsFor: () => undefined,
        }
        const apply = applyAuthoritativeCommand(session, services)

        const result = yield* apply(vehicleMount('mount-2', 'boat-1', 0))

        expect(result).toMatchObject({ _tag: 'AuthoritativeCommandRejected', reason: 'vehicle-occupied' })
        expect(mountCalls).toStrictEqual([])
      }),
    )

    it.effect('mounting a vehicle that does not exist is rejected as resource-not-found', () =>
      Effect.gen(function* () {
        const vehicles = fakeVehicles([])
        const session = new AuthoritativeSession()
        session.restore(baseSnapshot)
        const services: WorldWriteServices<NoBehaviour> = {
          entities: { despawn: () => Effect.succeed(false), find: () => Effect.succeed(undefined) },
          hotbarFor: () => undefined,
          inventoryFor: () => undefined,
          vehiclesFor: (player) => (player === alice ? vehicles : undefined),
          vitalsFor: () => undefined,
        }
        const apply = applyAuthoritativeCommand(session, services)

        const result = yield* apply(vehicleMount('mount-3', 'never-spawned', 0))

        expect(result).toMatchObject({ _tag: 'AuthoritativeCommandRejected', reason: 'resource-not-found' })
      }),
    )

    it.effect('dismount is accepted for the current occupant and calls VehicleServiceApi.dismount exactly once, even on replay', () =>
      Effect.gen(function* () {
        const dismountCalls: Array<string> = []
        const vehicles = fakeVehicles([occupiedBoat('boat-1', 'alice')], [], dismountCalls)
        const session = new AuthoritativeSession()
        session.restore(baseSnapshot)
        const services: WorldWriteServices<NoBehaviour> = {
          entities: { despawn: () => Effect.succeed(false), find: () => Effect.succeed(undefined) },
          hotbarFor: () => undefined,
          inventoryFor: () => undefined,
          vehiclesFor: (player) => (player === alice ? vehicles : undefined),
          vitalsFor: () => undefined,
        }
        const apply = applyAuthoritativeCommand(session, services)

        const first = yield* apply(vehicleDismount('dismount-1', 'boat-1', 0))
        const replay = yield* apply(vehicleDismount('dismount-1', 'boat-1', 0))

        expect(first).toMatchObject({ _tag: 'AuthoritativeCommandAccepted' })
        expect(replay).toStrictEqual(first)
        expect(dismountCalls).toStrictEqual(['dismount:boat-1:alice'])
      }),
    )

    it.effect('dismounting a vehicle the player is not the occupant of is rejected as not-mounted', () =>
      Effect.gen(function* () {
        const dismountCalls: Array<string> = []
        const vehicles = fakeVehicles([occupiedBoat('boat-1', 'bob')], [], dismountCalls)
        const session = new AuthoritativeSession()
        session.restore(baseSnapshot)
        const services: WorldWriteServices<NoBehaviour> = {
          entities: { despawn: () => Effect.succeed(false), find: () => Effect.succeed(undefined) },
          hotbarFor: () => undefined,
          inventoryFor: () => undefined,
          vehiclesFor: (player) => (player === alice ? vehicles : undefined),
          vitalsFor: () => undefined,
        }
        const apply = applyAuthoritativeCommand(session, services)

        const result = yield* apply(vehicleDismount('dismount-2', 'boat-1', 0))

        expect(result).toMatchObject({ _tag: 'AuthoritativeCommandRejected', reason: 'not-mounted' })
        expect(dismountCalls).toStrictEqual([])
      }),
    )

    it.effect('an unauthorized player is rejected without reading the roster or calling mount', () =>
      Effect.gen(function* () {
        const mountCalls: Array<string> = []
        const vehicles = fakeVehicles([emptyBoat('boat-1')], mountCalls)
        const session = new AuthoritativeSession()
        session.restore(baseSnapshot)
        const services: WorldWriteServices<NoBehaviour> = {
          entities: { despawn: () => Effect.succeed(false), find: () => Effect.succeed(undefined) },
          hotbarFor: () => undefined,
          inventoryFor: () => undefined,
          vehiclesFor: (player) => (player === alice ? vehicles : undefined),
          vitalsFor: () => undefined,
        }
        const apply = applyAuthoritativeCommand(session, services)

        const result = yield* apply(vehicleMount('nobody', 'boat-1', 0, bob))

        expect(result).toMatchObject({ _tag: 'AuthoritativeCommandRejected', reason: 'unauthorized-player' })
        expect(mountCalls).toStrictEqual([])
      }),
    )
  })
})

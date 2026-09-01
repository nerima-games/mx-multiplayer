import { describe, expect, it } from '@effect/vitest'
import { Effect } from 'effect'
import { EntityKind, makeEntityManager, makeVitalsService, type SpawnRequest, type VitalsServiceApi } from '@nerima-games/mc-sim'
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

const inventorySelect = (commandId: string, expectedRevision: number, player = alice): AuthoritativeCommand => ({
  _tag: 'PlayerInventoryCommand',
  action: { _tag: 'select-slot', slot: 0 },
  commandId: CommandId.make(commandId),
  expectedRevision,
  player,
  world,
})

describe('applyAuthoritativeCommand — writing through to mc-sim', () => {
  describe('EntityPickupCommand — the contested-pickup case', () => {
    it.effect('two peers racing for the same entity within one tick: the loser gets stale-revision, the entity is removed exactly once', () =>
      Effect.gen(function* () {
        const entities = yield* makeEntityManager<NoBehaviour>()
        const target = yield* entities.spawn(zombie(1))
        const session = new AuthoritativeSession()
        session.restore(baseSnapshot)
        const services: WorldWriteServices<NoBehaviour> = { entities, vitalsFor: () => undefined }
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
        const services: WorldWriteServices<NoBehaviour> = { entities, vitalsFor: () => undefined }
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
        const services: WorldWriteServices<NoBehaviour> = { entities, vitalsFor: () => undefined }
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
        const services: WorldWriteServices<NoBehaviour> = { entities, vitalsFor: () => undefined }
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

  describe('every other command tag reports CommandNotWritable rather than reaching into a rules module', () => {
    it.effect('PlayerInventoryCommand — mc-sim exposes InventoryService but not a per-player lookup this file builds', () =>
      Effect.gen(function* () {
        const entities = yield* makeEntityManager<NoBehaviour>()
        const session = new AuthoritativeSession()
        session.restore(baseSnapshot)
        const services: WorldWriteServices<NoBehaviour> = { entities, vitalsFor: () => undefined }
        const apply = applyAuthoritativeCommand(session, services)

        const result = yield* apply(inventorySelect('select', 0))

        expect(result).toMatchObject({ _tag: 'CommandNotWritable', commandTag: 'PlayerInventoryCommand' })
        if (result._tag !== 'CommandNotWritable') {
          throw new Error('expected CommandNotWritable')
        }
        expect(result.reason.length).toBeGreaterThan(0)
        // Nothing was admitted to the ledger for an unwritable command — it never reaches `session.execute`.
        expect(session.revision(world)).toBe(0)
      }),
    )
  })
})

/* eslint-disable id-length, max-statements, no-magic-numbers, no-ternary, no-undefined, no-underscore-dangle, sort-imports, sort-keys -- Fixtures make authority transitions explicit. */
import { describe, expect, it } from '@effect/vitest'
import { PlayerId, SurvivalAuthority, WorldId, type SurvivalCommand, type SurvivalSnapshot } from '../src/index'

const alice = PlayerId.make('alice')
const bob = PlayerId.make('bob')
const initial = (): SurvivalSnapshot => ({
  world: WorldId.make('overworld'),
  revision: 7,
  actors: [
    { player: alice, session: 'alice-session', position: { x: 0, y: 64, z: 0 }, gameMode: 'survival', inventory: [{ item: 'stone', count: 2 }], health: 20, spawn: { x: 0, y: 64, z: 0 }, lastActionTick: 0 },
    { player: bob, session: 'bob-session', position: { x: 1, y: 64, z: 0 }, gameMode: 'survival', inventory: [{ item: 'apple', count: 1 }], health: 4, spawn: { x: 10, y: 70, z: 10 }, lastActionTick: 0 },
  ],
  blocks: { '2,64,0': 'dirt' },
  drops: [],
})

const header = (requestId: string, revision = 7) => ({ actor: alice, session: 'alice-session', requestId, expectedRevision: revision, clientTick: 10 })

describe('survival authority', () => {
  it('atomically consumes an inventory slot and places a block', () => {
    const authority = new SurvivalAuthority(initial())
    const result = authority.execute({ ...header('place'), _tag: 'PlaceBlock', at: { x: 1, y: 64, z: 1 }, slot: 0, block: 'stone' })
    expect(result).toMatchObject({ accepted: true, revision: 8, events: [{ _tag: 'InventoryChanged' }, { _tag: 'BlockChanged' }] })
    const snapshot = authority.snapshot()
    expect(snapshot).toMatchObject({ revision: 8, blocks: { '1,64,1': 'stone' } })
    expect(snapshot.actors[0]?.inventory[0]).toStrictEqual({ item: 'stone', count: 1 })
  })

  it('rejects spoofed, stale, duplicate, unreachable, cooldown and inventory-invalid commands without mutation', () => {
    const cases: ReadonlyArray<[SurvivalCommand, string]> = [
      [{ ...header('spoof'), actor: PlayerId.make('mallory'), _tag: 'BreakBlock', at: { x: 2, y: 64, z: 0 } }, 'unauthorized-actor'],
      [{ ...header('session'), session: 'stolen', _tag: 'BreakBlock', at: { x: 2, y: 64, z: 0 } }, 'session-mismatch'],
      [{ ...header('stale', 6), _tag: 'BreakBlock', at: { x: 2, y: 64, z: 0 } }, 'stale-revision'],
      [{ ...header('far'), _tag: 'BreakBlock', at: { x: 20, y: 64, z: 0 } }, 'out-of-reach'],
      [{ ...header('empty'), _tag: 'PlaceBlock', at: { x: 1, y: 64, z: 1 }, slot: 1, block: 'stone' }, 'insufficient-items'],
      [{ ...header('cooldown'), clientTick: 2, _tag: 'BreakBlock', at: { x: 2, y: 64, z: 0 } }, 'cooldown-active'],
    ]
    for (const [command, reason] of cases) {
      const authority = new SurvivalAuthority(initial())
      expect(authority.execute(command)).toMatchObject({ accepted: false, reason, revision: 7 })
      expect(authority.snapshot()).toStrictEqual(initial())
    }
    const creativeSnapshot = initial()
    const creativeAuthority = new SurvivalAuthority({
      ...creativeSnapshot,
      actors: creativeSnapshot.actors.map((actor) => actor.player === alice ? { ...actor, gameMode: 'creative' } : actor),
    })
    expect(creativeAuthority.execute({ ...header('creative'), _tag: 'BreakBlock', at: { x: 2, y: 64, z: 0 } })).toMatchObject({
      accepted: false,
      reason: 'invalid-game-mode',
      revision: 7,
    })
    const authority = new SurvivalAuthority(initial())
    const command = { ...header('same'), _tag: 'BreakBlock', at: { x: 2, y: 64, z: 0 } } as const
    expect(authority.execute(command)).toMatchObject({ accepted: true, revision: 8 })
    expect(authority.execute(command)).toMatchObject({ accepted: false, reason: 'duplicate-request', revision: 8 })
  })

  it('emits deterministic damage, death, drops and respawn events', () => {
    const authority = new SurvivalAuthority(initial())
    expect(authority.execute({ ...header('kill'), _tag: 'Attack', target: bob })).toMatchObject({
      accepted: true,
      revision: 8,
      events: [{ _tag: 'ActorDamaged', health: 0 }, { _tag: 'ActorDied' }, { _tag: 'ItemDropped', item: 'apple' }],
    })
    expect(authority.execute({ actor: bob, session: 'bob-session', requestId: 'respawn', expectedRevision: 8, clientTick: 20, _tag: 'Respawn' })).toMatchObject({
      accepted: true,
      revision: 9,
      events: [{ _tag: 'ActorRespawned', at: { x: 10, y: 70, z: 10 }, health: 20 }],
    })
  })

  it('round-trips snapshots and rotates the authenticated session on rejoin', () => {
    const first = new SurvivalAuthority(initial())
    first.execute({ ...header('break'), _tag: 'BreakBlock', at: { x: 2, y: 64, z: 0 } })
    const restored = new SurvivalAuthority(first.snapshot())
    expect(restored.snapshot()).toStrictEqual(first.snapshot())
    expect(restored.rejoin(alice, 'alice-session', 'alice-rejoined')).toBe(true)
    expect(restored.execute({ actor: alice, session: 'alice-session', requestId: 'old', expectedRevision: 8, clientTick: 20, _tag: 'Respawn' })).toMatchObject({ reason: 'session-mismatch' })
  })

  it('authoritatively validates sleep and emits one threshold event', () => {
    const authority = new SurvivalAuthority(initial(), {
      sleepPercentage: 50,
      validateSleep: ({ bed }) => ({ dimension: 'overworld', bedValid: bed.y === 64, nightOrThunder: true, safe: true }),
    })
    const entered = authority.execute({ ...header('sleep'), _tag: 'EnterSleep', bed: { x: 0, y: 64, z: 1 } })
    expect(entered).toMatchObject({
      accepted: true,
      revision: 8,
      events: [
        { _tag: 'ActorSleepChanged', actor: alice },
        { _tag: 'SleepProgress', sleeping: 1, required: 1, connected: 2, ready: true },
        { _tag: 'NightSkipped', sleeping: 1, required: 1 },
      ],
    })
    expect(authority.snapshot().actors.every((actor) => actor.sleeping === undefined)).toBe(true)
    expect(authority.execute({ ...header('duplicate', 8), _tag: 'LeaveSleep' })).toMatchObject({ accepted: false, reason: 'not-sleeping' })
  })

  it('rejects spoofed, stale, duplicate and server-invalid sleep commands', () => {
    const command = { ...header('sleep'), _tag: 'EnterSleep', bed: { x: 0, y: 64, z: 1 } } as const
    const authority = new SurvivalAuthority(initial(), {
      validateSleep: () => ({ dimension: 'overworld', bedValid: true, nightOrThunder: false, safe: true }),
    })
    expect(authority.execute(command)).toMatchObject({ accepted: false, reason: 'not-sleep-time' })
    expect(authority.execute(command)).toMatchObject({ accepted: false, reason: 'duplicate-request' })
    expect(new SurvivalAuthority(initial()).execute({ ...command, requestId: 'spoof', actor: PlayerId.make('mallory') })).toMatchObject({ reason: 'unauthorized-actor' })
    expect(new SurvivalAuthority(initial()).execute({ ...command, requestId: 'stale', expectedRevision: 6 })).toMatchObject({ reason: 'stale-revision' })
    expect(new SurvivalAuthority(initial(), {
      validateSleep: () => ({ dimension: 'overworld', bedValid: true, nightOrThunder: true, safe: false }),
    }).execute(command)).toMatchObject({ reason: 'sleep-unsafe' })
    expect(new SurvivalAuthority(initial(), {
      validateSleep: () => ({ dimension: 'overworld', bedValid: false, nightOrThunder: true, safe: true }),
    }).execute(command)).toMatchObject({ reason: 'invalid-bed' })

    const leaveAuthority = new SurvivalAuthority(initial(), {
      validateSleep: () => ({ dimension: 'overworld', bedValid: true, nightOrThunder: true, safe: true }),
    })
    expect(leaveAuthority.execute({ ...command, requestId: 'enter-before-leave' })).toMatchObject({ accepted: true, revision: 8 })
    expect(leaveAuthority.execute({ ...header('leave', 8), _tag: 'LeaveSleep' })).toMatchObject({
      accepted: true,
      revision: 9,
      events: [{ _tag: 'ActorSleepChanged', sleeping: null }, { _tag: 'SleepProgress', sleeping: 0, ready: false }],
    })
  })

  it('persists sleep in snapshots and reconciles disconnect, death, dimension and bed invalidation', () => {
    let aliceValid = true
    const bobValid = true
    const authority = new SurvivalAuthority(initial(), {
      validateSleep: ({ actor }) => ({
        dimension: actor.player === alice && !aliceValid ? 'nether' : 'overworld',
        bedValid: actor.player === alice ? aliceValid : bobValid,
        nightOrThunder: true,
        safe: true,
      }),
    })
    expect(authority.execute({ ...header('alice-sleep'), _tag: 'EnterSleep', bed: { x: 0, y: 64, z: 1 } })).toMatchObject({ accepted: true })
    const restored = new SurvivalAuthority(authority.snapshot(), {
      validateSleep: ({ actor }) => ({ dimension: 'overworld', bedValid: actor.player === bob ? bobValid : aliceValid, nightOrThunder: true, safe: true }),
    })
    expect(restored.snapshot().actors[0]?.sleeping).toMatchObject({ dimension: 'overworld', bed: { x: 0, y: 64, z: 1 } })
    expect(restored.rejoin(alice, 'alice-session', 'alice-rejoined')).toBe(true)
    aliceValid = false
    expect(restored.reconcileSleep()).toMatchObject([{ _tag: 'ActorSleepChanged', actor: alice }, { _tag: 'SleepProgress', sleeping: 0 }])

    const deathBase = initial()
    const deathSnapshot: SurvivalSnapshot = { ...deathBase, actors: deathBase.actors.map((actor) => actor.player === bob ? { ...actor, sleeping: { dimension: 'overworld', bed: { x: 1, y: 64, z: 1 } } } : actor) }
    const deathAuthority = new SurvivalAuthority(deathSnapshot)
    const death = deathAuthority.execute({ ...header('kill-sleeper'), _tag: 'Attack', target: bob })
    expect(death).toMatchObject({ accepted: true })
    expect(death.accepted && death.events.some((event) => event._tag === 'ActorSleepChanged' && event.actor === bob)).toBe(true)
    expect(death.accepted && death.events.some((event) => event._tag === 'SleepProgress' && event.sleeping === 0)).toBe(true)

    const disconnectBase = initial()
    const disconnectSnapshot: SurvivalSnapshot = { ...disconnectBase, actors: disconnectBase.actors.map((actor) => actor.player === alice ? { ...actor, sleeping: { dimension: 'overworld', bed: { x: 0, y: 64, z: 1 } } } : actor) }
    const disconnectAuthority = new SurvivalAuthority(disconnectSnapshot)
    expect(disconnectAuthority.disconnect(bob)).toMatchObject([{ _tag: 'SleepProgress', connected: 1, required: 1 }, { _tag: 'NightSkipped' }])
    expect(disconnectAuthority.disconnect(bob)).toStrictEqual([])
  })
})

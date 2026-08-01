/* eslint-disable id-length, max-statements, no-magic-numbers, no-ternary, sort-imports, sort-keys -- Fixtures make authority transitions explicit. */
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
})

/* eslint-disable max-statements, no-magic-numbers, no-ternary, no-underscore-dangle, sort-imports, sort-keys -- State-machine fixtures are intentionally explicit. */
import { describe, expect, it } from '@effect/vitest'
import { createHungerAuthority, PlayerId, WorldId, type HungerSnapshot } from '../src/index'

const alice = PlayerId.make('alice')
const snapshot = (difficulty: HungerSnapshot['difficulty'] = 'normal'): HungerSnapshot => ({
  world: WorldId.make('overworld'), revision: 2, difficulty, tickRemainderMs: 0,
  actors: [{ player: alice, session: 'one', state: { food: 19, saturation: 0, exhaustion: 0, health: 18 }, food: { apple: 2 } }],
})
const header = (commandId: string, expectedRevision = 2) => ({ player: alice, session: 'one', commandId, expectedRevision })

describe('hunger authority', () => {
  it('validates activity bounds, stale revisions and replay before applying exhaustion', () => {
    expect(createHungerAuthority(snapshot()).execute({ ...header('large'), _tag: 'Activity', activity: 'walk', amount: 101 })).toMatchObject({ accepted: false, reason: 'invalid-command' })
    expect(createHungerAuthority(snapshot()).execute({ ...header('stale', 1), _tag: 'Activity', activity: 'jump', amount: 1 })).toMatchObject({ accepted: false, reason: 'stale-revision' })
    const authority = createHungerAuthority(snapshot())
    const command = { ...header('jump'), _tag: 'Activity', activity: 'jump', amount: 2 } as const
    expect(authority.execute(command)).toMatchObject({ accepted: true, revision: 3 })
    expect(authority.execute(command)).toMatchObject({ accepted: false, reason: 'duplicate-command' })
    expect(authority.snapshot().actors[0]?.state.exhaustion).toBeCloseTo(0.4)
  })

  it('consumes server inventory exactly once and persists through snapshot/rejoin', () => {
    const authority = createHungerAuthority(snapshot())
    const result = authority.execute({ ...header('eat'), _tag: 'Eat', item: 'apple' })
    expect(result).toMatchObject({ accepted: true })
    expect(result.accepted && result.events[0]).toMatchObject({ _tag: 'FoodConsumed', remaining: 1 })
    const restored = createHungerAuthority(authority.snapshot())
    expect(restored.rejoin(alice, 'one', 'two')).toBe(true)
    expect(restored.snapshot()).toMatchObject({ revision: 3, actors: [{ session: 'two', food: { apple: 1 }, state: { food: 20 } }] })
    expect(restored.execute({ player: alice, session: 'one', commandId: 'old', expectedRevision: 3, _tag: 'Eat', item: 'apple' })).toMatchObject({ reason: 'session-mismatch' })
  })

  it('ticks only each four seconds, regenerates, starves to difficulty floors and emits death', () => {
    const healing = createHungerAuthority(snapshot())
    expect(healing.tick(3999)).toStrictEqual([])
    expect(healing.tick(1)).toMatchObject([{ _tag: 'HungerChanged', state: { health: 19 } }])
    for (const [difficulty, floor] of [['easy', 10], ['normal', 1], ['hard', 0]] as const) {
      const base = snapshot(difficulty)
      const authority = createHungerAuthority({ ...base, actors: [{ ...base.actors[0]!, state: { food: 0, saturation: 0, exhaustion: 0, health: difficulty === 'easy' ? 10 : 1 } }] })
      const events = authority.tick(4000)
      expect(authority.snapshot().actors[0]?.state.health).toBe(floor)
      expect(events.some((event) => event._tag === 'HungerDeath')).toBe(difficulty === 'hard')
      if (difficulty === 'hard') {
        expect(authority.execute({ ...header('respawn', authority.snapshot().revision), _tag: 'Respawn' })).toMatchObject({ accepted: true })
        expect(authority.snapshot().actors[0]?.state).toStrictEqual({ food: 20, saturation: 5, exhaustion: 0, health: 20 })
      }
    }
  })

  it('removes disconnected actors without leaking state', () => {
    const authority = createHungerAuthority(snapshot())
    authority.disconnect(alice)
    expect(authority.snapshot()).toMatchObject({ revision: 3, actors: [] })
  })

  it('leaves state untouched when disconnect targets a player who is not present', () => {
    const authority = createHungerAuthority(snapshot())
    const before = authority.snapshot()
    authority.disconnect(PlayerId.make('ghost'))
    expect(authority.snapshot()).toStrictEqual(before)
  })

  it('rejects a rejoin with a blank session, an unknown player, or a mismatched previous session', () => {
    const authority = createHungerAuthority(snapshot())
    expect(authority.rejoin(alice, 'one', '')).toBe(false)
    expect(authority.rejoin(PlayerId.make('ghost'), 'one', 'two')).toBe(false)
    expect(authority.rejoin(alice, 'wrong-previous', 'two')).toBe(false)
    expect(authority.snapshot()).toMatchObject({ actors: [{ session: 'one' }] })
  })

  it('rejoins only the named actor, leaving every other actor in the world untouched', () => {
    const bob = PlayerId.make('bob')
    const base = snapshot()
    const withBob = {
      ...base,
      actors: [
        ...base.actors,
        { player: bob, session: 'bob-one', state: { food: 15, saturation: 1, exhaustion: 0, health: 20 }, food: {} },
      ],
    }
    const authority = createHungerAuthority(withBob)
    expect(authority.rejoin(alice, 'one', 'alice-two')).toBe(true)
    expect(authority.snapshot().actors).toStrictEqual([
      { player: alice, session: 'alice-two', state: withBob.actors[0]!.state, food: withBob.actors[0]!.food },
      withBob.actors[1],
    ])
  })

  it('rejects a command with a blank commandId or session, and a command from an unknown or mismatched player', () => {
    const authority = createHungerAuthority(snapshot())
    expect(authority.execute({ player: alice, session: 'one', commandId: '', expectedRevision: 2, _tag: 'Respawn' })).toMatchObject({ reason: 'invalid-command' })
    expect(authority.execute({ player: alice, session: '', commandId: 'x', expectedRevision: 2, _tag: 'Respawn' })).toMatchObject({ reason: 'invalid-command' })
    expect(authority.execute({ player: PlayerId.make('ghost'), session: 'one', commandId: 'x', expectedRevision: 2, _tag: 'Respawn' })).toMatchObject({ reason: 'unauthorized-player' })
    expect(authority.execute({ player: alice, session: 'wrong', commandId: 'x', expectedRevision: 2, _tag: 'Respawn' })).toMatchObject({ reason: 'session-mismatch' })
  })

  it('rejects every non-Respawn command from a dead actor, and accepts Respawn to revive them', () => {
    const base = snapshot()
    const dead = { ...base, actors: [{ ...base.actors[0]!, state: { ...base.actors[0]!.state, health: 0 } }] }
    const authority = createHungerAuthority(dead)
    expect(authority.execute({ ...header('move'), _tag: 'Activity', activity: 'walk', amount: 1 })).toMatchObject({ reason: 'invalid-command' })
    expect(authority.execute({ ...header('respawn'), _tag: 'Respawn' })).toMatchObject({ accepted: true })
    expect(authority.snapshot().actors[0]?.state.health).toBe(20)
  })

  it('rejects eating a food this authority does not recognize, one the actor holds none of, and eating while already full', () => {
    const authority = createHungerAuthority(snapshot())
    expect(authority.execute({ ...header('unknown'), _tag: 'Eat', item: 'diamond' })).toMatchObject({ reason: 'insufficient-items' })
    expect(authority.execute({ ...header('none-held'), _tag: 'Eat', item: 'bread' })).toMatchObject({ reason: 'insufficient-items' })

    const full = snapshot()
    const authorityFull = createHungerAuthority({
      ...full,
      actors: [{ ...full.actors[0]!, state: { ...full.actors[0]!.state, food: 20 } }],
    })
    expect(authorityFull.execute({ ...header('full'), _tag: 'Eat', item: 'apple' })).toMatchObject({ reason: 'cannot-eat' })
  })

  it('advances only the actor named by the command, leaving every other actor in the world untouched', () => {
    const bob = PlayerId.make('bob')
    const base = snapshot()
    const withBob = {
      ...base,
      actors: [
        ...base.actors,
        { player: bob, session: 'bob-one', state: { food: 15, saturation: 1, exhaustion: 0, health: 20 }, food: {} },
      ],
    }
    const authority = createHungerAuthority(withBob)
    authority.execute({ ...header('jump'), _tag: 'Activity', activity: 'jump', amount: 1 })
    expect(authority.snapshot().actors[1]).toStrictEqual(withBob.actors[1])
  })

  it('treats a non-finite or negative elapsed time as a no-op tick', () => {
    const authority = createHungerAuthority(snapshot())
    const before = authority.snapshot()
    expect(authority.tick(Number.NaN)).toStrictEqual([])
    expect(authority.tick(-1)).toStrictEqual([])
    expect(authority.snapshot()).toStrictEqual(before)
  })

  it('regenerates at exactly food 18, the documented threshold, but not at food 17', () => {
    // The default `snapshot()` fixture starts at food 19, which is >= 18 AND >= 19 —
    // it cannot distinguish the correct threshold from an off-by-one on it. Pin the
    // boundary itself: 18 must heal, 17 must not.
    const base = snapshot()
    const atThreshold = createHungerAuthority({
      ...base,
      actors: [{ ...base.actors[0]!, state: { food: 18, saturation: 0, exhaustion: 0, health: 18 } }],
    })
    atThreshold.tick(4000)
    expect(atThreshold.snapshot().actors[0]?.state).toMatchObject({ health: 19, exhaustion: 6 })

    const belowThreshold = createHungerAuthority({
      ...base,
      actors: [{ ...base.actors[0]!, state: { food: 17, saturation: 0, exhaustion: 0, health: 18 } }],
    })
    belowThreshold.tick(4000)
    expect(belowThreshold.snapshot().actors[0]?.state).toMatchObject({ health: 18, exhaustion: 0 })
  })

  it('drains saturation before food, and leaves an already-dead actor unticked', () => {
    const base = snapshot()
    const saturated = createHungerAuthority({
      ...base,
      actors: [{ ...base.actors[0]!, state: { food: 15, saturation: 1, exhaustion: 4, health: 18 } }],
    })
    // The actor already carries a full drain unit (exhaustion 4) before this
    // Tick; the while loop fires once, and saturation (currently 1) is
    // Preferred over food, clamped at 0 rather than going negative.
    saturated.tick(4000)
    expect(saturated.snapshot().actors[0]?.state).toMatchObject({ food: 15, saturation: 0 })

    const dead = createHungerAuthority({
      ...base,
      actors: [{ ...base.actors[0]!, state: { food: 10, saturation: 0, exhaustion: 0, health: 0 } }],
    })
    expect(dead.tick(4000)).toStrictEqual([])
    expect(dead.snapshot().actors[0]?.state).toStrictEqual({ food: 10, saturation: 0, exhaustion: 0, health: 0 })
  })

  it('drains food across more than one exhaustion unit per tick, floored at zero rather than going negative', () => {
    const base = snapshot()
    const starving = createHungerAuthority({
      ...base,
      actors: [{ ...base.actors[0]!, state: { food: 1, saturation: 0, exhaustion: 8, health: 18 } }],
    })
    // Two full drain units (exhaustion 8) with no saturation to spend first:
    // Food loses two units, but only has one to give before the floor clamps
    // The second unit at zero instead of going negative.
    starving.tick(4000)
    expect(starving.snapshot().actors[0]?.state.food).toBe(0)
  })
})

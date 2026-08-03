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
})

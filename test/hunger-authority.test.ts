/* eslint-disable max-statements, no-magic-numbers, no-underscore-dangle, sort-imports, sort-keys */
import { describe, expect, it } from '@effect/vitest'
import * as fc from 'fast-check'
import { DimensionRevisionSchema, ItemIdSchema, SimulationTickSchema } from '@nerima-games/mc-kernel'
import { Schema } from 'effect'
import { createHungerAuthority, type HungerCommand } from '../src/domain/hunger-authority.js'
import { PlayerId } from '../src/domain/protocol.js'

const alice = PlayerId.make('alice')
const TARGET_TICK = Schema.decodeUnknownSync(SimulationTickSchema)(10)
const dimensionRevision = (value: number) => Schema.decodeUnknownSync(DimensionRevisionSchema)(value)
const itemId = (value: number) => Schema.decodeUnknownSync(ItemIdSchema)(value)
const header = (commandId: string, expectedRevision = 2, expectedDimensionRevision = dimensionRevision(1)) => ({
  player: alice,
  session: 'session-one',
  commandId,
  expectedRevision,
  expectedDimensionRevision,
})
const unsupported = { accepted: false, reason: 'authority-boundary-unsupported' } as const
const invalid = { accepted: false, reason: 'invalid-command' } as const

describe('hunger authority boundary', () => {
  it('returns eat commands as mc-sim UseItem network intents', () => {
    const command: HungerCommand = { ...header('eat'), _tag: 'Eat', item: itemId(12) }
    const authority = createHungerAuthority()

    expect('snapshot' in authority).toBe(false)
    expect(authority.execute(command, TARGET_TICK)).toStrictEqual({
      accepted: true,
      intent: {
        id: 'eat',
        targetTick: TARGET_TICK,
        source: 'network',
        payload: { _tag: 'UseItem', actor: alice, item: itemId(12) },
        expectedRevision: 2,
        expectedDimensionRevision: 1,
      },
    })
    expect(command.expectedRevision).toBe(2)
    expect(command.expectedDimensionRevision).toBe(1)
  })

  it('rejects valid activity and respawn commands when C2 has no matching payload', () => {
    const commands: ReadonlyArray<HungerCommand> = [
      { ...header('activity'), _tag: 'Activity', activity: 'jump', amount: 1 },
      { ...header('respawn'), _tag: 'Respawn' },
    ]

    for (const command of commands) {
      expect(createHungerAuthority().execute(command, TARGET_TICK)).toStrictEqual(unsupported)
      expect(command.expectedRevision).toBe(2)
    }
  })

  it('rejects malformed headers, activities, and payload ids', () => {
    const malformed: ReadonlyArray<HungerCommand> = [
      { ...header('', 2), _tag: 'Respawn' },
      { ...header('blank-session', 2), session: '', _tag: 'Respawn' },
      { ...header('negative-revision', -1), _tag: 'Respawn' },
      { ...header('zero-activity'), _tag: 'Activity', activity: 'walk', amount: 0 },
      { ...header('over-boundary'), _tag: 'Activity', activity: 'walk', amount: 101 },
    ]

    for (const command of malformed) {
      expect(createHungerAuthority().execute(command, TARGET_TICK)).toStrictEqual(invalid)
    }

    const authority = createHungerAuthority()
    const negativeDimensionRevision = { ...header('negative-dimension-revision'), expectedDimensionRevision: -1, _tag: 'Respawn' }
    const invalidItem = { ...header('invalid-item'), _tag: 'Eat', item: Number.NaN }
    expect(Reflect.apply(authority.execute, authority, [negativeDimensionRevision, TARGET_TICK])).toStrictEqual(invalid)
    expect(Reflect.apply(authority.execute, authority, [invalidItem, TARGET_TICK])).toStrictEqual(invalid)
  })

  it('rejects invalid target ticks and C2 schema failures', () => {
    const authority = createHungerAuthority()
    const command: HungerCommand = { ...header('target'), _tag: 'Eat', item: itemId(12) }
    const badTick = Reflect.apply(authority.execute, authority, [command, -1])
    const fractionalTick = Reflect.apply(authority.execute, authority, [command, 1.5])
    const badPayload = Reflect.apply(authority.execute, authority, [
      { ...header('bad-item'), _tag: 'Eat', item: -1 },
      TARGET_TICK,
    ])

    expect(badTick).toStrictEqual(invalid)
    expect(fractionalTick).toStrictEqual(invalid)
    expect(badPayload).toStrictEqual(invalid)
  })

  it('rejects activity amounts outside the configured boundary', () => {
    const authority = createHungerAuthority({ maximumActivityAmount: 0 })
    const command: HungerCommand = { ...header('disabled-activity'), _tag: 'Activity', activity: 'walk', amount: 1 }

    expect(authority.execute(command, TARGET_TICK)).toStrictEqual(invalid)
  })

  it('returns typed unsupported for valid time advancement and typed invalid failures outside its domain', () => {
    const authority = createHungerAuthority()

    expect(authority.tick(4000)).toStrictEqual(unsupported)
    expect(authority.tick(Number.NaN)).toStrictEqual({ accepted: false, reason: 'invalid-elapsed-time' })
    expect(authority.tick(-1)).toStrictEqual({ accepted: false, reason: 'invalid-elapsed-time' })
  })

  it('routes generated activity amounts to unsupported or typed invalid failures', () => {
    fc.assert(fc.property(fc.integer({ min: -100, max: 200 }), (amount) => {
      const command: HungerCommand = {
        ...header(`activity-${amount}`),
        _tag: 'Activity',
        activity: 'walk',
        amount,
      }
      expect(createHungerAuthority().execute(command, TARGET_TICK)).toStrictEqual(
        amount > 0 && amount <= 100 ? unsupported : invalid,
      )
    }))
  })

  it('rejects session mutations without retaining session identity locally', () => {
    const authority = createHungerAuthority()

    expect(authority.rejoin(alice, 'old', 'new')).toStrictEqual(unsupported)
    expect(authority.rejoin(alice, '', 'new')).toStrictEqual(invalid)
    expect(authority.disconnect(alice)).toStrictEqual(unsupported)
    expect('snapshot' in authority).toBe(false)
  })
})

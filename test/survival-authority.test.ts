/* eslint-disable max-statements, no-magic-numbers, no-underscore-dangle, sort-imports, sort-keys */
import { describe, expect, it } from '@effect/vitest'
import * as fc from 'fast-check'
import {
  BlockIdSchema,
  DimensionIdSchema,
  DimensionRevisionSchema,
  SimulationTickSchema,
} from '@nerima-games/mc-kernel'
import { Schema } from 'effect'
import { PlayerId } from '../src/domain/protocol.js'
import { SurvivalAuthority, type SurvivalCommand } from '../src/domain/survival-authority.js'

const alice = PlayerId.make('alice')
const bob = PlayerId.make('bob')
const TARGET_TICK = Schema.decodeUnknownSync(SimulationTickSchema)(10)
const dimension = (value: 'overworld' | 'nether' | 'end') => Schema.decodeUnknownSync(DimensionIdSchema)(value)
const dimensionRevision = (value: number) => Schema.decodeUnknownSync(DimensionRevisionSchema)(value)
const blockId = (value: number) => Schema.decodeUnknownSync(BlockIdSchema)(value)
const header = (requestId: string, expectedRevision = 7, expectedDimensionRevision = dimensionRevision(4)) => ({
  actor: alice,
  session: 'session-one',
  requestId,
  expectedRevision,
  expectedDimensionRevision,
})
const unsupported = (requestId: string) => ({
  accepted: false,
  reason: 'authority-boundary-unsupported',
  requestId,
})
const invalid = (requestId: string) => ({ accepted: false, reason: 'invalid-command', requestId })
const blockIntent = (
  command: Extract<SurvivalCommand, { _tag: 'BreakBlock' }>,
  targetTick = TARGET_TICK,
) => ({
  accepted: true,
  intent: {
    id: command.requestId,
    targetTick,
    source: 'network',
    payload: {
      _tag: 'BreakBlock',
      actor: alice,
      address: { dimension: command.dimension, position: command.at },
    },
    expectedRevision: command.expectedRevision,
    expectedDimensionRevision: command.expectedDimensionRevision,
  },
  requestId: command.requestId,
})

describe('survival authority boundary', () => {
  it('returns supported commands as mc-sim C2 network intents', () => {
    const place: SurvivalCommand = {
      ...header('place'),
      _tag: 'PlaceBlock',
      dimension: dimension('overworld'),
      at: { x: 1, y: 64, z: 1 },
      block: blockId(100),
    }
    const breakBlock: SurvivalCommand = {
      ...header('break'),
      _tag: 'BreakBlock',
      dimension: dimension('nether'),
      at: { x: 2, y: 64, z: 0 },
    }
    const leaveSleep: SurvivalCommand = { ...header('wake'), _tag: 'LeaveSleep' }
    const authority = new SurvivalAuthority()

    expect('snapshot' in authority).toBe(false)
    expect(authority.execute(place, TARGET_TICK)).toStrictEqual({
      accepted: true,
      intent: {
        id: 'place',
        targetTick: TARGET_TICK,
        source: 'network',
        payload: {
          _tag: 'PlaceBlock',
          actor: alice,
          address: { dimension: dimension('overworld'), position: place.at },
          block: blockId(100),
        },
        expectedRevision: 7,
        expectedDimensionRevision: 4,
      },
      requestId: 'place',
    })
    expect(authority.execute(breakBlock, TARGET_TICK)).toStrictEqual(blockIntent(breakBlock))
    expect(authority.execute(leaveSleep, TARGET_TICK)).toStrictEqual({
      accepted: true,
      intent: {
        id: 'wake',
        targetTick: TARGET_TICK,
        source: 'network',
        payload: { _tag: 'LeaveSleep', actor: alice },
        expectedRevision: 7,
        expectedDimensionRevision: 4,
      },
      requestId: 'wake',
    })
    expect(place.expectedRevision).toBe(7)
    expect(breakBlock.expectedDimensionRevision).toBe(4)
  })

  it('returns repeated supported commands as the same intent without local mutation', () => {
    const authority = new SurvivalAuthority()
    const command: SurvivalCommand = {
      ...header('replayed'),
      _tag: 'BreakBlock',
      dimension: dimension('overworld'),
      at: { x: 2, y: 64, z: 0 },
    }

    expect(authority.execute(command, TARGET_TICK)).toStrictEqual(blockIntent(command))
    expect(authority.execute(command, TARGET_TICK)).toStrictEqual(blockIntent(command))
    expect(command.expectedRevision).toBe(7)
  })

  it('rejects valid tags whose payloads are not represented by C2', () => {
    const commands: ReadonlyArray<SurvivalCommand> = [
      { ...header('attack'), _tag: 'Attack', target: bob },
      { ...header('respawn'), _tag: 'Respawn' },
      { ...header('sleep'), _tag: 'EnterSleep', bed: { x: 0, y: 64, z: 1 } },
    ]

    for (const command of commands) {
      expect(new SurvivalAuthority().execute(command, TARGET_TICK)).toStrictEqual(unsupported(command.requestId))
    }
  })

  it('rejects malformed headers and command payloads before mapping to C2', () => {
    const malformed: ReadonlyArray<SurvivalCommand> = [
      { ...header(''), _tag: 'Respawn' },
      { ...header('blank-session'), session: '', _tag: 'Respawn' },
      { ...header('negative-revision', -1), _tag: 'Respawn' },
      { ...header('fractional-position'), _tag: 'BreakBlock', dimension: dimension('overworld'), at: { x: 1.5, y: 64, z: 0 } },
      { ...header('fractional-bed'), _tag: 'EnterSleep', bed: { x: 0, y: 64.5, z: 1 } },
    ]

    for (const command of malformed) {
      const inputBefore = { ...command }
      expect(new SurvivalAuthority().execute(command, TARGET_TICK)).toStrictEqual(invalid(command.requestId))
      expect(command).toStrictEqual(inputBefore)
    }

    const authority = new SurvivalAuthority()
    const invalidBlock = {
      ...header('invalid-block'),
      _tag: 'PlaceBlock',
      dimension: dimension('overworld'),
      at: { x: 1, y: 64, z: 1 },
      block: Number.NaN,
    }
    expect(Reflect.apply(authority.execute, authority, [{ ...header('blank-target'), _tag: 'Attack', target: '' }, TARGET_TICK]))
      .toStrictEqual(invalid('blank-target'))
    expect(Reflect.apply(authority.execute, authority, [invalidBlock, TARGET_TICK])).toStrictEqual(invalid('invalid-block'))
  })

  it('rejects invalid target ticks and C2 schema failures', () => {
    const authority = new SurvivalAuthority()
    const command: SurvivalCommand = {
      ...header('target'),
      _tag: 'BreakBlock',
      dimension: dimension('overworld'),
      at: { x: 1, y: 64, z: 0 },
    }
    const badDimension: SurvivalCommand = {
      ...header('bad-dimension'),
      _tag: 'BreakBlock',
      dimension: dimension('overworld'),
      at: { x: 1, y: 64, z: 0 },
    }
    const invalidDimension = { ...badDimension, dimension: 'moon' }
    const badTargetTick = Reflect.apply(authority.execute, authority, [command, -1])
    const fractionalTargetTick = Reflect.apply(authority.execute, authority, [command, 1.5])
    const badDimensionResult = Reflect.apply(authority.execute, authority, [invalidDimension, TARGET_TICK])

    expect(badTargetTick).toStrictEqual(invalid(command.requestId))
    expect(fractionalTargetTick).toStrictEqual(invalid(command.requestId))
    expect(badDimensionResult).toStrictEqual(invalid(badDimension.requestId))
  })

  it('rejects unknown runtime tags from untyped callers', () => {
    const malformed = { ...header('unknown-tag'), _tag: 'UnknownCommand' }

    expect(Reflect.apply(new SurvivalAuthority().execute, new SurvivalAuthority(), [malformed, TARGET_TICK])).toStrictEqual(
      invalid('unknown-tag'),
    )
  })

  it('returns generated valid break commands as C2 intents', () => {
    fc.assert(fc.property(
      fc.nat({ max: 1_000_000 }),
      fc.integer({ min: -1_000, max: 1_000 }),
      fc.integer({ min: -1_000, max: 1_000 }),
      fc.integer({ min: -1_000, max: 1_000 }),
      (revision, x, y, z) => {
        const requestId = `break-${revision}-${x}-${y}-${z}`
        const command: SurvivalCommand = {
          ...header(requestId, revision),
          _tag: 'BreakBlock',
          dimension: dimension('overworld'),
          at: { x, y, z },
        }

        expect(new SurvivalAuthority().execute(command, TARGET_TICK)).toStrictEqual(blockIntent(command))
      },
    ))
  })

  it('rejects generated negative revisions and fractional coordinates', () => {
    fc.assert(fc.property(fc.integer({ min: 1, max: 1_000_000 }), (offset) => {
      const negativeRevision: SurvivalCommand = { ...header(`revision-${offset}`, -offset), _tag: 'Respawn' }
      const negativeDimensionRevision = {
        ...header(`dimension-revision-${offset}`),
        expectedDimensionRevision: -offset,
        _tag: 'Respawn',
      }
      expect(new SurvivalAuthority().execute(negativeRevision, TARGET_TICK)).toStrictEqual(invalid(negativeRevision.requestId))
      expect(Reflect.apply(new SurvivalAuthority().execute, new SurvivalAuthority(), [negativeDimensionRevision, TARGET_TICK]))
        .toStrictEqual(invalid(negativeDimensionRevision.requestId))
    }))
    fc.assert(fc.property(fc.integer({ min: -1_000, max: 1_000 }), (x) => {
      const command: SurvivalCommand = {
        ...header(`fractional-${x}`),
        _tag: 'BreakBlock',
        dimension: dimension('overworld'),
        at: { x: x + 0.5, y: 64, z: 0 },
      }
      expect(new SurvivalAuthority().execute(command, TARGET_TICK)).toStrictEqual(invalid(command.requestId))
    }))
  })

  it('rejects session, disconnect, and sleep reconciliation mutations without local state', () => {
    const authority = new SurvivalAuthority()

    expect(authority.rejoin(alice, 'old', 'new')).toStrictEqual({ accepted: false, reason: 'authority-boundary-unsupported' })
    expect(authority.rejoin(alice, '', 'new')).toStrictEqual({ accepted: false, reason: 'invalid-command' })
    expect(authority.disconnect(alice)).toStrictEqual({ accepted: false, reason: 'authority-boundary-unsupported' })
    expect(authority.reconcileSleep()).toStrictEqual({ accepted: false, reason: 'authority-boundary-unsupported' })
    expect('snapshot' in authority).toBe(false)
  })
})

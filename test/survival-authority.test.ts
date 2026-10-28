/* eslint-disable max-statements, no-magic-numbers, no-underscore-dangle, sort-imports, sort-keys */
import { describe, expect, it } from '@effect/vitest'
import * as fc from 'fast-check'
import { PlayerId } from '../src/domain/protocol.js'
import { SurvivalAuthority, type SurvivalCommand } from '../src/domain/survival-authority.js'

const alice = PlayerId.make('alice')
const bob = PlayerId.make('bob')
const header = (requestId: string, expectedRevision = 7, clientTick = 10) => ({
  actor: alice,
  session: 'session-one',
  requestId,
  expectedRevision,
  clientTick,
})
const unsupported = (requestId: string) => ({ accepted: false, requestId, reason: 'authority-boundary-unsupported' })

describe('survival authority boundary', () => {
  it('rejects every valid mutation before sim work and returns no owner revision or delta', () => {
    const commands: ReadonlyArray<SurvivalCommand> = [
      { ...header('place'), _tag: 'PlaceBlock', at: { x: 1, y: 64, z: 1 }, slot: 0, block: 'stone' },
      { ...header('break'), _tag: 'BreakBlock', at: { x: 2, y: 64, z: 0 } },
      { ...header('attack'), _tag: 'Attack', target: bob },
      { ...header('respawn'), _tag: 'Respawn' },
      { ...header('sleep'), _tag: 'EnterSleep', bed: { x: 0, y: 64, z: 1 } },
      { ...header('wake'), _tag: 'LeaveSleep' },
    ]
    const authority = new SurvivalAuthority()

    expect('snapshot' in authority).toBe(false)
    for (const command of commands) {
      const inputBefore = { ...command }
      const result = authority.execute(command)
      expect(result).toStrictEqual(unsupported(command.requestId))
      expect(command).toStrictEqual(inputBefore)
      expect(command.expectedRevision).toBe(7)
      expect(result).not.toHaveProperty('revision')
      expect(result).not.toHaveProperty('events')
      expect(result).not.toHaveProperty('delta')
    }
  })

  it('does not mark an unsupported request as processed or advance a local revision', () => {
    const authority = new SurvivalAuthority()
    const command = { ...header('replayed'), _tag: 'BreakBlock', at: { x: 2, y: 64, z: 0 } } as const

    expect(authority.execute(command)).toStrictEqual(unsupported('replayed'))
    expect(authority.execute(command)).toStrictEqual(unsupported('replayed'))
    expect(command.expectedRevision).toBe(7)
  })

  it('rejects malformed headers and command payloads before returning the boundary failure', () => {
    const authority = new SurvivalAuthority()
    const malformed: ReadonlyArray<SurvivalCommand> = [
      { ...header(''), _tag: 'Respawn' },
      { ...header('blank-session'), session: '', _tag: 'Respawn' },
      { ...header('negative-revision', -1), _tag: 'Respawn' },
      { ...header('negative-tick', 7, -1), _tag: 'Respawn' },
      { ...header('fractional-position'), _tag: 'BreakBlock', at: { x: 1.5, y: 64, z: 0 } },
      { ...header('negative-slot'), _tag: 'PlaceBlock', at: { x: 1, y: 64, z: 1 }, slot: -1, block: 'stone' },
      { ...header('empty-block'), _tag: 'PlaceBlock', at: { x: 1, y: 64, z: 1 }, slot: 0, block: '' },
    ]

    for (const command of malformed) {
      const inputBefore = { ...command }
      const result = authority.execute(command)
      expect(result).toStrictEqual({
        accepted: false,
        requestId: command.requestId,
        reason: 'invalid-command',
      })
      expect(command).toStrictEqual(inputBefore)
      expect(command.expectedRevision).toBe(inputBefore.expectedRevision)
      expect(result).not.toHaveProperty('revision')
      expect(result).not.toHaveProperty('events')
      expect(result).not.toHaveProperty('delta')
    }
  })

  it('rejects unknown runtime tags from untyped callers', () => {
    const authority = new SurvivalAuthority()
    const malformed = { ...header('unknown-tag'), _tag: 'UnknownCommand' }

    expect(Reflect.apply(authority.execute, authority, [malformed])).toStrictEqual({
      accepted: false,
      requestId: 'unknown-tag',
      reason: 'invalid-command',
    })
  })

  it('accepts fixed zero and negative integer boundaries as valid input without applying them', () => {
    const command: SurvivalCommand = {
      ...header('boundary', 0, 0),
      _tag: 'PlaceBlock',
      at: { x: -1, y: 0, z: 0 },
      slot: 0,
      block: 'stone',
    }

    expect(new SurvivalAuthority().execute(command)).toStrictEqual(unsupported('boundary'))
    expect(command.expectedRevision).toBe(0)
    expect(command.clientTick).toBe(0)
  })

  it('accepts generated integer coordinates and nonnegative headers before the simulation boundary', () => {
    fc.assert(fc.property(
      fc.nat({ max: 1_000_000 }),
      fc.nat({ max: 1_000_000 }),
      fc.integer({ min: -1_000, max: 1_000 }),
      fc.integer({ min: -1_000, max: 1_000 }),
      fc.integer({ min: -1_000, max: 1_000 }),
      (revision, clientTick, x, y, z) => {
        const requestId = `integer-${revision}-${clientTick}-${x}-${y}-${z}`
        const command: SurvivalCommand = {
          ...header(requestId, revision, clientTick),
          _tag: 'PlaceBlock',
          at: { x, y, z },
          slot: 0,
          block: 'stone',
        }

        expect(new SurvivalAuthority().execute(command)).toStrictEqual(unsupported(requestId))
      },
    ))
  })

  it('rejects generated negative revisions, negative ticks, and fractional coordinates', () => {
    fc.assert(fc.property(fc.integer({ min: 1, max: 1_000_000 }), (offset) => {
      expect(new SurvivalAuthority().execute({
        ...header(`revision-${offset}`, -offset),
        _tag: 'Respawn',
      })).toMatchObject({ accepted: false, reason: 'invalid-command' })
      expect(new SurvivalAuthority().execute({
        ...header(`tick-${offset}`, 7, -offset),
        _tag: 'Respawn',
      })).toMatchObject({ accepted: false, reason: 'invalid-command' })
    }))
    fc.assert(fc.property(fc.integer({ min: -1_000, max: 1_000 }), (x) => {
      expect(new SurvivalAuthority().execute({
        ...header(`fractional-${x}`),
        _tag: 'BreakBlock',
        at: { x: x + 0.5, y: 64, z: 0 },
      })).toMatchObject({ accepted: false, reason: 'invalid-command' })
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

/* eslint-disable max-statements, no-magic-numbers, no-underscore-dangle, sort-imports, sort-keys */
import { describe, expect, it } from '@effect/vitest'
import * as fc from 'fast-check'
import { createHungerAuthority, type HungerCommand } from '../src/domain/hunger-authority.js'
import { PlayerId } from '../src/domain/protocol.js'

const alice = PlayerId.make('alice')
const header = (commandId: string, expectedRevision = 2) => ({ player: alice, session: 'session-one', commandId, expectedRevision })
const unsupported = { accepted: false, reason: 'authority-boundary-unsupported' } as const
const invalid = { accepted: false, reason: 'invalid-command' } as const

describe('hunger authority boundary', () => {
  it('rejects every valid mutation before sim work and never returns a local revision or delta', () => {
    const commands: ReadonlyArray<HungerCommand> = [
      { ...header('activity'), _tag: 'Activity', activity: 'jump', amount: 1 },
      { ...header('eat'), _tag: 'Eat', item: 'apple' },
      { ...header('respawn'), _tag: 'Respawn' },
    ]
    const authority = createHungerAuthority()

    expect('snapshot' in authority).toBe(false)
    for (const command of commands) {
      const inputBefore = { ...command }
      const result = authority.execute(command)
      expect(result).toStrictEqual(unsupported)
      expect(command).toStrictEqual(inputBefore)
      expect(command.expectedRevision).toBe(2)
      expect(result).not.toHaveProperty('revision')
      expect(result).not.toHaveProperty('events')
      expect(result).not.toHaveProperty('delta')
    }
  })

  it('does not record an unsupported request as a processed duplicate', () => {
    const authority = createHungerAuthority()
    const command = { ...header('same-request'), _tag: 'Activity', activity: 'walk', amount: 1 } as const

    expect(authority.execute(command)).toStrictEqual(unsupported)
    expect(authority.execute(command)).toStrictEqual(unsupported)
    expect(command.expectedRevision).toBe(2)
  })

  it('rejects malformed headers, activities, and food inputs without changing them', () => {
    const authority = createHungerAuthority()
    const malformed: ReadonlyArray<HungerCommand> = [
      { ...header('', 2), _tag: 'Respawn' },
      { ...header('blank-session', 2), session: '', _tag: 'Respawn' },
      { ...header('negative-revision', -1), _tag: 'Respawn' },
      { ...header('zero-activity'), _tag: 'Activity', activity: 'walk', amount: 0 },
      { ...header('over-boundary'), _tag: 'Activity', activity: 'walk', amount: 101 },
      { ...header('blank-food'), _tag: 'Eat', item: '' },
    ]

    for (const command of malformed) {
      const inputBefore = { ...command }
      const result = authority.execute(command)
      expect(result).toStrictEqual(invalid)
      expect(command).toStrictEqual(inputBefore)
      expect(command.expectedRevision).toBe(inputBefore.expectedRevision)
      expect(result).not.toHaveProperty('revision')
      expect(result).not.toHaveProperty('events')
      expect(result).not.toHaveProperty('delta')
    }
  })

  it('accepts the fixed activity boundary as syntactically valid, then returns unsupported', () => {
    const command = { ...header('at-limit'), _tag: 'Activity', activity: 'walk', amount: 100 } as const

    expect(createHungerAuthority().execute(command)).toStrictEqual(unsupported)
    expect(command.expectedRevision).toBe(2)
  })

  it('returns typed unsupported for valid time advancement and typed invalid failure outside its domain', () => {
    const authority = createHungerAuthority()

    expect(authority.tick(4000)).toStrictEqual(unsupported)
    expect(authority.tick(Number.NaN)).toStrictEqual({ accepted: false, reason: 'invalid-elapsed-time' })
    expect(authority.tick(-1)).toStrictEqual({ accepted: false, reason: 'invalid-elapsed-time' })
  })

  it('routes generated activity amounts through validation or the typed authority boundary', () => {
    fc.assert(fc.property(fc.integer({ min: -100, max: 200 }), (amount) => {
      const result = createHungerAuthority().execute({
        ...header(`activity-${amount}`),
        _tag: 'Activity',
        activity: 'walk',
        amount,
      })

      expect(result).toStrictEqual(amount > 0 && amount <= 100 ? unsupported : invalid)
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

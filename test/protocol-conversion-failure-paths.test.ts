import { describe, expect, it } from '@effect/vitest'
import { Result } from 'effect'
import { afterEach, vi } from 'vitest'
import { brewingStateFromWire } from '../src/domain/protocol/brewing-conversion.js'
import { furnaceStateFromWire } from '../src/domain/protocol/furnace-conversion.js'

const controls = vi.hoisted(() => ({ rejectBrewing: false, rejectFurnace: false }))

vi.mock('@nerima-games/mc-sim', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nerima-games/mc-sim')>()
  const { Schema } = await import('effect')
  return {
    ...actual,
    validateBrewingSnapshot: vi.fn((value: unknown): ReturnType<typeof actual.validateBrewingSnapshot> =>
      controls.rejectBrewing
        ? { _tag: 'Invalid', error: { _tag: 'BrewingValidationFailure', path: 'state', reason: 'dependency rejected snapshot' } }
        : actual.validateBrewingSnapshot(value),
    ),
    FurnaceStateSchema: actual.FurnaceStateSchema.check(Schema.makeFilter(() => !controls.rejectFurnace)),
  }
})

afterEach(() => {
  controls.rejectBrewing = false
  controls.rejectFurnace = false
})

describe('state conversion validation failures', () => {
  it('propagates a brewing validator refusal as invalid-state without replacing it with an empty stand', () => {
    const wire = { bottles: [null, null, null], ingredient: null, fuel: null, fuelCharges: 7, brewProgressSecs: 3.5 }
    expect(Result.isSuccess(brewingStateFromWire(wire))).toBe(true)
    controls.rejectBrewing = true
    expect(brewingStateFromWire(wire)).toStrictEqual(Result.fail({
      _tag: 'BrewingWireConversionFailure', path: 'state', reason: 'invalid-state',
    }))
  })

  it('propagates a furnace schema refusal as invalid-state without replacing the burn state', () => {
    const wire = {
      furnaceId: 'furnace:1', station: 'smoker', input: null, fuel: null, output: null,
      burnTicksRemaining: 5, burnTicksTotal: 20, cookTicks: 3,
    }
    expect(Result.isSuccess(furnaceStateFromWire(wire))).toBe(true)
    controls.rejectFurnace = true
    expect(furnaceStateFromWire(wire)).toStrictEqual(Result.fail({
      _tag: 'FurnaceWireConversionFailure', path: 'state', reason: 'invalid-state',
    }))
  })
})

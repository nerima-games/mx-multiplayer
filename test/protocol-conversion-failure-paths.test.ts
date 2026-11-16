import { describe, expect, it } from '@effect/vitest'
import { Result } from 'effect'
import { afterEach, vi } from 'vitest'
import { brewingState, furnaceState } from '@nerima-games/mc-sim'
import { itemStackFromUnknown } from '@nerima-games/mc-kernel'
import { brewingStateFromWire, brewingStateToWire } from '../src/domain/protocol/brewing-conversion.js'
import { furnaceStateFromWire, furnaceStateToWire } from '../src/domain/protocol/furnace-conversion.js'

const controls = vi.hoisted(() => ({
  rejectBrewing: false, rejectFurnace: false, rejectComponents: false, rejectStack: false,
  defaultsRequested: false, rejectTickBrand: false, rejectTickSeconds: false, rejectBrewingWire: false,
}))

vi.mock('@nerima-games/mc-kernel', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nerima-games/mc-kernel')>()
  const { Result: EffectResult } = await import('effect')
  return {
    ...actual,
    itemComponents: (...args: Parameters<typeof actual.itemComponents>): ReturnType<typeof actual.itemComponents> => {
      if (controls.rejectComponents) {
        return EffectResult.fail(actual.itemValidationFailure('components', 'dependency rejected components'))
      }
      // Arm stack refusal after domain validation, when the converter requests defaults.
      controls.defaultsRequested = true
      return actual.itemComponents(...args)
    },
    itemStack: (...args: Parameters<typeof actual.itemStack>): ReturnType<typeof actual.itemStack> =>
      controls.rejectStack && controls.defaultsRequested
        ? EffectResult.fail(actual.itemValidationFailure('stack', 'dependency rejected stack'))
        : actual.itemStack(...args),
    NonNegativeTickCount: Object.assign(
      (...args: Parameters<typeof actual.NonNegativeTickCount>) => actual.NonNegativeTickCount(...args),
      actual.NonNegativeTickCount,
      { result: (...args: Parameters<typeof actual.NonNegativeTickCount.result>) =>
        controls.rejectTickBrand ? actual.NonNegativeTickCount.result(-1) : actual.NonNegativeTickCount.result(...args) },
    ),
    secondsForTicks: (...args: Parameters<typeof actual.secondsForTicks>): ReturnType<typeof actual.secondsForTicks> =>
      controls.rejectTickSeconds ? EffectResult.fail({ _tag: 'TimeOverflow' }) : actual.secondsForTicks(...args),
  }
})

vi.mock('../src/domain/protocol/brewing.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/domain/protocol/brewing.js')>()
  const { Schema } = await import('effect')
  return {
    ...actual,
    BrewingStandState: actual.BrewingStandState.check(Schema.makeFilter(() => !controls.rejectBrewingWire)),
  }
})

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
  controls.rejectComponents = false
  controls.rejectStack = false
  controls.defaultsRequested = false
  controls.rejectTickBrand = false
  controls.rejectTickSeconds = false
  controls.rejectBrewingWire = false
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

  for (const dependency of ['rejectComponents', 'rejectStack'] as const) {
    it(`returns slot-specific invalid-stack failures when ${dependency} refuses encoding`, () => {
      const stack = Result.getOrThrow(itemStackFromUnknown('stone', 1))
      const brewing = Result.getOrThrow(brewingState({ ingredient: stack }))
      const furnace = Result.getOrThrow(furnaceState({ output: stack }))
      expect(Result.isSuccess(brewingStateToWire(brewing))).toBe(true)
      expect(Result.isSuccess(furnaceStateToWire(furnace, 'furnace:1'))).toBe(true)
      controls.defaultsRequested = false
      controls[dependency] = true
      expect(brewingStateToWire(brewing)).toStrictEqual(Result.fail({
        _tag: 'BrewingWireConversionFailure', path: 'ingredient', reason: 'invalid-stack',
      }))
      expect(furnaceStateToWire(furnace, 'furnace:1')).toStrictEqual(Result.fail({
        _tag: 'FurnaceWireConversionFailure', path: 'output', reason: 'invalid-stack',
      }))
    })
  }

  for (const dependency of ['rejectTickBrand', 'rejectTickSeconds'] as const) {
    it(`returns invalid-wire when ${dependency} refuses a valid tick value`, () => {
      const wire = {
        furnaceId: 'furnace:1', station: 'smoker', input: null, fuel: null, output: null,
        burnTicksRemaining: 5, burnTicksTotal: 20, cookTicks: 3,
      }
      expect(Result.isSuccess(furnaceStateFromWire(wire))).toBe(true)
      controls[dependency] = true
      expect(furnaceStateFromWire(wire)).toStrictEqual(Result.fail({
        _tag: 'FurnaceWireConversionFailure', path: 'state', reason: 'invalid-wire',
      }))
    })
  }

  it('returns invalid-state if the final brewing wire schema rejects the validated state', () => {
    const state = Result.getOrThrow(brewingState())
    expect(Result.isSuccess(brewingStateToWire(state))).toBe(true)
    controls.rejectBrewingWire = true
    expect(brewingStateToWire(state)).toStrictEqual(Result.fail({
      _tag: 'BrewingWireConversionFailure', path: 'state', reason: 'invalid-state',
    }))
  })

  it('returns invalid-state when the furnace ID cannot be represented on the wire', () => {
    const state = Result.getOrThrow(furnaceState())
    expect(Result.isSuccess(furnaceStateToWire(state, 'furnace:1'))).toBe(true)
    expect(furnaceStateToWire(state, '')).toStrictEqual(Result.fail({
      _tag: 'FurnaceWireConversionFailure', path: 'state', reason: 'invalid-state',
    }))
  })
})

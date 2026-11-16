import { describe, expect, it } from '@effect/vitest'
import { Result } from 'effect'
import { afterEach, vi } from 'vitest'
import { brewingState, furnaceState } from '@nerima-games/mc-sim'
import { FixedDurationSecs, itemStackFromUnknown, RecipeExperience, RecipeId } from '@nerima-games/mc-kernel'
import { brewingStateFromWire, brewingStateToWire } from '../src/domain/protocol/brewing-conversion.js'
import { furnaceStateFromWire, furnaceStateToWire } from '../src/domain/protocol/furnace-conversion.js'

const controls = vi.hoisted(() => ({
  rejectBrewing: false, rejectFurnace: false, rejectComponents: false, rejectStack: false,
  defaultsRequested: false, rejectTickBrand: false, rejectTickSeconds: false, rejectBrewingWire: false,
  tickBrandCalls: 0, rejectTickBrandAt: 0, tickSecondsCalls: 0, rejectTickSecondsAt: 0, invalidMatchedDuration: false,
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
      { result: (...args: Parameters<typeof actual.NonNegativeTickCount.result>) => {
        controls.tickBrandCalls += 1
        return controls.rejectTickBrand || controls.tickBrandCalls === controls.rejectTickBrandAt
          ? actual.NonNegativeTickCount.result(-1) : actual.NonNegativeTickCount.result(...args)
      } },
    ),
    secondsForTicks: (...args: Parameters<typeof actual.secondsForTicks>): ReturnType<typeof actual.secondsForTicks> => {
      controls.tickSecondsCalls += 1
      return controls.rejectTickSeconds || controls.tickSecondsCalls === controls.rejectTickSecondsAt
        ? EffectResult.fail({ _tag: 'TimeOverflow' }) : actual.secondsForTicks(...args)
    },
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
  const { Schema, Result: EffectResult } = await import('effect')
  const kernel = await import('@nerima-games/mc-kernel')
  return {
    ...actual,
    validateBrewingSnapshot: vi.fn((value: unknown): ReturnType<typeof actual.validateBrewingSnapshot> =>
      controls.rejectBrewing
        ? { _tag: 'Invalid', error: { _tag: 'BrewingValidationFailure', path: 'state', reason: 'dependency rejected snapshot' } }
        : actual.validateBrewingSnapshot(value),
    ),
    FurnaceStateSchema: actual.FurnaceStateSchema.check(Schema.makeFilter(() => !controls.rejectFurnace)),
    matchSmeltingRecipe: (...args: Parameters<typeof actual.matchSmeltingRecipe>): ReturnType<typeof actual.matchSmeltingRecipe> =>
      controls.invalidMatchedDuration ? EffectResult.succeed({
        id: 'test:dependency-invalid-duration', input: 'stone',
        output: EffectResult.getOrThrow(kernel.itemStackFromUnknown('glass', 1)), cookDurationSecs: NaN,
      }) : actual.matchSmeltingRecipe(...args),
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
  controls.tickBrandCalls = 0
  controls.rejectTickBrandAt = 0
  controls.tickSecondsCalls = 0
  controls.rejectTickSecondsAt = 0
  controls.invalidMatchedDuration = false
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

  it('returns a recipe failure when matching returns a starter recipe with invalid duration', () => {
    const state = Result.getOrThrow(furnaceState({ input: Result.getOrThrow(itemStackFromUnknown('stone', 1)) }))
    const recipe = { id: 'test:starter', input: 'stone' as const, output: Result.getOrThrow(itemStackFromUnknown('glass', 1)), cookDurationSecs: 1 }
    expect(Result.isSuccess(furnaceStateToWire(state, 'furnace:1', [recipe]))).toBe(true)
    controls.invalidMatchedDuration = true
    expect(furnaceStateToWire(state, 'furnace:1', [recipe])).toStrictEqual(Result.fail({
      _tag: 'FurnaceWireConversionFailure', path: 'recipes', reason: 'invalid-state',
    }))
  })

  for (const refusal of [
    { dependency: 'brand', call: 4 }, { dependency: 'brand', call: 5 },
    { dependency: 'seconds', call: 1 }, { dependency: 'seconds', call: 2 },
  ]) {
    it(`returns a recipe failure when the ${refusal.dependency} dependency refuses cap calculation call ${refusal.call}`, () => {
      const duration = Result.getOrThrow(FixedDurationSecs.result(0.15000000000000002))
      const recipe = {
        _tag: 'Smelting' as const, id: Result.getOrThrow(RecipeId.result('test:cap-failure')),
        input: 'stone' as const, output: Result.getOrThrow(itemStackFromUnknown('glass', 1)),
        cookTimeSecs: duration, cookTimeSecsByStation: { furnace: duration },
        experience: Result.getOrThrow(RecipeExperience.result(0)), stations: ['furnace' as const],
      }
      const state = Result.getOrThrow(furnaceState({ input: Result.getOrThrow(itemStackFromUnknown('stone', 1)), cookProgressSecs: 0.149 }))
      expect(Result.isSuccess(furnaceStateToWire(state, 'furnace:1', [recipe]))).toBe(true)
      controls.tickBrandCalls = 0
      controls.tickSecondsCalls = 0
      if (refusal.dependency === 'brand') {
        controls.rejectTickBrandAt = refusal.call
      } else {
        controls.rejectTickSecondsAt = refusal.call
      }
      expect(furnaceStateToWire(state, 'furnace:1', [recipe])).toStrictEqual(Result.fail({
        _tag: 'FurnaceWireConversionFailure', path: 'recipes', reason: 'invalid-state',
      }))
    })
  }
})

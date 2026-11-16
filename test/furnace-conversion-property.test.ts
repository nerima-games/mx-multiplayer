import { describe, expect, it } from '@effect/vitest'
import * as fc from 'fast-check'
import { deepStrictEqual } from 'node:assert/strict'
import {
  COOKING_STATIONS, FixedDurationSecs, itemStackFromUnknown, NonNegativeTickCount, type SmeltingRecipe,
} from '@nerima-games/mc-kernel'
import { furnaceState, VANILLA_SMELTING_RECIPES } from '@nerima-games/mc-sim'
import { Result, Schema } from 'effect'
import { furnaceStateFromWire, furnaceStateToWire, FurnaceStateWire, FurnaceWireConversionFailure } from '../src/index.js'

const durationArbitrary = fc.double({ min: Number.MIN_VALUE, noNaN: true, noDefaultInfinity: true })
const progressArbitrary = fc.double({ min: 0, noNaN: true, noDefaultInfinity: true })
const recipeArbitrary = fc.constantFrom(...COOKING_STATIONS).chain((station) =>
  fc.constantFrom(...VANILLA_SMELTING_RECIPES.filter((recipe) => recipe.stations.includes(station)))
    .map((recipe) => ({ station, recipe })),
)

const immediatelyBefore = (value: number): number => {
  const bits = new DataView(new ArrayBuffer(8))
  bits.setFloat64(0, value)
  bits.setBigUint64(0, bits.getBigUint64(0) - 1n)
  return bits.getFloat64(0)
}

const checkScalarConversion = (
  station: typeof COOKING_STATIONS[number],
  original: SmeltingRecipe,
  duration: number,
  progress: number,
): boolean => {
  const seconds = Result.getOrThrow(FixedDurationSecs.result(duration))
  const recipe = { ...original, cookTimeSecs: seconds, cookTimeSecsByStation: { ...original.cookTimeSecsByStation, [station]: seconds } }
  const state = Result.getOrThrow(furnaceState({
    station, input: Result.getOrThrow(itemStackFromUnknown(original.input, 1)), cookProgressSecs: progress,
  }))
  const encoded = furnaceStateToWire(state, 'furnace:property', [recipe])
  if (progress >= duration) {
    expect(encoded).toMatchObject({ _tag: 'Failure', failure: { reason: 'invalid-state' } })
  }
  if (progress < duration && Result.isSuccess(NonNegativeTickCount.result(Math.round(progress * 20)))) {
    expect(Result.isSuccess(encoded)).toBe(true)
  }
  if (Result.isFailure(encoded)) {
    expect(Schema.is(FurnaceWireConversionFailure)(encoded.failure)).toBe(true)
    expect(encoded.failure.reason).toBe('invalid-state')
    return false
  }
  expect(Schema.is(FurnaceStateWire)(encoded.success)).toBe(true)
  const restored = Result.getOrThrow(furnaceStateFromWire(encoded.success))
  expect(restored.cookProgressSecs).toBeLessThan(duration)
  const durationTicks = duration * 20
  if (Number.isSafeInteger(durationTicks) && durationTicks > 0) {
    expect(encoded.success.cookTicks).toBeLessThanOrEqual(durationTicks - 1)
  }
  deepStrictEqual(Result.getOrThrow(furnaceStateToWire(restored, 'furnace:property', [recipe])), encoded.success)
  return true
}

describe('furnace conversion scalar properties', () => {
  it('keeps generated station recipes and every finite nonnegative progress typed and stable', () => {
    let successful = 0
    fc.assert(fc.property(recipeArbitrary, durationArbitrary, progressArbitrary, ({ station, recipe }, duration, progress) => {
      if (checkScalarConversion(station, recipe, duration, progress)) {
        successful += 1
      }
    }), { seed: 0x51c0ffee, numRuns: 100 })
    expect(successful).toBeGreaterThan(0)
  })

  it('keeps the representable progress immediately before every positive finite duration below completion', () => {
    let successful = 0
    fc.assert(fc.property(recipeArbitrary, durationArbitrary, ({ station, recipe }, duration) => {
      const progress = immediatelyBefore(duration)
      expect(progress).toBeGreaterThanOrEqual(0)
      expect(progress).toBeLessThan(duration)
      if (checkScalarConversion(station, recipe, duration, progress)) {
        successful += 1
      }
    }), { seed: 0x51c0ffee, numRuns: 100 })
    expect(successful).toBeGreaterThan(0)
  })
})

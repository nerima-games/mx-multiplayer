import { describe, expect, it } from '@effect/vitest'
import * as fc from 'fast-check'
import { deepStrictEqual, strictEqual } from 'node:assert/strict'
import {
  FixedDurationSecs, itemStackFromUnknown, NonNegativeTickCount, RecipeExperience, RecipeId,
  secondsForTicks, smeltingCookTimeForStation, type CookingStation, type SmeltingRecipe,
} from '@nerima-games/mc-kernel'
import {
  advanceFurnace, advanceFurnaceTicks, furnaceState, VANILLA_SMELTING_RECIPES,
  type FurnaceState, type SmeltingRecipeInput,
} from '@nerima-games/mc-sim'
import { Result } from 'effect'
import { furnaceStateFromWire, furnaceStateToWire } from '../src/index.js'

type Step = { readonly kind: 'ticks' } | { readonly kind: 'seconds'; readonly seconds: number }
const steps: readonly [Step, Step, Step, Step] = [
  { kind: 'ticks' }, { kind: 'seconds', seconds: 1 / 60 },
  { kind: 'seconds', seconds: 1 / 144 }, { kind: 'seconds', seconds: 0.033 },
]
const oneTick = Result.getOrThrow(NonNegativeTickCount.result(1))
const tickSeconds = Result.getOrThrow(secondsForTicks(oneTick))
const stepSeconds = (step: Step): number => step.kind === 'ticks' ? tickSeconds : step.seconds
const advance = (state: FurnaceState, step: Step, recipes: ReadonlyArray<SmeltingRecipeInput>) =>
  step.kind === 'ticks' ? advanceFurnaceTicks(state, oneTick, recipes) : advanceFurnace(state, step.seconds, recipes)

const runTwoSmelts = (
  station: CookingStation,
  recipe: SmeltingRecipe,
  recipeTable: ReadonlyArray<SmeltingRecipeInput>,
  sequence: readonly [Step, Step, Step],
  phase: number,
  phaseCount: number,
): void => {
  let state = Result.getOrThrow(furnaceState({
    station,
    input: Result.getOrThrow(itemStackFromUnknown(recipe.input, 4)),
    fuel: Result.getOrThrow(itemStackFromUnknown('coal', 64)),
  }))
  const duration = Result.getOrThrow(smeltingCookTimeForStation(recipe, station))
  const maxSteps = Math.ceil(3 * duration / Math.min(...sequence.map(stepSeconds))) + 3
  let smelted = 0
  let observed = 0
  let checked = 0
  for (let index = 0; index < maxSteps && smelted < 2; index += 1) {
    const step = index % 3 === 0 ? sequence[0] : index % 3 === 1 ? sequence[1] : sequence[2]
    if (index % phaseCount === phase) {
      const wire = Result.getOrThrow(furnaceStateToWire(state, 'furnace:simulation', recipeTable))
      const restored = Result.getOrThrow(furnaceStateFromWire(wire))
      strictEqual(Result.isSuccess(advance(restored, step, recipeTable)), true)
      deepStrictEqual(Result.getOrThrow(furnaceStateToWire(restored, 'furnace:simulation', recipeTable)), wire)
      checked += 1
    }
    const outcome = Result.getOrThrow(advance(state, step, recipeTable))
    smelted += outcome.smeltedCount
    observed += 1
    // Collect finished output to leave room for recipes with a single-item stack limit.
    state = outcome.smeltedCount > 0 ? { ...outcome.state, output: undefined } : outcome.state
  }
  expect(observed).toBeGreaterThan(0)
  expect(checked).toBeGreaterThan(0)
  expect(smelted).toBeGreaterThanOrEqual(2)
  expect(state.fuelTimeRemainingSecs).toBeGreaterThan(0)
  const wire = Result.getOrThrow(furnaceStateToWire(state, 'furnace:simulation', recipeTable))
  expect(Result.isSuccess(advance(Result.getOrThrow(furnaceStateFromWire(wire)), sequence[0], recipeTable))).toBe(true)
}

const customRecipe = (station: CookingStation, duration: number): SmeltingRecipe => {
  const seconds = Result.getOrThrow(FixedDurationSecs.result(duration))
  return {
    _tag: 'Smelting', id: Result.getOrThrow(RecipeId.result('test:custom-cook-time')),
    input: 'stone', output: Result.getOrThrow(itemStackFromUnknown('glass', 1)),
    cookTimeSecs: seconds, cookTimeSecsByStation: { [station]: seconds },
    experience: Result.getOrThrow(RecipeExperience.result(0)), stations: [station],
  }
}

describe('furnace wire states advanced by the real simulation', () => {
  for (const station of ['furnace', 'blast_furnace', 'smoker'] as const) {
    const supported = VANILLA_SMELTING_RECIPES.filter((recipe) => recipe.stations.includes(station))
    const regressionRecipe = supported.find((recipe) => recipe.input === (station === 'smoker' ? 'beef' : 'raw_iron'))
    if (regressionRecipe === undefined) {
      throw new Error(`missing regression recipe for ${station}`)
    }
    // Every phase advances the same native trace; together they check every step once.
    for (const phase of [0, 1, 2, 3]) {
      for (const step of steps) {
        it(`keeps ${station} restorable through two smelts with ${step.kind === 'ticks' ? 'one tick' : step.seconds + ' seconds'} steps (phase ${phase})`, () => {
          runTwoSmelts(station, regressionRecipe, VANILLA_SMELTING_RECIPES, [step, step, step], phase, 4)
        })
      }

      it(`keeps generated ${station} recipes and frame sequences restorable through two smelts (phase ${phase})`, () => {
        fc.assert(fc.property(fc.constantFrom(...supported), fc.tuple(fc.constantFrom(...steps), fc.constantFrom(...steps), fc.constantFrom(...steps)), (recipe, sequence) => {
          runTwoSmelts(station, recipe, VANILLA_SMELTING_RECIPES, sequence, phase, 4)
        }), { seed: 0x51c0ffee, numRuns: 4 })
      })
    }

    it(`uses supplied non-tick cooking durations for ${station}`, () => {
      fc.assert(fc.property(fc.constantFrom(0.075, 0.117, 0.15000000000000002, 1.013), fc.tuple(fc.constantFrom(...steps), fc.constantFrom(...steps), fc.constantFrom(...steps)), (duration, sequence) => {
        const recipe = customRecipe(station, duration)
        runTwoSmelts(station, recipe, [recipe], sequence, 0, 1)
      }), { seed: 0x51c0ffee, numRuns: 4 })
    })
  }

  it('caps against the supplied recipe duration instead of the vanilla table', () => {
    const recipe = customRecipe('furnace', 0.117)
    const state = Result.getOrThrow(furnaceState({
      input: Result.getOrThrow(itemStackFromUnknown('stone', 4)),
      fuel: Result.getOrThrow(itemStackFromUnknown('coal', 1)), cookProgressSecs: 0.116,
    }))
    expect(Result.getOrThrow(furnaceStateToWire(state, 'furnace:custom', [recipe])).cookTicks).toBe(2)
    const shortRecipe = customRecipe('furnace', 0.075)
    const shortState = Result.getOrThrow(furnaceState({ ...state, cookProgressSecs: 0.074 }))
    expect(Result.getOrThrow(furnaceStateToWire(shortState, 'furnace:custom', [shortRecipe])).cookTicks).toBe(1)
    const exactRecipe = customRecipe('furnace', 0.15000000000000002)
    const exactState = Result.getOrThrow(furnaceState({ ...state, cookProgressSecs: 0.149 }))
    expect(Result.getOrThrow(furnaceStateToWire(exactState, 'furnace:custom', [exactRecipe])).cookTicks).toBe(2)
  })

  it('supports the same starter recipe table accepted by the simulation', () => {
    const recipe = { id: 'test:starter', input: 'sand' as const, output: Result.getOrThrow(itemStackFromUnknown('glass', 1)), cookDurationSecs: 0.117 }
    const state = Result.getOrThrow(furnaceState({
      input: Result.getOrThrow(itemStackFromUnknown('sand', 4)),
      fuel: Result.getOrThrow(itemStackFromUnknown('coal', 1)), cookProgressSecs: 0.116,
    }))
    const wire = Result.getOrThrow(furnaceStateToWire(state, 'furnace:starter', [recipe]))
    expect(wire.cookTicks).toBe(2)
    expect(Result.isSuccess(advanceFurnaceTicks(Result.getOrThrow(furnaceStateFromWire(wire)), oneTick, [recipe]))).toBe(true)
  })

  it('returns typed failures for completed progress and unusable recipe durations', () => {
    const recipe = customRecipe('furnace', 0.117)
    const state = Result.getOrThrow(furnaceState({
      input: Result.getOrThrow(itemStackFromUnknown('stone', 4)),
      fuel: Result.getOrThrow(itemStackFromUnknown('coal', 1)), cookProgressSecs: 0.117,
    }))
    expect(furnaceStateToWire(state, 'furnace:custom', [recipe])).toMatchObject({
      _tag: 'Failure', failure: { path: 'cookProgressSecs', reason: 'invalid-state' },
    })
    const unstarted = Result.getOrThrow(furnaceState({ ...state, cookProgressSecs: 0 }))
    for (const invalidRecipe of [
      { ...recipe, cookTimeSecsByStation: {} },
      customRecipe('furnace', 0),
    ]) {
      expect(furnaceStateToWire(unstarted, 'furnace:custom', [invalidRecipe])).toMatchObject({
        _tag: 'Failure', failure: { path: 'recipes', reason: 'invalid-state' },
      })
    }
    const hugeRecipe = customRecipe('furnace', Number.MAX_VALUE)
    const hugeWire = Result.getOrThrow(furnaceStateToWire(unstarted, 'furnace:custom', [hugeRecipe]))
    expect(hugeWire.cookTicks).toBe(0)
    expect(Result.isSuccess(advanceFurnaceTicks(Result.getOrThrow(furnaceStateFromWire(hugeWire)), oneTick, [hugeRecipe]))).toBe(true)
  })
})

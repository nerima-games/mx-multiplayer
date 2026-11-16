import { describe, expect, it } from '@effect/vitest'
import * as fc from 'fast-check'
import { ITEM_TYPES, itemStackFromUnknown, maxStackCountForItem, type ItemSlot } from '@nerima-games/mc-kernel'
import { brewingState, BrewingStateSchema, FurnaceStateSchema } from '@nerima-games/mc-sim'
import { Result, Schema } from 'effect'
import {
  brewingStateFromWire,
  brewingStateToWire,
  furnaceStateFromWire,
  BrewingWireConversionFailure,
  FurnaceWireConversionFailure,
} from '../src/index.js'

const stackArbitrary = fc.constantFrom(...ITEM_TYPES).chain((item) =>
  fc.integer({ min: 1, max: maxStackCountForItem(item) }).map((count) =>
    Result.getOrThrow(itemStackFromUnknown(item, count)),
  ),
)
const slotArbitrary = fc.option(stackArbitrary, { nil: undefined })
const stateArbitrary = fc.record({
  bottles: fc.tuple(slotArbitrary, slotArbitrary, slotArbitrary),
  ingredient: slotArbitrary,
  fuel: slotArbitrary,
  fuelCharges: fc.integer({ min: 0, max: 20 }),
  brewProgressSecs: fc.double({ min: 0, max: 20, maxExcluded: true, noNaN: true }),
}).map((state) => Result.getOrThrow(brewingState(state)))
const wireSlot = (slot: ItemSlot) =>
  slot === undefined ? null : { count: slot.count, item: slot.item }
const emptyBrewingWire = {
  bottles: [null, null, null], ingredient: null, fuel: null, fuelCharges: 0, brewProgressSecs: 0,
}
const emptyFurnaceWire = {
  furnaceId: 'furnace:1', station: 'furnace', input: null, fuel: null, output: null,
  burnTicksRemaining: 0, burnTicksTotal: 0, cookTicks: 0,
}

describe('protocol state conversion', () => {
  it('preserves every brewing slot, count, charge and fractional second with default components', () => {
    fc.assert(fc.property(stateArbitrary, (state) => {
      const wire = brewingStateToWire(state)
      expect(wire).toStrictEqual({
        bottles: state.bottles.map(wireSlot), ingredient: wireSlot(state.ingredient), fuel: wireSlot(state.fuel),
        fuelCharges: state.fuelCharges, brewProgressSecs: state.brewProgressSecs,
      })
      const restored = brewingStateFromWire(wire)
      expect(Result.isSuccess(restored)).toBe(true)
      if (Result.isSuccess(restored)) {
        expect(restored.success).toStrictEqual(state)
      }
    }), { seed: 0x51c0ffee, numRuns: 100 })
  })

  it('preserves all furnace stations, stacks and tick values when converting ticks to seconds', () => {
    fc.assert(fc.property(
      fc.constantFrom('furnace', 'blast_furnace', 'smoker'),
      fc.tuple(slotArbitrary, slotArbitrary, slotArbitrary),
      fc.nat({ max: Number.MAX_SAFE_INTEGER }),
      fc.nat({ max: Number.MAX_SAFE_INTEGER }),
      fc.nat({ max: Number.MAX_SAFE_INTEGER }),
      (station, [input, fuel, output], first, second, cookTicks) => {
        const burnTicksRemaining = Math.min(first, second)
        const burnTicksTotal = Math.max(first, second)
        const result = furnaceStateFromWire({
          ...emptyFurnaceWire, station, input: wireSlot(input), fuel: wireSlot(fuel), output: wireSlot(output),
          burnTicksRemaining, burnTicksTotal, cookTicks,
        })
        expect(Result.isSuccess(result)).toBe(true)
        if (Result.isSuccess(result)) {
          expect(result.success).toStrictEqual({
            station, input, fuel, output, fuelTimeRemainingSecs: burnTicksRemaining / 20,
            fuelTimeTotalSecs: burnTicksTotal / 20, cookProgressSecs: cookTicks / 20,
          })
        }
      },
    ), { seed: 0x51c0ffee, numRuns: 100 })
  })

  it('returns typed failures rather than discarding durability in each slot', () => {
    const stack = { item: 'stone', count: 1, durability: { current: 1, max: 2 } }
    for (const wire of [
      { ...emptyBrewingWire, bottles: [stack, null, null] },
      { ...emptyBrewingWire, bottles: [null, stack, null] },
      { ...emptyBrewingWire, bottles: [null, null, stack] },
      { ...emptyBrewingWire, ingredient: stack },
      { ...emptyBrewingWire, fuel: stack },
    ]) {
      expect(brewingStateFromWire(wire)).toMatchObject({
        _tag: 'Failure', failure: { _tag: 'BrewingWireConversionFailure', reason: 'unsupported-durability' },
      })
    }
    for (const slot of ['input', 'fuel', 'output']) {
      expect(furnaceStateFromWire({ ...emptyFurnaceWire, [slot]: stack })).toMatchObject({
        _tag: 'Failure', failure: { _tag: 'FurnaceWireConversionFailure', reason: 'unsupported-durability' },
      })
    }
  })

  it('rejects combinations whose item stack exceeds its native stack limit', () => {
    const stack = { item: 'water_bottle', count: 2 }
    expect(brewingStateFromWire({ ...emptyBrewingWire, bottles: [stack, null, null] })).toMatchObject({
      _tag: 'Failure', failure: { _tag: 'BrewingWireConversionFailure', reason: 'invalid-stack' },
    })
    expect(furnaceStateFromWire({ ...emptyFurnaceWire, input: stack })).toMatchObject({
      _tag: 'Failure', failure: { _tag: 'FurnaceWireConversionFailure', reason: 'invalid-stack' },
    })
  })

  it('returns a schema-valid state or typed failure for arbitrary untrusted inputs', () => {
    fc.assert(fc.property(fc.anything(), (input) => {
      const brewing = brewingStateFromWire(input)
      const furnace = furnaceStateFromWire(input)
      expect(Result.isSuccess(brewing)
        ? Schema.is(BrewingStateSchema)(brewing.success)
        : Schema.is(BrewingWireConversionFailure)(brewing.failure)).toBe(true)
      expect(Result.isSuccess(furnace)
        ? Schema.is(FurnaceStateSchema)(furnace.success)
        : Schema.is(FurnaceWireConversionFailure)(furnace.failure)).toBe(true)
    }), { seed: 0x51c0ffee, numRuns: 100 })
  })
})

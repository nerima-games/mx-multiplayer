import { describe, expect, it } from '@effect/vitest'
import * as fc from 'fast-check'
import { FixedDurationSecs, isBrewingState, ItemDamage, ITEM_TYPES, itemComponents, itemStackFromUnknown, MaxStackSize, maxStackCountForItem, NonNegativeTickCount, RepairCost, secondsForTicks, type ItemSlot } from '@nerima-games/mc-kernel'
import { brewingState, BrewingStateSchema, furnaceState, FurnaceStateSchema, validateBrewingSnapshot } from '@nerima-games/mc-sim'
import { Result, Schema } from 'effect'
import {
  brewingStateFromWire,
  brewingStateToWire,
  furnaceStateFromWire,
  furnaceStateToWire,
  FurnaceStateWire,
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
      const wire = Result.getOrThrow(brewingStateToWire(state))
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
            station, input, fuel, output,
            fuelTimeRemainingSecs: Result.getOrThrow(secondsForTicks(Result.getOrThrow(NonNegativeTickCount.result(burnTicksRemaining)))),
            fuelTimeTotalSecs: Result.getOrThrow(secondsForTicks(Result.getOrThrow(NonNegativeTickCount.result(burnTicksTotal)))),
            cookProgressSecs: Result.getOrThrow(secondsForTicks(Result.getOrThrow(NonNegativeTickCount.result(cookTicks)))),
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
    const validStack = Result.getOrThrow(itemStackFromUnknown('water_bottle', 1))
    expect(validateBrewingSnapshot({
      bottles: [{ ...validStack, count: 2 }, undefined, undefined],
      ingredient: undefined,
      fuel: undefined,
      fuelCharges: 0,
      brewProgressSecs: 0,
    })).toMatchObject({ _tag: 'Failure' })
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

  it('refuses unknown item names and counts outside the native StackCount domain', () => {
    for (const stack of [
      { item: 'not-an-item', count: 1 },
      { item: 'stone', count: 100 },
    ]) {
      expect(brewingStateFromWire({ ...emptyBrewingWire, bottles: [stack, null, null] })).toMatchObject({
        _tag: 'Failure', failure: { _tag: 'BrewingWireConversionFailure', path: 'bottles[0]', reason: 'invalid-stack' },
      })
      expect(furnaceStateFromWire({ ...emptyFurnaceWire, input: stack })).toMatchObject({
        _tag: 'Failure', failure: { _tag: 'FurnaceWireConversionFailure', path: 'input', reason: 'invalid-stack' },
      })
    }
  })

  it('uses canonical kernel seconds for three ticks and every tick from zero through twenty thousand', () => {
    expect(Result.getOrThrow(secondsForTicks(Result.getOrThrow(NonNegativeTickCount.result(3))))).toBe(0.15000000000000002)
    for (let ticks = 0; ticks <= 20_000; ticks += 1) {
      const expectedSecs = Result.getOrThrow(secondsForTicks(Result.getOrThrow(NonNegativeTickCount.result(ticks))))
      const state = Result.getOrThrow(furnaceStateFromWire({
        ...emptyFurnaceWire, burnTicksRemaining: ticks, burnTicksTotal: ticks, cookTicks: ticks,
      }))
      expect(state.fuelTimeRemainingSecs).toBe(expectedSecs)
      expect(state.fuelTimeTotalSecs).toBe(expectedSecs)
      expect(state.cookProgressSecs).toBe(expectedSecs)
      expect(Result.getOrThrow(furnaceStateToWire(state, 'furnace:1'))).toStrictEqual({
        ...emptyFurnaceWire, burnTicksRemaining: ticks, burnTicksTotal: ticks, cookTicks: ticks,
      })
    }
  })

  it('refuses nondefault components in every brewing and furnace slot before encoding', () => {
    const damagedTool = Result.getOrThrow(itemStackFromUnknown('wooden_pickaxe', 1, {
      components: Result.getOrThrow(itemComponents('wooden_pickaxe', { damage: Result.getOrThrow(ItemDamage.result(5)) })),
    }))
    const stackedPotion = Result.getOrThrow(itemStackFromUnknown('water_bottle', 5, {
      components: Result.getOrThrow(itemComponents('water_bottle', { maxStackSize: Result.getOrThrow(MaxStackSize.result(16)) })),
    }))
    for (const stack of [damagedTool, stackedPotion]) {
      const empty = Result.getOrThrow(brewingState())
      for (const state of [
        { ...empty, bottles: [stack, undefined, undefined] },
        { ...empty, bottles: [undefined, stack, undefined] },
        { ...empty, bottles: [undefined, undefined, stack] },
        { ...empty, ingredient: stack },
        { ...empty, fuel: stack },
      ]) {
        expect(brewingStateToWire(Result.getOrThrow(brewingState(state)))).toMatchObject({
          _tag: 'Failure', failure: { _tag: 'BrewingWireConversionFailure', reason: 'unsupported-components' },
        })
      }
      for (const slot of ['input', 'fuel', 'output']) {
        expect(furnaceStateToWire(Result.getOrThrow(furnaceState({ [slot]: stack })), 'furnace:1')).toMatchObject({
          _tag: 'Failure', failure: { _tag: 'FurnaceWireConversionFailure', reason: 'unsupported-components' },
        })
      }
    }
  })

  it('reports the kernel-valid completed brewing boundary as a wire failure', () => {
    const empty = Result.getOrThrow(brewingState())
    const before = { ...empty, brewProgressSecs: Result.getOrThrow(FixedDurationSecs.result(19.999999999999996)) }
    expect(Result.isSuccess(brewingStateToWire(before))).toBe(true)
    for (const progress of [20, 20.000000000000004]) {
      const state = { ...empty, brewProgressSecs: Result.getOrThrow(FixedDurationSecs.result(progress)) }
      expect(isBrewingState(state)).toBe(progress === 20)
      expect(brewingStateToWire(state)).toMatchObject({
        _tag: 'Failure', failure: { _tag: 'BrewingWireConversionFailure', reason: 'invalid-state' },
      })
    }
  })

  it('preserves all stations and default-component slots when encoding furnace states', () => {
    fc.assert(fc.property(
      fc.constantFrom('furnace', 'blast_furnace', 'smoker'),
      fc.tuple(slotArbitrary, slotArbitrary, slotArbitrary),
      fc.integer({ min: 0, max: 20_000 }), fc.integer({ min: 0, max: 20_000 }), fc.integer({ min: 0, max: 20_000 }),
      (station, [input, fuel, output], first, second, cookTicks) => {
        const remaining = Math.min(first, second)
        const total = Math.max(first, second)
        const state = Result.getOrThrow(furnaceState({
          station, input, fuel, output,
          fuelTimeRemainingSecs: Result.getOrThrow(secondsForTicks(Result.getOrThrow(NonNegativeTickCount.result(remaining)))),
          fuelTimeTotalSecs: Result.getOrThrow(secondsForTicks(Result.getOrThrow(NonNegativeTickCount.result(total)))),
          cookProgressSecs: Result.getOrThrow(secondsForTicks(Result.getOrThrow(NonNegativeTickCount.result(cookTicks)))),
        }))
        const wire = Result.getOrThrow(furnaceStateToWire(state, 'furnace:roundtrip'))
        expect(wire).toStrictEqual({
          furnaceId: 'furnace:roundtrip', station, input: wireSlot(input), fuel: wireSlot(fuel), output: wireSlot(output),
          burnTicksRemaining: remaining, burnTicksTotal: total, cookTicks,
        })
        expect(Result.getOrThrow(furnaceStateFromWire(wire))).toStrictEqual(state)
      },
    ), { seed: 0x51c0ffee, numRuns: 100 })
  })

  it('rounds non-tick furnace seconds to the nearest tick with half-ticks rounding upward', () => {
    for (const [seconds, expectedTicks] of [[0.024999999999999998, 0], [0.025, 1], [0.025000000000000005, 1], [0.075, 2], [0.126, 3]]) {
      const state = Result.getOrThrow(furnaceState({
        fuelTimeRemainingSecs: seconds, fuelTimeTotalSecs: seconds, cookProgressSecs: seconds,
      }))
      expect(Result.getOrThrow(furnaceStateToWire(state, 'furnace:1'))).toStrictEqual({
        ...emptyFurnaceWire, burnTicksRemaining: expectedTicks, burnTicksTotal: expectedTicks, cookTicks: expectedTicks,
      })
    }
  })

  it('returns typed failures for invalid furnace state and unrepresentable tick counts', () => {
    const empty = Result.getOrThrow(furnaceState())
    const inconsistent = { ...empty, fuelTimeRemainingSecs: Result.getOrThrow(FixedDurationSecs.result(1)) }
    expect(furnaceStateToWire(inconsistent, 'furnace:1')).toMatchObject({
      _tag: 'Failure', failure: { _tag: 'FurnaceWireConversionFailure', reason: 'invalid-state' },
    })
    const overflow = { ...empty, cookProgressSecs: Result.getOrThrow(FixedDurationSecs.result(Number.MAX_VALUE)) }
    expect(furnaceStateToWire(overflow, 'furnace:1')).toMatchObject({
      _tag: 'Failure', failure: { _tag: 'FurnaceWireConversionFailure', reason: 'invalid-state' },
    })
    const secondsArbitrary = fc.double({ min: 0, noNaN: true, noDefaultInfinity: true })
    fc.assert(fc.property(secondsArbitrary, secondsArbitrary, secondsArbitrary, (remaining, total, progress) => {
      const state = {
        ...empty,
        fuelTimeRemainingSecs: Result.getOrThrow(FixedDurationSecs.result(remaining)),
        fuelTimeTotalSecs: Result.getOrThrow(FixedDurationSecs.result(total)),
        cookProgressSecs: Result.getOrThrow(FixedDurationSecs.result(progress)),
      }
      const encoded = furnaceStateToWire(state, 'furnace:1')
      if (remaining > total) {
        expect(encoded).toMatchObject({ _tag: 'Failure', failure: { reason: 'invalid-state' } })
      }
      expect(Result.isSuccess(encoded)
        ? Schema.is(FurnaceStateWire)(encoded.success)
        : Schema.is(FurnaceWireConversionFailure)(encoded.failure)).toBe(true)
    }), { seed: 0x51c0ffee, numRuns: 100 })
  })

  it('rejects nondefault component stacks across the full item vocabulary before either wire encoding', () => {
    fc.assert(fc.property(stackArbitrary, (stack) => {
      const components = Result.getOrThrow(itemComponents(stack.item, { repairCost: Result.getOrThrow(RepairCost.result(1)) }))
      const modified = Result.getOrThrow(itemStackFromUnknown(stack.item, stack.count, { components }))
      expect(brewingStateToWire(Result.getOrThrow(brewingState({ fuel: modified })))).toMatchObject({
        _tag: 'Failure', failure: { _tag: 'BrewingWireConversionFailure', reason: 'unsupported-components' },
      })
      expect(furnaceStateToWire(Result.getOrThrow(furnaceState({ output: modified })), 'furnace:1')).toMatchObject({
        _tag: 'Failure', failure: { _tag: 'FurnaceWireConversionFailure', reason: 'unsupported-components' },
      })
    }), { seed: 0x51c0ffee, numRuns: 100 })
  })
})

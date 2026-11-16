import { type BrewingState, type Slot, StackCount, isItemType, itemComponents, itemStack, itemStackEqualsIgnoringCount } from '@nerima-games/mc-kernel'
import { Result, Schema } from 'effect'
import { BrewingStandState } from './brewing.js'
import type { ItemStackWire } from './item-stack.js'
import { validateBrewingSnapshot } from '@nerima-games/mc-sim'

export const BrewingWireConversionFailure: Schema.TaggedStruct<'BrewingWireConversionFailure', {
  path: typeof Schema.String
  reason: Schema.Literals<readonly ['invalid-wire', 'unsupported-durability', 'invalid-stack', 'invalid-state', 'unsupported-components']>
}> = Schema.TaggedStruct('BrewingWireConversionFailure', {
  path: Schema.String,
  reason: Schema.Literals(['invalid-wire', 'unsupported-durability', 'invalid-stack', 'invalid-state', 'unsupported-components']),
})
export type BrewingWireConversionFailure = typeof BrewingWireConversionFailure.Type

const slotToWire = (slot: Slot, path: string): Result.Result<ItemStackWire | null, BrewingWireConversionFailure> =>
  Result.gen(function* () {
    if (slot === undefined) {
      return null
    }
    const defaults = yield* Result.mapError(itemComponents(slot.item), (): BrewingWireConversionFailure => ({
      _tag: 'BrewingWireConversionFailure', path, reason: 'invalid-stack',
    }))
    if (!itemStackEqualsIgnoringCount(slot, { ...slot, components: defaults })) {
      return yield* Result.fail<BrewingWireConversionFailure>({
        _tag: 'BrewingWireConversionFailure', path, reason: 'unsupported-components',
      })
    }
    const stack = yield* Result.mapError(itemStack(slot.item, slot.count), (): BrewingWireConversionFailure => ({
      _tag: 'BrewingWireConversionFailure', path, reason: 'invalid-stack',
    }))
    return { count: stack.count, item: stack.item }
  })

export const brewingStateToWire = (state: BrewingState): Result.Result<BrewingStandState, BrewingWireConversionFailure> =>
  Result.gen(function* () {
    const validated = validateBrewingSnapshot(state)
    if (validated._tag !== 'Valid') {
      return yield* Result.fail<BrewingWireConversionFailure>({
        _tag: 'BrewingWireConversionFailure', path: 'state', reason: 'invalid-state',
      })
    }
    const [first, second, third] = validated.state.bottles
    const [firstWire, secondWire, thirdWire, ingredient, fuel] = yield* Result.all([
      slotToWire(first, 'bottles[0]'),
      slotToWire(second, 'bottles[1]'),
      slotToWire(third, 'bottles[2]'),
      slotToWire(validated.state.ingredient, 'ingredient'),
      slotToWire(validated.state.fuel, 'fuel'),
    ])
    return yield* Result.mapError(Schema.decodeUnknownResult(BrewingStandState)({
      bottles: [firstWire, secondWire, thirdWire],
      brewProgressSecs: validated.state.brewProgressSecs,
      fuel,
      fuelCharges: validated.state.fuelCharges,
      ingredient,
    }, { onExcessProperty: 'error' }), (): BrewingWireConversionFailure => ({
      _tag: 'BrewingWireConversionFailure', path: 'state', reason: 'invalid-state',
    }))
  })

const slotFromWire = (slot: ItemStackWire | null, path: string): Result.Result<Slot, BrewingWireConversionFailure> => {
  if (slot === null) {
    return Result.succeed(undefined)
  }
  if (slot.durability !== undefined) {
    return Result.fail({ _tag: 'BrewingWireConversionFailure', path, reason: 'unsupported-durability' })
  }
  if (!isItemType(slot.item)) {
    return Result.fail({ _tag: 'BrewingWireConversionFailure', path, reason: 'invalid-stack' })
  }
  const { item } = slot
  return Result.flatMap(
    Result.mapError(StackCount.result(slot.count), () : BrewingWireConversionFailure => ({ _tag: 'BrewingWireConversionFailure', path, reason: 'invalid-stack' })),
    (count) => Result.mapError(itemStack(item, count), () : BrewingWireConversionFailure => ({ _tag: 'BrewingWireConversionFailure', path, reason: 'invalid-stack' })),
  )
}

export const brewingStateFromWire = (wire: unknown): Result.Result<BrewingState, BrewingWireConversionFailure> =>
  Result.gen(function* () {
    const parsed = yield* Result.mapError(
      Schema.decodeUnknownResult(BrewingStandState)(wire, { onExcessProperty: 'error' }),
      (): BrewingWireConversionFailure => ({ _tag: 'BrewingWireConversionFailure', path: 'state', reason: 'invalid-wire' }),
    )
    const [firstWire, secondWire, thirdWire] = parsed.bottles
    const [first, second, third, ingredient, fuel] = yield* Result.all([
      slotFromWire(firstWire, 'bottles[0]'),
      slotFromWire(secondWire, 'bottles[1]'),
      slotFromWire(thirdWire, 'bottles[2]'),
      slotFromWire(parsed.ingredient, 'ingredient'),
      slotFromWire(parsed.fuel, 'fuel'),
    ])
    const validated = validateBrewingSnapshot({ ...parsed, bottles: [first, second, third], fuel, ingredient })
    if (validated._tag !== 'Valid') {
      return yield* Result.fail<BrewingWireConversionFailure>({
        _tag: 'BrewingWireConversionFailure', path: 'state', reason: 'invalid-state',
      })
    }
    return validated.state
  })

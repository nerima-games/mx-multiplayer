import { type BrewingState, type Slot, StackCount, isItemType, itemStack } from '@nerima-games/mc-kernel'
import { Result, Schema } from 'effect'
import { BrewingStandState } from './brewing.js'
import type { ItemStack } from './item-stack.js'
import { validateBrewingSnapshot } from '@nerima-games/mc-sim'

export const BrewingWireConversionFailure: Schema.TaggedStruct<'BrewingWireConversionFailure', {
  path: typeof Schema.String
  reason: Schema.Literals<readonly ['invalid-wire', 'unsupported-durability', 'invalid-stack', 'invalid-state']>
}> = Schema.TaggedStruct('BrewingWireConversionFailure', {
  path: Schema.String,
  reason: Schema.Literals(['invalid-wire', 'unsupported-durability', 'invalid-stack', 'invalid-state']),
})
export type BrewingWireConversionFailure = typeof BrewingWireConversionFailure.Type

const slotToWire = (slot: Slot): ItemStack | null => {
  if (slot === undefined) {
    return null
  }
  return { count: slot.count, item: slot.item }
}

export const brewingStateToWire = (state: BrewingState): BrewingStandState => {
  const [first, second, third] = state.bottles
  return {
    bottles: [slotToWire(first), slotToWire(second), slotToWire(third)],
    brewProgressSecs: state.brewProgressSecs,
    fuel: slotToWire(state.fuel),
    fuelCharges: state.fuelCharges,
    ingredient: slotToWire(state.ingredient),
  }
}

const slotFromWire = (slot: ItemStack | null, path: string): Result.Result<Slot, BrewingWireConversionFailure> => {
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

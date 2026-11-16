import { FixedDurationSecs, type FurnaceState as KernelFurnaceState, NonNegativeTickCount, type Slot, StackCount, isItemType, itemComponents, itemStack, itemStackEqualsIgnoringCount, secondsForTicks, smeltingCookTimeForStation } from '@nerima-games/mc-kernel'
import { FurnaceStateSchema, type SmeltingRecipeInput, VANILLA_SMELTING_RECIPES, matchSmeltingRecipe } from '@nerima-games/mc-sim'
import { Result, Schema } from 'effect'
import { FurnaceStateWire } from '../protocol.js'
import type { ItemStackWire } from './item-stack.js'

export const FurnaceWireConversionFailure: Schema.TaggedStruct<'FurnaceWireConversionFailure', {
  path: typeof Schema.String
  reason: Schema.Literals<readonly ['invalid-wire', 'unsupported-durability', 'invalid-stack', 'invalid-state', 'unsupported-components']>
}> = Schema.TaggedStruct('FurnaceWireConversionFailure', {
  path: Schema.String,
  reason: Schema.Literals(['invalid-wire', 'unsupported-durability', 'invalid-stack', 'invalid-state', 'unsupported-components']),
})
export type FurnaceWireConversionFailure = typeof FurnaceWireConversionFailure.Type

const TICKS_PER_SECOND = 20
const ONE = 1

const slotFromWire = (slot: ItemStackWire | null, path: string): Result.Result<Slot, FurnaceWireConversionFailure> => {
  if (slot === null) {
    return Result.succeed(undefined)
  }
  if (slot.durability !== undefined) {
    return Result.fail({ _tag: 'FurnaceWireConversionFailure', path, reason: 'unsupported-durability' })
  }
  if (!isItemType(slot.item)) {
    return Result.fail({ _tag: 'FurnaceWireConversionFailure', path, reason: 'invalid-stack' })
  }
  const { item } = slot
  return Result.flatMap(
    Result.mapError(StackCount.result(slot.count), () : FurnaceWireConversionFailure => ({ _tag: 'FurnaceWireConversionFailure', path, reason: 'invalid-stack' })),
    (count) => Result.mapError(itemStack(item, count), () : FurnaceWireConversionFailure => ({ _tag: 'FurnaceWireConversionFailure', path, reason: 'invalid-stack' })),
  )
}

const slotToWire = (slot: Slot, path: string): Result.Result<ItemStackWire | null, FurnaceWireConversionFailure> =>
  Result.gen(function* () {
    if (slot === undefined) {
      return null
    }
    const defaults = yield* Result.mapError(itemComponents(slot.item), (): FurnaceWireConversionFailure => ({
      _tag: 'FurnaceWireConversionFailure', path, reason: 'invalid-stack',
    }))
    if (!itemStackEqualsIgnoringCount(slot, { ...slot, components: defaults })) {
      return yield* Result.fail<FurnaceWireConversionFailure>({
        _tag: 'FurnaceWireConversionFailure', path, reason: 'unsupported-components',
      })
    }
    const stack = yield* Result.mapError(itemStack(slot.item, slot.count), (): FurnaceWireConversionFailure => ({
      _tag: 'FurnaceWireConversionFailure', path, reason: 'invalid-stack',
    }))
    return { count: stack.count, item: stack.item }
  })

const secondsFromWire = (ticks: FurnaceStateWire['cookTicks']): Result.Result<KernelFurnaceState['cookProgressSecs'], FurnaceWireConversionFailure> =>
  Result.flatMap(
    Result.mapError(NonNegativeTickCount.result(ticks), (): FurnaceWireConversionFailure => ({
      _tag: 'FurnaceWireConversionFailure', path: 'state', reason: 'invalid-wire',
    })),
    (count) => Result.mapError(secondsForTicks(count), (): FurnaceWireConversionFailure => ({
      _tag: 'FurnaceWireConversionFailure', path: 'state', reason: 'invalid-wire',
    })),
  )

export const furnaceStateFromWire = (wire: unknown): Result.Result<KernelFurnaceState, FurnaceWireConversionFailure> =>
  Result.gen(function* () {
    const parsed = yield* Result.mapError(
      Schema.decodeUnknownResult(FurnaceStateWire)(wire, { onExcessProperty: 'error' }),
      (): FurnaceWireConversionFailure => ({ _tag: 'FurnaceWireConversionFailure', path: 'state', reason: 'invalid-wire' }),
    )
    const input = yield* slotFromWire(parsed.input, 'input')
    const fuel = yield* slotFromWire(parsed.fuel, 'fuel')
    const output = yield* slotFromWire(parsed.output, 'output')
    const [remaining, total, progress] = yield* Result.all([
      secondsFromWire(parsed.burnTicksRemaining),
      secondsFromWire(parsed.burnTicksTotal),
      secondsFromWire(parsed.cookTicks),
    ])
    return yield* Result.mapError(
      Schema.decodeUnknownResult(FurnaceStateSchema)({
        cookProgressSecs: progress,
        fuel,
        fuelTimeRemainingSecs: remaining,
        fuelTimeTotalSecs: total,
        input,
        output,
        station: parsed.station,
      }, { onExcessProperty: 'error' }),
      (): FurnaceWireConversionFailure => ({ _tag: 'FurnaceWireConversionFailure', path: 'state', reason: 'invalid-state' }),
    )
  })
const ticksFromSeconds = (seconds: KernelFurnaceState['cookProgressSecs']): Result.Result<FurnaceStateWire['cookTicks'], FurnaceWireConversionFailure> =>
  Result.mapError(NonNegativeTickCount.result(Math.round(seconds * TICKS_PER_SECOND)), (): FurnaceWireConversionFailure => ({
    _tag: 'FurnaceWireConversionFailure', path: 'state', reason: 'invalid-state',
  }))


const invalidRecipe = (): FurnaceWireConversionFailure => ({
  _tag: 'FurnaceWireConversionFailure', path: 'recipes', reason: 'invalid-state',
})

const cookDurationForRecipe = (
  recipe: SmeltingRecipeInput,
  station: KernelFurnaceState['station'],
): Result.Result<KernelFurnaceState['cookProgressSecs'], FurnaceWireConversionFailure> => {
  if ('_tag' in recipe) {
    return Result.mapError(smeltingCookTimeForStation(recipe, station), invalidRecipe)
  }
  return Result.mapError(FixedDurationSecs.result(recipe.cookDurationSecs), invalidRecipe)
}

const capCookTicks = (
  roundedTicks: FurnaceStateWire['cookTicks'],
  duration: KernelFurnaceState['cookProgressSecs'],
): Result.Result<FurnaceStateWire['cookTicks'], FurnaceWireConversionFailure> =>
  Result.gen(function* () {
    let count = yield* Result.mapError(
      NonNegativeTickCount.result(Math.min(roundedTicks, Math.ceil(duration * TICKS_PER_SECOND) - ONE)),
      invalidRecipe,
    )
    let canonical = yield* Result.mapError(secondsForTicks(count), invalidRecipe)
    while (canonical >= duration) {
      count = yield* Result.mapError(NonNegativeTickCount.result(count - ONE), invalidRecipe)
      canonical = yield* Result.mapError(secondsForTicks(count), invalidRecipe)
    }
    return count
  })

const cookTicksForState = (
  state: KernelFurnaceState,
  roundedTicks: FurnaceStateWire['cookTicks'],
  recipes: ReadonlyArray<SmeltingRecipeInput>,
): Result.Result<FurnaceStateWire['cookTicks'], FurnaceWireConversionFailure> =>
  Result.gen(function* () {
    const recipe = yield* Result.mapError(matchSmeltingRecipe(state.input, state.station, recipes), invalidRecipe)
    if (recipe === undefined) {
      return roundedTicks
    }
    const duration = yield* cookDurationForRecipe(recipe, state.station)
    if (state.cookProgressSecs >= duration) {
      return yield* Result.fail<FurnaceWireConversionFailure>({
        _tag: 'FurnaceWireConversionFailure', path: 'cookProgressSecs', reason: 'invalid-state',
      })
    }
    return yield* capCookTicks(roundedTicks, duration)
  })

export const furnaceStateToWire = (
  state: KernelFurnaceState,
  furnaceId: FurnaceStateWire['furnaceId'],
  recipes: ReadonlyArray<SmeltingRecipeInput> = VANILLA_SMELTING_RECIPES,
): Result.Result<FurnaceStateWire, FurnaceWireConversionFailure> =>
  Result.gen(function* () {
    const validated = yield* Result.mapError(
      Schema.decodeUnknownResult(FurnaceStateSchema)(state, { onExcessProperty: 'error' }),
      (): FurnaceWireConversionFailure => ({ _tag: 'FurnaceWireConversionFailure', path: 'state', reason: 'invalid-state' }),
    )
    const [input, fuel, output] = yield* Result.all([
      slotToWire(validated.input, 'input'),
      slotToWire(validated.fuel, 'fuel'),
      slotToWire(validated.output, 'output'),
    ])
    const [burnTicksRemaining, burnTicksTotal, roundedCookTicks] = yield* Result.all([
      ticksFromSeconds(validated.fuelTimeRemainingSecs),
      ticksFromSeconds(validated.fuelTimeTotalSecs),
      ticksFromSeconds(validated.cookProgressSecs),
    ])
    const cookTicks = yield* cookTicksForState(validated, roundedCookTicks, recipes)
    return yield* Result.mapError(
      Schema.decodeUnknownResult(FurnaceStateWire)({
        burnTicksRemaining, burnTicksTotal, cookTicks, fuel, furnaceId, input, output, station: validated.station,
      }, { onExcessProperty: 'error' }),
      (): FurnaceWireConversionFailure => ({ _tag: 'FurnaceWireConversionFailure', path: 'state', reason: 'invalid-state' }),
    )
  })


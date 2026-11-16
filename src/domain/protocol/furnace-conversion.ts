import { type FurnaceState as KernelFurnaceState, type Slot, StackCount, isItemType, itemStack } from '@nerima-games/mc-kernel'
import { Result, Schema } from 'effect'
import { FurnaceState } from '../protocol.js'
import { FurnaceStateSchema } from '@nerima-games/mc-sim'
import type { ItemStack } from './item-stack.js'

export const FurnaceWireConversionFailure: Schema.TaggedStruct<'FurnaceWireConversionFailure', {
  path: typeof Schema.String
  reason: Schema.Literals<readonly ['invalid-wire', 'unsupported-durability', 'invalid-stack', 'invalid-state']>
}> = Schema.TaggedStruct('FurnaceWireConversionFailure', {
  path: Schema.String,
  reason: Schema.Literals(['invalid-wire', 'unsupported-durability', 'invalid-stack', 'invalid-state']),
})
export type FurnaceWireConversionFailure = typeof FurnaceWireConversionFailure.Type

const TICKS_PER_SECOND = 20

const slotFromWire = (slot: ItemStack | null, path: string): Result.Result<Slot, FurnaceWireConversionFailure> => {
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

export const furnaceStateFromWire = (wire: unknown): Result.Result<KernelFurnaceState, FurnaceWireConversionFailure> =>
  Result.gen(function* () {
    const parsed = yield* Result.mapError(
      Schema.decodeUnknownResult(FurnaceState)(wire, { onExcessProperty: 'error' }),
      (): FurnaceWireConversionFailure => ({ _tag: 'FurnaceWireConversionFailure', path: 'state', reason: 'invalid-wire' }),
    )
    const input = yield* slotFromWire(parsed.input, 'input')
    const fuel = yield* slotFromWire(parsed.fuel, 'fuel')
    const output = yield* slotFromWire(parsed.output, 'output')
    return yield* Result.mapError(
      Schema.decodeUnknownResult(FurnaceStateSchema)({
        cookProgressSecs: parsed.cookTicks / TICKS_PER_SECOND,
        fuel,
        fuelTimeRemainingSecs: parsed.burnTicksRemaining / TICKS_PER_SECOND,
        fuelTimeTotalSecs: parsed.burnTicksTotal / TICKS_PER_SECOND,
        input,
        output,
        station: parsed.station,
      }, { onExcessProperty: 'error' }),
      (): FurnaceWireConversionFailure => ({ _tag: 'FurnaceWireConversionFailure', path: 'state', reason: 'invalid-state' }),
    )
  })

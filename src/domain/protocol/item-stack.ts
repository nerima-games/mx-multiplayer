import { Schema } from 'effect'
import { WireNumber } from './identifiers.js'

const ZERO = 0
const MIN_NON_EMPTY_LENGTH = 1

export const ItemStackWire: Schema.Struct<{
  count: typeof Schema.Number
  durability: Schema.optionalKey<
    Schema.Struct<{
      current: typeof Schema.Number
      max: typeof Schema.Number
    }>
  >
  item: typeof Schema.String
}> = Schema.Struct({
  count: WireNumber.pipe(Schema.check(Schema.isInt()), Schema.check(Schema.isGreaterThan(ZERO))),
  durability: Schema.optionalKey(
    Schema.Struct({
      current: WireNumber.pipe(Schema.check(Schema.isInt()), Schema.check(Schema.isGreaterThanOrEqualTo(ZERO))),
      max: WireNumber.pipe(Schema.check(Schema.isInt()), Schema.check(Schema.isGreaterThan(ZERO))),
    }),
  ),
  item: Schema.String.pipe(Schema.check(Schema.isMinLength(MIN_NON_EMPTY_LENGTH))),
})
export type ItemStackWire = typeof ItemStackWire.Type

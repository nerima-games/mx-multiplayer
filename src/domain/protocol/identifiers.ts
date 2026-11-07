/**
 * The identifier and revision primitives every message in the protocol
 * shares, split out of `protocol.ts` so the per-domain modules under
 * `protocol/` (`anvil.ts`, `crafting.ts`, ...) can depend on them without
 * creating an import cycle back through `protocol.ts` itself, which in turn
 * imports those domain modules to fold their messages into `NetworkMessage`.
 * `protocol.ts` re-exports everything here, so this split changes no
 * existing import site outside this directory.
 */
import { Schema, type SchemaAST, SchemaGetter } from 'effect'

/** The floor every branded/free-text identifier and content string in this protocol shares: not blank. */
const ZERO = 0
const NEGATIVE_ZERO = -ZERO
const MIN_NON_EMPTY_LENGTH = 1

// JSON serialization writes negative zero as positive zero; normalize both directions without rejecting old frames.
export const isWireNegativeZero = (value: number): boolean => Object.is(value, NEGATIVE_ZERO)
export const canonicalizeWireNumber = (value: number): number => {
  if (isWireNegativeZero(value)) {
    return ZERO
  }
  return value
}
export const WireNumberCheck: SchemaAST.Filter<number> = Schema.makeFilter<number>(
  (value) => !isWireNegativeZero(value),
  { expected: 'a canonical JSON number' },
)
export const WireNumber: typeof Schema.Number = Schema.Number.pipe(Schema.decode({
  decode: SchemaGetter.transform(canonicalizeWireNumber),
  encode: SchemaGetter.transform(canonicalizeWireNumber),
}), Schema.check(WireNumberCheck))

/** A peer's stable identity for the lifetime of a session. */
export const PlayerId: Schema.brand<typeof Schema.String, 'PlayerId'> = Schema.String.pipe(
  Schema.check(Schema.isMinLength(MIN_NON_EMPTY_LENGTH)),
  Schema.brand('PlayerId'),
)
export type PlayerId = typeof PlayerId.Type

/** A peer's display name. Not unique, not an identity — never key on it. */
export const PlayerName: Schema.brand<typeof Schema.String, 'PlayerName'> = Schema.String.pipe(
  Schema.check(Schema.isMinLength(MIN_NON_EMPTY_LENGTH)),
  Schema.brand('PlayerName'),
)
export type PlayerName = typeof PlayerName.Type

/** Identifies which world a session is playing. */
export const WorldId: Schema.brand<typeof Schema.String, 'WorldId'> = Schema.String.pipe(
  Schema.check(Schema.isMinLength(MIN_NON_EMPTY_LENGTH)),
  Schema.brand('WorldId'),
)
export type WorldId = typeof WorldId.Type

/** Stable client-generated identity used to make command retries idempotent. */
export const CommandId: Schema.brand<typeof Schema.String, 'CommandId'> = Schema.String.pipe(
  Schema.check(Schema.isMinLength(MIN_NON_EMPTY_LENGTH)),
  Schema.brand('CommandId'),
)
export type CommandId = typeof CommandId.Type

/** Stable identity of a server-owned world entity. */
export const EntityId: Schema.brand<typeof Schema.String, 'EntityId'> = Schema.String.pipe(
  Schema.check(Schema.isMinLength(MIN_NON_EMPTY_LENGTH)),
  Schema.brand('EntityId'),
)
export type EntityId = typeof EntityId.Type

export const Revision: typeof Schema.Number = WireNumber.pipe(
  Schema.check(Schema.isInt()),
  Schema.check(Schema.isGreaterThanOrEqualTo(ZERO)),
)
export type Revision = typeof Revision.Type

/** A block-grid position. Integral by construction. */
export const BlockPos: Schema.Struct<{
  x: typeof Schema.Number
  y: typeof Schema.Number
  z: typeof Schema.Number
}> = Schema.Struct({
  x: WireNumber.pipe(Schema.check(Schema.isInt())),
  y: WireNumber.pipe(Schema.check(Schema.isInt())),
  z: WireNumber.pipe(Schema.check(Schema.isInt())),
})
export type BlockPos = typeof BlockPos.Type

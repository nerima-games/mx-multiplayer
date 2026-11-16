/**
 * The mc-kernel BrewingState wire shape, versioned independently of the domain.
 * Stack components are omitted; senders must use default-component stacks.
 * Status effects retain the mx-gameplay wire shape.
 */
import { BlockPos, CommandId, PlayerId, Revision, WireNumber, WorldId } from '../protocol/identifiers.js'
import { ItemStackWire } from './item-stack.js'
import { Schema } from 'effect'

const ZERO = 0
const MAX_FUEL_CHARGES = 20
const BREW_DURATION_SECS = 20
const BOTTLE_SLOT_COUNT = 3

export const BrewingSlotWire: Schema.NullOr<typeof ItemStackWire> = Schema.NullOr(ItemStackWire)
export type BrewingSlotWire = typeof BrewingSlotWire.Type

export const BrewingStandState: Schema.Struct<{
  bottles: Schema.Tuple<readonly [typeof BrewingSlotWire, typeof BrewingSlotWire, typeof BrewingSlotWire]>
  ingredient: typeof BrewingSlotWire
  fuel: typeof BrewingSlotWire
  fuelCharges: typeof Schema.Number
  brewProgressSecs: typeof Schema.Number
}> = Schema.Struct({
  bottles: Schema.Tuple([BrewingSlotWire, BrewingSlotWire, BrewingSlotWire]),
  brewProgressSecs: WireNumber.pipe(Schema.check(Schema.isFinite()), Schema.check(Schema.isGreaterThanOrEqualTo(ZERO)), Schema.check(Schema.isLessThan(BREW_DURATION_SECS))),
  fuel: BrewingSlotWire,
  fuelCharges: WireNumber.pipe(Schema.check(Schema.isInt()), Schema.check(Schema.isBetween({ maximum: MAX_FUEL_CHARGES, minimum: ZERO }))),
  ingredient: BrewingSlotWire,
})
export type BrewingStandState = typeof BrewingStandState.Type

/** Mirrors `@nerima-games/mx-gameplay`'s `StatusEffectType`. Not imported — see the file header. */
export const StatusEffectType: Schema.Literals<readonly ['poison', 'regeneration', 'speed', 'hunger', 'nausea']> = Schema.Literals([
  'poison',
  'regeneration',
  'speed',
  'hunger',
  'nausea',
])
export type StatusEffectType = typeof StatusEffectType.Type

/** Mirrors `@nerima-games/mx-gameplay`'s `ActiveStatusEffect`. Not imported — see the file header. */
export const ActiveStatusEffect: Schema.Struct<{
  amplifier: Schema.optionalKey<typeof Schema.Number>
  pulseClockSecs: typeof Schema.Number
  remainingSecs: typeof Schema.Number
  type: typeof StatusEffectType
}> = Schema.Struct({
  amplifier: Schema.optionalKey(WireNumber.pipe(Schema.check(Schema.isInt()), Schema.check(Schema.isGreaterThanOrEqualTo(ZERO)))),
  pulseClockSecs: WireNumber.pipe(Schema.check(Schema.isFinite()), Schema.check(Schema.isGreaterThanOrEqualTo(ZERO))),
  remainingSecs: WireNumber.pipe(Schema.check(Schema.isFinite()), Schema.check(Schema.isGreaterThan(ZERO))),
  type: StatusEffectType,
})
export type ActiveStatusEffect = typeof ActiveStatusEffect.Type

/** Mirrors `@nerima-games/mx-gameplay`'s `StatusEffectState`. Not imported — see the file header. */
export const StatusEffectState: Schema.Struct<{ effects: Schema.$Array<typeof ActiveStatusEffect> }> = Schema.Struct({
  effects: Schema.Array(ActiveStatusEffect),
})
export type StatusEffectState = typeof StatusEffectState.Type

const BREWING_SLOT_COUNT = 36

export const BrewingSlotIndex: typeof Schema.Number = WireNumber.pipe(
  Schema.check(Schema.isInt()),
  Schema.check(Schema.isGreaterThanOrEqualTo(ZERO)),
  Schema.check(Schema.isLessThan(BREWING_SLOT_COUNT)),
)
export type BrewingSlotIndex = typeof BrewingSlotIndex.Type

const BrewingBottleIndex: typeof Schema.Number = WireNumber.pipe(
  Schema.check(Schema.isInt()),
  Schema.check(Schema.isGreaterThanOrEqualTo(ZERO)),
  Schema.check(Schema.isLessThan(BOTTLE_SLOT_COUNT)),
)

export const BrewingAction: Schema.Union<
  readonly [
    Schema.TaggedStruct<'open', {}>,
    Schema.TaggedStruct<'insert-fuel', { slot: typeof BrewingSlotIndex }>,
    Schema.TaggedStruct<'insert-ingredient', { slot: typeof BrewingSlotIndex }>,
    Schema.TaggedStruct<'insert-bottle', { slot: typeof BrewingSlotIndex; bottleIndex: typeof BrewingBottleIndex }>,
    Schema.TaggedStruct<'collect', { bottleIndex: typeof BrewingBottleIndex }>,
    Schema.TaggedStruct<'drink', { slot: typeof BrewingSlotIndex }>,
  ]
> = Schema.Union([
  Schema.TaggedStruct('open', {}),
  Schema.TaggedStruct('insert-fuel', { slot: BrewingSlotIndex }),
  Schema.TaggedStruct('insert-ingredient', { slot: BrewingSlotIndex }),
  Schema.TaggedStruct('insert-bottle', { bottleIndex: BrewingBottleIndex, slot: BrewingSlotIndex }),
  Schema.TaggedStruct('collect', { bottleIndex: BrewingBottleIndex }),
  Schema.TaggedStruct('drink', { slot: BrewingSlotIndex }),
])
export type BrewingAction = typeof BrewingAction.Type

export const BrewingCommand: Schema.TaggedStruct<
  'BrewingCommand',
  {
    action: typeof BrewingAction
    at: typeof BlockPos
    commandId: typeof CommandId
    expectedRevision: typeof Revision
    player: typeof PlayerId
    world: typeof WorldId
  }
> = Schema.TaggedStruct('BrewingCommand', {
  action: BrewingAction,
  at: BlockPos,
  commandId: CommandId,
  expectedRevision: Revision,
  player: PlayerId,
  world: WorldId,
})
export type BrewingCommand = typeof BrewingCommand.Type

export const BrewingRejectionReason: Schema.Literals<
  readonly ['stale-revision', 'unauthorized-player', 'wrong-world', 'invalid-command', 'missing-ingredients', 'no-room']
> = Schema.Literals([
  'stale-revision',
  'unauthorized-player',
  'wrong-world',
  'invalid-command',
  'missing-ingredients',
  'no-room',
])
export type BrewingRejectionReason = typeof BrewingRejectionReason.Type

export const BrewingCommandAccepted: Schema.TaggedStruct<
  'BrewingCommandAccepted',
  { commandId: typeof CommandId; revision: typeof Revision }
> = Schema.TaggedStruct('BrewingCommandAccepted', {
  commandId: CommandId,
  revision: Revision,
})
export type BrewingCommandAccepted = typeof BrewingCommandAccepted.Type

export const BrewingCommandRejected: Schema.TaggedStruct<
  'BrewingCommandRejected',
  { commandId: typeof CommandId; reason: typeof BrewingRejectionReason; revision: typeof Revision }
> = Schema.TaggedStruct('BrewingCommandRejected', {
  commandId: CommandId,
  reason: BrewingRejectionReason,
  revision: Revision,
})
export type BrewingCommandRejected = typeof BrewingCommandRejected.Type

export const BrewingCommandResult: Schema.Union<readonly [typeof BrewingCommandAccepted, typeof BrewingCommandRejected]> =
  Schema.Union([BrewingCommandAccepted, BrewingCommandRejected])
export type BrewingCommandResult = typeof BrewingCommandResult.Type

export const BrewingStandDelta: Schema.TaggedStruct<
  'BrewingStandDelta',
  { at: typeof BlockPos; revision: typeof Revision; state: typeof BrewingStandState; world: typeof WorldId }
> = Schema.TaggedStruct('BrewingStandDelta', {
  at: BlockPos,
  revision: Revision,
  state: BrewingStandState,
  world: WorldId,
})
export type BrewingStandDelta = typeof BrewingStandDelta.Type

export const PlayerStatusEffectsDelta: Schema.TaggedStruct<
  'PlayerStatusEffectsDelta',
  { player: typeof PlayerId; revision: typeof Revision; state: typeof StatusEffectState; world: typeof WorldId }
> = Schema.TaggedStruct('PlayerStatusEffectsDelta', {
  player: PlayerId,
  revision: Revision,
  state: StatusEffectState,
  world: WorldId,
})
export type PlayerStatusEffectsDelta = typeof PlayerStatusEffectsDelta.Type

/** Every message this module contributes to the shared `NetworkMessage` union. */
export const BrewingMessage: Schema.Union<
  readonly [
    typeof BrewingCommand,
    typeof BrewingCommandAccepted,
    typeof BrewingCommandRejected,
    typeof BrewingStandDelta,
    typeof PlayerStatusEffectsDelta,
  ]
> = Schema.Union([BrewingCommand, BrewingCommandAccepted, BrewingCommandRejected, BrewingStandDelta, PlayerStatusEffectsDelta])
export type BrewingMessage = typeof BrewingMessage.Type

/**
 * Brewing-stand interaction, and the status effects a potion applies.
 *
 * Lowered from the composing app's `multiplayer-shared/brewing-network.ts`.
 *
 * ---------------------------------------------------------------------------
 * `BrewingStandState` and `StatusEffectState` are MIRRORED here, not imported
 * ---------------------------------------------------------------------------
 *
 * The original file imported `BrewingStandState` and `StatusEffectState`
 * straight from `@nerima-games/mx-gameplay`. This package's Tier (§1,
 * DEPENDENCY_POLICY.md) allows only `mc-kernel` and `mc-sim` — the
 * `no-restricted-imports` group in `.oxlintrc.json` enforces exactly that —
 * and `src/index.ts`'s own header already states mx-multiplayer "has no edge
 * to mx-gameplay". A published-package boundary would fail this build even
 * before the tier check did.
 *
 * But the deeper reason is the one `protocol.ts`'s header gives for `Vec3` and
 * `BlockPos`: a wire format and a domain type have different change budgets.
 * If the wire schema imported `mx-gameplay`'s `BrewingStandState` directly,
 * an unrelated refactor of that type (renaming a field, tightening a range)
 * would silently change what this build can decode, and two peers running
 * different `mx-gameplay` versions could disagree about a frame's validity
 * without anything failing to compile — the exact failure mode a protocol
 * version exists to make loud. Declaring the wire shape independently, here,
 * is what lets it be versioned independently, the same rule `ItemStack` and
 * `MobState` already follow inside `protocol.ts` itself.
 */
import { BlockPos, CommandId, PlayerId, Revision, WorldId } from '../protocol/identifiers.js'
import { Schema } from 'effect'

/** Mirrors `@nerima-games/mx-gameplay`'s `BREWING_INGREDIENTS`. Not imported — see the file header. */
export const BrewingIngredient: Schema.Literal<['nether_wart', 'sugar', 'spider_eye', 'ghast_tear']> = Schema.Literal(
  'nether_wart',
  'sugar',
  'spider_eye',
  'ghast_tear',
)
export type BrewingIngredient = typeof BrewingIngredient.Type

/** Mirrors `@nerima-games/mx-gameplay`'s `POTION_TYPES`. Not imported — see the file header. */
export const PotionType: Schema.Literal<['awkward', 'speed', 'poison', 'regeneration']> = Schema.Literal(
  'awkward',
  'speed',
  'poison',
  'regeneration',
)
export type PotionType = typeof PotionType.Type

const strictShape = { parseOptions: { onExcessProperty: 'error' as const } }

/** Mirrors `@nerima-games/mx-gameplay`'s `BrewingBottle`. Not imported — see the file header. */
export const BrewingBottle: Schema.Union<[Schema.Literal<['water_bottle']>, Schema.Struct<{ potion: typeof PotionType }>]> =
  Schema.Union(Schema.Literal('water_bottle'), Schema.Struct({ potion: PotionType }).annotations(strictShape))
export type BrewingBottle = typeof BrewingBottle.Type

const BrewingProgress: Schema.Struct<{ output: typeof PotionType; remainingSecs: Schema.filter<typeof Schema.Number> }> =
  Schema.Struct({
    output: PotionType,
    remainingSecs: Schema.Number.pipe(Schema.finite(), Schema.nonNegative()),
  }).annotations(strictShape)

/** Mirrors `@nerima-games/mx-gameplay`'s `BrewingStandState`. Not imported — see the file header. */
export const BrewingStandState: Schema.Struct<{
  bottle: Schema.optional<typeof BrewingBottle>
  brewing: Schema.optional<typeof BrewingProgress>
  fuelUnits: Schema.filter<Schema.filter<typeof Schema.Number>>
  ingredient: Schema.optional<typeof BrewingIngredient>
}> = Schema.Struct({
  bottle: Schema.optional(BrewingBottle),
  brewing: Schema.optional(BrewingProgress),
  fuelUnits: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
  ingredient: Schema.optional(BrewingIngredient),
})
export type BrewingStandState = typeof BrewingStandState.Type

/** Mirrors `@nerima-games/mx-gameplay`'s `StatusEffectType`. Not imported — see the file header. */
export const StatusEffectType: Schema.Literal<['poison', 'regeneration', 'speed', 'hunger', 'nausea']> = Schema.Literal(
  'poison',
  'regeneration',
  'speed',
  'hunger',
  'nausea',
)
export type StatusEffectType = typeof StatusEffectType.Type

/** Mirrors `@nerima-games/mx-gameplay`'s `ActiveStatusEffect`. Not imported — see the file header. */
export const ActiveStatusEffect: Schema.Struct<{
  amplifier: Schema.optional<Schema.filter<Schema.filter<typeof Schema.Number>>>
  pulseClockSecs: Schema.filter<Schema.filter<typeof Schema.Number>>
  remainingSecs: Schema.filter<Schema.filter<typeof Schema.Number>>
  type: typeof StatusEffectType
}> = Schema.Struct({
  amplifier: Schema.optional(Schema.Number.pipe(Schema.int(), Schema.nonNegative())),
  pulseClockSecs: Schema.Number.pipe(Schema.finite(), Schema.nonNegative()),
  remainingSecs: Schema.Number.pipe(Schema.finite(), Schema.positive()),
  type: StatusEffectType,
})
export type ActiveStatusEffect = typeof ActiveStatusEffect.Type

/** Mirrors `@nerima-games/mx-gameplay`'s `StatusEffectState`. Not imported — see the file header. */
export const StatusEffectState: Schema.Struct<{ effects: Schema.Array$<typeof ActiveStatusEffect> }> = Schema.Struct({
  effects: Schema.Array(ActiveStatusEffect),
})
export type StatusEffectState = typeof StatusEffectState.Type

const BREWING_SLOT_COUNT = 36

export const BrewingSlotIndex: Schema.filter<Schema.filter<typeof Schema.Number>> = Schema.Number.pipe(
  Schema.int(),
  Schema.nonNegative(),
  Schema.lessThan(BREWING_SLOT_COUNT),
)
export type BrewingSlotIndex = typeof BrewingSlotIndex.Type

export const BrewingAction: Schema.Union<
  [
    Schema.TaggedStruct<'open', {}>,
    Schema.TaggedStruct<'insert', { slot: typeof BrewingSlotIndex }>,
    Schema.TaggedStruct<'collect', {}>,
    Schema.TaggedStruct<'drink', {}>,
  ]
> = Schema.Union(
  Schema.TaggedStruct('open', {}),
  Schema.TaggedStruct('insert', { slot: BrewingSlotIndex }),
  Schema.TaggedStruct('collect', {}),
  Schema.TaggedStruct('drink', {}),
).annotations(strictShape)
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

export const BrewingRejectionReason: Schema.Literal<
  ['stale-revision', 'unauthorized-player', 'wrong-world', 'invalid-command', 'missing-ingredients', 'no-room']
> = Schema.Literal(
  'stale-revision',
  'unauthorized-player',
  'wrong-world',
  'invalid-command',
  'missing-ingredients',
  'no-room',
)
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

export const BrewingCommandResult: Schema.Union<[typeof BrewingCommandAccepted, typeof BrewingCommandRejected]> =
  Schema.Union(BrewingCommandAccepted, BrewingCommandRejected)
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
  [
    typeof BrewingCommand,
    typeof BrewingCommandAccepted,
    typeof BrewingCommandRejected,
    typeof BrewingStandDelta,
    typeof PlayerStatusEffectsDelta,
  ]
> = Schema.Union(BrewingCommand, BrewingCommandAccepted, BrewingCommandRejected, BrewingStandDelta, PlayerStatusEffectsDelta)
export type BrewingMessage = typeof BrewingMessage.Type

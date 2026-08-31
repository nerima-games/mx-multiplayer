/**
 * Enchanting-table interaction: a player picks one of three rolled offers.
 *
 * Lowered from the composing app's `multiplayer-shared/enchanting-network.ts`.
 *
 * `EnchantedItem` is MIRRORED here, not imported from `@nerima-games/mx-gameplay`
 * — same reasoning as `protocol/brewing.ts`'s file header: this package's Tier
 * allows only `mc-kernel` and `mc-sim`, and a wire format that imported a
 * domain type would let an unrelated refactor of that type silently change
 * what this build can decode.
 */
import { CommandId, PlayerId, Revision, WorldId } from '../protocol/identifiers.js'
import { Schema } from 'effect'

const MIN_ITEM_NAME_LENGTH = 1

/** Mirrors `@nerima-games/mx-gameplay`'s `ENCHANTMENT_IDS`. Not imported — see the file header. */
export const EnchantmentId: Schema.Literal<
  ['protection', 'sharpness', 'efficiency', 'unbreaking', 'fortune', 'power']
> = Schema.Literal('protection', 'sharpness', 'efficiency', 'unbreaking', 'fortune', 'power')
export type EnchantmentId = typeof EnchantmentId.Type

const strictShape = { parseOptions: { onExcessProperty: 'error' as const } }

/** Mirrors `@nerima-games/mx-gameplay`'s `Enchantment`. Not imported — see the file header. */
export const Enchantment: Schema.Struct<{
  id: typeof EnchantmentId
  level: Schema.filter<Schema.filter<typeof Schema.Number>>
}> = Schema.Struct({
  id: EnchantmentId,
  level: Schema.Number.pipe(Schema.int(), Schema.positive()),
}).annotations(strictShape)
export type Enchantment = typeof Enchantment.Type

/** Mirrors `@nerima-games/mc-sim`'s `Durability`, the same shape `protocol.ts`'s `ItemStack.durability` already mirrors. */
const EnchantedItemDurability: Schema.Struct<{
  current: Schema.filter<Schema.filter<typeof Schema.Number>>
  max: Schema.filter<Schema.filter<typeof Schema.Number>>
}> = Schema.Struct({
  current: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
  max: Schema.Number.pipe(Schema.int(), Schema.positive()),
}).annotations(strictShape)

/**
 * Mirrors `@nerima-games/mx-gameplay`'s `EnchantedItem`. Not imported — see
 * the file header. `item` is an opaque non-empty string, the same choice
 * `protocol/crafting.ts` makes for the same reason (see that file's header).
 */
export const EnchantedItem: Schema.Struct<{
  durability: Schema.NullOr<typeof EnchantedItemDurability>
  enchantments: Schema.Array$<typeof Enchantment>
  item: Schema.filter<typeof Schema.String>
}> = Schema.Struct({
  durability: Schema.NullOr(EnchantedItemDurability),
  enchantments: Schema.Array(Enchantment),
  item: Schema.String.pipe(Schema.minLength(MIN_ITEM_NAME_LENGTH)),
}).annotations(strictShape)
export type EnchantedItem = typeof EnchantedItem.Type

const ENCHANTING_SLOT_COUNT = 36

export const EnchantingSlotIndex: Schema.filter<Schema.filter<typeof Schema.Number>> = Schema.Number.pipe(
  Schema.int(),
  Schema.nonNegative(),
  Schema.lessThan(ENCHANTING_SLOT_COUNT),
)
export type EnchantingSlotIndex = typeof EnchantingSlotIndex.Type

/** An enchanting table always rolls exactly three offers; a player picks one by index. */
const OFFER_INDEX_FIRST = 0
const OFFER_INDEX_SECOND = 1
const OFFER_INDEX_THIRD = 2
export const EnchantingOfferIndex: Schema.Literal<[typeof OFFER_INDEX_FIRST, typeof OFFER_INDEX_SECOND, typeof OFFER_INDEX_THIRD]> =
  Schema.Literal(OFFER_INDEX_FIRST, OFFER_INDEX_SECOND, OFFER_INDEX_THIRD)
export type EnchantingOfferIndex = typeof EnchantingOfferIndex.Type

export const EnchantingCommand: Schema.TaggedStruct<
  'EnchantingCommand',
  {
    commandId: typeof CommandId
    expectedRevision: typeof Revision
    offer: typeof EnchantingOfferIndex
    player: typeof PlayerId
    slot: typeof EnchantingSlotIndex
    world: typeof WorldId
  }
> = Schema.TaggedStruct('EnchantingCommand', {
  commandId: CommandId,
  expectedRevision: Revision,
  offer: EnchantingOfferIndex,
  player: PlayerId,
  slot: EnchantingSlotIndex,
  world: WorldId,
})
export type EnchantingCommand = typeof EnchantingCommand.Type

export const EnchantingRejectionReason: Schema.Literal<
  [
    'stale-revision',
    'unauthorized-player',
    'wrong-world',
    'invalid-command',
    'no-item',
    'invalid-item',
    'incompatible-item',
    'conflicting-enchantment',
    'insufficient-level',
    'insufficient-lapis',
  ]
> = Schema.Literal(
  'stale-revision',
  'unauthorized-player',
  'wrong-world',
  'invalid-command',
  'no-item',
  'invalid-item',
  'incompatible-item',
  'conflicting-enchantment',
  'insufficient-level',
  'insufficient-lapis',
)
export type EnchantingRejectionReason = typeof EnchantingRejectionReason.Type

export const EnchantingCommandAccepted: Schema.TaggedStruct<
  'EnchantingCommandAccepted',
  { commandId: typeof CommandId; revision: typeof Revision }
> = Schema.TaggedStruct('EnchantingCommandAccepted', {
  commandId: CommandId,
  revision: Revision,
})
export type EnchantingCommandAccepted = typeof EnchantingCommandAccepted.Type

export const EnchantingCommandRejected: Schema.TaggedStruct<
  'EnchantingCommandRejected',
  { commandId: typeof CommandId; reason: typeof EnchantingRejectionReason; revision: typeof Revision }
> = Schema.TaggedStruct('EnchantingCommandRejected', {
  commandId: CommandId,
  reason: EnchantingRejectionReason,
  revision: Revision,
})
export type EnchantingCommandRejected = typeof EnchantingCommandRejected.Type

export const EnchantingCommandResult: Schema.Union<
  [typeof EnchantingCommandAccepted, typeof EnchantingCommandRejected]
> = Schema.Union(EnchantingCommandAccepted, EnchantingCommandRejected)
export type EnchantingCommandResult = typeof EnchantingCommandResult.Type

const EnchantedSlotEntry: Schema.Struct<{ item: typeof EnchantedItem; slot: typeof EnchantingSlotIndex }> = Schema.Struct({
  item: EnchantedItem,
  slot: EnchantingSlotIndex,
})

/**
 * All of one player's enchanted items, plus the seed their next enchanting
 * roll should use — the seed travels with the delta because the roll is
 * server-authoritative and must reproduce identically for a reconnecting
 * client, not be re-rolled locally.
 */
export const PlayerEnchantmentsDelta: Schema.TaggedStruct<
  'PlayerEnchantmentsDelta',
  {
    items: Schema.Array$<typeof EnchantedSlotEntry>
    player: typeof PlayerId
    revision: typeof Revision
    seed: Schema.filter<Schema.filter<typeof Schema.Number>>
    world: typeof WorldId
  }
> = Schema.TaggedStruct('PlayerEnchantmentsDelta', {
  items: Schema.Array(EnchantedSlotEntry),
  player: PlayerId,
  revision: Revision,
  seed: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
  world: WorldId,
})
export type PlayerEnchantmentsDelta = typeof PlayerEnchantmentsDelta.Type

/** Every message this module contributes to the shared `NetworkMessage` union. */
export const EnchantingMessage: Schema.Union<
  [
    typeof EnchantingCommand,
    typeof EnchantingCommandAccepted,
    typeof EnchantingCommandRejected,
    typeof PlayerEnchantmentsDelta,
  ]
> = Schema.Union(EnchantingCommand, EnchantingCommandAccepted, EnchantingCommandRejected, PlayerEnchantmentsDelta)
export type EnchantingMessage = typeof EnchantingMessage.Type

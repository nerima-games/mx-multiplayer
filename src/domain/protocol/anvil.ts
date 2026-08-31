/**
 * Anvil renaming: the one command an anvil accepts, and its result.
 *
 * Lowered from the composing app's `multiplayer-shared/anvil-network.ts`. That
 * file hand-rolled its own JSON decoder (`isRecord` / `hasExactlyKeys` /
 * manual field checks) around a single `_tag: 'AnvilCommandResult'` carrying
 * an `accepted` boolean. Here the accepted/rejected split becomes two tagged
 * variants unioned into `AnvilCommandResult` — the same shape
 * `AuthoritativeCommandAccepted` / `AuthoritativeCommandRejected` already use
 * in `protocol.ts` — so this domain does not invent a second convention for
 * the same idea, and the shared `codec.ts` gets the decoding for free instead
 * of a bespoke parser.
 */
import { CommandId, PlayerId, Revision, WorldId } from '../protocol/identifiers.js'
import { Schema } from 'effect'

/** Anvils have 36 slots; the renamed item always sits in the first (input) slot in the reference implementation's layout. */
const ANVIL_SLOT_COUNT = 36
const ANVIL_MAX_NAME_LENGTH = 50

export const AnvilSlotIndex: Schema.filter<Schema.filter<typeof Schema.Number>> = Schema.Number.pipe(
  Schema.int(),
  Schema.nonNegative(),
  Schema.lessThan(ANVIL_SLOT_COUNT),
)
export type AnvilSlotIndex = typeof AnvilSlotIndex.Type

/** Empty is a legal rename target (clearing a custom name back to the item's default). */
export const AnvilItemName: Schema.filter<typeof Schema.String> = Schema.String.pipe(
  Schema.maxLength(ANVIL_MAX_NAME_LENGTH),
)
export type AnvilItemName = typeof AnvilItemName.Type

export const AnvilCommand: Schema.TaggedStruct<
  'AnvilCommand',
  {
    commandId: typeof CommandId
    expectedRevision: typeof Revision
    name: typeof AnvilItemName
    player: typeof PlayerId
    slot: typeof AnvilSlotIndex
    world: typeof WorldId
  }
> = Schema.TaggedStruct('AnvilCommand', {
  commandId: CommandId,
  expectedRevision: Revision,
  name: AnvilItemName,
  player: PlayerId,
  slot: AnvilSlotIndex,
  world: WorldId,
})
export type AnvilCommand = typeof AnvilCommand.Type

export const AnvilRejectionReason: Schema.Literal<
  [
    'stale-revision',
    'unauthorized-player',
    'wrong-world',
    'invalid-command',
    'no-item',
    'no-change',
    'missing-iron',
    'insufficient-experience',
  ]
> = Schema.Literal(
  'stale-revision',
  'unauthorized-player',
  'wrong-world',
  'invalid-command',
  'no-item',
  'no-change',
  'missing-iron',
  'insufficient-experience',
)
export type AnvilRejectionReason = typeof AnvilRejectionReason.Type

export const AnvilCommandAccepted: Schema.TaggedStruct<
  'AnvilCommandAccepted',
  { commandId: typeof CommandId; revision: typeof Revision }
> = Schema.TaggedStruct('AnvilCommandAccepted', {
  commandId: CommandId,
  revision: Revision,
})
export type AnvilCommandAccepted = typeof AnvilCommandAccepted.Type

export const AnvilCommandRejected: Schema.TaggedStruct<
  'AnvilCommandRejected',
  { commandId: typeof CommandId; reason: typeof AnvilRejectionReason; revision: typeof Revision }
> = Schema.TaggedStruct('AnvilCommandRejected', {
  commandId: CommandId,
  reason: AnvilRejectionReason,
  revision: Revision,
})
export type AnvilCommandRejected = typeof AnvilCommandRejected.Type

export const AnvilCommandResult: Schema.Union<[typeof AnvilCommandAccepted, typeof AnvilCommandRejected]> = Schema.Union(
  AnvilCommandAccepted,
  AnvilCommandRejected,
)
export type AnvilCommandResult = typeof AnvilCommandResult.Type

const AnvilNameEntry: Schema.Struct<{ name: typeof AnvilItemName; slot: typeof AnvilSlotIndex }> = Schema.Struct({
  name: AnvilItemName,
  slot: AnvilSlotIndex,
})

/**
 * All of one player's currently-renamed anvil slots, as an authoritative
 * delta. `names` omits any slot at its default name — an empty array means
 * "nothing renamed", not "no anvils".
 */
export const PlayerAnvilNamesDelta: Schema.TaggedStruct<
  'PlayerAnvilNamesDelta',
  { names: Schema.Array$<typeof AnvilNameEntry>; player: typeof PlayerId; revision: typeof Revision; world: typeof WorldId }
> = Schema.TaggedStruct('PlayerAnvilNamesDelta', {
  names: Schema.Array(AnvilNameEntry),
  player: PlayerId,
  revision: Revision,
  world: WorldId,
})
export type PlayerAnvilNamesDelta = typeof PlayerAnvilNamesDelta.Type

/** Every message this module contributes to the shared `NetworkMessage` union. */
export const AnvilMessage: Schema.Union<
  [typeof AnvilCommand, typeof AnvilCommandAccepted, typeof AnvilCommandRejected, typeof PlayerAnvilNamesDelta]
> = Schema.Union(AnvilCommand, AnvilCommandAccepted, AnvilCommandRejected, PlayerAnvilNamesDelta)
export type AnvilMessage = typeof AnvilMessage.Type

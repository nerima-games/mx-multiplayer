/**
 * Crafting-grid submission: a player proposes a grid of items, the server
 * resolves the recipe.
 *
 * Lowered from the composing app's `multiplayer-shared/crafting-network.ts`.
 * That file typed a cell as `@nerima-games/mc-kernel`'s `ItemType` literal
 * union directly. Here a cell is an opaque non-empty string, the same choice
 * `protocol.ts` already makes for `BlockPlace.block`: a peer running a newer
 * build that knows an item type this build does not must still produce a
 * decodable frame, which this build then rejects as unknown *content*, not a
 * malformed *frame*. Typing the wire as the literal union would turn "your
 * client is older than mine" into a parse error instead.
 */
import { CommandId, PlayerId, Revision, WorldId } from '../protocol/identifiers.js'
import { Schema } from 'effect'

const MIN_ITEM_NAME_LENGTH = 1
/** A crafting grid is either the inventory's 2x2 pocket grid or a crafting table's 3x3. */
const POCKET_GRID_SIZE = 2
const TABLE_GRID_SIZE = 3

/** An opaque item-type name; see the file header for why this is not kernel's `ItemType` literal union. */
export const CraftingItemName: Schema.filter<typeof Schema.String> = Schema.String.pipe(
  Schema.minLength(MIN_ITEM_NAME_LENGTH),
)
export type CraftingItemName = typeof CraftingItemName.Type

export const CraftingGridSize: Schema.Literal<[typeof POCKET_GRID_SIZE, typeof TABLE_GRID_SIZE]> = Schema.Literal(
  POCKET_GRID_SIZE,
  TABLE_GRID_SIZE,
)
export type CraftingGridSize = typeof CraftingGridSize.Type

const strictGrid = { parseOptions: { onExcessProperty: 'error' as const } }

/**
 * A square crafting grid: `cells.length` must equal `width * height`, read
 * row-major. That invariant is cross-field, so `Schema.filter` checks it
 * after the struct's own fields decode — a malformed cell count is rejected
 * as `malformed-frame` at the codec boundary, the same as any other invalid
 * frame, rather than reaching a consumer that must re-derive the invariant.
 */
export const CraftingGrid: Schema.filter<
  Schema.Struct<{ cells: Schema.Array$<Schema.NullOr<typeof CraftingItemName>>; height: typeof CraftingGridSize; width: typeof CraftingGridSize }>
> = Schema.Struct({
  cells: Schema.Array(Schema.NullOr(CraftingItemName)),
  height: CraftingGridSize,
  width: CraftingGridSize,
}).pipe(
  Schema.filter((grid) => grid.cells.length === grid.width * grid.height || 'cells.length must equal width * height'),
  Schema.annotations(strictGrid),
)
export type CraftingGrid = typeof CraftingGrid.Type

export const CraftingCommand: Schema.TaggedStruct<
  'CraftingCommand',
  { commandId: typeof CommandId; expectedRevision: typeof Revision; grid: typeof CraftingGrid; player: typeof PlayerId; world: typeof WorldId }
> = Schema.TaggedStruct('CraftingCommand', {
  commandId: CommandId,
  expectedRevision: Revision,
  grid: CraftingGrid,
  player: PlayerId,
  world: WorldId,
})
export type CraftingCommand = typeof CraftingCommand.Type

export const CraftingRejectionReason: Schema.Literal<
  ['stale-revision', 'unauthorized-player', 'wrong-world', 'invalid-command', 'no-match', 'missing-ingredients', 'no-room']
> = Schema.Literal(
  'stale-revision',
  'unauthorized-player',
  'wrong-world',
  'invalid-command',
  'no-match',
  'missing-ingredients',
  'no-room',
)
export type CraftingRejectionReason = typeof CraftingRejectionReason.Type

export const CraftingCommandAccepted: Schema.TaggedStruct<
  'CraftingCommandAccepted',
  { commandId: typeof CommandId; revision: typeof Revision }
> = Schema.TaggedStruct('CraftingCommandAccepted', {
  commandId: CommandId,
  revision: Revision,
})
export type CraftingCommandAccepted = typeof CraftingCommandAccepted.Type

export const CraftingCommandRejected: Schema.TaggedStruct<
  'CraftingCommandRejected',
  { commandId: typeof CommandId; reason: typeof CraftingRejectionReason; revision: typeof Revision }
> = Schema.TaggedStruct('CraftingCommandRejected', {
  commandId: CommandId,
  reason: CraftingRejectionReason,
  revision: Revision,
})
export type CraftingCommandRejected = typeof CraftingCommandRejected.Type

export const CraftingCommandResult: Schema.Union<[typeof CraftingCommandAccepted, typeof CraftingCommandRejected]> =
  Schema.Union(CraftingCommandAccepted, CraftingCommandRejected)
export type CraftingCommandResult = typeof CraftingCommandResult.Type

/** Every message this module contributes to the shared `NetworkMessage` union. */
export const CraftingMessage: Schema.Union<
  [typeof CraftingCommand, typeof CraftingCommandAccepted, typeof CraftingCommandRejected]
> = Schema.Union(CraftingCommand, CraftingCommandAccepted, CraftingCommandRejected)
export type CraftingMessage = typeof CraftingMessage.Type

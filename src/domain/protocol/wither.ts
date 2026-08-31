/**
 * Wither boss-fight commands, and the server's runtime snapshot of every
 * active wither and wither skull.
 *
 * Lowered from the composing app's `multiplayer-shared/wither-network.ts` —
 * the WIRE FORMAT only. That file's `RuntimeWitherSkull` / `WitherRuntimeSnapshot`
 * types came from its sibling `multiplayer-shared/wither-runtime.ts`, which is
 * being lowered to `@nerima-games/mx-gameplay` separately (the runtime half of
 * the boss fight is a game rule; this repository only carries what crosses
 * the wire).
 *
 * Every shape below is MIRRORED, not imported, including from
 * `@nerima-games/mc-sim` even though that package is on this repository's
 * allowed-dependency list (`.oxlintrc.json`'s `no-restricted-imports`). Being
 * Tier-allowed answers a different question than the one that matters here —
 * see `protocol/brewing.ts`'s file header for the argument: a wire format
 * that imported `mc-sim`'s `WitherState` would let an unrelated `mc-sim`
 * refactor silently change what this build can decode, the exact failure a
 * protocol version exists to make loud. `protocol.ts` itself makes the same
 * call for `Vec3` against `mc-kernel`, its most permissive possible source.
 */
import { CommandId, PlayerId, Revision } from '../protocol/identifiers.js'
import { Schema } from 'effect'

const MIN_NON_EMPTY_LENGTH = 1
const strictShape = { parseOptions: { onExcessProperty: 'error' as const } }

/** A continuous position, the same shape as `protocol.ts`'s `Vec3` (re-declared, not imported — see the file header). */
const WitherPosition: Schema.Struct<{
  x: Schema.filter<typeof Schema.Number>
  y: Schema.filter<typeof Schema.Number>
  z: Schema.filter<typeof Schema.Number>
}> = Schema.Struct({
  x: Schema.Number.pipe(Schema.finite()),
  y: Schema.Number.pipe(Schema.finite()),
  z: Schema.Number.pipe(Schema.finite()),
})

/** Mirrors `@nerima-games/mc-sim`'s `WitherPhase`. Not imported — see the file header. */
export const WitherPhase: Schema.Literal<['charging', 'airborne', 'armoured', 'dead']> = Schema.Literal(
  'charging',
  'airborne',
  'armoured',
  'dead',
)
export type WitherPhase = typeof WitherPhase.Type

/** Mirrors `@nerima-games/mc-sim`'s `WitherDamageKind`. Not imported — see the file header. */
export const WitherDamageKind: Schema.Literal<['melee', 'ranged', 'magic', 'explosion', 'void']> = Schema.Literal(
  'melee',
  'ranged',
  'magic',
  'explosion',
  'void',
)
export type WitherDamageKind = typeof WitherDamageKind.Type

/** Mirrors `@nerima-games/mc-sim`'s `WitherSkullVariant`. Not imported — see the file header. */
export const WitherSkullVariant: Schema.Literal<['normal', 'blue']> = Schema.Literal('normal', 'blue')
export type WitherSkullVariant = typeof WitherSkullVariant.Type

/** Mirrors `@nerima-games/mc-sim`'s `WITHER_MAX_HEALTH`. Not imported — see the file header. */
const WITHER_MAX_HEALTH = 300

/** Mirrors `@nerima-games/mc-sim`'s `WitherState`. Not imported — see the file header. */
const WitherState: Schema.Struct<{
  chargeRemainingSecs: Schema.filter<Schema.filter<typeof Schema.Number>>
  feetPosition: typeof WitherPosition
  healthPoints: Schema.filter<Schema.filter<typeof Schema.Number>>
  phase: typeof WitherPhase
  velocity: typeof WitherPosition
}> = Schema.Struct({
  chargeRemainingSecs: Schema.Number.pipe(Schema.finite(), Schema.nonNegative()),
  feetPosition: WitherPosition,
  healthPoints: Schema.Number.pipe(Schema.finite(), Schema.nonNegative(), Schema.lessThanOrEqualTo(WITHER_MAX_HEALTH)),
  phase: WitherPhase,
  velocity: WitherPosition,
}).annotations(strictShape)

/** Mirrors `@nerima-games/mc-sim`'s `WitherSkullProjectileDescriptor`. Not imported — see the file header. */
const WitherSkullDescriptor: Schema.Struct<{
  destroysResistantBlocks: typeof Schema.Boolean
  direction: typeof WitherPosition
  explosivePower: Schema.filter<Schema.filter<typeof Schema.Number>>
  origin: typeof WitherPosition
  speed: Schema.filter<Schema.filter<typeof Schema.Number>>
  variant: typeof WitherSkullVariant
}> = Schema.Struct({
  destroysResistantBlocks: Schema.Boolean,
  direction: WitherPosition,
  explosivePower: Schema.Number.pipe(Schema.finite(), Schema.positive()),
  origin: WitherPosition,
  speed: Schema.Number.pipe(Schema.finite(), Schema.positive()),
  variant: WitherSkullVariant,
}).annotations(strictShape)

const WitherEntryId: Schema.filter<typeof Schema.String> = Schema.String.pipe(Schema.minLength(MIN_NON_EMPTY_LENGTH))
const WitherDimension: Schema.filter<typeof Schema.String> = Schema.String.pipe(Schema.minLength(MIN_NON_EMPTY_LENGTH))

/** Mirrors one entry of the composing app's `WitherRuntimeSnapshot.withers`. Not imported — see the file header. */
const RuntimeWitherEntry: Schema.Struct<{
  dimension: typeof WitherDimension
  id: typeof WitherEntryId
  meleeCooldownSecs: Schema.filter<Schema.filter<typeof Schema.Number>>
  rangedCooldownSecs: Schema.filter<Schema.filter<typeof Schema.Number>>
  shotsFired: Schema.filter<Schema.filter<typeof Schema.Number>>
  state: typeof WitherState
}> = Schema.Struct({
  dimension: WitherDimension,
  id: WitherEntryId,
  meleeCooldownSecs: Schema.Number.pipe(Schema.finite(), Schema.nonNegative()),
  rangedCooldownSecs: Schema.Number.pipe(Schema.finite(), Schema.nonNegative()),
  shotsFired: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
  state: WitherState,
}).annotations(strictShape)

/** Mirrors the composing app's `RuntimeWitherSkull`. Not imported — see the file header. */
const RuntimeWitherSkullEntry: Schema.Struct<{
  ageSecs: Schema.filter<Schema.filter<typeof Schema.Number>>
  descriptor: typeof WitherSkullDescriptor
  dimension: typeof WitherDimension
  id: typeof WitherEntryId
  ownerId: typeof WitherEntryId
  position: typeof WitherPosition
}> = Schema.Struct({
  ageSecs: Schema.Number.pipe(Schema.finite(), Schema.nonNegative()),
  descriptor: WitherSkullDescriptor,
  dimension: WitherDimension,
  id: WitherEntryId,
  ownerId: WitherEntryId,
  position: WitherPosition,
}).annotations(strictShape)

/** Mirrors the composing app's `WitherRuntimeSnapshot`. Not imported — see the file header. */
export const WitherRuntimeSnapshot: Schema.Struct<{
  nextSkullId: Schema.filter<Schema.filter<typeof Schema.Number>>
  nextWitherId: Schema.filter<Schema.filter<typeof Schema.Number>>
  skulls: Schema.Array$<typeof RuntimeWitherSkullEntry>
  withers: Schema.Array$<typeof RuntimeWitherEntry>
}> = Schema.Struct({
  nextSkullId: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
  nextWitherId: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
  skulls: Schema.Array(RuntimeWitherSkullEntry),
  withers: Schema.Array(RuntimeWitherEntry),
}).annotations(strictShape)
export type WitherRuntimeSnapshot = typeof WitherRuntimeSnapshot.Type

export const SummonWitherCommand: Schema.TaggedStruct<
  'SummonWitherCommand',
  {
    commandId: typeof CommandId
    dimension: typeof WitherDimension
    expectedRevision: typeof Revision
    player: typeof PlayerId
    position: typeof WitherPosition
  }
> = Schema.TaggedStruct('SummonWitherCommand', {
  commandId: CommandId,
  dimension: WitherDimension,
  expectedRevision: Revision,
  player: PlayerId,
  position: WitherPosition,
})
export type SummonWitherCommand = typeof SummonWitherCommand.Type

export const DamageWitherCommand: Schema.TaggedStruct<
  'DamageWitherCommand',
  {
    amount: Schema.filter<Schema.filter<typeof Schema.Number>>
    commandId: typeof CommandId
    expectedRevision: typeof Revision
    kind: typeof WitherDamageKind
    player: typeof PlayerId
    witherId: typeof WitherEntryId
  }
> = Schema.TaggedStruct('DamageWitherCommand', {
  amount: Schema.Number.pipe(Schema.finite(), Schema.positive()),
  commandId: CommandId,
  expectedRevision: Revision,
  kind: WitherDamageKind,
  player: PlayerId,
  witherId: WitherEntryId,
})
export type DamageWitherCommand = typeof DamageWitherCommand.Type

export const WitherCommand: Schema.Union<[typeof SummonWitherCommand, typeof DamageWitherCommand]> = Schema.Union(
  SummonWitherCommand,
  DamageWitherCommand,
)
export type WitherCommand = typeof WitherCommand.Type

export const WitherRejectionReason: Schema.Literal<['stale-revision', 'invalid-command']> = Schema.Literal(
  'stale-revision',
  'invalid-command',
)
export type WitherRejectionReason = typeof WitherRejectionReason.Type

export const WitherCommandAccepted: Schema.TaggedStruct<
  'WitherCommandAccepted',
  { commandId: typeof CommandId; revision: typeof Revision }
> = Schema.TaggedStruct('WitherCommandAccepted', {
  commandId: CommandId,
  revision: Revision,
})
export type WitherCommandAccepted = typeof WitherCommandAccepted.Type

export const WitherCommandRejected: Schema.TaggedStruct<
  'WitherCommandRejected',
  { commandId: typeof CommandId; reason: typeof WitherRejectionReason; revision: typeof Revision }
> = Schema.TaggedStruct('WitherCommandRejected', {
  commandId: CommandId,
  reason: WitherRejectionReason,
  revision: Revision,
})
export type WitherCommandRejected = typeof WitherCommandRejected.Type

export const WitherCommandResult: Schema.Union<[typeof WitherCommandAccepted, typeof WitherCommandRejected]> = Schema.Union(
  WitherCommandAccepted,
  WitherCommandRejected,
)
export type WitherCommandResult = typeof WitherCommandResult.Type

export const WitherSnapshotDelta: Schema.TaggedStruct<
  'WitherSnapshotDelta',
  { revision: typeof Revision; snapshot: typeof WitherRuntimeSnapshot }
> = Schema.TaggedStruct('WitherSnapshotDelta', {
  revision: Revision,
  snapshot: WitherRuntimeSnapshot,
})
export type WitherSnapshotDelta = typeof WitherSnapshotDelta.Type

/** Every message this module contributes to the shared `NetworkMessage` union. */
export const WitherMessage: Schema.Union<
  [typeof SummonWitherCommand, typeof DamageWitherCommand, typeof WitherCommandAccepted, typeof WitherCommandRejected, typeof WitherSnapshotDelta]
> = Schema.Union(SummonWitherCommand, DamageWitherCommand, WitherCommandAccepted, WitherCommandRejected, WitherSnapshotDelta)
export type WitherMessage = typeof WitherMessage.Type

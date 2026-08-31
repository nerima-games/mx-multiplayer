/**
 * The Ender Dragon encounter: a player-submitted damage request, and the
 * authoritative encounter snapshot.
 *
 * Lowered from the composing app's `multiplayer-shared/ender-dragon-network.ts`.
 *
 * `EnderDragonEncounterSnapshot` is MIRRORED here, not imported from
 * `@nerima-games/mx-gameplay` — same reasoning as `protocol/brewing.ts`'s file
 * header. The mirror covers the STRUCTURAL shape (phase, health range, timer,
 * reward flag) that a malformed or truncated frame must fail on; it does not
 * repeat `mx-gameplay`'s cross-field consistency rule (dead ⇔ zero health and
 * an emitted reward) — that is a game-state invariant the authority enforces
 * when it constructs a snapshot, not a wire-frame shape a peer could violate
 * independently of the fields already being individually valid. The original
 * `actor` / `requestId` fields are renamed to `player` / `commandId` to match
 * every other command header in this protocol; there is no `world` field
 * because the Ender Dragon exists in exactly one realm, unlike everything
 * else here that names one explicitly.
 */
import { CommandId, PlayerId, Revision } from '../protocol/identifiers.js'
import { Schema } from 'effect'

/** Mirrors `@nerima-games/mx-gameplay`'s `ENDER_DRAGON_MAX_HEALTH`. Not imported — see the file header. */
const ENDER_DRAGON_MAX_HEALTH = 200

const strictShape = { parseOptions: { onExcessProperty: 'error' as const } }

/** Mirrors `@nerima-games/mx-gameplay`'s `EnderDragonPhaseSchema`. Not imported — see the file header. */
export const EnderDragonPhase: Schema.Literal<['circling', 'perching', 'charging', 'dead']> = Schema.Literal(
  'circling',
  'perching',
  'charging',
  'dead',
)
export type EnderDragonPhase = typeof EnderDragonPhase.Type

/** Mirrors `@nerima-games/mx-gameplay`'s `EnderDragonEncounterSnapshotSchema`. Not imported — see the file header. */
export const EnderDragonEncounterSnapshot: Schema.Struct<{
  health: Schema.filter<Schema.filter<typeof Schema.Number>>
  phase: typeof EnderDragonPhase
  phaseTimerSecs: Schema.filter<typeof Schema.Number>
  rewardEmitted: typeof Schema.Boolean
}> = Schema.Struct({
  health: Schema.Number.pipe(Schema.finite(), Schema.nonNegative(), Schema.lessThanOrEqualTo(ENDER_DRAGON_MAX_HEALTH)),
  phase: EnderDragonPhase,
  phaseTimerSecs: Schema.Number.pipe(Schema.finite(), Schema.nonNegative()),
  rewardEmitted: Schema.Boolean,
}).annotations(strictShape)
export type EnderDragonEncounterSnapshot = typeof EnderDragonEncounterSnapshot.Type

export const DamageEnderDragonCommand: Schema.TaggedStruct<
  'DamageEnderDragonCommand',
  { commandId: typeof CommandId; expectedRevision: typeof Revision; player: typeof PlayerId }
> = Schema.TaggedStruct('DamageEnderDragonCommand', {
  commandId: CommandId,
  expectedRevision: Revision,
  player: PlayerId,
})
export type DamageEnderDragonCommand = typeof DamageEnderDragonCommand.Type

export const EnderDragonRejectionReason: Schema.Literal<['stale-revision', 'invalid-command']> = Schema.Literal(
  'stale-revision',
  'invalid-command',
)
export type EnderDragonRejectionReason = typeof EnderDragonRejectionReason.Type

export const DamageEnderDragonCommandAccepted: Schema.TaggedStruct<
  'DamageEnderDragonCommandAccepted',
  { commandId: typeof CommandId; revision: typeof Revision }
> = Schema.TaggedStruct('DamageEnderDragonCommandAccepted', {
  commandId: CommandId,
  revision: Revision,
})
export type DamageEnderDragonCommandAccepted = typeof DamageEnderDragonCommandAccepted.Type

export const DamageEnderDragonCommandRejected: Schema.TaggedStruct<
  'DamageEnderDragonCommandRejected',
  { commandId: typeof CommandId; reason: typeof EnderDragonRejectionReason; revision: typeof Revision }
> = Schema.TaggedStruct('DamageEnderDragonCommandRejected', {
  commandId: CommandId,
  reason: EnderDragonRejectionReason,
  revision: Revision,
})
export type DamageEnderDragonCommandRejected = typeof DamageEnderDragonCommandRejected.Type

export const DamageEnderDragonCommandResult: Schema.Union<
  [typeof DamageEnderDragonCommandAccepted, typeof DamageEnderDragonCommandRejected]
> = Schema.Union(DamageEnderDragonCommandAccepted, DamageEnderDragonCommandRejected)
export type DamageEnderDragonCommandResult = typeof DamageEnderDragonCommandResult.Type

export const EnderDragonSnapshotDelta: Schema.TaggedStruct<
  'EnderDragonSnapshotDelta',
  { revision: typeof Revision; snapshot: typeof EnderDragonEncounterSnapshot }
> = Schema.TaggedStruct('EnderDragonSnapshotDelta', {
  revision: Revision,
  snapshot: EnderDragonEncounterSnapshot,
})
export type EnderDragonSnapshotDelta = typeof EnderDragonSnapshotDelta.Type

/** Every message this module contributes to the shared `NetworkMessage` union. */
export const EnderDragonMessage: Schema.Union<
  [
    typeof DamageEnderDragonCommand,
    typeof DamageEnderDragonCommandAccepted,
    typeof DamageEnderDragonCommandRejected,
    typeof EnderDragonSnapshotDelta,
  ]
> = Schema.Union(
  DamageEnderDragonCommand,
  DamageEnderDragonCommandAccepted,
  DamageEnderDragonCommandRejected,
  EnderDragonSnapshotDelta,
)
export type EnderDragonMessage = typeof EnderDragonMessage.Type

/**
 * A client-observed damage event, submitted for authoritative confirmation.
 *
 * Lowered from the composing app's `multiplayer-shared/player-damage-network.ts`.
 */
import { CommandId, PlayerId, Revision, WorldId } from '../protocol/identifiers.js'
import { Schema } from 'effect'

/** No vanilla damage source deals more than a full 10 hearts in one hit. */
const PLAYER_DAMAGE_MAX_AMOUNT = 20
/** `minimumHealthPoints` caps at one heart: a damage source that cannot kill still leaves the player alive. */
const PLAYER_DAMAGE_MAX_MINIMUM_HEALTH_POINTS = 1

export const PlayerDamageAmount: Schema.filter<Schema.filter<Schema.filter<typeof Schema.Number>>> = Schema.Number.pipe(
  Schema.finite(),
  Schema.positive(),
  Schema.lessThanOrEqualTo(PLAYER_DAMAGE_MAX_AMOUNT),
)
export type PlayerDamageAmount = typeof PlayerDamageAmount.Type

export const PlayerDamageMinimumHealth: Schema.filter<Schema.filter<Schema.filter<typeof Schema.Number>>> = Schema.Number.pipe(
  Schema.finite(),
  Schema.nonNegative(),
  Schema.lessThanOrEqualTo(PLAYER_DAMAGE_MAX_MINIMUM_HEALTH_POINTS),
)
export type PlayerDamageMinimumHealth = typeof PlayerDamageMinimumHealth.Type

export const PlayerDamageCommand: Schema.TaggedStruct<
  'PlayerDamageCommand',
  {
    amount: typeof PlayerDamageAmount
    commandId: typeof CommandId
    expectedRevision: typeof Revision
    minimumHealthPoints: Schema.optional<typeof PlayerDamageMinimumHealth>
    player: typeof PlayerId
    world: typeof WorldId
  }
> = Schema.TaggedStruct('PlayerDamageCommand', {
  amount: PlayerDamageAmount,
  commandId: CommandId,
  expectedRevision: Revision,
  /** Fall damage and similar sources that cannot reduce health below one point. Absent for lethal-capable sources. */
  minimumHealthPoints: Schema.optional(PlayerDamageMinimumHealth),
  player: PlayerId,
  world: WorldId,
})
export type PlayerDamageCommand = typeof PlayerDamageCommand.Type

export const PlayerDamageRejectionReason: Schema.Literal<
  ['stale-revision', 'unauthorized-player', 'wrong-world', 'invalid-command']
> = Schema.Literal('stale-revision', 'unauthorized-player', 'wrong-world', 'invalid-command')
export type PlayerDamageRejectionReason = typeof PlayerDamageRejectionReason.Type

export const PlayerDamageCommandAccepted: Schema.TaggedStruct<
  'PlayerDamageCommandAccepted',
  { commandId: typeof CommandId; revision: typeof Revision }
> = Schema.TaggedStruct('PlayerDamageCommandAccepted', {
  commandId: CommandId,
  revision: Revision,
})
export type PlayerDamageCommandAccepted = typeof PlayerDamageCommandAccepted.Type

export const PlayerDamageCommandRejected: Schema.TaggedStruct<
  'PlayerDamageCommandRejected',
  { commandId: typeof CommandId; reason: typeof PlayerDamageRejectionReason; revision: typeof Revision }
> = Schema.TaggedStruct('PlayerDamageCommandRejected', {
  commandId: CommandId,
  reason: PlayerDamageRejectionReason,
  revision: Revision,
})
export type PlayerDamageCommandRejected = typeof PlayerDamageCommandRejected.Type

export const PlayerDamageCommandResult: Schema.Union<
  [typeof PlayerDamageCommandAccepted, typeof PlayerDamageCommandRejected]
> = Schema.Union(PlayerDamageCommandAccepted, PlayerDamageCommandRejected)
export type PlayerDamageCommandResult = typeof PlayerDamageCommandResult.Type

/** Every message this module contributes to the shared `NetworkMessage` union. */
export const PlayerDamageMessage: Schema.Union<
  [typeof PlayerDamageCommand, typeof PlayerDamageCommandAccepted, typeof PlayerDamageCommandRejected]
> = Schema.Union(PlayerDamageCommand, PlayerDamageCommandAccepted, PlayerDamageCommandRejected)
export type PlayerDamageMessage = typeof PlayerDamageMessage.Type

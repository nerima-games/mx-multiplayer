/**
 * A client request for server-side damage resolution. Damage magnitudes and
 * survival floors are not part of the wire command.
 *
 * Lowered from the composing app's `multiplayer-shared/player-damage-network.ts`.
 */
import { CommandId, PlayerId, Revision, WorldId } from '../protocol/identifiers.js'
import { Schema } from 'effect'

export const PlayerDamageCommand: Schema.TaggedStruct<
  'PlayerDamageCommand',
  {
    commandId: typeof CommandId
    expectedRevision: typeof Revision
    player: typeof PlayerId
    world: typeof WorldId
  }
> = Schema.TaggedStruct('PlayerDamageCommand', {
  commandId: CommandId,
  expectedRevision: Revision,
  player: PlayerId,
  world: WorldId,
})
export type PlayerDamageCommand = typeof PlayerDamageCommand.Type

export const PlayerDamageRejectionReason: Schema.Literals<
  readonly ['stale-revision', 'unauthorized-player', 'wrong-world', 'invalid-command']
> = Schema.Literals(['stale-revision', 'unauthorized-player', 'wrong-world', 'invalid-command'])
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
  readonly [typeof PlayerDamageCommandAccepted, typeof PlayerDamageCommandRejected]
> = Schema.Union([PlayerDamageCommandAccepted, PlayerDamageCommandRejected])
export type PlayerDamageCommandResult = typeof PlayerDamageCommandResult.Type

/** Every message this module contributes to the shared `NetworkMessage` union. */
export const PlayerDamageMessage: Schema.Union<
  readonly [typeof PlayerDamageCommand, typeof PlayerDamageCommandAccepted, typeof PlayerDamageCommandRejected]
> = Schema.Union([PlayerDamageCommand, PlayerDamageCommandAccepted, PlayerDamageCommandRejected])
export type PlayerDamageMessage = typeof PlayerDamageMessage.Type

import {
  AuthoritativeCommand,
  type AuthoritativeCommandResult,
  type CommandId,
  type PlayerId,
} from '../../domain/protocol.js'
import { AuthoritativeSession, type ServerConnectionIdentity } from '../../domain/authoritative-session.js'
import { Brand, Effect, Result, Schema } from 'effect'
import {
  type EntityManagerApi,
  type HotbarServiceApi,
  type InventoryServiceApi,
  type ItemStackFailure,
  type PlayerStorageFailure,
  type VehicleServiceApi,
  type VitalsServiceApi,
} from '@nerima-games/mc-sim'

/**
 * Legacy service lookups remain in the host-facing type while command commits are
 * unavailable. They are deliberately not invoked without a WCC delta-producing path.
 */
export type WorldWriteServices<Behaviour> = {
  readonly entities: Pick<EntityManagerApi<Behaviour>, 'find' | 'despawn'>
  readonly vitalsFor: (player: PlayerId) => VitalsServiceApi | undefined
  readonly inventoryFor: (
    player: PlayerId,
  ) => Pick<InventoryServiceApi, 'equipFromInventory' | 'moveStack' | 'unequipToInventory'> | undefined
  readonly hotbarFor: (player: PlayerId) => Pick<HotbarServiceApi, 'setSelectedSlot'> | undefined
  readonly vehiclesFor: (player: PlayerId) => Pick<VehicleServiceApi, 'dismount' | 'mount' | 'vehicles'> | undefined
}

export type CommandNotWritable = {
  readonly _tag: 'CommandNotWritable'
  readonly commandId: CommandId
  readonly commandTag: AuthoritativeCommand['_tag']
  readonly reason: string
}

export type CommandApplicationOutcome = AuthoritativeCommandResult | CommandNotWritable

export type CommandApplicationFailure = ItemStackFailure | PlayerStorageFailure | Schema.SchemaError | Brand.BrandError

const WCC_COMMIT_UNAVAILABLE_REASON =
  'No configured mc-sim WorldCommitCoordinator path can atomically apply this command and emit its authoritative delta.'
const STRICT_COMMAND_PARSE_OPTIONS = { onExcessProperty: 'error' as const }

/**
 * Applies only commands backed by a WCC commit that returns the authoritative delta.
 * The current mc-sim services exposed here mutate their own state without that commit,
 * so valid commands fail closed before any service lookup or mutation.
 */
export const applyAuthoritativeCommand =
  <Behaviour>(
    session: AuthoritativeSession,
    _services: WorldWriteServices<Behaviour>,
    identity: ServerConnectionIdentity,
  ) =>
  (input: unknown): Effect.Effect<CommandApplicationOutcome, CommandApplicationFailure> => {
    const decoded = Schema.decodeUnknownResult(AuthoritativeCommand, STRICT_COMMAND_PARSE_OPTIONS)(input)
    if (Result.isFailure(decoded)) {
      return Effect.fail(decoded.failure)
    }

    const command = decoded.success
    const prior = session.preflight(identity, command)
    if (prior !== undefined) {
      return Effect.succeed(prior)
    }
    return Effect.succeed({
      _tag: 'CommandNotWritable',
      commandId: command.commandId,
      commandTag: command._tag,
      reason: WCC_COMMIT_UNAVAILABLE_REASON,
    })
  }

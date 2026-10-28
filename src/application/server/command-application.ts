import {
  AuthoritativeCommand,
  type CommandId,
  type PlayerId,
} from '../../domain/protocol.js'
import {
  type AuthoritativeCommandIntentResult,
  AuthoritativeSession,
  type ServerConnectionIdentity,
} from '../../domain/authoritative-session.js'
import { Brand, Effect, Result, Schema } from 'effect'
import { type DimensionRevision, type SimulationTick, isItemType, itemIdOf } from '@nerima-games/mc-kernel'
import {
  type EntityManagerApi,
  type HotbarServiceApi,
  IntentSchema,
  type InventoryServiceApi,
  type ItemStackFailure,
  type PlayerStorageFailure,
  type VehicleServiceApi,
  type VitalsServiceApi,
} from '@nerima-games/mc-sim'

/** Retained for hosts that shared the earlier application signature. This path does not call these services. */
export type WorldWriteServices<Behaviour> = {
  readonly entities: Pick<EntityManagerApi<Behaviour>, 'find' | 'despawn'>
  readonly vitalsFor: (player: PlayerId) => VitalsServiceApi | undefined
  readonly inventoryFor: (
    player: PlayerId,
  ) => Pick<InventoryServiceApi, 'equipFromInventory' | 'moveStack' | 'unequipToInventory'> | undefined
  readonly hotbarFor: (player: PlayerId) => Pick<HotbarServiceApi, 'setSelectedSlot'> | undefined
  readonly vehiclesFor: (player: PlayerId) => Pick<VehicleServiceApi, 'dismount' | 'mount' | 'vehicles'> | undefined
}

/** Tick and dimension revision are server state and never come from AuthoritativeCommand. */
export type CommandIntentContext = {
  readonly identity: ServerConnectionIdentity
  readonly targetTick: SimulationTick
  readonly expectedDimensionRevision: DimensionRevision
}

export type CommandUnsupportedReason =
  | 'no-matching-c2-intent-payload'
  | 'intent-payload-does-not-preserve-command'

export type CommandUnsupported = {
  readonly _tag: 'CommandUnsupported'
  readonly commandId: CommandId
  readonly commandTag: AuthoritativeCommand['_tag']
  readonly reason: CommandUnsupportedReason
}

export type CommandApplicationOutcome = AuthoritativeCommandIntentResult | CommandUnsupported

export type CommandApplicationFailure = ItemStackFailure | PlayerStorageFailure | Schema.SchemaError | Brand.BrandError

type IntentPayloadResolution =
  | { readonly _tag: 'mapped'; readonly payload: unknown }
  | { readonly _tag: 'unsupported'; readonly reason: CommandUnsupportedReason }

type MappedCommandTag =
  | 'BowUseCommand'
  | 'FishingCommand'
  | 'PlayerVitalsCommand'
  | 'VehicleCommand'
  | 'VillagerTradeCommand'

type UnsupportedCommandTag = Exclude<AuthoritativeCommand['_tag'], MappedCommandTag>

const UNSUPPORTED_COMMAND_REASONS: Record<UnsupportedCommandTag, CommandUnsupportedReason> = {
  BucketUseCommand: 'no-matching-c2-intent-payload',
  ContainerCommand: 'no-matching-c2-intent-payload',
  EndPortalUseCommand: 'no-matching-c2-intent-payload',
  EnderPearlCommand: 'intent-payload-does-not-preserve-command',
  EntityAttackCommand: 'intent-payload-does-not-preserve-command',
  EntityPickupCommand: 'no-matching-c2-intent-payload',
  FurnaceCommand: 'no-matching-c2-intent-payload',
  IgniteTntCommand: 'no-matching-c2-intent-payload',
  InsertEyeIntoEndPortalFrameCommand: 'no-matching-c2-intent-payload',
  NetherPortalUseCommand: 'no-matching-c2-intent-payload',
  PlayerInventoryCommand: 'no-matching-c2-intent-payload',
  ThrowEyeOfEnderCommand: 'no-matching-c2-intent-payload',
  ToggleLeverCommand: 'no-matching-c2-intent-payload',
  VehicleUseCommand: 'no-matching-c2-intent-payload',
  WorldTimeWeatherCommand: 'no-matching-c2-intent-payload',
}

const noPayload = (): IntentPayloadResolution => ({ _tag: 'unsupported', reason: 'no-matching-c2-intent-payload' })
const doesNotPreserve = (): IntentPayloadResolution => ({ _tag: 'unsupported', reason: 'intent-payload-does-not-preserve-command' })
const mappedPayload = (payload: unknown): IntentPayloadResolution => ({ _tag: 'mapped', payload })
const VEHICLE_THROTTLE = 1
const NEUTRAL_VEHICLE_STEERING = 0

const resolveVitalsIntent = (
  command: Extract<AuthoritativeCommand, { readonly _tag: 'PlayerVitalsCommand' }>,
): IntentPayloadResolution => {
  if (typeof command.action === 'object' && command.action._tag === 'eat') {
    let item: unknown = command.action.item
    if (isItemType(command.action.item)) {
      item = itemIdOf(command.action.item)
    }
    return mappedPayload({ _tag: 'UseItem', actor: command.player, item })
  }

  if (command.action === 'respawn') {
    return noPayload()
  }
  return doesNotPreserve()
}

const resolveBowIntent = (
  command: Extract<AuthoritativeCommand, { readonly _tag: 'BowUseCommand' }>,
): IntentPayloadResolution => {
  let action: 'draw' | 'release' = 'release'
  if (command.action === 'start') {
    action = 'draw'
  }
  return mappedPayload({ _tag: 'BowAction', action, actor: command.player })
}

const resolveVehicleIntent = (
  command: Extract<AuthoritativeCommand, { readonly _tag: 'VehicleCommand' }>,
): IntentPayloadResolution => {
  if (typeof command.action === 'string') {
    return mappedPayload({
      _tag: 'VehicleAction',
      action: command.action,
      actor: command.player,
      vehicle: command.entityId,
    })
  }

  let throttle = -VEHICLE_THROTTLE
  if (command.action.direction === 'forward') {
    throttle = VEHICLE_THROTTLE
  }
  return mappedPayload({
    _tag: 'VehicleControl',
    actor: command.player,
    steering: NEUTRAL_VEHICLE_STEERING,
    throttle,
    vehicle: command.entityId,
  })
}

const resolveIntentPayload = (command: AuthoritativeCommand): IntentPayloadResolution => {
  switch (command._tag) {
    case 'BowUseCommand':
      return resolveBowIntent(command)
    case 'FishingCommand':
      return mappedPayload({ _tag: 'FishingAction', action: command.action, actor: command.player })
    case 'PlayerVitalsCommand':
      return resolveVitalsIntent(command)
    case 'VehicleCommand':
      return resolveVehicleIntent(command)
    case 'VillagerTradeCommand':
      return mappedPayload({
        _tag: 'TradeVillager',
        actor: command.player,
        offerId: command.offerId,
        villager: command.villagerId,
      })
    default:
      return { _tag: 'unsupported', reason: UNSUPPORTED_COMMAND_REASONS[command._tag] }
  }
}

const STRICT_COMMAND_PARSE_OPTIONS = { onExcessProperty: 'error' as const }

const applyDecodedCommand = (
  session: AuthoritativeSession,
  context: CommandIntentContext,
  command: AuthoritativeCommand,
): Effect.Effect<CommandApplicationOutcome, CommandApplicationFailure> => {
  const prior = session.preflightIntent(context.identity, command)
  if (prior !== undefined) {
    return Effect.succeed(prior)
  }

  const resolution = resolveIntentPayload(command)
  if (resolution._tag === 'unsupported') {
    return Effect.succeed({
      _tag: 'CommandUnsupported',
      commandId: command.commandId,
      commandTag: command._tag,
      reason: resolution.reason,
    })
  }

  const intent = Schema.decodeUnknownResult(IntentSchema, STRICT_COMMAND_PARSE_OPTIONS)({
    expectedDimensionRevision: context.expectedDimensionRevision,
    expectedRevision: command.expectedRevision,
    id: command.commandId,
    payload: resolution.payload,
    source: 'network',
    targetTick: context.targetTick,
  })
  if (Result.isFailure(intent)) {
    return Effect.fail(intent.failure)
  }
  return session.executeIntent(context.identity, command, intent.success)
}

/** Validates network commands and returns their canonical C2 intent without applying game rules or owner state. */
export const applyAuthoritativeCommand =
  <Behaviour>(
    session: AuthoritativeSession,
    _services: WorldWriteServices<Behaviour>,
    context: CommandIntentContext,
  ) =>
  (input: unknown): Effect.Effect<CommandApplicationOutcome, CommandApplicationFailure> => {
    const decoded = Schema.decodeUnknownResult(AuthoritativeCommand, STRICT_COMMAND_PARSE_OPTIONS)(input)
    if (Result.isFailure(decoded)) {
      return Effect.fail(decoded.failure)
    }
    return applyDecodedCommand(session, context, decoded.success)
  }

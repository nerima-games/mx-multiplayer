import {
  type AreaOfInterest,
  type AreaOfInterestInputError,
  type ChunkInterest,
  areaOfInterestIncludesLocation,
  areaOfInterestIncludesOwner,
  createAreaOfInterest,
} from '../../domain/area-of-interest.js'
import {
  AuthoritativeCommand,
  AuthoritativeResyncRequest,
  AuthoritativeSnapshot,
  type AuthoritativeSnapshot as AuthoritativeSnapshotValue,
  type NetworkMessage as NetworkMessageValue,
  type PlayerId as PlayerIdValue,
  type PlayerMove as PlayerMoveValue,
  ReplicatedWorldDeltaMessage,
  type ReplicatedWorldDeltaMessage as ReplicatedWorldDeltaValue,
  ReplicatedWorldSnapshot,
  type ReplicatedWorldSnapshot as ReplicatedWorldSnapshotValue,
  WorldId,
  type WorldId as WorldIdValue,
  WorldSnapshot,
  type WorldSnapshot as WorldSnapshotValue,
} from '../../domain/protocol.js'
import {
  type AuthoritativeCommandIntentAccepted,
  AuthoritativeSession,
  type ServerConnectionIdentity,
} from '../../domain/authoritative-session.js'
import {
  BlockIdSchema,
  BlockPositionSchema,
  BlockStateValuesSchema,
  DIMENSIONS,
  EncodedBlockStateSchema,
  WorldIdSchema as KernelWorldIdSchema,
  WorldRevisionSchema,
  decodeBlockState,
  defaultBlockState,
  encodeBlockState,
} from '@nerima-games/mc-kernel'
import {
  CONNECTION_RATE_LIMITS,
  type ConnectionMessageKind,
  type ConnectionMessageRateLimiter,
  type ConnectionRateLimitFailure,
  type ConnectionRateLimiter,
  type MessageKindRateLimitFailure,
  RateLimitConfigurationError,
  createConnectionMessageRateLimiter,
  createConnectionRateLimiter,
} from '../../domain/rate-limit.js'
import { Clock, Effect, Result, Schema } from 'effect'
import {
  type CommandApplicationFailure,
  type CommandApplicationOutcome,
  type CommandIntentContext,
  type WorldWriteServices,
  applyAuthoritativeCommand,
} from './command-application.js'
import {
  type DeltaProjectionOutcome,
  projectReplicatedWorldDelta,
} from '../../domain/chunk-delta.js'
import { type InboundFrameInspection, inspectInboundFrame } from './frame-inspection.js'
import {
  type NonNegativeSafeInteger,
  NonNegativeSafeIntegerSchema,
  type PositiveSafeInteger,
  PositiveSafeIntegerSchema,
  type ReplicatedOwnerRegistry,
} from '../../domain/codec.js'
import {
  type ReconnectAuth,
  type ReconnectToken,
  ReconnectTokenInput,
} from './reconnect-auth.js'
import {
  ReplicatedOwnerChangeSchema,
  type ReplicatedOwnerId,
  ReplicatedOwnerIdSchema,
} from '@nerima-games/mc-sim'
import { BlockPos } from '../../domain/protocol/identifiers.js'

const MAX_SERVER_CONNECTIONS_VALUE = 20
const ZERO = 0
export const MAX_SERVER_CONNECTIONS: PositiveSafeInteger = Schema.decodeUnknownSync(PositiveSafeIntegerSchema)(MAX_SERVER_CONNECTIONS_VALUE)

const strictParseOptions = { onExcessProperty: 'error' as const }

const ServerDimensionSchema: Schema.Literals<typeof DIMENSIONS> = Schema.Literals(DIMENSIONS)
const ServerBlockPositionSchema: typeof BlockPositionSchema = BlockPositionSchema
const LocatedOwnerSchema: Schema.TaggedStruct<'Located', {
  blockPosition: typeof BlockPos
  dimension: typeof ServerDimensionSchema
}> = Schema.TaggedStruct('Located', {
  blockPosition: BlockPos,
  dimension: ServerDimensionSchema,
})
const AbsentOwnerSchema: Schema.TaggedStruct<'Absent', {}> = Schema.TaggedStruct('Absent', {})
const ServerOwnerLocationResolutionSchema: Schema.Union<readonly [typeof LocatedOwnerSchema, typeof AbsentOwnerSchema]> =
  Schema.Union([LocatedOwnerSchema, AbsentOwnerSchema])
const ServerBlockStatePairSchema: Schema.Struct<{
  afterState: typeof EncodedBlockStateSchema
  beforeState: typeof EncodedBlockStateSchema
}> = Schema.Struct({
  afterState: EncodedBlockStateSchema,
  beforeState: EncodedBlockStateSchema,
})
const ServerBlockChangeSourceSchema: Schema.Struct<{
  after: typeof BlockIdSchema
  before: typeof BlockIdSchema
  dimension: typeof ServerDimensionSchema
  position: typeof ServerBlockPositionSchema
  state: Schema.optionalKey<typeof BlockStateValuesSchema>
}> = Schema.Struct({
  after: BlockIdSchema,
  before: BlockIdSchema,
  dimension: ServerDimensionSchema,
  position: ServerBlockPositionSchema,
  state: Schema.optionalKey(BlockStateValuesSchema),
})
const ServerBlockReadingBlockSourceSchema: Schema.TaggedStruct<'Block', { block: typeof BlockIdSchema }> =
  Schema.TaggedStruct('Block', { block: BlockIdSchema })
const ServerBlockReadingChunkNotLoadedSourceSchema: Schema.TaggedStruct<'ChunkNotLoaded', {}> =
  Schema.TaggedStruct('ChunkNotLoaded', {})
const ServerBlockReadingOutOfWorldSourceSchema: Schema.TaggedStruct<'OutOfWorld', {}> =
  Schema.TaggedStruct('OutOfWorld', {})
const ServerBlockReadingSourceSchema: Schema.Union<readonly [
  typeof ServerBlockReadingBlockSourceSchema,
  typeof ServerBlockReadingChunkNotLoadedSourceSchema,
  typeof ServerBlockReadingOutOfWorldSourceSchema,
]> = Schema.Union([
  ServerBlockReadingBlockSourceSchema,
  ServerBlockReadingChunkNotLoadedSourceSchema,
  ServerBlockReadingOutOfWorldSourceSchema,
])
const ServerBlockReadSourceSchema: Schema.Struct<{
  dimension: typeof ServerDimensionSchema
  position: typeof ServerBlockPositionSchema
  reading: typeof ServerBlockReadingSourceSchema
}> = Schema.Struct({
  dimension: ServerDimensionSchema,
  position: ServerBlockPositionSchema,
  reading: ServerBlockReadingSourceSchema,
})
const ServerDeltaSourceSchema: Schema.TaggedStruct<'ReplicatedWorldDelta', {
  blockChanges: Schema.$Array<typeof ServerBlockChangeSourceSchema>
  changes: Schema.$Array<typeof ReplicatedOwnerChangeSchema>
  revision: typeof WorldRevisionSchema
  world: typeof KernelWorldIdSchema
}> = Schema.TaggedStruct('ReplicatedWorldDelta', {
  blockChanges: Schema.Array(ServerBlockChangeSourceSchema),
  changes: Schema.Array(ReplicatedOwnerChangeSchema),
  revision: WorldRevisionSchema,
  world: KernelWorldIdSchema,
})
const ServerSnapshotSourceSchema: Schema.TaggedStruct<'ReplicatedWorldSnapshot', {
  blocks: Schema.$Array<typeof ServerBlockReadSourceSchema>
  owners: Schema.$Array<typeof ReplicatedOwnerChangeSchema>
  revision: typeof WorldRevisionSchema
  world: typeof KernelWorldIdSchema
}> = Schema.TaggedStruct('ReplicatedWorldSnapshot', {
  blocks: Schema.Array(ServerBlockReadSourceSchema),
  owners: Schema.Array(ReplicatedOwnerChangeSchema),
  revision: WorldRevisionSchema,
  world: KernelWorldIdSchema,
})

export type ServerOwnerLocationResolution = typeof ServerOwnerLocationResolutionSchema.Type
export type ServerOwnerLocationIndex = ReadonlyMap<ReplicatedOwnerId, unknown>
export type ServerBlockStateLookup = Readonly<{
  change: Omit<typeof ServerBlockChangeSourceSchema.Type, 'state'>
  revision: typeof WorldRevisionSchema.Type
  world: typeof KernelWorldIdSchema.Type
}>
export type ServerBlockStatePair = typeof ServerBlockStatePairSchema.Type
export type ServerBlockReadStateLookup = Readonly<{
  block: LoadedWorldBlockRead
  revision: typeof WorldRevisionSchema.Type
  world: typeof KernelWorldIdSchema.Type
}>

export type ServerConnectionHandle = Readonly<{
  identity: ServerConnectionIdentity
}>

type ConnectionRecord = {
  readonly handle: ServerConnectionHandle
  readonly identity: ServerConnectionIdentity
  readonly player: PlayerIdValue
  readonly world: WorldIdValue
  readonly globalLimiter: ConnectionRateLimiter
  readonly kindLimiter: ConnectionMessageRateLimiter
  interest: AreaOfInterest | undefined
}

type ServerWorldBlockReadSource = typeof ServerBlockReadSourceSchema.Type
type LoadedWorldBlockRead = ServerWorldBlockReadSource & Readonly<{
  reading: Extract<ServerWorldBlockReadSource['reading'], { readonly _tag: 'Block' }>
}>

export type ServerAdapterConfiguration<Behaviour> = Readonly<{
  readonly commandContextFor: (
    identity: ServerConnectionIdentity,
    player: PlayerIdValue,
    world: WorldIdValue,
  ) => CommandIntentContext
  readonly commandServices: WorldWriteServices<Behaviour>
  /** Resolves both sides of a simulation change; a missing state is a typed refusal. */
  readonly blockStatesForChange: (lookup: ServerBlockStateLookup) => Result.Result<ServerBlockStatePair, unknown>
  /** Reads the authoritative state for a loaded block in a snapshot; no state is synthesized. */
  readonly blockStateForRead: (lookup: ServerBlockReadStateLookup) => Result.Result<typeof EncodedBlockStateSchema.Type, unknown>
  /** Only loaded and visible chunks belong here; omit unloaded chunks. */
  readonly interestInputFor: (
    identity: ServerConnectionIdentity,
    player: PlayerIdValue,
    world: WorldIdValue,
  ) => ServerLoadedInterestInput
  /** Applies accepted protocol intents through host-owned gameplay rules and returns the resulting state to publish. */
  readonly applyAcceptedInbound: (
    connection: ServerConnectionHandle,
    inbound: ServerAcceptedInboundOutcome,
  ) => Effect.Effect<ServerFrameDeliveryInput | undefined, unknown>
  readonly ownerRegistry: ReplicatedOwnerRegistry
  readonly reconnectAuth: Pick<ReconnectAuth, 'resume'>
  readonly session: AuthoritativeSession
}>

export type ServerConnectOutcome =
  | Readonly<{ _tag: 'Connected'; connection: ServerConnectionHandle }>
  | Readonly<{
      _tag: 'ConnectionRejected'
      current: NonNegativeSafeInteger
      limit: PositiveSafeInteger
      reason: 'connection-limit' | 'rate-limiter-initialization'
      failure?: RateLimitConfigurationError
    }>

export type ServerResumeOutcome =
  | Readonly<{ _tag: 'ResumeAccepted'; player: PlayerIdValue; token: ReconnectToken }>
  | Readonly<{ _tag: 'ResumeRejected'; reason: 'missing-token' | 'invalid-token' }>
  | Readonly<{ _tag: 'ResumeUnavailable'; reason: 'authentication-service-failed' }>

export type ServerInboundOutcome =
  | Readonly<{ _tag: 'FrameRejected'; inspection: Extract<InboundFrameInspection, { readonly _tag: 'Rejected' }> }>
  | Readonly<{ _tag: 'ConnectionRefused'; reason: 'unknown-connection' | 'non-text-frame' | 'sender-mismatch' | 'wrong-world' | 'unsupported-message' }>
  | Readonly<{
      _tag: 'RateLimited'
      action: 'drop' | 'warn' | 'disconnect'
      failure: MessageKindRateLimitFailure | ConnectionRateLimitFailure
      kind: ConnectionMessageKind | undefined
    }>
  | Readonly<{ _tag: 'ChatReceived'; message: Extract<NetworkMessageValue, { readonly _tag: 'Chat' }> }>
  | Readonly<{ _tag: 'MovementReceived'; message: PlayerMoveValue }>
  | Readonly<{ _tag: 'ResyncRequested'; request: typeof AuthoritativeResyncRequest.Type }>
  | Readonly<{ _tag: 'CommandApplied'; command: typeof AuthoritativeCommand.Type; outcome: CommandApplicationOutcome }>
  | Readonly<{ _tag: 'CommandApplicationRefused'; failure: CommandApplicationFailure }>

type InboundNetworkMessage = NetworkMessageValue

export type ServerProjectionRefusal = Readonly<{
  _tag: 'ServerProjectionRefused'
  reason:
    | 'unknown-connection'
    | 'invalid-authoritative-snapshot'
    | 'invalid-replicated-snapshot'
    | 'cross-world-snapshot'
    | 'invalid-location-owner-id'
    | 'missing-owner-location'
    | 'invalid-owner-location'
    | 'invalid-block-location'
    | 'invalid-block-state'
    | 'invalid-server-interest'
    | 'invalid-world-snapshot'
    | 'invalid-player-location'
    | 'invalid-replicated-delta'
    | 'delta-projection-failed'
}>

export type ServerProjectionFailure = ServerProjectionRefusal

export type ProjectedRecipientSnapshot = Readonly<{
  authoritative: AuthoritativeSnapshotValue
  replicatedWorld: ReplicatedWorldSnapshotValue
  worldSnapshot: WorldSnapshotValue
}>

export type TargetedSnapshotDelivery = Readonly<{
  _tag: 'TargetedSnapshot'
  connection: ServerConnectionHandle
  snapshot: ProjectedRecipientSnapshot
}>

export type TargetedDeltaDelivery = Readonly<{
  _tag: 'TargetedDelta'
  connection: ServerConnectionHandle
  outcome: DeltaProjectionOutcome
}>

export type ServerSnapshotProjectionInputs = Readonly<{
  locations: ServerOwnerLocationIndex
  playerDimensions: ServerPlayerDimensionIndex
  replicatedWorld: unknown
  worldSnapshot: unknown
}>

export type ServerLoadedInterestInput = Readonly<{
  chunks: ReadonlyArray<ChunkInterest>
  ownerIds: ReadonlyArray<ReplicatedOwnerId>
}>

export type ServerPlayerDimensionIndex = ReadonlyMap<PlayerIdValue, typeof ServerDimensionSchema.Type>

export type ServerAcceptedInboundOutcome =
  | Extract<ServerInboundOutcome, { readonly _tag: 'ChatReceived' | 'MovementReceived' | 'ResyncRequested' }>
  | Readonly<{
      _tag: 'CommandApplied'
      command: typeof AuthoritativeCommand.Type
      outcome: AuthoritativeCommandIntentAccepted
    }>

export type ServerSnapshotDeliveryInput = Readonly<{
  world: WorldIdValue
  authoritative: unknown
  inputs: ServerSnapshotProjectionInputs
}>

export type ServerFrameDeliveryInput = Readonly<{
  snapshots?: ReadonlyArray<ServerSnapshotDeliveryInput>
  delta?: unknown
}>

export type ServerAdapterRequest =
  | Readonly<{ _tag: 'Connect'; player: PlayerIdValue; world: WorldIdValue }>
  | Readonly<{ _tag: 'Disconnect'; connection: unknown }>
  | Readonly<{ _tag: 'Resume'; token: unknown }>
  | Readonly<{ _tag: 'ReceiveFrame'; connection: unknown; frame: unknown }>
  | Readonly<{ _tag: 'PublishWorldState'; delivery: ServerFrameDeliveryInput }>

export type ServerFrameDeliveries = Readonly<{
  snapshots: ReadonlyArray<TargetedSnapshotDelivery>
  deltas: ReadonlyArray<TargetedDeltaDelivery>
}>

export type ServerAdapterOutcome =
  | ServerConnectOutcome
  | ServerResumeOutcome
  | Readonly<{ _tag: 'Disconnected'; disconnected: boolean }>
  | Readonly<{ _tag: 'FrameHandled'; inbound: ServerInboundOutcome; deliveries: ServerFrameDeliveries }>
  | Readonly<{ _tag: 'FrameApplicationFailed'; inbound: ServerAcceptedInboundOutcome; reason: 'host-application-failed' }>
  | Readonly<{ _tag: 'FrameDeliveryRefused'; inbound?: ServerInboundOutcome; failure: ServerProjectionFailure }>
  | Readonly<{ _tag: 'WorldStatePublished'; deliveries: ServerFrameDeliveries }>
  | Readonly<{ _tag: 'WorldStateRefused'; failure: ServerProjectionFailure }>

export type ServerAdapter = Readonly<{
  handle: (request: ServerAdapterRequest) => Effect.Effect<ServerAdapterOutcome>
}>

const refusal = (reason: ServerProjectionRefusal['reason']): ServerProjectionRefusal => ({
  _tag: 'ServerProjectionRefused',
  reason,
})

const classifyMessage = (message: InboundNetworkMessage): ConnectionMessageKind => {
  if (Schema.is(AuthoritativeCommand)(message)) {
    return 'command'
  }
  if (message._tag === 'BlockPlace' || message._tag === 'BlockBreak' || message._tag.endsWith('Command')) {
    return 'command'
  }
  switch (message._tag) {
    case 'Chat':
      return 'chat'
    case 'PlayerMove':
      return 'movement'
    default:
      return 'other'
  }
}

const rateLimitAction = (failure: MessageKindRateLimitFailure): 'drop' | 'warn' | 'disconnect' => {
  if ('kind' in failure) {
    if (failure.kind === 'chat') {
      return 'warn'
    }
    return 'drop'
  }
  return 'disconnect'
}

const createConnectionRateLimiterForAdmission = (): Result.Result<ConnectionRateLimiter, RateLimitConfigurationError> =>
  createConnectionRateLimiter(CONNECTION_RATE_LIMITS)

type ResolvedOwnerLocation = Readonly<{
  location: ServerOwnerLocationResolution
  ownerId: ReplicatedOwnerId
}>

const readLocationOwnerId = (ownerInput: unknown): Result.Result<ReplicatedOwnerId, ServerProjectionRefusal> => {
  const decoded = Schema.decodeUnknownResult(ReplicatedOwnerIdSchema, strictParseOptions)(ownerInput)
  if (Result.isFailure(decoded)) {
    return Result.fail(refusal('invalid-location-owner-id'))
  }
  return Result.succeed(decoded.success)
}

const resolveOwnerLocation = (
  ownerInput: unknown,
  locations: ServerOwnerLocationIndex,
): Result.Result<ResolvedOwnerLocation, ServerProjectionRefusal> => {
  const ownerId = readLocationOwnerId(ownerInput)
  if (Result.isFailure(ownerId)) {
    return Result.fail(ownerId.failure)
  }
  const locationInput = locations.get(ownerId.success)
  if (locationInput === undefined) {
    return Result.fail(refusal('missing-owner-location'))
  }
  const location = Schema.decodeUnknownResult(ServerOwnerLocationResolutionSchema, strictParseOptions)(locationInput)
  if (Result.isFailure(location)) {
    return Result.fail(refusal('invalid-owner-location'))
  }
  return Result.succeed({ location: location.success, ownerId: ownerId.success })
}

const ownerVisibleInInterest = (
  ownerInput: unknown,
  locations: ServerOwnerLocationIndex,
  interest: AreaOfInterest,
): Result.Result<boolean, ServerProjectionRefusal | AreaOfInterestInputError> => {
  const resolved = resolveOwnerLocation(ownerInput, locations)
  if (Result.isFailure(resolved)) {
    return Result.fail(resolved.failure)
  }
  const { location, ownerId } = resolved.success
  if (location._tag === 'Absent') {
    return Result.succeed(false)
  }
  const inChunk = areaOfInterestIncludesLocation(interest, location.dimension, location.blockPosition)
  if (Result.isFailure(inChunk)) {
    return Result.fail(inChunk.failure)
  }
  return Result.succeed(areaOfInterestIncludesOwner(interest, ownerId) || inChunk.success)
}

type LocatedEntriesProjectionRequest<Entry> = Readonly<{
  entries: ReadonlyArray<Entry>
  interest: AreaOfInterest
  locations: ServerOwnerLocationIndex
  ownerIdFor: (entry: Entry) => unknown
}>

type OptionalLocatedEntriesProjectionRequest<Entry> = Omit<LocatedEntriesProjectionRequest<Entry>, 'entries'> & Readonly<{
  entries: ReadonlyArray<Entry> | undefined
}>

const projectLocatedEntries = <Entry>(
  request: LocatedEntriesProjectionRequest<Entry>,
): Result.Result<ReadonlyArray<Entry>, ServerProjectionRefusal | AreaOfInterestInputError> => {
  const { entries, interest, locations, ownerIdFor } = request
  const projected: Array<Entry> = []
  for (const entry of entries) {
    const visible = ownerVisibleInInterest(ownerIdFor(entry), locations, interest)
    if (Result.isFailure(visible)) {
      return Result.fail(visible.failure)
    }
    if (visible.success) {
      projected.push(entry)
    }
  }
  return Result.succeed(Object.freeze(projected))
}

const projectOptionalLocatedEntries = <Entry>(
  request: OptionalLocatedEntriesProjectionRequest<Entry>,
): Result.Result<ReadonlyArray<Entry> | undefined, ServerProjectionRefusal | AreaOfInterestInputError> => {
  if (request.entries === undefined) {
    return Result.succeed(undefined)
  }
  return projectLocatedEntries({ ...request, entries: request.entries })
}

type SnapshotCollectionsProjectionRequest = Readonly<{
  interest: AreaOfInterest
  locations: ServerOwnerLocationIndex
  snapshot: AuthoritativeSnapshotValue
}>

type SnapshotCollectionsProjection = Readonly<{
  containers: AuthoritativeSnapshotValue['containers']
  entities: AuthoritativeSnapshotValue['entities'] | undefined
  furnaces: AuthoritativeSnapshotValue['furnaces']
  villagerTrades: AuthoritativeSnapshotValue['villagerTrades']
}>

const projectSnapshotEntityCollections = (
  request: SnapshotCollectionsProjectionRequest,
): Result.Result<Pick<SnapshotCollectionsProjection, 'containers' | 'entities'>, ServerProjectionRefusal | AreaOfInterestInputError> => {
  const { interest, locations, snapshot } = request
  const entities = projectOptionalLocatedEntries({
    entries: snapshot.entities,
    interest,
    locations,
    ownerIdFor: (entity) => entity.entityId,
  })
  if (Result.isFailure(entities)) {
    return Result.fail(entities.failure)
  }
  const containers = projectLocatedEntries({
    entries: snapshot.containers,
    interest,
    locations,
    ownerIdFor: (state) => state.containerId,
  })
  if (Result.isFailure(containers)) {
    return Result.fail(containers.failure)
  }
  return Result.succeed({ containers: containers.success, entities: entities.success })
}

const projectSnapshotMachineCollections = (
  request: SnapshotCollectionsProjectionRequest,
): Result.Result<Pick<SnapshotCollectionsProjection, 'furnaces' | 'villagerTrades'>, ServerProjectionRefusal | AreaOfInterestInputError> => {
  const { interest, locations, snapshot } = request
  const furnaces = projectLocatedEntries({
    entries: snapshot.furnaces,
    interest,
    locations,
    ownerIdFor: (state) => state.furnaceId,
  })
  if (Result.isFailure(furnaces)) {
    return Result.fail(furnaces.failure)
  }
  const villagerTrades = projectLocatedEntries({
    entries: snapshot.villagerTrades,
    interest,
    locations,
    ownerIdFor: (state) => state.villagerId,
  })
  if (Result.isFailure(villagerTrades)) {
    return Result.fail(villagerTrades.failure)
  }
  return Result.succeed({ furnaces: furnaces.success, villagerTrades: villagerTrades.success })
}

const projectSnapshotCollections = (
  request: SnapshotCollectionsProjectionRequest,
): Result.Result<SnapshotCollectionsProjection, ServerProjectionRefusal | AreaOfInterestInputError> => {
  const entitiesAndContainers = projectSnapshotEntityCollections(request)
  if (Result.isFailure(entitiesAndContainers)) {
    return Result.fail(entitiesAndContainers.failure)
  }
  const machines = projectSnapshotMachineCollections(request)
  if (Result.isFailure(machines)) {
    return Result.fail(machines.failure)
  }
  return Result.succeed({ ...entitiesAndContainers.success, ...machines.success })
}

type ReplicatedSnapshotProjectionRequest = Readonly<{
  interest: AreaOfInterest
  locations: ServerOwnerLocationIndex
  replicatedWorld: ReplicatedWorldSnapshotValue
}>

const projectReplicatedSnapshotOwners = (
  request: ReplicatedSnapshotProjectionRequest,
): Result.Result<ReadonlyArray<ReplicatedWorldSnapshotValue['owners'][number]>, ServerProjectionRefusal | AreaOfInterestInputError> =>
  projectLocatedEntries({
    entries: request.replicatedWorld.owners,
    interest: request.interest,
    locations: request.locations,
    ownerIdFor: (owner) => owner.owner,
  })

const projectReplicatedSnapshotBlocks = (
  request: ReplicatedSnapshotProjectionRequest,
): Result.Result<ReadonlyArray<ReplicatedWorldSnapshotValue['blocks'][number]>, ServerProjectionRefusal | AreaOfInterestInputError> => {
  const visibleBlocks: Array<ReplicatedWorldSnapshotValue['blocks'][number]> = []
  for (const block of request.replicatedWorld.blocks) {
    const inChunk = areaOfInterestIncludesLocation(request.interest, block.dimension, block.position)
    if (Result.isFailure(inChunk)) {
      return Result.fail(refusal('invalid-block-location'))
    }
    if (inChunk.success) {
      visibleBlocks.push(block)
    }
  }
  return Result.succeed(Object.freeze(visibleBlocks))
}

const projectedAuthoritativeSnapshot = (
  snapshot: AuthoritativeSnapshotValue,
  recipient: PlayerIdValue,
  collections: SnapshotCollectionsProjection,
): AuthoritativeSnapshotValue => {
  const projected: AuthoritativeSnapshotValue = {
    ...snapshot,
    containers: collections.containers,
    furnaces: collections.furnaces,
    inventories: snapshot.inventories.filter((entry) => entry.player === recipient),
    villagerTrades: collections.villagerTrades,
    vitals: snapshot.vitals.filter((entry) => entry.player === recipient),
  }
  if (collections.entities !== undefined) {
    return { ...projected, entities: collections.entities }
  }
  return projected
}

type SnapshotLocationProjectionRequest = Readonly<{
  interest: AreaOfInterest
  locations: ServerOwnerLocationIndex
  playerDimensions: ServerPlayerDimensionIndex
  recipient: PlayerIdValue
  replicatedWorld: ReplicatedWorldSnapshotValue
  snapshot: AuthoritativeSnapshotValue
  worldSnapshot: WorldSnapshotValue
}>

const decodePlayerDimension = (
  dimensions: ServerPlayerDimensionIndex,
  player: WorldSnapshotValue['players'][number],
): Result.Result<typeof ServerDimensionSchema.Type, ServerProjectionRefusal> => {
  const dimensionInput = dimensions.get(player.player)
  if (dimensionInput === undefined) {
    return Result.fail(refusal('invalid-player-location'))
  }
  const dimension = Schema.decodeUnknownResult(ServerDimensionSchema, strictParseOptions)(dimensionInput)
  if (Result.isFailure(dimension)) {
    return Result.fail(refusal('invalid-player-location'))
  }
  return Result.succeed(dimension.success)
}

const playerLocationIsVisible = (
  interest: AreaOfInterest,
  dimension: typeof ServerDimensionSchema.Type,
  player: WorldSnapshotValue['players'][number],
): Result.Result<boolean, ServerProjectionRefusal> =>
  Result.mapError(
    areaOfInterestIncludesLocation(interest, dimension, {
      x: Math.floor(player.at.x),
      y: Math.floor(player.at.y),
      z: Math.floor(player.at.z),
    }),
    () => refusal('invalid-player-location'),
  )

const worldSnapshotPlayerIsVisible = (
  request: Readonly<{
    dimensions: ServerPlayerDimensionIndex
    interest: AreaOfInterest
    player: WorldSnapshotValue['players'][number]
    snapshot: WorldSnapshotValue
  }>,
): Result.Result<boolean, ServerProjectionRefusal> => {
  if (request.player.world !== request.snapshot.world) {
    return Result.succeed(false)
  }
  const dimension = decodePlayerDimension(request.dimensions, request.player)
  if (Result.isFailure(dimension)) {
    return Result.fail(dimension.failure)
  }
  return playerLocationIsVisible(request.interest, dimension.success, request.player)
}

const projectWorldSnapshotPlayers = (
  request: Pick<SnapshotLocationProjectionRequest, 'interest' | 'playerDimensions' | 'worldSnapshot'>,
): Result.Result<WorldSnapshotValue, ServerProjectionRefusal> => {
  const players: Array<WorldSnapshotValue['players'][number]> = []
  for (const player of request.worldSnapshot.players) {
    const visible = worldSnapshotPlayerIsVisible({
      dimensions: request.playerDimensions,
      interest: request.interest,
      player,
      snapshot: request.worldSnapshot,
    })
    if (Result.isFailure(visible)) {
      return Result.fail(visible.failure)
    }
    if (visible.success) {
      players.push(player)
    }
  }
  return Result.succeed({ ...request.worldSnapshot, players: Object.freeze(players) })
}

const filterSnapshotLocations = (
  request: SnapshotLocationProjectionRequest,
): Result.Result<ProjectedRecipientSnapshot, ServerProjectionRefusal | AreaOfInterestInputError> => {
  const projected = Result.all([
    projectSnapshotCollections(request),
    projectReplicatedSnapshotOwners(request),
    projectReplicatedSnapshotBlocks(request),
    projectWorldSnapshotPlayers(request),
  ] as const)
  return Result.map(projected, ([collections, owners, blocks, worldSnapshot]) => ({
    authoritative: projectedAuthoritativeSnapshot(request.snapshot, request.recipient, collections),
    replicatedWorld: {
      ...request.replicatedWorld,
      blocks,
      owners,
    },
    worldSnapshot,
  }))
}

const interestFor = <Behaviour>(
  config: ServerAdapterConfiguration<Behaviour>,
  connection: ConnectionRecord,
): Result.Result<AreaOfInterest, AreaOfInterestInputError> => createAreaOfInterest(
  config.interestInputFor(connection.identity, connection.player, connection.world),
)

type BlockStateChangeEnrichmentRequest<Behaviour> = Readonly<{
  change: typeof ServerBlockChangeSourceSchema.Type
  resolver: ServerAdapterConfiguration<Behaviour>['blockStatesForChange']
  revision: typeof WorldRevisionSchema.Type
  world: typeof KernelWorldIdSchema.Type
}>

const hasValidBlockStatePair = (
  change: typeof ServerBlockChangeSourceSchema.Type,
  states: ServerBlockStatePair,
): boolean =>
  Result.isSuccess(decodeBlockState(change.before, states.beforeState))
  && Result.isSuccess(decodeBlockState(change.after, states.afterState))

const encodeAfterBlockState = (
  change: typeof ServerBlockChangeSourceSchema.Type,
): Result.Result<typeof EncodedBlockStateSchema.Type, unknown> => {
  if (change.state === undefined) {
    const defaults = defaultBlockState(change.after)
    if (Result.isFailure(defaults)) {
      return Result.fail(defaults.failure)
    }
    return encodeBlockState(change.after, defaults.success)
  }
  return encodeBlockState(change.after, change.state)
}

const resolveBlockStatePair = <Behaviour>(
  request: BlockStateChangeEnrichmentRequest<Behaviour>,
  change: Omit<typeof ServerBlockChangeSourceSchema.Type, 'state'>,
): Result.Result<ServerBlockStatePair, ServerProjectionRefusal> => {
  const resolved = request.resolver({ change, revision: request.revision, world: request.world })
  if (Result.isFailure(resolved)) {
    return Result.fail(refusal('invalid-block-state'))
  }
  const states = Schema.decodeUnknownResult(ServerBlockStatePairSchema, strictParseOptions)(resolved.success)
  if (Result.isFailure(states) || !hasValidBlockStatePair(change, states.success)) {
    return Result.fail(refusal('invalid-block-state'))
  }
  return Result.succeed(states.success)
}

const enrichBlockStateChange = <Behaviour>(
  request: BlockStateChangeEnrichmentRequest<Behaviour>,
): Result.Result<ReplicatedWorldDeltaValue['blockChanges'][number], ServerProjectionRefusal> => {
  const change = {
    after: request.change.after,
    before: request.change.before,
    dimension: request.change.dimension,
    position: request.change.position,
  }
  const states = resolveBlockStatePair(request, change)
  if (Result.isFailure(states)) {
    return Result.fail(states.failure)
  }
  const afterState = encodeAfterBlockState(request.change)
  // Keep the resolved world state consistent with the state emitted by mc-sim.
  if (Result.isFailure(afterState) || afterState.success !== states.success.afterState) {
    return Result.fail(refusal('invalid-block-state'))
  }
  return Result.succeed({ ...change, ...states.success, afterState: afterState.success })
}

const enrichBlockStates = <Behaviour>(
  source: typeof ServerDeltaSourceSchema.Type,
  resolver: ServerAdapterConfiguration<Behaviour>['blockStatesForChange'],
): Result.Result<ReplicatedWorldDeltaValue['blockChanges'], ServerProjectionRefusal> => {
  const blockChanges: Array<ReplicatedWorldDeltaValue['blockChanges'][number]> = []
  for (const change of source.blockChanges) {
    const enriched = enrichBlockStateChange({ change, resolver, revision: source.revision, world: source.world })
    if (Result.isFailure(enriched)) {
      return Result.fail(enriched.failure)
    }
    blockChanges.push(enriched.success)
  }
  return Result.succeed(Object.freeze(blockChanges))
}

type UnloadedWorldBlockRead = Readonly<{
  dimension: typeof ServerDimensionSchema.Type
  position: typeof ServerBlockPositionSchema.Type
  reading: Extract<typeof ServerBlockReadingSourceSchema.Type, { readonly _tag: 'ChunkNotLoaded' | 'OutOfWorld' }>
}>

type LoadedBlockStateEnrichmentRequest<Behaviour> = Readonly<{
  block: LoadedWorldBlockRead
  resolver: ServerAdapterConfiguration<Behaviour>['blockStateForRead']
  revision: typeof WorldRevisionSchema.Type
  world: typeof KernelWorldIdSchema.Type
}>

const enrichUnloadedSnapshotBlock = (
  block: UnloadedWorldBlockRead,
): Result.Result<ReplicatedWorldSnapshotValue['blocks'][number], ServerProjectionRefusal> =>
  Result.succeed({ dimension: block.dimension, position: block.position, reading: block.reading })

const enrichLoadedSnapshotBlock = <Behaviour>(
  request: LoadedBlockStateEnrichmentRequest<Behaviour>,
): Result.Result<ReplicatedWorldSnapshotValue['blocks'][number], ServerProjectionRefusal> => {
  const resolved = request.resolver({ block: request.block, revision: request.revision, world: request.world })
  if (Result.isFailure(resolved)) {
    return Result.fail(refusal('invalid-block-state'))
  }
  const state = Schema.decodeUnknownResult(EncodedBlockStateSchema, strictParseOptions)(resolved.success)
  if (Result.isFailure(state) || Result.isFailure(decodeBlockState(request.block.reading.block, state.success))) {
    return Result.fail(refusal('invalid-block-state'))
  }
  return Result.succeed({
    dimension: request.block.dimension,
    position: request.block.position,
    reading: request.block.reading,
    state: state.success,
  })
}

type SnapshotSourceBlockEnrichmentRequest<Behaviour> = Readonly<{
  block: ServerWorldBlockReadSource
  resolver: ServerAdapterConfiguration<Behaviour>['blockStateForRead']
  revision: typeof WorldRevisionSchema.Type
  world: typeof KernelWorldIdSchema.Type
}>

const enrichSnapshotSourceBlock = <Behaviour>(
  request: SnapshotSourceBlockEnrichmentRequest<Behaviour>,
): Result.Result<ReplicatedWorldSnapshotValue['blocks'][number], ServerProjectionRefusal> => {
  // eslint-disable-next-line default-case -- The source schema validates this closed union.
  switch (request.block.reading._tag) {
    case 'ChunkNotLoaded':
    case 'OutOfWorld': {
      const unloaded: UnloadedWorldBlockRead = {
        dimension: request.block.dimension,
        position: request.block.position,
        reading: request.block.reading,
      }
      return enrichUnloadedSnapshotBlock(unloaded)
    }
    case 'Block': {
      const loaded: LoadedWorldBlockRead = {
        dimension: request.block.dimension,
        position: request.block.position,
        reading: request.block.reading,
      }
      return enrichLoadedSnapshotBlock({
        block: loaded,
        resolver: request.resolver,
        revision: request.revision,
        world: request.world,
      })
    }
  }
}

const enrichSnapshotBlockStates = <Behaviour>(
  source: typeof ServerSnapshotSourceSchema.Type,
  resolver: ServerAdapterConfiguration<Behaviour>['blockStateForRead'],
): Result.Result<ReplicatedWorldSnapshotValue['blocks'], ServerProjectionRefusal> => {
  const blocks: Array<ReplicatedWorldSnapshotValue['blocks'][number]> = []
  for (const block of source.blocks) {
    const enriched = enrichSnapshotSourceBlock({ block, resolver, revision: source.revision, world: source.world })
    if (Result.isFailure(enriched)) {
      return Result.fail(enriched.failure)
    }
    blocks.push(enriched.success)
  }
  return Result.succeed(Object.freeze(blocks))
}

type SnapshotStatePreparationRequest<Behaviour> = Readonly<{
  input: unknown
  resolver: ServerAdapterConfiguration<Behaviour>['blockStateForRead']
}>

const decodeReplicatedSnapshot = <Behaviour>(
  request: SnapshotStatePreparationRequest<Behaviour>,
): Result.Result<ReplicatedWorldSnapshotValue, ServerProjectionRefusal> => {
  const source = Schema.decodeUnknownResult(ServerSnapshotSourceSchema, strictParseOptions)(request.input)
  if (Result.isFailure(source)) {
    return Result.fail(refusal('invalid-replicated-snapshot'))
  }
  const blocks = enrichSnapshotBlockStates(source.success, request.resolver)
  if (Result.isFailure(blocks)) {
    return Result.fail(blocks.failure)
  }
  const decoded = Schema.decodeUnknownResult(ReplicatedWorldSnapshot, strictParseOptions)({
    ...source.success,
    blocks: blocks.success,
  })
  if (Result.isFailure(decoded)) {
    return Result.fail(refusal('invalid-replicated-snapshot'))
  }
  return Result.succeed(decoded.success)
}

type SnapshotInputsPreparationRequest<Behaviour> = Readonly<{
  authoritativeInput: unknown
  replicatedWorldInput: unknown
  worldSnapshotInput: unknown
  resolver: ServerAdapterConfiguration<Behaviour>['blockStateForRead']
  world: WorldIdValue
}>

type PreparedSnapshotInputs = Readonly<{
  authoritative: AuthoritativeSnapshotValue
  replicatedWorld: ReplicatedWorldSnapshotValue
  worldSnapshot: WorldSnapshotValue
}>

const decodeAuthoritativeSnapshot = (input: unknown): Result.Result<AuthoritativeSnapshotValue, ServerProjectionRefusal> => {
  const decoded = Schema.decodeUnknownResult(AuthoritativeSnapshot, strictParseOptions)(input)
  if (Result.isFailure(decoded)) {
    return Result.fail(refusal('invalid-authoritative-snapshot'))
  }
  return Result.succeed(decoded.success)
}

const decodeWorldSnapshot = (input: unknown): Result.Result<WorldSnapshotValue, ServerProjectionRefusal> => {
  const decoded = Schema.decodeUnknownResult(WorldSnapshot, strictParseOptions)(input)
  if (Result.isFailure(decoded)) {
    return Result.fail(refusal('invalid-world-snapshot'))
  }
  return Result.succeed(decoded.success)
}

const decodeSnapshotInputs = <Behaviour>(
  request: SnapshotInputsPreparationRequest<Behaviour>,
): Result.Result<PreparedSnapshotInputs, ServerProjectionRefusal> => {
  const decoded = Result.all([
    decodeAuthoritativeSnapshot(request.authoritativeInput),
    decodeReplicatedSnapshot({ input: request.replicatedWorldInput, resolver: request.resolver }),
    decodeWorldSnapshot(request.worldSnapshotInput),
  ] as const)
  if (Result.isFailure(decoded)) {
    return Result.fail(decoded.failure)
  }
  const [authoritative, replicatedWorld, worldSnapshot] = decoded.success
  if (
    authoritative.world !== request.world ||
    replicatedWorld.world !== request.world ||
    worldSnapshot.world !== request.world
  ) {
    return Result.fail(refusal('cross-world-snapshot'))
  }
  return Result.succeed({
    authoritative,
    replicatedWorld,
    worldSnapshot,
  })
}

type DeltaStatePreparationRequest<Behaviour> = Readonly<{
  input: unknown
  resolver: ServerAdapterConfiguration<Behaviour>['blockStatesForChange']
}>

const decodeReplicatedDelta = <Behaviour>(
  request: DeltaStatePreparationRequest<Behaviour>,
): Result.Result<ReplicatedWorldDeltaValue, ServerProjectionRefusal> => {
  const source = Schema.decodeUnknownResult(ServerDeltaSourceSchema, strictParseOptions)(request.input)
  if (Result.isFailure(source)) {
    return Result.fail(refusal('invalid-replicated-delta'))
  }
  const blockChanges = enrichBlockStates(source.success, request.resolver)
  if (Result.isFailure(blockChanges)) {
    return Result.fail(blockChanges.failure)
  }
  const decoded = Schema.decodeUnknownResult(ReplicatedWorldDeltaMessage, strictParseOptions)({
    ...source.success,
    blockChanges: blockChanges.success,
  })
  if (Result.isFailure(decoded)) {
    return Result.fail(refusal('invalid-replicated-delta'))
  }
  return Result.succeed(decoded.success)
}

type AcceptedFrameInspection = Extract<InboundFrameInspection, { readonly _tag: 'Accepted' }>

type DispatchableInboundFrame = Readonly<{
  _tag: 'InboundFrameReady'
  message: InboundNetworkMessage
}>

const inspectClientFrame = (
  untrustedFrame: unknown,
  ownerRegistry: ReplicatedOwnerRegistry,
): Result.Result<AcceptedFrameInspection, ServerInboundOutcome> => {
  const frame = Schema.decodeUnknownResult(Schema.String)(untrustedFrame)
  if (Result.isFailure(frame)) {
    return Result.fail({ _tag: 'ConnectionRefused', reason: 'non-text-frame' })
  }
  const inspection = inspectInboundFrame(frame.success, ownerRegistry)
  if (inspection._tag === 'Rejected') {
    return Result.fail({ _tag: 'FrameRejected', inspection })
  }
  return Result.succeed(inspection)
}

const consumeInboundRateLimits = (
  connection: ConnectionRecord,
  inspection: AcceptedFrameInspection,
): Effect.Effect<DispatchableInboundFrame | ServerInboundOutcome> => Effect.gen(function* () {
  const now = yield* Clock.currentTimeMillis
  const globalLimit = connection.globalLimiter.consume(inspection.byteLength, now)
  if (Result.isFailure(globalLimit)) {
    return { _tag: 'RateLimited', action: 'disconnect', failure: globalLimit.failure, kind: undefined }
  }
  const kind = classifyMessage(inspection.message)
  const kindLimit = connection.kindLimiter.consume(kind, now)
  if (Result.isFailure(kindLimit)) {
    return { _tag: 'RateLimited', action: rateLimitAction(kindLimit.failure), failure: kindLimit.failure, kind }
  }
  return { _tag: 'InboundFrameReady', message: inspection.message }
})

const dispatchChat = (
  connection: ConnectionRecord,
  message: Extract<NetworkMessageValue, { readonly _tag: 'Chat' }>,
): ServerInboundOutcome => {
  if (message.player !== connection.player) {
    return { _tag: 'ConnectionRefused', reason: 'sender-mismatch' }
  }
  return { _tag: 'ChatReceived', message }
}

const dispatchMovement = (connection: ConnectionRecord, message: PlayerMoveValue): ServerInboundOutcome => {
  if (message.player !== connection.player) {
    return { _tag: 'ConnectionRefused', reason: 'sender-mismatch' }
  }
  if (message.world !== undefined && message.world !== connection.world) {
    return { _tag: 'ConnectionRefused', reason: 'wrong-world' }
  }
  return { _tag: 'MovementReceived', message }
}

const dispatchResync = (
  connection: ConnectionRecord,
  request: typeof AuthoritativeResyncRequest.Type,
): ServerInboundOutcome => {
  if (request.world !== connection.world) {
    return { _tag: 'ConnectionRefused', reason: 'wrong-world' }
  }
  return { _tag: 'ResyncRequested', request }
}

const dispatchInboundMessage = <Behaviour>(
  config: ServerAdapterConfiguration<Behaviour>,
  connection: ConnectionRecord,
  message: InboundNetworkMessage,
): Effect.Effect<ServerInboundOutcome> => Effect.gen(function* () {
  if (Schema.is(AuthoritativeCommand)(message)) {
    const context = config.commandContextFor(connection.identity, connection.player, connection.world)
    return yield* Effect.match(
      applyAuthoritativeCommand(config.session, config.commandServices, context)(message),
      {
        onFailure: (failure): ServerInboundOutcome => ({ _tag: 'CommandApplicationRefused', failure }),
        onSuccess: (outcome): ServerInboundOutcome => ({ _tag: 'CommandApplied', command: message, outcome }),
      },
    )
  }
  switch (message._tag) {
    case 'Chat':
      return dispatchChat(connection, message)
    case 'PlayerMove':
      return dispatchMovement(connection, message)
    case 'AuthoritativeResyncRequest':
      return dispatchResync(connection, message)
    default:
      return { _tag: 'ConnectionRefused', reason: 'unsupported-message' }
  }
})

type RecipientSnapshotProjectionRequest = Readonly<{
  connection: ConnectionRecord
  interest: AreaOfInterest
  locations: ServerOwnerLocationIndex
  playerDimensions: ServerPlayerDimensionIndex
  snapshot: PreparedSnapshotInputs
}>

const normalizeSnapshotProjectionFailure = (
  failure: ServerProjectionRefusal | AreaOfInterestInputError,
): ServerProjectionRefusal => {
  if (failure._tag === 'AreaOfInterestInputError') {
    return refusal('invalid-owner-location')
  }
  return failure
}

const projectSnapshotForConnection = (
  request: RecipientSnapshotProjectionRequest,
): Result.Result<TargetedSnapshotDelivery, ServerProjectionFailure> => {
  const projected = filterSnapshotLocations({
    interest: request.interest,
    locations: request.locations,
    playerDimensions: request.playerDimensions,
    recipient: request.connection.player,
    replicatedWorld: request.snapshot.replicatedWorld,
    snapshot: request.snapshot.authoritative,
    worldSnapshot: request.snapshot.worldSnapshot,
  })
  if (Result.isFailure(projected)) {
    return Result.fail(normalizeSnapshotProjectionFailure(projected.failure))
  }
  request.connection.interest = request.interest
  return Result.succeed({
    _tag: 'TargetedSnapshot',
    connection: request.connection.handle,
    snapshot: projected.success,
  })
}

const projectSnapshotInputForConnection = <Behaviour>(
  config: ServerAdapterConfiguration<Behaviour>,
  connection: ConnectionRecord,
  input: ServerSnapshotDeliveryInput,
): Result.Result<TargetedSnapshotDelivery, ServerProjectionFailure> => {
  const snapshot = decodeSnapshotInputs({
    authoritativeInput: input.authoritative,
    replicatedWorldInput: input.inputs.replicatedWorld,
    resolver: config.blockStateForRead,
    world: connection.world,
    worldSnapshotInput: input.inputs.worldSnapshot,
  })
  if (Result.isFailure(snapshot)) {
    return Result.fail(snapshot.failure)
  }
  const interest = interestFor(config, connection)
  if (Result.isFailure(interest)) {
    return Result.fail(refusal('invalid-server-interest'))
  }
  return projectSnapshotForConnection({
    connection,
    interest: interest.success,
    locations: input.inputs.locations,
    playerDimensions: input.inputs.playerDimensions,
    snapshot: snapshot.success,
  })
}

const deltaRecipientFor = (connection: ConnectionRecord, interest: AreaOfInterest) => {
  const recipient = { id: connection.player, interest }
  if (connection.interest === undefined) {
    return recipient
  }
  return { ...recipient, previousInterest: connection.interest }
}

type RecipientDeltaProjectionRequest<Behaviour> = Readonly<{
  config: ServerAdapterConfiguration<Behaviour>
  connection: ConnectionRecord
  delta: ReplicatedWorldDeltaValue
}>

const hasDeltaChanges = (outcome: Extract<DeltaProjectionOutcome, { readonly _tag: 'ProjectedDelta' }>): boolean =>
  outcome.message.blockChanges.length > ZERO || outcome.message.changes.length > ZERO

type ResolvedDeltaProjection = Readonly<{
  interest: AreaOfInterest
  outcome: DeltaProjectionOutcome
}>

const resolveDeltaProjectionForConnection = <Behaviour>(
  request: RecipientDeltaProjectionRequest<Behaviour>,
): Result.Result<ResolvedDeltaProjection, ServerProjectionRefusal> => {
  const interest = interestFor(request.config, request.connection)
  if (Result.isFailure(interest)) {
    return Result.fail(refusal('invalid-server-interest'))
  }
  const projected = projectReplicatedWorldDelta(request.delta, [deltaRecipientFor(request.connection, interest.success)], request.config.ownerRegistry)
  if (Result.isFailure(projected)) {
    return Result.fail(refusal('delta-projection-failed'))
  }
  const [outcome] = projected.success
  if (outcome === undefined) {
    return Result.fail(refusal('delta-projection-failed'))
  }
  return Result.succeed({ interest: interest.success, outcome })
}

const shouldDeliverDelta = (
  connection: ConnectionRecord,
  interest: AreaOfInterest,
  outcome: DeltaProjectionOutcome,
): boolean => {
  if (outcome._tag !== 'ProjectedDelta') {
    return true
  }
  connection.interest = interest
  return hasDeltaChanges(outcome)
}

const projectDeltaForConnection = <Behaviour>(
  request: RecipientDeltaProjectionRequest<Behaviour>,
): Result.Result<TargetedDeltaDelivery | undefined, ServerProjectionRefusal> => {
  const resolved = resolveDeltaProjectionForConnection(request)
  if (Result.isFailure(resolved)) {
    return Result.fail(resolved.failure)
  }
  const { interest, outcome } = resolved.success
  if (!shouldDeliverDelta(request.connection, interest, outcome)) {
    return Result.succeed(undefined)
  }
  return Result.succeed({ _tag: 'TargetedDelta', connection: request.connection.handle, outcome })
}

type AppendDeltaDeliveryRequest<Behaviour> = Readonly<{
  config: ServerAdapterConfiguration<Behaviour>
  connection: ConnectionRecord
  delta: ReplicatedWorldDeltaValue
  deliveries: Array<TargetedDeltaDelivery>
}>

const appendDeltaDelivery = <Behaviour>(
  request: AppendDeltaDeliveryRequest<Behaviour>,
): Result.Result<void, ServerProjectionFailure> => {
  if (request.connection.world !== request.delta.world) {
    return Result.succeed(undefined)
  }
  const delivery = projectDeltaForConnection({
    config: request.config,
    connection: request.connection,
    delta: request.delta,
  })
  if (Result.isFailure(delivery)) {
    return Result.fail(delivery.failure)
  }
  if (delivery.success !== undefined) {
    request.deliveries.push(delivery.success)
  }
  return Result.succeed(undefined)
}

const projectDeltaForConnections = <Behaviour>(
  config: ServerAdapterConfiguration<Behaviour>,
  delta: ReplicatedWorldDeltaValue,
  connections: ReadonlyMap<ServerConnectionIdentity, ConnectionRecord>,
): Result.Result<ReadonlyArray<TargetedDeltaDelivery>, ServerProjectionFailure> => {
  const deliveries: Array<TargetedDeltaDelivery> = []
  for (const connection of connections.values()) {
    const appended = appendDeltaDelivery({ config, connection, deliveries, delta })
    if (Result.isFailure(appended)) {
      return Result.fail(appended.failure)
    }
  }
  return Result.succeed(Object.freeze(deliveries))
}

const appendSnapshotDeliveriesForInput = <Behaviour>(
  request: Readonly<{
    config: ServerAdapterConfiguration<Behaviour>
    connections: ReadonlyMap<ServerConnectionIdentity, ConnectionRecord>
    input: ServerSnapshotDeliveryInput
    snapshots: Array<TargetedSnapshotDelivery>
  }>,
): Result.Result<void, ServerProjectionFailure> => {
  const world = Schema.decodeUnknownResult(WorldId, strictParseOptions)(request.input.world)
  if (Result.isFailure(world)) {
    return Result.fail(refusal('invalid-authoritative-snapshot'))
  }
  for (const connection of request.connections.values()) {
    if (connection.world === world.success) {
      const projected = projectSnapshotInputForConnection(request.config, connection, request.input)
      if (Result.isFailure(projected)) {
        return Result.fail(projected.failure)
      }
      request.snapshots.push(projected.success)
    }
  }
  return Result.succeed(undefined)
}

const projectWorldSnapshotDeliveries = <Behaviour>(
  config: ServerAdapterConfiguration<Behaviour>,
  connections: ReadonlyMap<ServerConnectionIdentity, ConnectionRecord>,
  input: ServerFrameDeliveryInput,
): Result.Result<ReadonlyArray<TargetedSnapshotDelivery>, ServerProjectionFailure> => {
  const snapshots: Array<TargetedSnapshotDelivery> = []
  const snapshotInputs = input.snapshots ?? []
  if (!Array.isArray(snapshotInputs)) {
    return Result.fail(refusal('invalid-authoritative-snapshot'))
  }
  for (const snapshot of snapshotInputs) {
    const appended = appendSnapshotDeliveriesForInput({ config, connections, input: snapshot, snapshots })
    if (Result.isFailure(appended)) {
      return Result.fail(appended.failure)
    }
  }
  return Result.succeed(Object.freeze(snapshots))
}

const projectWorldDeltaDeliveries = <Behaviour>(
  config: ServerAdapterConfiguration<Behaviour>,
  connections: ReadonlyMap<ServerConnectionIdentity, ConnectionRecord>,
  input: ServerFrameDeliveryInput,
): Result.Result<ReadonlyArray<TargetedDeltaDelivery>, ServerProjectionFailure> => {
  if (input.delta === undefined) {
    return Result.succeed([])
  }
  const decoded = decodeReplicatedDelta({ input: input.delta, resolver: config.blockStatesForChange })
  if (Result.isFailure(decoded)) {
    return Result.fail(decoded.failure)
  }
  return projectDeltaForConnections(config, decoded.success, connections)
}

const projectServerFrameDelivery = <Behaviour>(
  config: ServerAdapterConfiguration<Behaviour>,
  connections: ReadonlyMap<ServerConnectionIdentity, ConnectionRecord>,
  delivery: ServerFrameDeliveryInput,
): Result.Result<ServerFrameDeliveries, ServerProjectionFailure> => {
  const snapshots = projectWorldSnapshotDeliveries(config, connections, delivery)
  if (Result.isFailure(snapshots)) {
    return Result.fail(snapshots.failure)
  }
  const deltas = projectWorldDeltaDeliveries(config, connections, delivery)
  if (Result.isFailure(deltas)) {
    return Result.fail(deltas.failure)
  }
  return Result.succeed({ deltas: deltas.success, snapshots: snapshots.success })
}

const emptyServerFrameDeliveries = (): ServerFrameDeliveries => ({ deltas: [], snapshots: [] })

type ServerConnectionRegistry = Readonly<{
  connections: Map<ServerConnectionIdentity, ConnectionRecord>
  findConnection: (handle: unknown) => ConnectionRecord | undefined
  handles: WeakMap<object, ConnectionRecord>
}>

const createConnectionRegistry = (): ServerConnectionRegistry => {
  const connections: Map<ServerConnectionIdentity, ConnectionRecord> = new Map()
  const handles = new WeakMap<object, ConnectionRecord>()
  const findConnection = (handle: unknown): ConnectionRecord | undefined => {
    if (typeof handle !== 'object' || handle === null) {
      return undefined
    }
    return handles.get(handle)
  }
  return { connections, findConnection, handles }
}

const isAcceptedInboundOutcome = (outcome: ServerInboundOutcome): outcome is ServerAcceptedInboundOutcome => {
  if (outcome._tag === 'CommandApplied') {
    return outcome.outcome._tag === 'AuthoritativeCommandIntentAccepted'
  }
  return outcome._tag === 'ChatReceived' || outcome._tag === 'MovementReceived' || outcome._tag === 'ResyncRequested'
}

export const createServerAdapter = <Behaviour>(
  config: ServerAdapterConfiguration<Behaviour>,
): ServerAdapter => {
  const { connections, findConnection, handles } = createConnectionRegistry()

  const registerConnection = (request: Readonly<{
    globalLimiter: ConnectionRateLimiter
    player: PlayerIdValue
    world: WorldIdValue
  }>): ServerConnectionHandle => {
    const identity = config.session.connect(request.player, request.world)
    const handle: ServerConnectionHandle = Object.freeze({ identity })
    const connection: ConnectionRecord = {
      globalLimiter: request.globalLimiter,
      handle,
      identity,
      interest: undefined,
      kindLimiter: createConnectionMessageRateLimiter(),
      player: request.player,
      world: request.world,
    }
    connections.set(identity, connection)
    handles.set(handle, connection)
    return handle
  }

  const connect = (player: PlayerIdValue, world: WorldIdValue): ServerConnectOutcome => {
    const current = connections.size
    if (current >= MAX_SERVER_CONNECTIONS) {
      return {
        _tag: 'ConnectionRejected',
        current: Schema.decodeUnknownSync(NonNegativeSafeIntegerSchema)(current),
        limit: MAX_SERVER_CONNECTIONS,
        reason: 'connection-limit',
      }
    }
    const limiter = createConnectionRateLimiterForAdmission()
    if (Result.isFailure(limiter)) {
      return {
        _tag: 'ConnectionRejected',
        current: Schema.decodeUnknownSync(NonNegativeSafeIntegerSchema)(current),
        failure: limiter.failure,
        limit: MAX_SERVER_CONNECTIONS,
        reason: 'rate-limiter-initialization',
      }
    }
    return {
      _tag: 'Connected',
      connection: registerConnection({ globalLimiter: limiter.success, player, world }),
    }
  }

  const disconnect = (handle: unknown): boolean => {
    const connection = findConnection(handle)
    if (connection === undefined) {
      return false
    }
    connections.delete(connection.identity)
    handles.delete(connection.handle)
    config.session.disconnectConnection(connection.identity)
    return true
  }

  const resume = (untrustedToken: unknown): Effect.Effect<ServerResumeOutcome> => Effect.gen(function* () {
    if (untrustedToken === undefined || untrustedToken === null) {
      return { _tag: 'ResumeRejected', reason: 'missing-token' }
    }
    const token = Schema.decodeUnknownResult(ReconnectTokenInput)(untrustedToken)
    if (Result.isFailure(token)) {
      return { _tag: 'ResumeRejected', reason: 'invalid-token' }
    }
    const authentication = Effect.flatMap(
      Effect.try({
        catch: () => 'authentication-service-failed',
        try: () => config.reconnectAuth.resume(token.success),
      }),
      (effect) => effect,
    )
    return yield* Effect.match(authentication, {
      onFailure: (): ServerResumeOutcome => ({ _tag: 'ResumeUnavailable', reason: 'authentication-service-failed' }),
      onSuccess: (resumed): ServerResumeOutcome => {
        if (resumed === undefined) {
          return { _tag: 'ResumeRejected', reason: 'invalid-token' }
        }
        return { _tag: 'ResumeAccepted', player: resumed.player, token: resumed.token }
      },
    })
  })

  const receiveFrame = (
    handle: unknown,
    untrustedFrame: unknown,
  ): Effect.Effect<ServerInboundOutcome> => Effect.gen(function* () {
    const connection = findConnection(handle)
    if (connection === undefined) {
      return { _tag: 'ConnectionRefused', reason: 'unknown-connection' }
    }
    const inspection = inspectClientFrame(untrustedFrame, config.ownerRegistry)
    if (Result.isFailure(inspection)) {
      return inspection.failure
    }
    const limited = yield* consumeInboundRateLimits(connection, inspection.success)
    if (limited._tag !== 'InboundFrameReady') {
      return limited
    }
    return yield* dispatchInboundMessage(config, connection, limited.message)
  })

  const handle = (request: ServerAdapterRequest): Effect.Effect<ServerAdapterOutcome> => {
    // eslint-disable-next-line default-case -- ServerAdapterRequest is a closed union.
    switch (request._tag) {
      case 'Connect':
        return Effect.succeed(connect(request.player, request.world))
      case 'Disconnect':
        return Effect.succeed({ _tag: 'Disconnected', disconnected: disconnect(request.connection) })
      case 'Resume':
        return resume(request.token)
      case 'PublishWorldState': {
        const projected = projectServerFrameDelivery(config, connections, request.delivery)
        if (Result.isFailure(projected)) {
          return Effect.succeed({ _tag: 'WorldStateRefused', failure: projected.failure })
        }
        return Effect.succeed({ _tag: 'WorldStatePublished', deliveries: projected.success })
      }
      case 'ReceiveFrame':
        return Effect.gen(function* () {
          const inbound = yield* receiveFrame(request.connection, request.frame)
          if (!isAcceptedInboundOutcome(inbound)) {
            return { _tag: 'FrameHandled', deliveries: emptyServerFrameDeliveries(), inbound }
          }
          const connection = findConnection(request.connection)
          if (connection === undefined) {
            return { _tag: 'FrameHandled', deliveries: emptyServerFrameDeliveries(), inbound }
          }
          const application = Effect.flatMap(
            Effect.try({
              catch: () => 'host-application-failed',
              try: () => config.applyAcceptedInbound(connection.handle, inbound),
            }),
            (effect) => effect,
          )
          return yield* Effect.match(application, {
            onFailure: (): ServerAdapterOutcome => ({
              _tag: 'FrameApplicationFailed',
              inbound,
              reason: 'host-application-failed',
            }),
            onSuccess: (delivery): ServerAdapterOutcome => {
              if (delivery === undefined) {
                return { _tag: 'FrameHandled', deliveries: emptyServerFrameDeliveries(), inbound }
              }
              const projected = projectServerFrameDelivery(config, connections, delivery)
              if (Result.isFailure(projected)) {
                return { _tag: 'FrameDeliveryRefused', failure: projected.failure, inbound }
              }
              return { _tag: 'FrameHandled', deliveries: projected.success, inbound }
            },
          })
        })
    }
  }

  return Object.freeze({ handle })
}

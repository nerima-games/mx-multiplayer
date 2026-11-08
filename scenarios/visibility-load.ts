import {
  type AreaOfInterest,
  CONNECTION_RATE_LIMITS,
  type ConnectionRateLimitFailure,
  type DeltaProjectionOutcome,
  PlayerId,
  type ReplicatedOwnerRegistry,
  type ReplicatedWorldDeltaMessage,
  WorldId,
  createAreaOfInterest,
  createConnectionRateLimiter,
  createReplicatedOwnerRegistry,
  projectReplicatedWorldDelta,
} from '../src/index.js'
import { BlockIdSchema, BlockPositionSchema, EncodedBlockStateSchema, WorldRevisionSchema } from '@nerima-games/mc-kernel'
import { Result, Schema } from 'effect'
import type {
  ScenarioClientId,
  ScenarioDefinition,
  ScenarioEvaluationInput,
  ScenarioStepContext,
} from './types.js'

const ZERO = 0
const ONE = 1
const CLIENT_COUNT = 2
const INSIDE_BOUNDARY_X = 15
const OUTSIDE_BOUNDARY_X = 16
const BOUNDARY_Z = 8
const BLOCK_Y = 64
const BEFORE_BLOCK_ID = 0
const INSIDE_BLOCK_ID = 1
const OUTSIDE_BLOCK_ID = 2
const FRAME_SIZE_BYTES = 1
const FRAME_REFILL_MS = 40
const BYTE_LIMIT = 80
const ACCEPTED_BYTES_BEFORE_REJECTION = 60
const REJECTED_BYTES = 21
const ACCEPTED_BYTES_AFTER_REJECTION = 20
const BYTE_RATE_FRAMES_PER_SECOND = 25
const BYTE_RATE_BYTES_PER_SECOND = 1_000
const BYTE_RATE_BURST_FRAMES = 2
const OWNER_REGISTRY_MAX_DELTA_BLOCK_CHANGES = 2
const OWNER_REGISTRY_MAX_SNAPSHOT_BLOCK_READS = 1
const OWNER_REGISTRY_MAX_DEPTH = 13
const OWNER_REGISTRY_MAX_COLLECTION_ITEMS = 6
const OWNER_REGISTRY_MAX_FRAME_BYTES = 100_000
const WORLD = WorldId.make('overworld')
const ZERO_BLOCK_STATE = Schema.decodeUnknownSync(EncodedBlockStateSchema)(ZERO)

export const VISIBILITY_LOAD_OWNER_REGISTRY: ReplicatedOwnerRegistry = Result.getOrThrow(createReplicatedOwnerRegistry([], {
  maxCollectionItems: OWNER_REGISTRY_MAX_COLLECTION_ITEMS,
  maxDeltaBlockChanges: OWNER_REGISTRY_MAX_DELTA_BLOCK_CHANGES,
  maxDeltaFrameBytes: OWNER_REGISTRY_MAX_FRAME_BYTES,
  maxDepth: OWNER_REGISTRY_MAX_DEPTH,
  maxRegisteredOwners: ZERO,
  maxSnapshotBlockReads: OWNER_REGISTRY_MAX_SNAPSHOT_BLOCK_READS,
  maxSnapshotFrameBytes: OWNER_REGISTRY_MAX_FRAME_BYTES,
  ownerStates: [],
}))

const interestFor = (chunkX: number): AreaOfInterest => Result.getOrThrow(createAreaOfInterest({
  chunks: [{ dimension: 'overworld', x: chunkX, z: ZERO }],
  ownerIds: [],
}))

const CLIENT_INTERESTS: Readonly<Record<ScenarioClientId, AreaOfInterest>> = {
  'client-a': interestFor(ZERO),
  'client-b': interestFor(ONE),
}
const SCENARIO_CLIENTS: ScenarioStepContext['clients'] = [
  { id: 'client-a', player: 'scenario-player-a' },
  { id: 'client-b', player: 'scenario-player-b' },
]

const blockChange = (x: number, after: number): ReplicatedWorldDeltaMessage['blockChanges'][number] => ({
  after: Schema.decodeUnknownSync(BlockIdSchema)(after),
  afterState: ZERO_BLOCK_STATE,
  before: Schema.decodeUnknownSync(BlockIdSchema)(BEFORE_BLOCK_ID),
  beforeState: ZERO_BLOCK_STATE,
  dimension: 'overworld',
  position: Schema.decodeUnknownSync(BlockPositionSchema)({ x, y: BLOCK_Y, z: BOUNDARY_Z }),
})

const deltaForFrame = (frame: number): ReplicatedWorldDeltaMessage => ({
  _tag: 'ReplicatedWorldDelta',
  blockChanges: [
    blockChange(INSIDE_BOUNDARY_X, INSIDE_BLOCK_ID),
    blockChange(OUTSIDE_BOUNDARY_X, OUTSIDE_BLOCK_ID),
  ],
  changes: [],
  revision: Schema.decodeUnknownSync(WorldRevisionSchema)(frame),
  world: WORLD,
})

const projectedMessage = (outcome: DeltaProjectionOutcome): ReplicatedWorldDeltaMessage => {
  if (outcome._tag !== 'ProjectedDelta') {
    throw new Error(`expected a projected delta, received ${outcome.reason}`)
  }
  return outcome.message
}

const projectedMessages = (
  frame: number,
  clients: ScenarioStepContext['clients'],
): ReadonlyMap<ScenarioClientId, ReplicatedWorldDeltaMessage> => {
  const projections = Result.getOrThrow(projectReplicatedWorldDelta(
    deltaForFrame(frame),
    clients.map((client) => ({
      id: PlayerId.make(client.player),
      interest: CLIENT_INTERESTS[client.id],
      previousInterest: CLIENT_INTERESTS[client.id],
    })),
    VISIBILITY_LOAD_OWNER_REGISTRY,
  ))
  const byPlayer = new Map(projections.map((projection) => [projection.recipientId, projection] as const))
  const messages = new Map<ScenarioClientId, ReplicatedWorldDeltaMessage>()
  for (const client of clients) {
    const projection = byPlayer.get(PlayerId.make(client.player))
    if (projection === undefined) {
      throw new Error(`missing AOI projection for ${client.id}`)
    }
    messages.set(client.id, projectedMessage(projection))
  }
  return messages
}

export const projectVisibilityLoadFrame = (frame: number): ReadonlyMap<ScenarioClientId, ReplicatedWorldDeltaMessage> =>
  projectedMessages(frame, SCENARIO_CLIENTS)

const makeLimiter = (config: unknown) => Result.getOrThrow(createConnectionRateLimiter(config))

const hasFailureReason = (
  result: Result.Result<void, ConnectionRateLimitFailure>,
  reason: 'frame-rate' | 'byte-rate' | 'delta-too-large',
): boolean => Result.isFailure(result) && result.failure._tag === 'RateLimitExceeded' && result.failure.reason === reason

const frameRatePasses = (): boolean => {
  const frameLimiter = makeLimiter(CONNECTION_RATE_LIMITS)
  let burstAccepted = true
  for (let frame = ZERO; frame < CONNECTION_RATE_LIMITS.burstFrames; frame += ONE) {
    burstAccepted = Result.isSuccess(frameLimiter.consume(FRAME_SIZE_BYTES, ZERO)) && burstAccepted
  }
  const frameOverflow = frameLimiter.consume(FRAME_SIZE_BYTES, ZERO)
  const frameRefill = frameLimiter.consume(FRAME_SIZE_BYTES, FRAME_REFILL_MS)
  return burstAccepted
    && hasFailureReason(frameOverflow, 'frame-rate')
    && Result.isSuccess(frameRefill)
}

const byteRatePasses = (): boolean => {
  const byteLimiter = makeLimiter({
    burstFrames: BYTE_RATE_BURST_FRAMES,
    bytesPerSecond: BYTE_RATE_BYTES_PER_SECOND,
    framesPerSecond: BYTE_RATE_FRAMES_PER_SECOND,
    maxDeltaBytes: BYTE_LIMIT,
  })
  const initialBytesAccepted = Result.isSuccess(byteLimiter.consume(ACCEPTED_BYTES_BEFORE_REJECTION, ZERO))
  const byteOverflow = byteLimiter.consume(REJECTED_BYTES, ZERO)
  const bytesAcceptedAfterRejection = Result.isSuccess(byteLimiter.consume(ACCEPTED_BYTES_AFTER_REJECTION, ZERO))
  return initialBytesAccepted
    && hasFailureReason(byteOverflow, 'byte-rate')
    && bytesAcceptedAfterRejection
}

const deltaSizePasses = (): boolean => {
  const deltaLimiter = makeLimiter(CONNECTION_RATE_LIMITS)
  const exactDeltaAccepted = Result.isSuccess(deltaLimiter.consume(CONNECTION_RATE_LIMITS.maxDeltaBytes, ZERO))
  const oversizedDelta = deltaLimiter.consume(CONNECTION_RATE_LIMITS.maxDeltaBytes + ONE, ZERO)
  const frameAfterOversizedDeltaAccepted = Result.isSuccess(deltaLimiter.consume(FRAME_SIZE_BYTES, ZERO))

  return exactDeltaAccepted
    && hasFailureReason(oversizedDelta, 'delta-too-large')
    && frameAfterOversizedDeltaAccepted
}

const rateBoundariesPass = (): boolean => frameRatePasses() && byteRatePasses() && deltaSizePasses()

const latestRuntimeTracePasses = (input: ScenarioEvaluationInput): boolean => {
  const entries = input.wireLog.filter((entry) => entry.frame === input.frame)
  const clients = new Set(entries
    .filter((entry) => entry.tag === 'ReplicatedWorldDelta' && entry.outcome === 'delivered')
    .map((entry) => entry.from))
  return entries.length === CLIENT_COUNT && clients.size === CLIENT_COUNT
}

const projectedChunksPass = (frame: number): boolean => {
  const messages = projectVisibilityLoadFrame(frame)
  const clientAXs = messages.get('client-a')?.blockChanges.map((change) => change.position.x)
  const clientBXs = messages.get('client-b')?.blockChanges.map((change) => change.position.x)
  return clientAXs?.length === ONE
    && clientAXs[ZERO] === INSIDE_BOUNDARY_X
    && clientBXs?.length === ONE
    && clientBXs[ZERO] === OUTSIDE_BOUNDARY_X
}

export const visibilityLoadScenario: ScenarioDefinition = {
  actions: ({ frame, clients }) => {
    const projections = projectedMessages(frame, clients)
    return clients.map((client) => {
      const message = projections.get(client.id)
      if (message === undefined) {
        throw new Error(`missing AOI projection for ${client.id}`)
      }
      return {
        clientId: client.id,
        kind: 'message',
        message,
        owners: VISIBILITY_LOAD_OWNER_REGISTRY,
      }
    })
  },
  angle: 'A6',
  description: 'Per-client C4 deltas travel through the owner-aware runtime path while frame, byte, and delta limits use deterministic inputs.',
  evaluate: (input) => {
    if (input.frame === ZERO) {
      return { status: 'incomplete', summary: 'waiting for the first projected chunk frame' }
    }
    const passed = latestRuntimeTracePasses(input)
      && projectedChunksPass(input.frame)
      && rateBoundariesPass()
    if (passed) {
      return {
        status: 'pass',
        summary: 'recipient projections contain only their chunk update; frame and byte boundaries passed',
      }
    }
    return { status: 'fail', summary: 'chunk projection or rate boundary check failed' }
  },
  group: 'visibility',
  id: 's4.visibility-load.aoi-rate-boundaries',
  title: 'Per-client chunk visibility and rate limits',
}

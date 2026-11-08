import { describe, expect, it } from '@effect/vitest'
import {
  BlockIdSchema,
  BlockPositionSchema,
  DimensionRevisionSchema,
  EncodedBlockStateSchema,
  SimulationTickSchema,
  WorldIdSchema as KernelWorldIdSchema,
  WorldRevisionSchema,
} from '@nerima-games/mc-kernel'
import { makeReplicatedOwnerId } from '@nerima-games/mc-sim'
import { Effect, Result, Schema } from 'effect'
import { afterEach, beforeEach, vi } from 'vitest'
import { AuthoritativeSession } from '../src/domain/authoritative-session.js'
import {
  createReplicatedOwnerRegistry,
  encodeFrame,
  ReplicatedOwnerRegistryLimitsSchema,
  type ReplicatedOwnerRegistryLimits,
} from '../src/domain/codec.js'
import type { WorldWriteServices } from '../src/application/server/command-application.js'
import {
  createServerAdapter,
  type ServerAdapter,
  type ServerAdapterConfiguration,
  type ServerOwnerLocationIndex,
  type ServerOwnerLocationResolution,
  type ServerSnapshotProjectionInputs,
} from '../src/application/server/server-adapter.js'
import { EntityId, PlayerId, WorldId, type AuthoritativeSnapshot } from '../src/domain/protocol.js'

const mockControls = vi.hoisted(() => ({
  rejectFinalDeltaDecode: false,
  rejectFinalSnapshotDecode: false,
  rejectKindLimiter: false,
  rejectOwnerIdDecode: false,
  rejectLocationChecks: false,
  rejectRateLimiterCreation: false,
  returnEmptyDeltaProjection: false,
}))

vi.mock('@nerima-games/mc-sim', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nerima-games/mc-sim')>()
  const { Schema: EffectSchema } = await import('effect')
  const ownerIdDecodeGate = EffectSchema.makeFilter<typeof actual.ReplicatedOwnerIdSchema.Type>(
    () => !mockControls.rejectOwnerIdDecode,
    { expected: 'owner ID decode enabled by test control' },
  )
  return {
    ...actual,
    ReplicatedOwnerIdSchema: actual.ReplicatedOwnerIdSchema.pipe(EffectSchema.check(ownerIdDecodeGate)),
  }
})

vi.mock('../src/domain/area-of-interest.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/domain/area-of-interest.js')>()
  const { Result: EffectResult } = await import('effect')
  return {
    ...actual,
    areaOfInterestIncludesLocation: (...args: Parameters<typeof actual.areaOfInterestIncludesLocation>) => {
      if (mockControls.rejectLocationChecks) {
        return EffectResult.fail(new actual.AreaOfInterestInputError({ path: 'location', reason: 'invalid-chunk' }))
      }
      return actual.areaOfInterestIncludesLocation(...args)
    },
  }
})

vi.mock('../src/domain/protocol.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/domain/protocol.js')>()
  const { Schema: EffectSchema } = await import('effect')
  const snapshotDecodeGate = EffectSchema.makeFilter<typeof actual.ReplicatedWorldSnapshot.Type>(
    () => !mockControls.rejectFinalSnapshotDecode,
    { expected: 'snapshot decode enabled by test control' },
  )
  const deltaDecodeGate = EffectSchema.makeFilter<typeof actual.ReplicatedWorldDeltaMessage.Type>(
    () => !mockControls.rejectFinalDeltaDecode,
    { expected: 'delta decode enabled by test control' },
  )
  return {
    ...actual,
    ReplicatedWorldDeltaMessage: actual.ReplicatedWorldDeltaMessage.pipe(EffectSchema.check(deltaDecodeGate)),
    ReplicatedWorldSnapshot: actual.ReplicatedWorldSnapshot.pipe(EffectSchema.check(snapshotDecodeGate)),
  }
})

vi.mock('../src/domain/rate-limit.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/domain/rate-limit.js')>()
  const { Result: EffectResult } = await import('effect')
  return {
    ...actual,
    createConnectionMessageRateLimiter: () => {
      if (!mockControls.rejectKindLimiter) {
        return actual.createConnectionMessageRateLimiter()
      }
      return Object.freeze({
        consume: () => EffectResult.fail(new actual.RateLimitInputError({ reason: 'invalid-time' })),
      })
    },
    createConnectionRateLimiter: (...args: Parameters<typeof actual.createConnectionRateLimiter>) => {
      if (mockControls.rejectRateLimiterCreation) {
        return EffectResult.fail(new actual.RateLimitConfigurationError({ field: 'config', reason: 'invalid-value' }))
      }
      return actual.createConnectionRateLimiter(...args)
    },
  }
})

vi.mock('../src/domain/chunk-delta.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/domain/chunk-delta.js')>()
  const { Result: EffectResult } = await import('effect')
  return {
    ...actual,
    projectReplicatedWorldDelta: (...args: Parameters<typeof actual.projectReplicatedWorldDelta>) => {
      if (mockControls.returnEmptyDeltaProjection) {
        return EffectResult.succeed([])
      }
      return actual.projectReplicatedWorldDelta(...args)
    },
  }
})

const resetMockControls = (): void => {
  mockControls.rejectFinalDeltaDecode = false
  mockControls.rejectFinalSnapshotDecode = false
  mockControls.rejectKindLimiter = false
  mockControls.rejectOwnerIdDecode = false
  mockControls.rejectLocationChecks = false
  mockControls.rejectRateLimiterCreation = false
  mockControls.returnEmptyDeltaProjection = false
}

beforeEach(resetMockControls)
afterEach(resetMockControls)

const WORLD = WorldId.make('failure-path-world')
const KERNEL_WORLD = Schema.decodeUnknownSync(KernelWorldIdSchema)('failure-path-world')
const PLAYER = PlayerId.make('failure-path-player')
const OWNER = makeReplicatedOwnerId('owner:failure-path')
const BLOCK_ID = Schema.decodeUnknownSync(BlockIdSchema)(106)
const STATE_ZERO = Schema.decodeUnknownSync(EncodedBlockStateSchema)(0)
const STATE_SIXTEEN = Schema.decodeUnknownSync(EncodedBlockStateSchema)(16)

const ownerRegistryLimits: ReplicatedOwnerRegistryLimits = Schema.decodeUnknownSync(ReplicatedOwnerRegistryLimitsSchema)({
  maxRegisteredOwners: 0,
  maxDeltaBlockChanges: 320,
  maxSnapshotBlockReads: 3_422_759,
  maxDepth: 13,
  maxCollectionItems: 31_149,
  maxDeltaFrameBytes: 54_489,
  maxSnapshotFrameBytes: 3_422_759,
  ownerStates: [],
})
const ownerRegistry = Result.getOrThrow(createReplicatedOwnerRegistry([], ownerRegistryLimits))

const EMPTY_SERVICES: WorldWriteServices<never> = {
  entities: {
    despawn: () => Effect.succeed(false),
    find: () => Effect.succeed(undefined),
  },
  hotbarFor: () => undefined,
  inventoryFor: () => undefined,
  vehiclesFor: () => undefined,
  vitalsFor: () => undefined,
}

const authoritativeSnapshot = (): AuthoritativeSnapshot => ({
  _tag: 'AuthoritativeSnapshot',
  containers: [],
  entities: [],
  furnaces: [],
  inventories: [],
  revision: 4,
  timeWeather: { timeOfDay: 6_000, weather: 'clear' },
  villagerTrades: [],
  vitals: [],
  world: WORLD,
})

const makeAdapter = (): ServerAdapter => {
  const session = new AuthoritativeSession((world) => world === WORLD ? 4 : undefined)
  session.restore(authoritativeSnapshot())
  const config: ServerAdapterConfiguration<never> = {
    blockStateForRead: () => Result.succeed(STATE_ZERO),
    blockStatesForChange: () => Result.succeed({ afterState: STATE_SIXTEEN, beforeState: STATE_ZERO }),
    commandContextFor: (identity) => ({
      expectedDimensionRevision: Schema.decodeUnknownSync(DimensionRevisionSchema)(0),
      identity,
      targetTick: Schema.decodeUnknownSync(SimulationTickSchema)(0),
    }),
    commandServices: EMPTY_SERVICES,
    interestInputFor: () => ({ chunks: [{ dimension: 'overworld', x: 0, z: 0 }], ownerIds: [] }),
    ownerRegistry,
    reconnectAuth: { resume: () => Effect.succeed(undefined) },
    session,
  }
  return createServerAdapter(config)
}

const connect = (adapter: ServerAdapter) => {
  const result = adapter.connect(PLAYER, WORLD)
  if (result._tag !== 'Connected') {
    throw new Error('expected connection admission')
  }
  return result.connection
}

const replicatedSnapshot = (
  owners: ReadonlyArray<Readonly<{ owner: typeof OWNER; state: unknown }>> = [],
  blocks: ReadonlyArray<unknown> = [],
) => ({
  _tag: 'ReplicatedWorldSnapshot' as const,
  blocks,
  owners,
  revision: Schema.decodeUnknownSync(WorldRevisionSchema)(4),
  world: KERNEL_WORLD,
})

const snapshotInputs = (
  replicatedWorld: unknown,
  locations: ServerOwnerLocationIndex = new Map(),
): ServerSnapshotProjectionInputs => ({ locations, replicatedWorld })

const emptyDelta = () => ({
  _tag: 'ReplicatedWorldDelta' as const,
  blockChanges: [],
  changes: [],
  revision: Schema.decodeUnknownSync(WorldRevisionSchema)(5),
  world: KERNEL_WORLD,
})

const makeFrame = (message: unknown) => Result.getOrThrow(encodeFrame(message, ownerRegistry))

const ownerLocation = (): ServerOwnerLocationResolution => ({
  _tag: 'Located',
  blockPosition: Schema.decodeUnknownSync(BlockPositionSchema)({ x: 0, y: 64, z: 0 }),
  dimension: 'overworld',
})

describe('server adapter typed failure paths', () => {
  it('returns a typed refusal when an entity owner ID cannot be decoded', () => {
    mockControls.rejectOwnerIdDecode = true
    const adapter = makeAdapter()
    const connection = connect(adapter)
    const snapshot = {
      ...authoritativeSnapshot(),
      entities: [{
        _tag: 'living' as const,
        at: { x: 0, y: 64, z: 0 },
        entityId: EntityId.make('entity:failure-path'),
        entityType: 'zombie',
        health: 20,
        maxHealth: 20,
      }],
    }

    expect(adapter.projectSnapshot(connection, snapshot, snapshotInputs({
      _tag: 'ReplicatedWorldSnapshot',
      blocks: [],
      owners: [],
      revision: Schema.decodeUnknownSync(WorldRevisionSchema)(4),
      world: KERNEL_WORLD,
    }))).toMatchObject({
      _tag: 'Failure',
      failure: { _tag: 'ServerProjectionRefused', reason: 'invalid-location-owner-id' },
    })
  })

  it('maps owner AOI errors to invalid-owner-location', () => {
    mockControls.rejectLocationChecks = true
    const adapter = makeAdapter()
    const connection = connect(adapter)
    const locations: ServerOwnerLocationIndex = new Map([[OWNER, ownerLocation()]])
    const result = adapter.projectSnapshot(
      connection,
      authoritativeSnapshot(),
      snapshotInputs(replicatedSnapshot([{ owner: OWNER, state: { value: 1 } }]), locations),
    )

    expect(result).toMatchObject({
      _tag: 'Failure',
      failure: { _tag: 'ServerProjectionRefused', reason: 'invalid-owner-location' },
    })
  })

  it('maps block AOI errors to invalid-block-location', () => {
    mockControls.rejectLocationChecks = true
    const adapter = makeAdapter()
    const connection = connect(adapter)
    const result = adapter.projectSnapshot(
      connection,
      authoritativeSnapshot(),
      snapshotInputs(replicatedSnapshot([], [{
        dimension: 'overworld',
        position: Schema.decodeUnknownSync(BlockPositionSchema)({ x: 0, y: 64, z: 0 }),
        reading: { _tag: 'Block', block: BLOCK_ID },
      }])),
    )

    expect(result).toMatchObject({
      _tag: 'Failure',
      failure: { _tag: 'ServerProjectionRefused', reason: 'invalid-block-location' },
    })
  })

  it('refuses a failed final replicated snapshot decode', () => {
    mockControls.rejectFinalSnapshotDecode = true
    const adapter = makeAdapter()
    const connection = connect(adapter)

    expect(adapter.projectSnapshot(
      connection,
      authoritativeSnapshot(),
      snapshotInputs(replicatedSnapshot()),
    )).toMatchObject({
      _tag: 'Failure',
      failure: { _tag: 'ServerProjectionRefused', reason: 'invalid-replicated-snapshot' },
    })
  })

  it('refuses a failed final replicated delta decode', () => {
    mockControls.rejectFinalDeltaDecode = true

    expect(makeAdapter().projectDelta(emptyDelta())).toMatchObject({
      _tag: 'Failure',
      failure: { _tag: 'ServerProjectionRefused', reason: 'invalid-replicated-delta' },
    })
  })

  it('rejects connection admission when the global limiter cannot be initialized', () => {
    mockControls.rejectRateLimiterCreation = true

    expect(makeAdapter().connect(PLAYER, WORLD)).toMatchObject({
      _tag: 'ConnectionRejected',
      reason: 'rate-limiter-initialization',
      failure: { _tag: 'RateLimitConfigurationError' },
    })
  })

  it('disconnects when the kind limiter returns a typed input failure', async () => {
    mockControls.rejectKindLimiter = true
    const adapter = makeAdapter()
    const connection = connect(adapter)
    const frame = makeFrame({ _tag: 'Chat', player: PLAYER, text: 'hello' })

    await expect(Effect.runPromise(adapter.receiveFrame(connection, frame))).resolves.toMatchObject({
      _tag: 'RateLimited',
      action: 'disconnect',
      kind: 'chat',
      failure: { _tag: 'RateLimitInputError', reason: 'invalid-time' },
    })
  })

  it('refuses an empty chunk-delta projection for a connected recipient', () => {
    const adapter = makeAdapter()
    connect(adapter)
    mockControls.returnEmptyDeltaProjection = true

    expect(adapter.projectDelta(emptyDelta())).toMatchObject({
      _tag: 'Failure',
      failure: { _tag: 'ServerProjectionRefused', reason: 'delta-projection-failed' },
    })
  })
})

/* eslint-disable no-magic-numbers, id-length -- Compact fixed fixtures make scale cardinalities explicit. */
import { describe, expect, it } from '@effect/vitest'
import * as fc from 'fast-check'
import { performance } from 'node:perf_hooks'
import { BlockIdSchema, BlockPositionSchema, WorldRevisionSchema } from '@nerima-games/mc-kernel'
import {
  makeReplicatedOwnerId,
  ReplicatedOwnerIdSchema,
} from '@nerima-games/mc-sim'
import type {
  ReplicatedBlockChange,
  ReplicatedOwnerChange,
  ReplicatedOwnerId,
} from '@nerima-games/mc-sim'
import { Result, Schema } from 'effect'
import {
  areaOfInterestExpanded,
  areaOfInterestIncludesBlockChange,
  areaOfInterestIncludesChunkKey,
  areaOfInterestIncludesOwner,
  chunkInterestKeyForBlockChange,
  createAreaOfInterest,
  isAreaOfInterest,
  type AreaOfInterest,
} from '../src/domain/area-of-interest.js'
import {
  MAX_C4_DELTA_FRAME_BYTES,
  projectReplicatedWorldDelta,
} from '../src/domain/chunk-delta.js'
import {
  createReplicatedOwnerRegistry,
  decodeFrame,
  NonNegativeSafeIntegerSchema,
  PositiveSafeIntegerSchema,
  encodeFrame,
  wireFrameByteLength,
} from '../src/domain/codec.js'
import type { ReplicatedOwnerRegistry, ReplicatedOwnerRegistryLimits } from '../src/domain/codec.js'
import {
  AuthoritativeResyncRequest,
  NetworkMessage,
  ReplicatedWorldDeltaMessage,
  WorldId,
} from '../src/domain/protocol.js'
import {
  CONNECTION_RATE_LIMITS,
  createConnectionRateLimiter,
  RateLimitConfigurationError,
  RateLimitExceeded,
  RateLimitInputError,
} from '../src/domain/rate-limit.js'

const strictParseOptions = { onExcessProperty: 'error' as const }
const nonNegativeBound = (value: number) => Schema.decodeUnknownSync(NonNegativeSafeIntegerSchema)(value)
const positiveBound = (value: number) => Schema.decodeUnknownSync(PositiveSafeIntegerSchema)(value)
const AOI_PROPERTY_SEED = 4_102_026
const RATE_PROPERTY_SEED = 4_102_027
const PROJECTION_PROPERTY_SEED = 4_102_028
const PROPERTY_RUNS = 96
const CHUNK_SIDE_BLOCKS = 16
const WORLD = WorldId.make('scale-world')
const OTHER_WORLD = WorldId.make('other-world')
const OWNER_A = makeReplicatedOwnerId('owner:a')
const OWNER_B = makeReplicatedOwnerId('owner:b')
const OWNER_C = makeReplicatedOwnerId('owner:c')
const OWNER_D = makeReplicatedOwnerId('owner:d')
const OWNER_IDS: ReadonlyArray<ReplicatedOwnerId> = [OWNER_A, OWNER_B, OWNER_C, OWNER_D]
const CHUNK_EDGE_CASES = [
  { offsetX: 0, offsetZ: 0, visible: true },
  { offsetX: 15, offsetZ: 15, visible: true },
  { offsetX: -1, offsetZ: 8, visible: false },
  { offsetX: 16, offsetZ: 8, visible: false },
  { offsetX: 8, offsetZ: -1, visible: false },
  { offsetX: 8, offsetZ: 16, visible: false },
] as const
const OWNER_STATE_SCHEMA = Schema.Struct({ value: Schema.Number })
const OWNER_REGISTRATIONS = OWNER_IDS.map((ownerId) => ({
  ownerId,
  schema: OWNER_STATE_SCHEMA,
  initialState: { value: 0 },
}))
const OWNER_STATE_BOUNDS: ReplicatedOwnerRegistryLimits['ownerStates'] = OWNER_IDS.map((ownerId) => ({
  ownerId,
  maxStateBytes: positiveBound(64),
  maxStateDepth: positiveBound(3),
  maxCollectionItems: positiveBound(4),
}))
const EMPTY_OWNER_REGISTRATIONS: typeof OWNER_REGISTRATIONS = []

const registryLimits = (maxDeltaFrameBytes = 100_000): ReplicatedOwnerRegistryLimits => ({
  maxRegisteredOwners: nonNegativeBound(OWNER_IDS.length),
  maxDeltaBlockChanges: nonNegativeBound(320),
  maxSnapshotBlockReads: nonNegativeBound(3_422_759),
  maxDepth: positiveBound(13),
  maxCollectionItems: positiveBound(31_149),
  maxDeltaFrameBytes: positiveBound(maxDeltaFrameBytes),
  maxSnapshotFrameBytes: positiveBound(3_422_759),
  ownerStates: OWNER_STATE_BOUNDS,
})

const makeOwnerRegistry = (maxDeltaFrameBytes = 100_000): ReplicatedOwnerRegistry => {
  const result = createReplicatedOwnerRegistry(OWNER_REGISTRATIONS, registryLimits(maxDeltaFrameBytes))
  if (Result.isFailure(result)) {
    throw result.failure
  }
  return result.success
}

const EMPTY_OWNER_REGISTRY_LIMITS: ReplicatedOwnerRegistryLimits = {
  maxRegisteredOwners: nonNegativeBound(0),
  maxDeltaBlockChanges: nonNegativeBound(320),
  maxSnapshotBlockReads: nonNegativeBound(3_422_759),
  maxDepth: positiveBound(13),
  maxCollectionItems: positiveBound(31_149),
  maxDeltaFrameBytes: positiveBound(100_000),
  maxSnapshotFrameBytes: positiveBound(3_422_759),
  ownerStates: [],
}

const makeEmptyOwnerRegistry = (maxDeltaFrameBytes = 100_000): ReplicatedOwnerRegistry => {
  const result = createReplicatedOwnerRegistry(EMPTY_OWNER_REGISTRATIONS, {
    ...EMPTY_OWNER_REGISTRY_LIMITS,
    maxDeltaFrameBytes,
  })
  if (Result.isFailure(result)) {
    throw result.failure
  }
  return result.success
}

const revision = (value: number): number => Schema.decodeUnknownSync(WorldRevisionSchema)(value)

const ownerId = (value: string): ReplicatedOwnerId => Schema.decodeUnknownSync(ReplicatedOwnerIdSchema)(value)

const ownerChange = (owner: ReplicatedOwnerId, value: number): ReplicatedOwnerChange => ({
  owner,
  state: { value },
})

const blockChange = (
  x: number,
  z = 0,
  dimension: ReplicatedBlockChange['dimension'] = 'overworld',
  after = 1,
): ReplicatedBlockChange => ({
  before: Schema.decodeUnknownSync(BlockIdSchema)(0),
  dimension,
  position: Schema.decodeUnknownSync(BlockPositionSchema)({ x, y: 64, z }),
  after: Schema.decodeUnknownSync(BlockIdSchema)(after),
})

const makeDelta = (
  blockChanges: ReadonlyArray<ReplicatedBlockChange> = [],
  changes: ReadonlyArray<ReplicatedOwnerChange> = [],
  world = WORLD,
  atRevision = revision(77),
) => ({
  _tag: 'ReplicatedWorldDelta' as const,
  blockChanges,
  changes,
  revision: atRevision,
  world,
})

const makeInterest = (
  chunks: ReadonlyArray<Readonly<{ dimension: 'overworld' | 'nether' | 'end'; x: number; z: number }>> = [],
  ownerIds: ReadonlyArray<ReplicatedOwnerId> = [],
): AreaOfInterest => {
  const result = createAreaOfInterest({ chunks, ownerIds })
  if (Result.isFailure(result)) {
    throw result.failure
  }
  return result.success
}

const expectChunkEdgeMembership = (
  dimension: ReplicatedBlockChange['dimension'],
  chunkX: number,
  chunkZ: number,
  edge: typeof CHUNK_EDGE_CASES[number],
): void => {
  const interest = makeInterest([{ dimension, x: chunkX, z: chunkZ }])
  const change = blockChange(
    (chunkX * CHUNK_SIDE_BLOCKS) + edge.offsetX,
    (chunkZ * CHUNK_SIDE_BLOCKS) + edge.offsetZ,
    dimension,
  )
  expect(areaOfInterestIncludesBlockChange(interest, change)).toBe(edge.visible)
}

const readFrame = (frame: string, owners: ReplicatedOwnerRegistry): unknown => {
  const decoded = decodeFrame(frame, owners)
  expect(Result.isSuccess(decoded)).toBe(true)
  const message = Result.getOrThrow(decoded)
  const strictMessage = Schema.decodeUnknownResult(NetworkMessage, strictParseOptions)(message)
  expect(Result.isSuccess(strictMessage)).toBe(true)
  return Result.getOrThrow(strictMessage)
}

const readResyncRequest = (request: unknown): typeof AuthoritativeResyncRequest.Type => {
  const decoded = Schema.decodeUnknownResult(AuthoritativeResyncRequest, strictParseOptions)(request)
  expect(Result.isSuccess(decoded)).toBe(true)
  return Result.getOrThrow(decoded)
}

const resultError = <A, E>(result: Result.Result<A, E>): E => {
  if (Result.isSuccess(result)) {
    throw new Error('Expected a failure result')
  }
  return result.failure
}

const arrayValueAt = <Value>(values: ReadonlyArray<Value>, index: number): Value => {
  const value = values[index]
  if (value === undefined) {
    throw new Error(`Expected an item at index ${index}`)
  }
  return value
}

const candidateDimension = (index: number): ReplicatedBlockChange['dimension'] => {
  const dimensionIndex = index % 3
  if (dimensionIndex === 0) {
    return 'overworld'
  }
  if (dimensionIndex === 1) {
    return 'nether'
  }
  return 'end'
}

const createLimiter = (config: unknown = CONNECTION_RATE_LIMITS) => {
  const result = createConnectionRateLimiter(config)
  if (Result.isFailure(result)) {
    throw result.failure
  }
  return result.success
}

describe('area of interest', () => {
  it('validates exact fields and selects dimension-qualified chunks using floor for negative blocks', () => {
    const interest = makeInterest([
      { dimension: 'overworld', x: -1, z: 0 },
      { dimension: 'nether', x: 0, z: 0 },
    ], [ownerId('owner:one')])

    expect(interest.chunkCount).toBe(2)
    expect(interest.ownerCount).toBe(1)
    expect(isAreaOfInterest(interest)).toBe(true)
    expect(areaOfInterestIncludesOwner(interest, ownerId('owner:one'))).toBe(true)
    expect(areaOfInterestIncludesOwner(interest, ownerId('owner:two'))).toBe(false)
    expect(areaOfInterestIncludesBlockChange(interest, blockChange(-1))).toBe(true)
    expect(areaOfInterestIncludesBlockChange(interest, blockChange(0))).toBe(false)
    expect(areaOfInterestIncludesBlockChange(interest, blockChange(0, 0, 'nether'))).toBe(true)
    expect(isAreaOfInterest(null)).toBe(false)
  })

  it('property-checks generated chunk membership at fixed edges and immediately outside', () => {
    for (const edge of CHUNK_EDGE_CASES) {
      expectChunkEdgeMembership('overworld', -2, 3, edge)
    }

    fc.assert(
      fc.property(
        fc.constantFrom('overworld', 'nether', 'end'),
        fc.integer({ min: -64, max: 64 }),
        fc.integer({ min: -64, max: 64 }),
        fc.constantFrom(...CHUNK_EDGE_CASES),
        (dimension, chunkX, chunkZ, edge) => {
          expectChunkEdgeMembership(dimension, chunkX, chunkZ, edge)
        },
      ),
      { seed: AOI_PROPERTY_SEED, numRuns: PROPERTY_RUNS },
    )
  })

  it('rejects non-objects, missing and unknown fields, symbols, and accessors', () => {
    expect(resultError(createAreaOfInterest(null))).toMatchObject({ reason: 'not-object', path: 'interest' })
    expect(resultError(createAreaOfInterest([]))).toMatchObject({ reason: 'not-object', path: 'interest' })
    expect(resultError(createAreaOfInterest({}))).toMatchObject({ reason: 'missing-field', path: 'interest.chunks' })
    expect(resultError(createAreaOfInterest({ chunks: [], ownerIds: [], extra: true }))).toMatchObject({ reason: 'unknown-field' })
    const symbolInput = { chunks: [], ownerIds: [] }
    Object.defineProperty(symbolInput, Symbol('hidden'), { value: true })
    expect(resultError(createAreaOfInterest(symbolInput))).toMatchObject({ reason: 'unknown-field' })
    const accessorInput = Object.defineProperty({ chunks: [] }, 'ownerIds', { get: () => [] })
    expect(resultError(createAreaOfInterest(accessorInput))).toMatchObject({ reason: 'accessor-field', path: 'interest.ownerIds' })
  })

  it('property-checks missing, null, and excess interest fields as typed failures', () => {
    fc.assert(
      fc.property(fc.constantFrom('chunks', 'ownerIds'), (field) => {
        const missingField = field === 'chunks' ? { ownerIds: [] } : { chunks: [] }
        const nullField = field === 'chunks'
          ? { chunks: null, ownerIds: [] }
          : { chunks: [], ownerIds: null }

        expect(resultError(createAreaOfInterest(missingField))).toMatchObject({ reason: 'missing-field' })
        expect(resultError(createAreaOfInterest(nullField))).toMatchObject({ reason: 'invalid-array' })
      }),
      { seed: AOI_PROPERTY_SEED + 1, numRuns: PROPERTY_RUNS },
    )

    fc.assert(
      fc.property(fc.nat({ max: 100_000 }), (unknownField) => {
        expect(resultError(createAreaOfInterest({
          chunks: [],
          ownerIds: [],
          [`unknown-${unknownField}`]: true,
        }))).toMatchObject({ reason: 'unknown-field' })
      }),
      { seed: AOI_PROPERTY_SEED + 2, numRuns: PROPERTY_RUNS },
    )
  })

  it('rejects invalid arrays, holes, accessors, extra array properties, and invalid owners', () => {
    expect(resultError(createAreaOfInterest({ chunks: [], ownerIds: null }))).toMatchObject({ reason: 'invalid-array' })
    expect(resultError(createAreaOfInterest({ chunks: [], ownerIds: [ownerId('owner:one'), ownerId('owner:one')] }))).toMatchObject({ reason: 'duplicate-owner' })
    expect(resultError(createAreaOfInterest({ chunks: [], ownerIds: [''] }))).toMatchObject({ reason: 'invalid-owner' })
    expect(resultError(createAreaOfInterest({ chunks: [], ownerIds: Array(1) }))).toMatchObject({ reason: 'invalid-array' })
    const accessorArray: unknown[] = []
    Object.defineProperty(accessorArray, '0', { get: () => ownerId('owner:one'), configurable: true })
    accessorArray.length = 1
    expect(resultError(createAreaOfInterest({ chunks: [], ownerIds: accessorArray }))).toMatchObject({ reason: 'invalid-array' })
    const extraArray: unknown[] = []
    Object.defineProperty(extraArray, 'extra', { value: true })
    expect(resultError(createAreaOfInterest({ chunks: [], ownerIds: extraArray }))).toMatchObject({ reason: 'invalid-array' })
  })

  it('rejects a non-array chunk selection after valid owner selection', () => {
    expect(resultError(createAreaOfInterest({ chunks: null, ownerIds: [] }))).toMatchObject({
      reason: 'invalid-array',
      path: 'interest.chunks',
    })
  })

  it('rejects malformed, out-of-range, accessor-backed, and duplicate chunk entries', () => {
    expect(resultError(createAreaOfInterest({ chunks: [null], ownerIds: [] }))).toMatchObject({ reason: 'not-object' })
    expect(resultError(createAreaOfInterest({ chunks: [{ dimension: 'overworld', x: 0, z: 0, extra: 1 }], ownerIds: [] }))).toMatchObject({ reason: 'unknown-field' })
    expect(resultError(createAreaOfInterest({ chunks: [{ dimension: 'overworld', x: 0 }], ownerIds: [] }))).toMatchObject({ reason: 'missing-field' })
    const accessorChunk = Object.defineProperty({ dimension: 'overworld', z: 0 }, 'x', { get: () => 0 })
    expect(resultError(createAreaOfInterest({ chunks: [accessorChunk], ownerIds: [] }))).toMatchObject({ reason: 'accessor-field' })
    expect(resultError(createAreaOfInterest({ chunks: [{ dimension: 'invalid', x: 0, z: 0 }], ownerIds: [] }))).toMatchObject({ reason: 'invalid-chunk' })
    expect(resultError(createAreaOfInterest({ chunks: [{ dimension: 'overworld', x: 1.5, z: 0 }], ownerIds: [] }))).toMatchObject({ reason: 'invalid-chunk' })
    expect(resultError(createAreaOfInterest({ chunks: [{ dimension: 'overworld', x: Number.MAX_SAFE_INTEGER + 1, z: 0 }], ownerIds: [] }))).toMatchObject({ reason: 'invalid-chunk' })
    expect(resultError(createAreaOfInterest({
      chunks: [
        { dimension: 'overworld', x: 0, z: 0 },
        { dimension: 'overworld', x: 0, z: 0 },
      ],
      ownerIds: [],
    }))).toMatchObject({ reason: 'duplicate-chunk' })
  })

  it('detects initial and expanded interests while allowing shrink-only selections', () => {
    const empty = makeInterest()
    const ownerOnly = makeInterest([], [ownerId('owner:new')])
    const chunkOnly = makeInterest([{ dimension: 'end', x: -2, z: 7 }])
    expect(areaOfInterestExpanded(undefined, empty)).toBe(true)
    expect(areaOfInterestExpanded(empty, ownerOnly)).toBe(true)
    expect(areaOfInterestExpanded(empty, chunkOnly)).toBe(true)
    expect(areaOfInterestExpanded(ownerOnly, empty)).toBe(false)
    expect(areaOfInterestExpanded(empty, empty)).toBe(false)
    expect(areaOfInterestExpanded(undefined, {})).toBe(false)
    expect(areaOfInterestExpanded({}, empty)).toBe(true)
    expect(areaOfInterestIncludesOwner({}, ownerId('owner:new'))).toBe(false)
    expect(areaOfInterestIncludesBlockChange({}, blockChange(0))).toBe(false)
  })

  it('does not match chunk keys for an unregistered interest object', () => {
    expect(areaOfInterestIncludesChunkKey({}, chunkInterestKeyForBlockChange(blockChange(0)))).toBe(false)
  })
})

describe('per-connection frame and byte rate limiting', () => {
  it('uses the frozen fixture-derived production limits', () => {
    expect(CONNECTION_RATE_LIMITS).toEqual({
      framesPerSecond: 25,
      bytesPerSecond: 1_089_775,
      burstFrames: 80,
      maxDeltaBytes: 54_489,
    })
  })

  it('rejects malformed configs with typed failures', () => {
    expect(resultError(createConnectionRateLimiter(null))).toBeInstanceOf(RateLimitConfigurationError)
    expect(resultError(createConnectionRateLimiter([]))).toMatchObject({ reason: 'not-object' })
    expect(resultError(createConnectionRateLimiter({ framesPerSecond: 25 }))).toMatchObject({
      reason: 'missing-field',
      field: 'bytesPerSecond',
    })
    expect(resultError(createConnectionRateLimiter({ ...CONNECTION_RATE_LIMITS, unknown: 1 }))).toMatchObject({
      reason: 'unknown-field',
    })
    const symbolConfig = { ...CONNECTION_RATE_LIMITS }
    Object.defineProperty(symbolConfig, Symbol('hidden'), { value: 1 })
    expect(resultError(createConnectionRateLimiter(symbolConfig))).toMatchObject({ reason: 'unknown-field' })
    const accessorConfig = Object.defineProperty({ ...CONNECTION_RATE_LIMITS }, 'bytesPerSecond', { get: () => 1_000 })
    expect(resultError(createConnectionRateLimiter(accessorConfig))).toMatchObject({
      reason: 'accessor-field',
      field: 'bytesPerSecond',
    })
    expect(resultError(createConnectionRateLimiter({ ...CONNECTION_RATE_LIMITS, framesPerSecond: 0 }))).toMatchObject({
      reason: 'invalid-value',
      field: 'framesPerSecond',
    })
    expect(resultError(createConnectionRateLimiter({ ...CONNECTION_RATE_LIMITS, bytesPerSecond: 1.5 }))).toMatchObject({
      reason: 'invalid-value',
      field: 'bytesPerSecond',
    })
    expect(resultError(createConnectionRateLimiter({ ...CONNECTION_RATE_LIMITS, burstFrames: Number.NaN }))).toMatchObject({
      reason: 'invalid-value',
      field: 'burstFrames',
    })
    expect(resultError(createConnectionRateLimiter({
      framesPerSecond: 1,
      bytesPerSecond: Number.MAX_SAFE_INTEGER,
      burstFrames: Number.MAX_SAFE_INTEGER,
      maxDeltaBytes: 1,
    }))).toMatchObject({ reason: 'capacity-overflow' })
    expect(resultError(createConnectionRateLimiter({
      framesPerSecond: 25,
      bytesPerSecond: 25,
      burstFrames: 1,
      maxDeltaBytes: 2,
    }))).toMatchObject({ reason: 'capacity-too-small', field: 'maxDeltaBytes' })
  })

  it('admits the exact delta ceiling and rejects the next byte without spending a token', () => {
    const limiter = createLimiter()
    expect(Result.isSuccess(limiter.consume(CONNECTION_RATE_LIMITS.maxDeltaBytes, 0))).toBe(true)
    const tooLarge = limiter.consume(CONNECTION_RATE_LIMITS.maxDeltaBytes + 1, 0)
    expect(resultError(tooLarge)).toBeInstanceOf(RateLimitExceeded)
    expect(resultError(tooLarge)).toMatchObject({ reason: 'delta-too-large', requested: 54_490, limit: 54_489 })
    expect(Result.isSuccess(limiter.consume(1, 0))).toBe(true)
  })

  it('enforces the 80-frame burst, refills exactly at 40 ms, and isolates connections', () => {
    const first = createLimiter()
    const second = createLimiter()
    for (let frame = 0; frame < 80; frame += 1) {
      expect(Result.isSuccess(first.consume(1, 0))).toBe(true)
    }
    expect(resultError(first.consume(1, 0))).toMatchObject({ reason: 'frame-rate' })
    expect(resultError(first.consume(1, 39.999))).toMatchObject({ reason: 'frame-rate' })
    expect(Result.isSuccess(first.consume(1, 40))).toBe(true)
    expect(Result.isSuccess(second.consume(1, 0))).toBe(true)
    expect(Result.isSuccess(first.consume(1, 1_000_000))).toBe(true)
  })

  it('enforces byte tokens and preserves state after frame-rate and byte-rate rejection', () => {
    const limiter = createLimiter({
      framesPerSecond: 25,
      bytesPerSecond: 1_000,
      burstFrames: 2,
      maxDeltaBytes: 80,
    })
    expect(Result.isSuccess(limiter.consume(60, 0))).toBe(true)
    expect(resultError(limiter.consume(21, 0))).toMatchObject({ reason: 'byte-rate', requested: 21, limit: 80 })
    expect(Result.isSuccess(limiter.consume(20, 0))).toBe(true)
    expect(resultError(limiter.consume(1, 0))).toMatchObject({ reason: 'frame-rate' })
    expect(resultError(limiter.consume(1, 0))).toMatchObject({ reason: 'frame-rate' })
    expect(Result.isSuccess(limiter.consume(1, 40))).toBe(true)
  })

  it('returns typed failures for invalid sizes and times without accepting a regressed clock', () => {
    const limiter = createLimiter()
    expect(resultError(limiter.consume(1, Number.NaN))).toBeInstanceOf(RateLimitInputError)
    expect(resultError(limiter.consume(1, Number.POSITIVE_INFINITY))).toMatchObject({ reason: 'invalid-time' })
    expect(resultError(limiter.consume(1, -1))).toMatchObject({ reason: 'invalid-time' })
    expect(resultError(limiter.consume(0, 0))).toMatchObject({ reason: 'invalid-frame-size' })
    expect(resultError(limiter.consume(1.5, 0))).toMatchObject({ reason: 'invalid-frame-size' })
    expect(resultError(limiter.consume('1', 0))).toMatchObject({ reason: 'invalid-frame-size' })
    expect(Result.isSuccess(limiter.consume(1, 10))).toBe(true)
    expect(resultError(limiter.consume(1, 9))).toMatchObject({ reason: 'time-regressed' })
    expect(Result.isSuccess(limiter.consume(1, 10))).toBe(true)
  })

  it('checks exact and beyond-boundary frame sizes across deterministic limits', () => {
    for (const frameBytes of [1, 7, 1_024, 54_488, 54_489]) {
      const limiter = createLimiter({ ...CONNECTION_RATE_LIMITS, maxDeltaBytes: frameBytes })
      expect(Result.isSuccess(limiter.consume(frameBytes, 0))).toBe(true)
      expect(resultError(limiter.consume(frameBytes + 1, 0))).toMatchObject({
        reason: 'delta-too-large',
        requested: frameBytes + 1,
        limit: frameBytes,
      })
    }
  })

  it('property-checks generated delta ceilings and production frame and byte refill boundaries', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: CONNECTION_RATE_LIMITS.maxDeltaBytes }), (frameBytes) => {
        const limiter = createLimiter({ ...CONNECTION_RATE_LIMITS, maxDeltaBytes: frameBytes })
        expect(Result.isSuccess(limiter.consume(frameBytes, 0))).toBe(true)
        expect(resultError(limiter.consume(frameBytes + 1, 0))).toMatchObject({
          reason: 'delta-too-large',
          requested: frameBytes + 1,
          limit: frameBytes,
        })
      }),
      { seed: RATE_PROPERTY_SEED, numRuns: PROPERTY_RUNS },
    )

    const frameLimiter = createLimiter()
    for (let frame = 0; frame < CONNECTION_RATE_LIMITS.burstFrames; frame += 1) {
      expect(Result.isSuccess(frameLimiter.consume(1, 0))).toBe(true)
    }
    expect(resultError(frameLimiter.consume(1, 39.999))).toMatchObject({ reason: 'frame-rate' })
    expect(Result.isSuccess(frameLimiter.consume(1, 40))).toBe(true)

    const oneSecondFrameLimiter = createLimiter()
    for (let frame = 0; frame < CONNECTION_RATE_LIMITS.burstFrames; frame += 1) {
      expect(Result.isSuccess(oneSecondFrameLimiter.consume(1, 0))).toBe(true)
    }
    for (let frame = 0; frame < CONNECTION_RATE_LIMITS.framesPerSecond; frame += 1) {
      expect(Result.isSuccess(oneSecondFrameLimiter.consume(1, 1_000))).toBe(true)
    }
    expect(resultError(oneSecondFrameLimiter.consume(1, 1_000))).toMatchObject({ reason: 'frame-rate' })

    const byteLimiter = createLimiter()
    const byteCapacity = (CONNECTION_RATE_LIMITS.bytesPerSecond / CONNECTION_RATE_LIMITS.framesPerSecond)
      * CONNECTION_RATE_LIMITS.burstFrames
    const fullCapacityFrames = Math.floor(byteCapacity / CONNECTION_RATE_LIMITS.maxDeltaBytes)
    const initialRemainder = byteCapacity - (fullCapacityFrames * CONNECTION_RATE_LIMITS.maxDeltaBytes)
    for (let frame = 0; frame < fullCapacityFrames; frame += 1) {
      expect(Result.isSuccess(byteLimiter.consume(CONNECTION_RATE_LIMITS.maxDeltaBytes, 0))).toBe(true)
    }
    expect(Result.isSuccess(byteLimiter.consume(initialRemainder, 0))).toBe(true)
    expect(resultError(byteLimiter.consume(1, 0))).toMatchObject({ reason: 'byte-rate' })

    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 43_150, max: 43_591 }), { minLength: 24, maxLength: 24 }),
        (firstFrameSizes) => {
          const refreshedLimiter = createLimiter()
          for (let frame = 0; frame < fullCapacityFrames; frame += 1) {
            expect(Result.isSuccess(refreshedLimiter.consume(CONNECTION_RATE_LIMITS.maxDeltaBytes, 0))).toBe(true)
          }
          expect(Result.isSuccess(refreshedLimiter.consume(initialRemainder, 0))).toBe(true)

          for (const frameBytes of firstFrameSizes) {
            expect(Result.isSuccess(refreshedLimiter.consume(frameBytes, 1_000))).toBe(true)
          }
          const finalFrameBytes = CONNECTION_RATE_LIMITS.bytesPerSecond
            - firstFrameSizes.reduce((total, frameBytes) => total + frameBytes, 0)
          expect(finalFrameBytes).toBeGreaterThan(0)
          expect(finalFrameBytes).toBeLessThanOrEqual(CONNECTION_RATE_LIMITS.maxDeltaBytes)
          expect(Result.isSuccess(refreshedLimiter.consume(finalFrameBytes, 1_000))).toBe(true)
          expect(resultError(refreshedLimiter.consume(1, 1_000))).toMatchObject({ reason: 'byte-rate' })
        },
      ),
      { seed: RATE_PROPERTY_SEED, numRuns: PROPERTY_RUNS },
    )
  })
})

describe('C4 per-recipient chunk projection', () => {
  const owners = makeOwnerRegistry()

  it('filters owner and block changes while retaining the committed world and revision', () => {
    const interest = makeInterest([{ dimension: 'overworld', x: 0, z: 0 }], [OWNER_A])
    const delta = makeDelta(
      [blockChange(1, 1, 'overworld', 7), blockChange(17, 1, 'overworld', 8)],
      [ownerChange(OWNER_A, 9), ownerChange(OWNER_B, 10)],
    )
    const projected = projectReplicatedWorldDelta(delta, [{ id: 'client-a', interest, previousInterest: interest }], owners)
    expect(Result.isSuccess(projected)).toBe(true)
    const outcome = arrayValueAt(Result.getOrThrow(projected), 0)
    expect(outcome._tag).toBe('ProjectedDelta')
    if (outcome._tag !== 'ProjectedDelta') {
      throw new Error('Expected a projected delta')
    }
    const decoded = readFrame(outcome.frame, owners)
    expect(decoded).toMatchObject({
      _tag: 'ReplicatedWorldDelta',
      blockChanges: [delta.blockChanges[0]],
      changes: [delta.changes[0]],
      revision: delta.revision,
      world: delta.world,
    })
    expect(outcome.message.revision).toBe(delta.revision)
    expect(outcome.message.world).toBe(delta.world)
    expect(outcome.frameBytes).toBe(wireFrameByteLength(outcome.frame))
  })

  it('property-checks one atomic grouped delta per recipient for a source revision', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            included: fc.boolean(),
            changeCount: fc.integer({ min: 1, max: 4 }),
          }),
          { minLength: 1, maxLength: 4 },
        ),
        fc.array(fc.boolean(), { minLength: OWNER_IDS.length, maxLength: OWNER_IDS.length }),
        fc.integer({ min: 1, max: 100_000 }),
        (chunkSelections, ownerSelections, sourceRevision) => {
          const sourceGroups = chunkSelections.map((selection, groupIndex) => {
            const chunkX = groupIndex * 2
            return {
              blockChanges: Array.from({ length: selection.changeCount }, (_blockSlot, blockIndex) =>
                blockChange(
                  (chunkX * CHUNK_SIDE_BLOCKS) + blockIndex,
                  0,
                  'overworld',
                  (groupIndex * selection.changeCount) + blockIndex + 1,
                )),
              chunk: { dimension: 'overworld' as const, x: chunkX, z: 0 },
              included: selection.included,
            }
          })
          const allBlockChanges = sourceGroups.flatMap((group) => group.blockChanges)
          const selectedGroups = sourceGroups.filter((group) => group.included)
          const selectedOwners = OWNER_IDS.filter((_owner, ownerIndex) => ownerSelections[ownerIndex] === true)
          const allOwnerChanges = OWNER_IDS.map((owner, ownerIndex) => ownerChange(owner, ownerIndex + 1))
          const selectedOwnerChanges = allOwnerChanges.filter((_change, ownerIndex) => ownerSelections[ownerIndex] === true)
          const delta = makeDelta(allBlockChanges, allOwnerChanges, WORLD, revision(sourceRevision))
          const selectedInterest = makeInterest(selectedGroups.map((group) => group.chunk), selectedOwners)
          const fullInterest = makeInterest(sourceGroups.map((group) => group.chunk), OWNER_IDS)
          const expectedRecipients = [
            {
              id: 'selected-recipient',
              interest: selectedInterest,
              blockChanges: selectedGroups.flatMap((group) => group.blockChanges),
              changes: selectedOwnerChanges,
            },
            {
              id: 'full-recipient',
              interest: fullInterest,
              blockChanges: allBlockChanges,
              changes: allOwnerChanges,
            },
          ]
          const projection = projectReplicatedWorldDelta(delta, expectedRecipients.map((recipient) => ({
            id: recipient.id,
            interest: recipient.interest,
            previousInterest: recipient.interest,
          })), owners)

          expect(Result.isSuccess(projection)).toBe(true)
          const outcomes = Result.getOrThrow(projection)
          expect(outcomes).toHaveLength(expectedRecipients.length)
          for (const [recipientIndex, expected] of expectedRecipients.entries()) {
            const outcome = arrayValueAt(outcomes, recipientIndex)
            expect(outcome._tag).toBe('ProjectedDelta')
            if (outcome._tag !== 'ProjectedDelta') {
              throw new Error('Expected one projected group for the source revision')
            }
            const decoded = Schema.decodeUnknownResult(ReplicatedWorldDeltaMessage, strictParseOptions)(
              readFrame(outcome.frame, owners),
            )
            expect(Result.isSuccess(decoded)).toBe(true)
            const message = Result.getOrThrow(decoded)
            expect(message.revision).toBe(delta.revision)
            expect(message.world).toBe(delta.world)
            expect(message.blockChanges).toEqual(expected.blockChanges)
            expect(message.changes).toEqual(expected.changes)
            expect(outcome.recipientId).toBe(expected.id)
            expect(outcome.message).toEqual(message)
          }
        },
      ),
      { seed: PROJECTION_PROPERTY_SEED, numRuns: PROPERTY_RUNS },
    )
  })

  it('property-checks strict delta decoding for missing, null, excess, and unknown-tag values', () => {
    const delta = makeDelta([], [], WORLD, revision(17))
    const decodeStrictDelta = Schema.decodeUnknownResult(ReplicatedWorldDeltaMessage, strictParseOptions)

    fc.assert(
      fc.property(
        fc.constantFrom('blockChanges', 'changes', 'revision', 'world'),
        (field) => {
          const deltaRecord = {
            _tag: delta._tag,
            blockChanges: delta.blockChanges,
            changes: delta.changes,
            revision: delta.revision,
            world: delta.world,
          }
          const missingField = Object.fromEntries(
            Object.entries(deltaRecord).filter(([key]) => key !== field),
          )
          const nullField = { ...deltaRecord, [field]: null }

          expect(Result.isFailure(decodeStrictDelta(missingField))).toBe(true)
          expect(Result.isFailure(decodeStrictDelta(nullField))).toBe(true)
        },
      ),
      { seed: PROJECTION_PROPERTY_SEED + 1, numRuns: PROPERTY_RUNS },
    )

    fc.assert(
      fc.property(fc.nat({ max: 100_000 }), (suffix) => {
        expect(Result.isFailure(decodeStrictDelta({
          ...delta,
          [`unknown-${suffix}`]: null,
        }))).toBe(true)
        expect(Result.isFailure(decodeStrictDelta({
          ...delta,
          _tag: `Unknown-${suffix}`,
        }))).toBe(true)
      }),
      { seed: PROJECTION_PROPERTY_SEED + 2, numRuns: PROPERTY_RUNS },
    )
  })

  it('emits an empty delta group to advance exactly one revision after outside changes', () => {
    const interest = makeInterest()
    const delta = makeDelta([blockChange(16)], [ownerChange(OWNER_A, 11)], OTHER_WORLD, revision(78))
    const projected = projectReplicatedWorldDelta(delta, [{ id: 'empty-client', interest, previousInterest: interest }], owners)
    expect(Result.isSuccess(projected)).toBe(true)
    const outcome = arrayValueAt(Result.getOrThrow(projected), 0)
    expect(outcome._tag).toBe('ProjectedDelta')
    if (outcome._tag !== 'ProjectedDelta') {
      throw new Error('Expected an empty delta group')
    }
    expect(readFrame(outcome.frame, owners)).toEqual({
      _tag: 'ReplicatedWorldDelta',
      blockChanges: [],
      changes: [],
      revision: delta.revision,
      world: delta.world,
    })
    expect(outcome.message.revision).toBe(revision(78))
  })

  it('requests a typed authoritative snapshot when owner or chunk interest expands', () => {
    const previous = makeInterest()
    const expanded = makeInterest([{ dimension: 'nether', x: 1, z: -1 }], [OWNER_C])
    const delta = makeDelta([], [], OTHER_WORLD, revision(91))
    const projected = projectReplicatedWorldDelta(delta, [{
      id: 'entering-client',
      interest: expanded,
      previousInterest: previous,
      lastKnownRevision: 90,
    }], owners)
    expect(Result.isSuccess(projected)).toBe(true)
    const outcome = arrayValueAt(Result.getOrThrow(projected), 0)
    expect(outcome).toMatchObject({ _tag: 'ResyncRequired', reason: 'interest-expanded' })
    if (outcome._tag !== 'ResyncRequired') {
      throw new Error('Expected a resync request')
    }
    expect(readResyncRequest(outcome.request)).toEqual({
      _tag: 'AuthoritativeResyncRequest',
      lastKnownRevision: 90,
      world: OTHER_WORLD,
    })
    const initial = projectReplicatedWorldDelta(delta, [{ id: 'initial-client', interest: previous }], owners)
    expect(Result.getOrThrow(initial)[0]).toMatchObject({ _tag: 'ResyncRequired', reason: 'interest-expanded' })
  })

  it('keeps shrink-only interests on the delta path and validates recipient inputs', () => {
    const wider = makeInterest([{ dimension: 'overworld', x: 5, z: 5 }], [OWNER_A])
    const narrower = makeInterest()
    const shrink = projectReplicatedWorldDelta(makeDelta(), [{ id: 'shrinking-client', interest: narrower, previousInterest: wider }], owners)
    expect(Result.getOrThrow(shrink)[0]).toMatchObject({ _tag: 'ProjectedDelta' })
    expect(resultError(projectReplicatedWorldDelta(null, [], owners))).toMatchObject({ reason: 'invalid-delta' })
    expect(resultError(projectReplicatedWorldDelta(makeDelta(), null, owners))).toMatchObject({ reason: 'invalid-recipient' })
    expect(resultError(projectReplicatedWorldDelta(makeDelta(), [{ id: '', interest: narrower }], owners))).toMatchObject({ reason: 'invalid-recipient' })
    expect(resultError(projectReplicatedWorldDelta(makeDelta(), [{ id: 'bad', interest: {} }], owners))).toMatchObject({ reason: 'invalid-recipient' })
    expect(resultError(projectReplicatedWorldDelta(makeDelta(), [{ id: 'bad', interest: narrower, previousInterest: {} }], owners))).toMatchObject({ reason: 'invalid-recipient' })
    expect(resultError(projectReplicatedWorldDelta(makeDelta(), [{ id: 'bad', interest: narrower, lastKnownRevision: -1 }], owners))).toMatchObject({ reason: 'invalid-recipient' })
    expect(resultError(projectReplicatedWorldDelta(makeDelta(), [{ id: 'bad', interest: narrower, extra: true }], owners))).toMatchObject({ reason: 'invalid-recipient' })
    expect(resultError(projectReplicatedWorldDelta(makeDelta(), [null], owners))).toMatchObject({ reason: 'invalid-recipient' })
    expect(resultError(projectReplicatedWorldDelta(makeDelta(), [{ interest: narrower }], owners))).toMatchObject({ reason: 'invalid-recipient' })
    expect(resultError(projectReplicatedWorldDelta(makeDelta(), [
      { id: 'same', interest: narrower },
      { id: 'same', interest: narrower },
    ], owners))).toMatchObject({ reason: 'invalid-recipient' })
    expect(Result.getOrThrow(projectReplicatedWorldDelta(makeDelta(), [], owners))).toEqual([])
  })

  it('rejects accessor-backed recipient fields and sparse recipient arrays', () => {
    const interest = makeInterest()
    const fields: ReadonlyArray<'id' | 'interest' | 'previousInterest' | 'lastKnownRevision'> = ['id', 'interest', 'previousInterest', 'lastKnownRevision']
    for (const field of fields) {
      const recipient = { id: 'client', interest }
      Object.defineProperty(recipient, field, { get: () => (field === 'id' ? 'client' : interest) })
      expect(resultError(projectReplicatedWorldDelta(makeDelta(), [recipient], owners))).toMatchObject({ reason: 'invalid-recipient' })
    }
    expect(resultError(projectReplicatedWorldDelta(makeDelta(), Array(1), owners))).toMatchObject({ reason: 'invalid-recipient' })
    const indexAccessor: unknown[] = []
    Object.defineProperty(indexAccessor, '0', { get: () => ({ id: 'client', interest }), configurable: true })
    indexAccessor.length = 1
    expect(resultError(projectReplicatedWorldDelta(makeDelta(), indexAccessor, owners))).toMatchObject({ reason: 'invalid-recipient' })
  })

  it('routes exact and over-ceiling atomic groups through resync without fragmentation', () => {
    const emptyOwners = makeEmptyOwnerRegistry()
    const baseDelta = makeDelta([], [], WorldId.make('w'))
    const baselineFrame = Result.getOrThrow(encodeFrame(baseDelta, emptyOwners))
    const targetWorldLength = 1 + MAX_C4_DELTA_FRAME_BYTES - wireFrameByteLength(baselineFrame)
    const exactDelta = makeDelta([], [], WorldId.make('w'.repeat(targetWorldLength)))
    const exact = projectReplicatedWorldDelta(exactDelta, [{
      id: 'exact-client',
      interest: makeInterest(),
      previousInterest: makeInterest(),
    }], emptyOwners)
    const exactOutcome = arrayValueAt(Result.getOrThrow(exact), 0)
    expect(exactOutcome._tag).toBe('ProjectedDelta')
    if (exactOutcome._tag !== 'ProjectedDelta') {
      throw new Error('Expected an exact-ceiling frame')
    }
    expect(exactOutcome.frameBytes).toBe(MAX_C4_DELTA_FRAME_BYTES)
    expect(readFrame(exactOutcome.frame, emptyOwners)).toMatchObject({ _tag: 'ReplicatedWorldDelta' })

    const tooLargeDelta = makeDelta([], [], WorldId.make('w'.repeat(targetWorldLength + 1)))
    const tooLarge = projectReplicatedWorldDelta(tooLargeDelta, [{
      id: 'oversized-client',
      interest: makeInterest(),
      previousInterest: makeInterest(),
      lastKnownRevision: 77,
    }], emptyOwners)
    expect(Result.getOrThrow(tooLarge)[0]).toMatchObject({
      _tag: 'ResyncRequired',
      reason: 'delta-frame-too-large',
    })
    const narrowCodec = makeEmptyOwnerRegistry(MAX_C4_DELTA_FRAME_BYTES)
    const encodedFailure = projectReplicatedWorldDelta(tooLargeDelta, [{
      id: 'codec-bound-client',
      interest: makeInterest(),
      previousInterest: makeInterest(),
    }], narrowCodec)
    expect(Result.getOrThrow(encodedFailure)[0]).toMatchObject({
      _tag: 'ResyncRequired',
      reason: 'delta-frame-too-large',
    })
  })

  it('returns a typed projection error when an owner state cannot be encoded', () => {
    const interest = makeInterest([], [OWNER_A])
    const invalidState = { _tag: 'ReplicatedWorldDelta', blockChanges: [], changes: [{ owner: OWNER_IDS[0], state: { unexpected: true } }], revision: revision(1), world: WORLD }
    expect(resultError(projectReplicatedWorldDelta(invalidState, [{ id: 'client', interest, previousInterest: interest }], owners)))
      .toMatchObject({ reason: 'frame-encoding-failed' })
  })

  it('projects a fixed dedicated-server tick within byte and time headroom', () => {
    const playerCount = 64
    const candidateChunkCount = 1_024
    const deltaChunkCount = 32
    const changesPerChunk = 10
    const candidateChunks = Array.from({ length: candidateChunkCount }, (_candidateSlot, index) => ({
      dimension: index < deltaChunkCount ? 'overworld' : candidateDimension(index),
      x: index % 32,
      z: Math.floor(index / 32),
    }))
    const deltaChunks = candidateChunks.filter((chunk) => chunk.dimension === 'overworld' && chunk.z === 0)
    expect(deltaChunks).toHaveLength(deltaChunkCount)
    const blockChanges = Array.from({ length: deltaChunkCount * changesPerChunk }, (_, index) => {
      const chunk = arrayValueAt(deltaChunks, Math.floor(index / changesPerChunk))
      return blockChange(chunk.x * 16 + (index % changesPerChunk), chunk.z * 16, chunk.dimension, index + 1)
    })
    const delta = makeDelta(blockChanges, OWNER_IDS.map((owner, index) => ownerChange(owner, index + 1)))
    const recipients = Array.from({ length: playerCount }, (_playerSlot, playerIndex) => {
      const selectedDeltaChunks = Array.from({ length: 4 }, (_deltaChunkSlot, offset) => arrayValueAt(deltaChunks, (playerIndex + (offset * 7)) % deltaChunkCount))
      const selectedOutsideChunks = Array.from({ length: 12 }, (_outsideChunkSlot, offset) => arrayValueAt(candidateChunks, 
        deltaChunkCount + ((playerIndex * 12 + (offset * 31)) % (candidateChunkCount - deltaChunkCount))
      ))
      const interest = makeInterest([...selectedDeltaChunks, ...selectedOutsideChunks], OWNER_IDS)
      return { id: `player-${playerIndex}`, interest, previousInterest: interest }
    })

    const startedAt = performance.now()
    const projection = projectReplicatedWorldDelta(delta, recipients, owners)
    const elapsedMs = performance.now() - startedAt
    expect(Result.isSuccess(projection)).toBe(true)
    const outcomes = Result.getOrThrow(projection)
    expect(outcomes).toHaveLength(playerCount)
    expect(outcomes.every((outcome) => outcome._tag === 'ProjectedDelta')).toBe(true)
    const projected = outcomes.filter((outcome) => outcome._tag === 'ProjectedDelta')
    expect(projected.every((outcome) => outcome.message.blockChanges.length === 4 * changesPerChunk)).toBe(true)
    expect(projected.every((outcome) => outcome.message.changes.length === OWNER_IDS.length)).toBe(true)
    expect(projected.every((outcome) => outcome.message.revision === delta.revision && outcome.message.world === delta.world)).toBe(true)
    const aggregateTickBytes = projected.reduce((total, outcome) => total + outcome.frameBytes, 0)
    expect(projected.every((outcome) => outcome.frameBytes <= MAX_C4_DELTA_FRAME_BYTES)).toBe(true)
    expect(aggregateTickBytes).toBeGreaterThan(0)
    expect(aggregateTickBytes).toBeLessThanOrEqual(playerCount * MAX_C4_DELTA_FRAME_BYTES)
    // This 3 s guard is 30% of Vitest's 10 s timeout; counts and bytes are the scale evidence.
    expect(elapsedMs, `projection took ${elapsedMs.toFixed(1)} ms for ${playerCount} players`).toBeLessThan(3_000)
    console.info(`scale projection: players=${playerCount}, chunks=${candidateChunkCount}, bytes=${aggregateTickBytes}, elapsedMs=${elapsedMs.toFixed(1)}`)
    for (const outcome of projected) {
      const decoded = readFrame(outcome.frame, owners)
      expect(Schema.decodeUnknownResult(ReplicatedWorldDeltaMessage, strictParseOptions)(decoded)).toMatchObject({ _tag: 'Success' })
    }
  })
})

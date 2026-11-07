import { describe, expect, it } from '@effect/vitest'
import { Result } from 'effect'
import { createScenarioRuntime } from '../../apps/debug-ui/entrypoints/scenarios/scenario-runtime.js'
import {
  projectVisibilityLoadFrame,
  visibilityLoadScenario,
  VISIBILITY_LOAD_OWNER_REGISTRY,
} from '../../scenarios/visibility-load.js'
import type { ScenarioResult } from '../../scenarios/types.js'
import {
  CONNECTION_RATE_LIMITS,
  RateLimitExceeded,
  createConnectionRateLimiter,
  decodeFrame,
  type ConnectionRateLimitFailure,
} from '../../src/index.js'

const ZERO = 0
const ONE = 1
const CLIENT_COUNT = 2
const FIXED_SEED = 17
const INSIDE_BOUNDARY_X = 15
const OUTSIDE_BOUNDARY_X = 16
const FRAME_SIZE_BYTES = 1
const FRAME_REFILL_MS = 40
const BYTE_LIMIT = 80
const ACCEPTED_BYTES_BEFORE_REJECTION = 60
const REJECTED_BYTES = 21
const ACCEPTED_BYTES_AFTER_REJECTION = 20
const BYTE_RATE_FRAMES_PER_SECOND = 25
const BYTE_RATE_BYTES_PER_SECOND = 1_000
const BYTE_RATE_BURST_FRAMES = 2

const runScenario = async (): Promise<ScenarioResult> => {
  const runtime = await createScenarioRuntime(visibilityLoadScenario, { seed: FIXED_SEED })
  return runtime.run(ONE)
}

const expectScenarioDeltasDelivered = (result: ScenarioResult): void => {
  const frameEntries = result.wireLog.filter((entry) => entry.frame === ONE)
  expect(frameEntries).toHaveLength(CLIENT_COUNT)
  expect(frameEntries.map((entry) => entry.from).sort()).toStrictEqual(['client-a', 'client-b'])
  const projections = projectVisibilityLoadFrame(ONE)
  for (const entry of frameEntries) {
    expect(entry.tag).toBe('ReplicatedWorldDelta')
    expect(entry.outcome).toBe('delivered')
    const decoded = decodeFrame(entry.text, VISIBILITY_LOAD_OWNER_REGISTRY)
    expect(Result.isSuccess(decoded)).toBe(true)
    expect(Result.getOrThrow(decoded)).toStrictEqual(projections.get(entry.from))
  }
  expect(result.verdict.status).toBe('pass')
}

const makeLimiter = (config: unknown) => {
  const limiter = createConnectionRateLimiter(config)
  expect(Result.isSuccess(limiter)).toBe(true)
  return Result.getOrThrow(limiter)
}

const rateLimitError = (result: Result.Result<void, ConnectionRateLimitFailure>): RateLimitExceeded => {
  expect(Result.isFailure(result)).toBe(true)
  if (Result.isSuccess(result)) {
    throw new Error('expected a rate limit rejection')
  }
  const error = result.failure
  expect(error).toBeInstanceOf(RateLimitExceeded)
  if (!(error instanceof RateLimitExceeded)) {
    throw new Error('expected a rate limit rejection')
  }
  return error
}

describe('AOI and load scenario', () => {
  // Fails if the runtime drops, misdecodes, or sends another client's adjacent-chunk block.
  it('delivers each owner-aware C4 delta with only the recipient AOI projection', async () => {
    const result = await runScenario()
    expectScenarioDeltasDelivered(result)
    const projections = projectVisibilityLoadFrame(ONE)
    expect(projections.get('client-a')?.blockChanges.map((change) => change.position.x)).toStrictEqual([INSIDE_BOUNDARY_X])
    expect(projections.get('client-b')?.blockChanges.map((change) => change.position.x)).toStrictEqual([OUTSIDE_BOUNDARY_X])
  })

  // Fails if owner-aware frame serialization or per-client delivery order varies for a fixed seed.
  it('replays the same client delta wire log for the same seed', async () => {
    const first = await runScenario()
    const second = await runScenario()
    expectScenarioDeltasDelivered(first)
    expectScenarioDeltasDelivered(second)
    expect(first.wireLog).toStrictEqual(second.wireLog)
  })

  // Fails if the limiter accepts beyond its burst or rejects the first refilled frame.
  it('accepts the full frame burst, rejects the next frame, and accepts after refill', async () => {
    const scenario = await runScenario()
    expectScenarioDeltasDelivered(scenario)
    const limiter = makeLimiter(CONNECTION_RATE_LIMITS)
    for (let frame = ZERO; frame < CONNECTION_RATE_LIMITS.burstFrames; frame += ONE) {
      expect(Result.isSuccess(limiter.consume(FRAME_SIZE_BYTES, ZERO))).toBe(true)
    }
    expect(rateLimitError(limiter.consume(FRAME_SIZE_BYTES, ZERO))).toMatchObject({
      reason: 'frame-rate',
      requested: ONE,
      limit: CONNECTION_RATE_LIMITS.burstFrames,
    })
    expect(Result.isSuccess(limiter.consume(FRAME_SIZE_BYTES, FRAME_REFILL_MS))).toBe(true)
  })

  // Fails if byte rejection spends remaining tokens or the exact delta ceiling is rejected.
  it('rejects byte and delta overages while preserving acceptance on both sides', async () => {
    const scenario = await runScenario()
    expectScenarioDeltasDelivered(scenario)
    const byteLimiter = makeLimiter({
      burstFrames: BYTE_RATE_BURST_FRAMES,
      bytesPerSecond: BYTE_RATE_BYTES_PER_SECOND,
      framesPerSecond: BYTE_RATE_FRAMES_PER_SECOND,
      maxDeltaBytes: BYTE_LIMIT,
    })
    expect(Result.isSuccess(byteLimiter.consume(ACCEPTED_BYTES_BEFORE_REJECTION, ZERO))).toBe(true)
    expect(rateLimitError(byteLimiter.consume(REJECTED_BYTES, ZERO))).toMatchObject({
      reason: 'byte-rate',
      requested: REJECTED_BYTES,
      limit: BYTE_LIMIT,
    })
    expect(Result.isSuccess(byteLimiter.consume(ACCEPTED_BYTES_AFTER_REJECTION, ZERO))).toBe(true)

    const deltaLimiter = makeLimiter(CONNECTION_RATE_LIMITS)
    expect(Result.isSuccess(deltaLimiter.consume(CONNECTION_RATE_LIMITS.maxDeltaBytes, ZERO))).toBe(true)
    expect(rateLimitError(deltaLimiter.consume(CONNECTION_RATE_LIMITS.maxDeltaBytes + ONE, ZERO))).toMatchObject({
      reason: 'delta-too-large',
      requested: CONNECTION_RATE_LIMITS.maxDeltaBytes + ONE,
      limit: CONNECTION_RATE_LIMITS.maxDeltaBytes,
    })
    expect(Result.isSuccess(deltaLimiter.consume(FRAME_SIZE_BYTES, ZERO))).toBe(true)
  })
})

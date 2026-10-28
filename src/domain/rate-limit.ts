import { Data, Result, Schema } from 'effect'
import { type PositiveSafeInteger, PositiveSafeIntegerSchema } from './codec.js'

const FIXTURE_FRAMES_PER_SECOND = 25
const FIXTURE_BYTES_PER_SECOND = 1_089_775
const FIXTURE_BURST_FRAMES = 80
const FIXTURE_MAX_DELTA_BYTES = 54_489
const ZERO = 0
const ONE = 1
const MILLISECONDS_PER_SECOND = 1_000

export const CONNECTION_RATE_LIMITS: ConnectionRateLimitConfig = Object.freeze({
  burstFrames: Schema.decodeUnknownSync(PositiveSafeIntegerSchema)(FIXTURE_BURST_FRAMES),
  bytesPerSecond: Schema.decodeUnknownSync(PositiveSafeIntegerSchema)(FIXTURE_BYTES_PER_SECOND),
  framesPerSecond: Schema.decodeUnknownSync(PositiveSafeIntegerSchema)(FIXTURE_FRAMES_PER_SECOND),
  maxDeltaBytes: Schema.decodeUnknownSync(PositiveSafeIntegerSchema)(FIXTURE_MAX_DELTA_BYTES),
})

export type ConnectionRateLimitConfig = Readonly<{
  framesPerSecond: PositiveSafeInteger
  bytesPerSecond: PositiveSafeInteger
  burstFrames: PositiveSafeInteger
  maxDeltaBytes: PositiveSafeInteger
}>

export type ConnectionRateLimitConfigField = keyof ConnectionRateLimitConfig

export type RateLimitConfigurationErrorReason =
  | 'not-object'
  | 'missing-field'
  | 'unknown-field'
  | 'accessor-field'
  | 'invalid-value'
  | 'capacity-too-small'
  | 'capacity-overflow'

const RateLimitConfigurationError_base: ReturnType<typeof Data.TaggedError<'RateLimitConfigurationError'>> =
  Data.TaggedError('RateLimitConfigurationError')

export class RateLimitConfigurationError extends RateLimitConfigurationError_base<{
  readonly reason: RateLimitConfigurationErrorReason
  readonly field: ConnectionRateLimitConfigField | 'config'
}> {}

export type RateLimitInputErrorReason = 'invalid-frame-size' | 'invalid-time' | 'time-regressed'

const RateLimitInputError_base: ReturnType<typeof Data.TaggedError<'RateLimitInputError'>> =
  Data.TaggedError('RateLimitInputError')

export class RateLimitInputError extends RateLimitInputError_base<{
  readonly reason: RateLimitInputErrorReason
}> {}

export type RateLimitExceededReason = 'frame-rate' | 'byte-rate' | 'delta-too-large'

const RateLimitExceeded_base: ReturnType<typeof Data.TaggedError<'RateLimitExceeded'>> =
  Data.TaggedError('RateLimitExceeded')

export class RateLimitExceeded extends RateLimitExceeded_base<{
  readonly reason: RateLimitExceededReason
  readonly requested: number
  readonly limit: number
}> {}

export type ConnectionRateLimitFailure = RateLimitInputError | RateLimitExceeded

export type ConnectionRateLimiter = Readonly<{
  consume: (frameByteLength: unknown, nowMs: unknown) => Result.Result<void, ConnectionRateLimitFailure>
}>

const CONFIG_FIELDS: ReadonlyArray<ConnectionRateLimitConfigField> = [
  'framesPerSecond',
  'bytesPerSecond',
  'burstFrames',
  'maxDeltaBytes',
]

const isConfigField = (key: string): key is ConnectionRateLimitConfigField =>
  CONFIG_FIELDS.some((field) => field === key)

type MutableTokenBucket = {
  byteCapacity: number
  byteTokens: number
  config: ConnectionRateLimitConfig
  frameTokens: number
  hasLastRefillAt: boolean
  lastRefillAt: number
}

const isPositiveSafeInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > ZERO

const configurationFailure = (
  reason: RateLimitConfigurationErrorReason,
  field: ConnectionRateLimitConfigField | 'config',
): Result.Result<never, RateLimitConfigurationError> =>
  Result.fail(new RateLimitConfigurationError({ field, reason }))

const readConfigObject = (input: unknown): Result.Result<object, RateLimitConfigurationError> => {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return configurationFailure('not-object', 'config')
  }
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== 'string' || !isConfigField(key)) {
      return configurationFailure('unknown-field', 'config')
    }
  }
  return Result.succeed(input)
}

const readConfigField = (
  input: object,
  field: ConnectionRateLimitConfigField,
): Result.Result<PositiveSafeInteger, RateLimitConfigurationError> => {
  const descriptor = Object.getOwnPropertyDescriptor(input, field)
  if (descriptor === undefined) {
    return configurationFailure('missing-field', field)
  }
  if (!('value' in descriptor)) {
    return configurationFailure('accessor-field', field)
  }
  const decoded = Schema.decodeUnknownResult(PositiveSafeIntegerSchema)(descriptor.value)
  if (Result.isFailure(decoded)) {
    return configurationFailure('invalid-value', field)
  }
  return Result.succeed(decoded.success)
}

const readConfigValues = (
  input: object,
): Result.Result<ConnectionRateLimitConfig, RateLimitConfigurationError> => {
  const values = Result.all([
    readConfigField(input, 'framesPerSecond'),
    readConfigField(input, 'bytesPerSecond'),
    readConfigField(input, 'burstFrames'),
    readConfigField(input, 'maxDeltaBytes'),
  ] as const)
  return Result.map(values, ([framesPerSecond, bytesPerSecond, burstFrames, maxDeltaBytes]) => ({
    burstFrames,
    bytesPerSecond,
    framesPerSecond,
    maxDeltaBytes,
  }))
}

const validateCapacity = (
  config: ConnectionRateLimitConfig,
): Result.Result<ConnectionRateLimitConfig, RateLimitConfigurationError> => {
  const byteCapacity = (config.bytesPerSecond / config.framesPerSecond) * config.burstFrames
  if (byteCapacity > Number.MAX_SAFE_INTEGER) {
    return configurationFailure('capacity-overflow', 'config')
  }
  if (byteCapacity < config.maxDeltaBytes) {
    return configurationFailure('capacity-too-small', 'maxDeltaBytes')
  }
  return Result.succeed(Object.freeze(config))
}

const decodeConfig = (
  input: unknown,
): Result.Result<ConnectionRateLimitConfig, RateLimitConfigurationError> => {
  const object = readConfigObject(input)
  if (Result.isFailure(object)) {
    return Result.fail(object.failure)
  }
  const config = readConfigValues(object.success)
  if (Result.isFailure(config)) {
    return Result.fail(config.failure)
  }
  return validateCapacity(config.success)
}

const validateCurrentTime = (
  nowMs: unknown,
  state: MutableTokenBucket,
): Result.Result<number, RateLimitInputError> => {
  if (typeof nowMs !== 'number' || !Number.isFinite(nowMs) || nowMs < ZERO) {
    return Result.fail(new RateLimitInputError({ reason: 'invalid-time' }))
  }
  if (state.hasLastRefillAt && nowMs < state.lastRefillAt) {
    return Result.fail(new RateLimitInputError({ reason: 'time-regressed' }))
  }
  return Result.succeed(nowMs)
}

const refillTokens = (state: MutableTokenBucket, nowMs: number): void => {
  if (state.hasLastRefillAt) {
    const elapsedMs = nowMs - state.lastRefillAt
    state.frameTokens = Math.min(
      state.config.burstFrames,
      state.frameTokens + (elapsedMs * state.config.framesPerSecond) / MILLISECONDS_PER_SECOND,
    )
    state.byteTokens = Math.min(
      state.byteCapacity,
      state.byteTokens + (elapsedMs * state.config.bytesPerSecond) / MILLISECONDS_PER_SECOND,
    )
  }
  state.lastRefillAt = nowMs
  state.hasLastRefillAt = true
}

const validateFrameSize = (
  frameByteLength: unknown,
  config: ConnectionRateLimitConfig,
): Result.Result<number, ConnectionRateLimitFailure> => {
  if (!isPositiveSafeInteger(frameByteLength)) {
    return Result.fail(new RateLimitInputError({ reason: 'invalid-frame-size' }))
  }
  if (frameByteLength > config.maxDeltaBytes) {
    return Result.fail(new RateLimitExceeded({
      limit: config.maxDeltaBytes,
      reason: 'delta-too-large',
      requested: frameByteLength,
    }))
  }
  return Result.succeed(frameByteLength)
}

const consumeTokens = (
  state: MutableTokenBucket,
  frameByteLength: number,
): Result.Result<void, RateLimitExceeded> => {
  if (state.frameTokens < ONE) {
    return Result.fail(new RateLimitExceeded({
      limit: state.config.burstFrames,
      reason: 'frame-rate',
      requested: ONE,
    }))
  }
  if (state.byteTokens < frameByteLength) {
    return Result.fail(new RateLimitExceeded({
      limit: state.byteCapacity,
      reason: 'byte-rate',
      requested: frameByteLength,
    }))
  }
  state.frameTokens -= ONE
  state.byteTokens -= frameByteLength
  return Result.succeed(undefined)
}

const consume = (
  state: MutableTokenBucket,
  frameByteLength: unknown,
  nowMs: unknown,
): Result.Result<void, ConnectionRateLimitFailure> => {
  const time = validateCurrentTime(nowMs, state)
  if (Result.isFailure(time)) {
    return Result.fail(time.failure)
  }
  refillTokens(state, time.success)
  const size = validateFrameSize(frameByteLength, state.config)
  if (Result.isFailure(size)) {
    return Result.fail(size.failure)
  }
  return consumeTokens(state, size.success)
}

export const createConnectionRateLimiter = (
  configInput: unknown,
): Result.Result<ConnectionRateLimiter, RateLimitConfigurationError> => Result.map(
  decodeConfig(configInput),
  (config) => {
    const byteCapacity = (config.bytesPerSecond / config.framesPerSecond) * config.burstFrames
    const state: MutableTokenBucket = {
      byteCapacity,
      byteTokens: byteCapacity,
      config,
      frameTokens: config.burstFrames,
      hasLastRefillAt: false,
      lastRefillAt: ZERO,
    }
    return Object.freeze({
      consume: (frameByteLength: unknown, nowMs: unknown) => consume(state, frameByteLength, nowMs),
    })
  },
)

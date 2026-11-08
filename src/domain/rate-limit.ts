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

export type RateLimitInputErrorReason = 'invalid-frame-size' | 'invalid-message-kind' | 'invalid-time' | 'time-regressed'

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

export type ConnectionMessageKind = 'chat' | 'command' | 'movement' | 'other'

const CHAT_MESSAGE_WINDOW_MS_VALUE = 10_000
const CHAT_MESSAGE_LIMIT_VALUE = 3
const COMMAND_BURST_VALUE = 20
const COMMAND_MESSAGES_PER_SECOND_VALUE = 10
const MOVEMENT_BURST_VALUE = 40
const MOVEMENT_MESSAGES_PER_SECOND_VALUE = 20
const OTHER_BURST_VALUE = 80
const OTHER_MESSAGES_PER_SECOND_VALUE = 25
const positiveMessageLimit = (value: number): PositiveSafeInteger =>
  Schema.decodeUnknownSync(PositiveSafeIntegerSchema)(value)

export const CHAT_MESSAGE_WINDOW_MS: PositiveSafeInteger = positiveMessageLimit(CHAT_MESSAGE_WINDOW_MS_VALUE)
export const CHAT_MESSAGE_LIMIT: PositiveSafeInteger = positiveMessageLimit(CHAT_MESSAGE_LIMIT_VALUE)

type MessageKindPolicy = Readonly<{
  burst: PositiveSafeInteger
  messagesPerSecond: PositiveSafeInteger
}>

type MessageKindRateLimits = Readonly<{
  chat: Readonly<{
    messages: PositiveSafeInteger
    windowMs: PositiveSafeInteger
  }>
} & Readonly<Record<Exclude<ConnectionMessageKind, 'chat'>, MessageKindPolicy>>>

const MESSAGE_KIND_POLICIES: Readonly<Record<Exclude<ConnectionMessageKind, 'chat'>, MessageKindPolicy>> = Object.freeze({
  command: Object.freeze({
    burst: positiveMessageLimit(COMMAND_BURST_VALUE),
    messagesPerSecond: positiveMessageLimit(COMMAND_MESSAGES_PER_SECOND_VALUE),
  }),
  movement: Object.freeze({
    burst: positiveMessageLimit(MOVEMENT_BURST_VALUE),
    messagesPerSecond: positiveMessageLimit(MOVEMENT_MESSAGES_PER_SECOND_VALUE),
  }),
  other: Object.freeze({
    burst: positiveMessageLimit(OTHER_BURST_VALUE),
    messagesPerSecond: positiveMessageLimit(OTHER_MESSAGES_PER_SECOND_VALUE),
  }),
})

const NON_CHAT_MESSAGE_KINDS: ReadonlyArray<Exclude<ConnectionMessageKind, 'chat'>> = ['command', 'movement', 'other']

export const MESSAGE_KIND_RATE_LIMITS: MessageKindRateLimits = Object.freeze({
  chat: Object.freeze({ messages: CHAT_MESSAGE_LIMIT, windowMs: CHAT_MESSAGE_WINDOW_MS }),
  ...MESSAGE_KIND_POLICIES,
})

export type MessageKindRateLimitReason = 'chat-window' | 'kind-rate'

export type MessageKindRateLimitDetails = Readonly<{
  kind: ConnectionMessageKind
  limit: PositiveSafeInteger
  reason: MessageKindRateLimitReason
  requested: PositiveSafeInteger
}>

const MessageKindRateLimitExceeded_base: ReturnType<typeof Data.TaggedError<'MessageKindRateLimitExceeded'>> =
  Data.TaggedError('MessageKindRateLimitExceeded')

export class MessageKindRateLimitExceeded extends MessageKindRateLimitExceeded_base<MessageKindRateLimitDetails> {}

export type MessageKindRateLimitFailure = RateLimitInputError | MessageKindRateLimitExceeded

export type ConnectionMessageRateLimiter = Readonly<{
  consume: (kind: unknown, nowMs: unknown) => Result.Result<void, MessageKindRateLimitFailure>
}>

type MessageKindBucket = {
  readonly burst: PositiveSafeInteger
  readonly messagesPerSecond: number
  hasLastRefillAt: boolean
  lastRefillAt: number
  tokens: number
}

const makeMessageKindBucket = (
  kind: Exclude<ConnectionMessageKind, 'chat'>,
): readonly [Exclude<ConnectionMessageKind, 'chat'>, MessageKindBucket] => {
  const policy = MESSAGE_KIND_POLICIES[kind]
  return [kind, {
    burst: Schema.decodeUnknownSync(PositiveSafeIntegerSchema)(policy.burst),
    hasLastRefillAt: false,
    lastRefillAt: ZERO,
    messagesPerSecond: policy.messagesPerSecond,
    tokens: policy.burst,
  }]
}

const isConnectionMessageKind = (value: unknown): value is ConnectionMessageKind =>
  value === 'chat' || value === 'command' || value === 'movement' || value === 'other'

const consumeChatMessage = (timestamps: Array<number>, nowMs: number): Result.Result<void, MessageKindRateLimitExceeded> => {
  const cutoff = nowMs - CHAT_MESSAGE_WINDOW_MS
  while (timestamps.length > ZERO) {
    const oldest = timestamps[ZERO]
    if (oldest === undefined || oldest > cutoff) {
      break
    }
    timestamps.shift()
  }
  if (timestamps.length >= CHAT_MESSAGE_LIMIT) {
    return Result.fail(new MessageKindRateLimitExceeded({
      kind: 'chat',
      limit: CHAT_MESSAGE_LIMIT,
      reason: 'chat-window',
      requested: positiveMessageLimit(ONE),
    }))
  }
  timestamps.push(nowMs)
  return Result.succeed(undefined)
}

const refillMessageKindBucket = (bucket: MessageKindBucket, nowMs: number): void => {
  if (bucket.hasLastRefillAt) {
    bucket.tokens = Math.min(
      bucket.burst,
      bucket.tokens + ((nowMs - bucket.lastRefillAt) * bucket.messagesPerSecond) / MILLISECONDS_PER_SECOND,
    )
  }
  bucket.hasLastRefillAt = true
  bucket.lastRefillAt = nowMs
}

const consumeMessageKindBucket = (
  kind: Exclude<ConnectionMessageKind, 'chat'>,
  bucket: MessageKindBucket,
): Result.Result<void, MessageKindRateLimitExceeded> => {
  if (bucket.tokens < ONE) {
    return Result.fail(new MessageKindRateLimitExceeded({
      kind,
      limit: bucket.burst,
      reason: 'kind-rate',
      requested: Schema.decodeUnknownSync(PositiveSafeIntegerSchema)(ONE),
    }))
  }
  bucket.tokens -= ONE
  return Result.succeed(undefined)
}

type MessageRateLimiterState = {
  buckets: Map<Exclude<ConnectionMessageKind, 'chat'>, MessageKindBucket>
  chatTimestamps: Array<number>
  hasLastObservedAt: boolean
  lastObservedAt: number
}

type ValidatedMessageRateInput = Readonly<{
  kind: ConnectionMessageKind
  nowMs: number
}>

const decodeMessageRateInput = (
  kindInput: unknown,
  nowInput: unknown,
): Result.Result<ValidatedMessageRateInput, RateLimitInputError> => {
  if (!isConnectionMessageKind(kindInput)) {
    return Result.fail(new RateLimitInputError({ reason: 'invalid-message-kind' }))
  }
  if (typeof nowInput !== 'number' || !Number.isFinite(nowInput) || nowInput < ZERO) {
    return Result.fail(new RateLimitInputError({ reason: 'invalid-time' }))
  }
  return Result.succeed({ kind: kindInput, nowMs: nowInput })
}

const consumeMessageKind = (
  state: MessageRateLimiterState,
  kind: Exclude<ConnectionMessageKind, 'chat'>,
  nowMs: number,
): Result.Result<void, MessageKindRateLimitFailure> => {
  const bucket = state.buckets.get(kind)
  if (bucket === undefined) {
    return Result.fail(new RateLimitInputError({ reason: 'invalid-message-kind' }))
  }
  refillMessageKindBucket(bucket, nowMs)
  return consumeMessageKindBucket(kind, bucket)
}

const consumeValidatedMessage = (
  state: MessageRateLimiterState,
  input: ValidatedMessageRateInput,
): Result.Result<void, MessageKindRateLimitFailure> => {
  if (state.hasLastObservedAt && input.nowMs < state.lastObservedAt) {
    return Result.fail(new RateLimitInputError({ reason: 'time-regressed' }))
  }
  state.hasLastObservedAt = true
  state.lastObservedAt = input.nowMs
  if (input.kind === 'chat') {
    return consumeChatMessage(state.chatTimestamps, input.nowMs)
  }
  return consumeMessageKind(state, input.kind, input.nowMs)
}

const consumeMessage = (
  state: MessageRateLimiterState,
  kindInput: unknown,
  nowInput: unknown,
): Result.Result<void, MessageKindRateLimitFailure> => {
  const input = decodeMessageRateInput(kindInput, nowInput)
  if (Result.isFailure(input)) {
    return Result.fail(input.failure)
  }
  return consumeValidatedMessage(state, input.success)
}

export const createConnectionMessageRateLimiter = (): ConnectionMessageRateLimiter => {
  const state: MessageRateLimiterState = {
    buckets: new Map<Exclude<ConnectionMessageKind, 'chat'>, MessageKindBucket>(NON_CHAT_MESSAGE_KINDS.map(makeMessageKindBucket)),
    chatTimestamps: [],
    hasLastObservedAt: false,
    lastObservedAt: ZERO,
  }
  return Object.freeze({
    consume: (kindInput: unknown, nowInput: unknown) => consumeMessage(state, kindInput, nowInput),
  })
}

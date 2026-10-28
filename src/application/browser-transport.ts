/**
 * The browser adapter for `TransportPort`: a real WebSocket in, `WireText` out.
 *
 * Lowered from the composing app's `web/multiplayer-url.ts` and
 * `web/multiplayer-websocket.ts`. Only the URL-validation and connection-
 * lifecycle judgment moved here; the per-message wire formats that the
 * composing app's `multiplayer-shared/*-network.ts` files hand-rolled around
 * this transport belong to `domain/protocol/*.ts` and the shared
 * `NetworkMessage` codec (`domain/codec.ts`). This adapter recognizes only
 * codec-valid Ping/Pong frames for transport liveness; other messages remain
 * raw `WireText` for the application consumer.
 *
 * ---------------------------------------------------------------------------
 * No `"DOM"` in `lib`, on purpose
 * ---------------------------------------------------------------------------
 *
 * `tsconfig.build.json` compiles `src/application/` with the same
 * `lib: ["ES2024"]` / `types: []` as `src/domain/`, so the whole shipped
 * surface stays testable under `environment: 'node'` (`vitest.config.ts`).
 * `WebSocket` and `URL` are platform globals, not ECMAScript ones, so neither
 * is declared here, and this file never reads either off `globalThis` — doing
 * so would need an unchecked cast the moment the result crossed back into a
 * typed signature (`no-type-assertion`, `sgconfig.yml`), which is exactly the
 * shortcut the structural approach exists to avoid. Instead every entry point
 * takes its `WebSocket` constructor (`socketFactory`) and `URL` constructor
 * (`UrlConstructor`) as a required parameter, narrowed to the handful of
 * members this file touches — the same choice mc-render's
 * `application/dom-surface.ts` documents for the identical problem, at the
 * scale this file actually needs (one constructor surface each, not a whole
 * event system). A real browser host passes the platform globals it already
 * has typed correctly in its own DOM-aware project; every test below passes a
 * stand-in.
 *
 * ---------------------------------------------------------------------------
 * What this file is not
 * ---------------------------------------------------------------------------
 *
 * `TransportService` moves `WireText`; `sendMessage` / `receiveMessage` in
 * `domain/transport.ts` own application decoding. The adapter decodes bounded
 * ingress once to enforce codec preflight and consume Ping/Pong, then preserves
 * raw text so the consumer can receive typed protocol failures. Its other
 * judgments are how to represent WebSocket lifecycle faults and when a resume
 * handshake must complete before ordinary traffic may send. The resume
 * handshake's `PlayerResume` / `PlayerResumeAccepted` envelope is deliberately
 * NOT a `NetworkMessage` — it authenticates the connection the protocol will
 * run over, so it has to be decodable before a peer has proven which protocol
 * version, if any, it speaks. Its shape belongs with whatever session-token
 * issuance replaces `multiplayer-server/reconnect-auth.ts`; this file only
 * consumes it.
 */
import { Clock, Deferred, Duration, Effect, Queue, Result, Schema } from 'effect'
import {
  type NonNegativeSafeInteger,
  NonNegativeSafeIntegerSchema,
  type PositiveSafeInteger,
  type WireText,
  decodeFrame,
  encodeFrame,
  wireFrameByteLength,
} from '../domain/codec.js'
import { ProtocolError, TransportError } from '../domain/errors.js'
import type { NetworkMessage } from '../domain/protocol.js'
import type { TransportService } from '../domain/transport.js'

const MAX_INBOUND_CAPACITY = 80
const DEFAULT_INBOUND_CAPACITY = MAX_INBOUND_CAPACITY
const INBOUND_BYTE_CAPACITY = 3_486_960
const FRAME_RATE_PER_SECOND = 25
const FRAME_RATE_BURST = 80
const BYTE_RATE_PER_SECOND = 1_089_775
const BYTE_RATE_BURST = 3_486_960
const MAX_FRAME_CODE_UNITS = 1_048_576
const GLOBAL_FRAME_BYTE_LIMIT = 4_194_304
const POLICY_VIOLATION_CODE = 4008
const FRAME_TOO_LARGE_CODE = 4009
const UNSUPPORTED_DATA_CODE = 4003
const ZERO = 0
const ONE = 1
const ZERO_NANOS = 0n
const NANOSECONDS_PER_SECOND = 1_000_000_000
const NANOSECONDS_PER_MILLISECOND = 1_000_000
const MAX_SAFE_INTEGER_SUCCESSOR = Number.MAX_SAFE_INTEGER + ONE

type InboundQueueAccounting = { readonly frameBytes: Array<number>; queuedBytes: number }

const releaseTakenFrames = (accounting: InboundQueueAccounting, queuedFrames: number): void => {
  if (accounting.frameBytes.length <= queuedFrames) {
    return
  }
  const takenFrames = accounting.frameBytes.splice(ZERO, accounting.frameBytes.length - queuedFrames)
  for (const frameBytes of takenFrames) {
    accounting.queuedBytes -= frameBytes
  }
}

// ---------------------------------------------------------------------------
// The structural browser surface
// ---------------------------------------------------------------------------

/** The `URL` members this file reads. A real `URL` instance satisfies this without a cast. */
export type UrlLike = {
  readonly href: string
  readonly hostname: string
  readonly protocol: string
}
type UrlConstructorLike = new (input: string) => UrlLike

type WebSocketMessageEventLike = { readonly data: unknown }
type WebSocketCloseEventLike = { readonly code?: number; readonly reason?: string }
type WebSocketEventMap = {
  readonly close: WebSocketCloseEventLike
  readonly error: unknown
  readonly message: WebSocketMessageEventLike
  readonly open: unknown
}

/** The `WebSocket` members this file reads. A real browser `WebSocket` satisfies this without a cast. */
export type WebSocketLike = {
  addEventListener<EventName extends keyof WebSocketEventMap>(
    type: EventName,
    listener: (event: WebSocketEventMap[EventName]) => void,
  ): void
  close(code?: number, reason?: string): void
  readonly readyState: number
  removeEventListener<EventName extends keyof WebSocketEventMap>(
    type: EventName,
    listener: (event: WebSocketEventMap[EventName]) => void,
  ): void
  send(data: string): void
}
/** The `readyState` a browser `WebSocket` reports before `open` has fired. */
const WEBSOCKET_CONNECTING_READY_STATE = 0
/** The `readyState` a browser `WebSocket` reports once `open` has fired. */
const WEBSOCKET_OPEN_READY_STATE = 1
/** WebSocket close code for a normal, locally-initiated disposal (RFC 6455 §7.4.1). */
const NORMAL_CLOSURE_CODE = 1000

/** A single JSON parse helper, reused everywhere this file reads an untrusted frame. */
const JSON_PARSE_FAILED: unique symbol = Symbol('browser-transport/json-parse-failed')
const JSON_UNKNOWN_SCHEMA = Schema.fromJsonString(Schema.Unknown)

const tryParseJson = (text: string): unknown => {
  const parsed = Schema.decodeUnknownResult(JSON_UNKNOWN_SCHEMA)(text)
  if (Result.isFailure(parsed)) {
    return JSON_PARSE_FAILED
  }
  return parsed.success
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

// ---------------------------------------------------------------------------
// Server URL validation
// ---------------------------------------------------------------------------

export type MultiplayerUrlValidation =
  | { readonly ok: false; readonly message: string }
  | { readonly ok: true; readonly url: UrlLike }

const isLoopbackHostname = (hostname: string): boolean =>
  hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]'

const parseUrl = (value: string, UrlConstructor: UrlConstructorLike): UrlLike | undefined => {
  const parsed = Result.try(() => new UrlConstructor(value))
  if (Result.isFailure(parsed)) {
    return undefined
  }
  return parsed.success
}

const resolvePageUrl = (pageUrl: UrlLike | string, UrlConstructor: UrlConstructorLike): UrlLike | undefined => {
  if (typeof pageUrl === 'string') {
    return parseUrl(pageUrl, UrlConstructor)
  }
  return pageUrl
}

/** `undefined` means "not yet decided": the caller still owes a loopback check. */
const validateWsProtocol = (url: UrlLike): MultiplayerUrlValidation | undefined => {
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    return { message: 'Multiplayer server must use ws:// or wss://.', ok: false }
  }
  if (url.protocol === 'wss:') {
    return { ok: true, url }
  }
  return undefined
}

/**
 * A `ws://` server is only safe to reach when the page and the server are
 * both loopback: anything else is either a secure-context downgrade (an
 * `https:` page reaching an unencrypted socket) or a plaintext credential
 * exposed to whatever network the page's origin is reachable from.
 */
const validateLoopbackPair = (
  url: UrlLike,
  pageUrl: UrlLike | string,
  UrlConstructor: UrlConstructorLike,
): MultiplayerUrlValidation => {
  const page = resolvePageUrl(pageUrl, UrlConstructor)
  if (page === undefined) {
    return { message: 'Enter a valid multiplayer server URL.', ok: false }
  }
  if (page.protocol === 'https:') {
    return { message: 'HTTPS pages require a secure wss:// multiplayer server.', ok: false }
  }
  if (page.protocol !== 'http:' || !isLoopbackHostname(page.hostname) || !isLoopbackHostname(url.hostname)) {
    return {
      message: 'ws:// is only allowed when both this page and the multiplayer server use a loopback address.',
      ok: false,
    }
  }
  return { ok: true, url }
}

/**
 * `UrlConstructor` is the caller's real `URL` — a browser host passes the
 * platform global, a test passes a stand-in. See the file header: this
 * project's `lib` has no `URL`, so nothing here may reach for one itself.
 */
export const validateMultiplayerUrl = (
  value: string,
  pageUrl: UrlLike | string,
  UrlConstructor: UrlConstructorLike,
): MultiplayerUrlValidation => {
  const url = parseUrl(value, UrlConstructor)
  if (url === undefined) {
    return { message: 'Enter a valid multiplayer server URL.', ok: false }
  }
  const protocolResult = validateWsProtocol(url)
  if (protocolResult !== undefined) {
    return protocolResult
  }
  return validateLoopbackPair(url, pageUrl, UrlConstructor)
}

// ---------------------------------------------------------------------------
// Resume-handshake envelope
// ---------------------------------------------------------------------------

type PlayerResumeAccepted = {
  readonly _tag: 'PlayerResumeAccepted'
  readonly player: string
  readonly token: string
}

/** The `PlayerResumeAccepted` envelope always carries exactly these three fields. */
const PLAYER_RESUME_ACCEPTED_FIELD_COUNT = 3

/**
 * `undefined` means "not a resume-shaped frame at all" — ordinary protocol
 * traffic falls through to `inbound` unexamined. A frame that IS resume-shaped
 * never reaches `inbound`, whether or not it turns out well-formed: see
 * `receiveSocketMessage`.
 */
const parseResumeCandidate = (frame: string): Record<string, unknown> | undefined => {
  const value = tryParseJson(frame)
  if (!isRecord(value) || value['_tag'] !== 'PlayerResumeAccepted') {
    return undefined
  }
  return value
}

/** `candidate` has already been confirmed resume-shaped by `parseResumeCandidate`; this only checks its fields. */
const decodePlayerResumeAccepted = (candidate: Record<string, unknown>): PlayerResumeAccepted | undefined => {
  const { player, token } = candidate
  const keyCount = Object.keys(candidate).length
  if (keyCount !== PLAYER_RESUME_ACCEPTED_FIELD_COUNT || typeof player !== 'string' || typeof token !== 'string') {
    return undefined
  }
  return { _tag: 'PlayerResumeAccepted', player, token }
}

// ---------------------------------------------------------------------------
// WebSocket transport
// ---------------------------------------------------------------------------

export type WebSocketTransportState = 'closed' | 'connecting' | 'open'

export type BrowserTransportFault =
  | {
      readonly _tag: 'InboundQueueOverflow'
      readonly maxBytes: NonNegativeSafeInteger
      readonly maxFrames: NonNegativeSafeInteger
      readonly observedBytes: NonNegativeSafeInteger
      readonly observedFrames: NonNegativeSafeInteger
    }
  | {
      readonly _tag: 'FrameRateExceeded'
      readonly burstFrames: NonNegativeSafeInteger
      readonly maxFramesPerSecond: NonNegativeSafeInteger
      readonly observedFrames: NonNegativeSafeInteger
    }
  | {
      readonly _tag: 'ByteRateExceeded'
      readonly burstBytes: NonNegativeSafeInteger
      readonly maxBytesPerSecond: NonNegativeSafeInteger
      readonly observedBytes: NonNegativeSafeInteger
    }
  | { readonly _tag: 'IdleTimeout'; readonly idleTimeoutMs: NonNegativeSafeInteger }
  | { readonly _tag: 'HeartbeatTimeout'; readonly nonce: NonNegativeSafeInteger }
  | { readonly _tag: 'NonTextFrame' }
  | ProtocolError

const nonNegativeSafeInteger = (value: number): NonNegativeSafeInteger => NonNegativeSafeIntegerSchema.make(value)

export type ReconnectAuthOptions = {
  readonly clearRegistrationToken?: () => void
  readonly loadRegistrationToken?: () => string | undefined
  readonly loadToken: () => string | undefined
  readonly playerId: string
  readonly saveToken: (token: string) => void
}

export type BrowserWebSocketTransportOptions = {
  /** Required positive integer interval for transport Ping frames and response deadlines. */
  readonly heartbeatIntervalMs: PositiveSafeInteger
  /** Required positive integer receive-idle deadline. */
  readonly idleTimeoutMs: PositiveSafeInteger
  readonly inboundCapacity?: number
  readonly reconnectAuth?: ReconnectAuthOptions
  /** The caller's real `WebSocket` constructor — see the file header for why this is not read from `globalThis`. */
  readonly socketFactory: (url: string) => WebSocketLike
  readonly url: string
}

export type BrowserWebSocketTransport = TransportService & {
  readonly close: Effect.Effect<void>
  /** The first terminal ingress or liveness fault, if the transport closed for one. */
  readonly fault: () => BrowserTransportFault | undefined
  readonly isAuthenticated: () => boolean
  readonly state: () => WebSocketTransportState
}

type SocketHandlers = {
  readonly handleClose: (event: WebSocketCloseEventLike) => void
  readonly handleError: () => void
  readonly handleMessage: (event: WebSocketMessageEventLike) => void
  readonly handleOpen: () => void
}

type RuntimeState = {
  authenticated: boolean
  awaitingResume: boolean
  current: WebSocketTransportState
  disposed: boolean
  fault: BrowserTransportFault | undefined
  frameTokens: number
  byteTokens: number
  lastRateUpdateNanos: bigint
  lastInboundNanos: bigint
  nextPingNonce: number
  pendingPingNonce: number | undefined
  livenessStarted: boolean
  handlers?: SocketHandlers
  sentRegistrationToken: boolean
  terminalError: TransportError
}

/** Everything a connection-lifecycle helper needs, bundled so no function here takes more than three parameters. */
type SocketContext = {
  readonly clock: Clock.Clock
  readonly completed: Deferred.Deferred<void>
  readonly livenessStarted: Deferred.Deferred<void>
  readonly inboundAccounting: InboundQueueAccounting
  readonly inboundCapacity: number
  readonly inbound: Queue.Queue<WireText>
  readonly runtime: RuntimeState
  readonly socket: WebSocketLike
}

const createRuntimeState = (reconnectAuth: ReconnectAuthOptions | undefined, nowNanos: bigint): RuntimeState => ({
  authenticated: false,
  awaitingResume: reconnectAuth !== undefined,
  byteTokens: BYTE_RATE_BURST,
  current: 'connecting',
  disposed: false,
  fault: undefined,
  frameTokens: FRAME_RATE_BURST,
  lastInboundNanos: nowNanos,
  lastRateUpdateNanos: nowNanos,
  livenessStarted: false,
  nextPingNonce: ZERO,
  pendingPingNonce: undefined,
  sentRegistrationToken: false,
  terminalError: new TransportError({ detail: 'websocket transport is closed', reason: 'closed' }),
})

/**
 * `terminateTransport` is the only caller, and its own `current === 'closed'`
 * guard means this runs at most once per transport — `handlers` is always set
 * synchronously in `startTransport`, before any socket event can fire, so by
 * the time this is reachable it is never `undefined`.
 */
const detachSocketListeners = (ctx: SocketContext): void => {
  const { handlers } = ctx.runtime
  /* v8 ignore start -- see doc comment: unreachable under the current call graph, kept as a floor against a future refactor. */
  if (handlers === undefined) {
    return
  }
  /* v8 ignore stop */
  ctx.socket.removeEventListener('open', handlers.handleOpen)
  ctx.socket.removeEventListener('message', handlers.handleMessage)
  ctx.socket.removeEventListener('close', handlers.handleClose)
  ctx.socket.removeEventListener('error', handlers.handleError)
}

const terminateTransport = (ctx: SocketContext, error: TransportError, shutdownInbound: boolean): void => {
  if (ctx.runtime.current === 'closed') {
    return
  }
  ctx.runtime.current = 'closed'
  ctx.runtime.authenticated = false
  ctx.runtime.terminalError = error
  detachSocketListeners(ctx)
  Deferred.doneUnsafe(ctx.completed, Effect.succeed(undefined))
  if (shutdownInbound) {
    Queue.shutdownUnsafe(ctx.inbound)
  }
}

const faultDetail = (fault: BrowserTransportFault): string => {
  if (fault._tag === 'ProtocolError') {
    const { detail } = fault
    return detail
  }
  return `websocket transport fault: ${fault._tag}`
}

const faultCloseCode = (fault: BrowserTransportFault): number => {
  if (fault._tag === 'ProtocolError' && fault.reason === 'frame-too-large') {
    return FRAME_TOO_LARGE_CODE
  }
  if (fault._tag === 'NonTextFrame') {
    return UNSUPPORTED_DATA_CODE
  }
  return POLICY_VIOLATION_CODE
}

const terminateWithFault = (ctx: SocketContext, fault: BrowserTransportFault): void => {
  // Fault callbacks are synchronous; the first liveness fault completes the race and cancels its peer.
  /* v8 ignore next 3 -- @preserve */
  if (ctx.runtime.current === 'closed') {
    return
  }
  ctx.runtime.fault = fault
  terminateTransport(ctx, new TransportError({ detail: faultDetail(fault), reason: 'closed' }), true)
  Result.try(() => ctx.socket.close(faultCloseCode(fault), fault._tag))
}

const resolveRegistrationToken = (
  token: string | undefined,
  reconnectAuth: ReconnectAuthOptions,
): string | undefined => {
  if (token !== undefined) {
    return undefined
  }
  return reconnectAuth.loadRegistrationToken?.()
}

const sendResumeRequest = (ctx: SocketContext, reconnectAuth: ReconnectAuthOptions): void => {
  const sent = Result.try({
    catch: (cause) => cause,
    try: () => {
      const token = reconnectAuth.loadToken()
      const registrationToken = resolveRegistrationToken(token, reconnectAuth)
      ctx.runtime.sentRegistrationToken = registrationToken !== undefined
      ctx.socket.send(JSON.stringify({ _tag: 'PlayerResume', player: reconnectAuth.playerId, registrationToken, token }))
    },
  })
  if (Result.isFailure(sent)) {
    const detail = `websocket resume authentication failed: ${String(sent.failure)}`
    terminateTransport(ctx, new TransportError({ detail, reason: 'send-failed' }), false)
  }
}

const beginConnection = (ctx: SocketContext, reconnectAuth: ReconnectAuthOptions | undefined): void => {
  if (ctx.runtime.current !== 'connecting') {
    return
  }
  ctx.runtime.current = 'open'
  if (reconnectAuth === undefined) {
    ctx.runtime.authenticated = true
    return
  }
  sendResumeRequest(ctx, reconnectAuth)
}

const rejectResumeToken = (ctx: SocketContext, detail: string): void => {
  terminateTransport(ctx, new TransportError({ detail, reason: 'not-connected' }), false)
}

const persistResumeToken = (ctx: SocketContext, reconnectAuth: ReconnectAuthOptions, accepted: PlayerResumeAccepted): void => {
  const saved = Result.try({
    catch: (cause) => cause,
    try: () => {
      reconnectAuth.saveToken(accepted.token)
      if (ctx.runtime.sentRegistrationToken) {
        reconnectAuth.clearRegistrationToken?.()
      }
    },
  })
  if (Result.isFailure(saved)) {
    rejectResumeToken(ctx, `failed to persist websocket resume token: ${String(saved.failure)}`)
    return
  }
  ctx.runtime.awaitingResume = false
  ctx.runtime.authenticated = true
}

const acceptResumeToken = (
  ctx: SocketContext,
  reconnectAuth: ReconnectAuthOptions,
  candidate: Record<string, unknown>,
): void => {
  const accepted = decodePlayerResumeAccepted(candidate)
  if (accepted === undefined || accepted.player !== reconnectAuth.playerId) {
    rejectResumeToken(ctx, 'invalid websocket resume authentication response')
    return
  }
  persistResumeToken(ctx, reconnectAuth, accepted)
}

const receiveResumeHandshake = (
  ctx: SocketContext,
  reconnectAuth: ReconnectAuthOptions,
  candidate: Record<string, unknown>,
): void => {
  if (ctx.runtime.awaitingResume) {
    acceptResumeToken(ctx, reconnectAuth, candidate)
  }
}

const resolveResumeCandidate = (
  reconnectAuth: ReconnectAuthOptions | undefined,
  frame: string,
): Record<string, unknown> | undefined => {
  if (reconnectAuth === undefined) {
    return undefined
  }
  return parseResumeCandidate(frame)
}

const currentMonotonicNanos = (ctx: SocketContext): bigint => ctx.clock.monotonicTimeNanosUnsafe()

const refillRateBuckets = (ctx: SocketContext, nowNanos: bigint): void => {
  let elapsedNanos = ZERO_NANOS
  if (nowNanos > ctx.runtime.lastRateUpdateNanos) {
    elapsedNanos = nowNanos - ctx.runtime.lastRateUpdateNanos
  }
  const elapsedSeconds = Number(elapsedNanos) / NANOSECONDS_PER_SECOND
  ctx.runtime.frameTokens = Math.min(FRAME_RATE_BURST, ctx.runtime.frameTokens + elapsedSeconds * FRAME_RATE_PER_SECOND)
  ctx.runtime.byteTokens = Math.min(BYTE_RATE_BURST, ctx.runtime.byteTokens + elapsedSeconds * BYTE_RATE_PER_SECOND)
  ctx.runtime.lastRateUpdateNanos = nowNanos
}

const consumeRateBudget = (ctx: SocketContext, frameBytes: number, nowNanos: bigint): BrowserTransportFault | undefined => {
  refillRateBuckets(ctx, nowNanos)
  if (ctx.runtime.frameTokens < ONE) {
    return {
      _tag: 'FrameRateExceeded',
      burstFrames: nonNegativeSafeInteger(FRAME_RATE_BURST),
      maxFramesPerSecond: nonNegativeSafeInteger(FRAME_RATE_PER_SECOND),
      observedFrames: nonNegativeSafeInteger(Math.ceil(FRAME_RATE_BURST - ctx.runtime.frameTokens + ONE)),
    }
  }
  if (ctx.runtime.byteTokens < frameBytes) {
    return {
      _tag: 'ByteRateExceeded',
      burstBytes: nonNegativeSafeInteger(BYTE_RATE_BURST),
      maxBytesPerSecond: nonNegativeSafeInteger(BYTE_RATE_PER_SECOND),
      observedBytes: nonNegativeSafeInteger(Math.ceil(BYTE_RATE_BURST - ctx.runtime.byteTokens + frameBytes)),
    }
  }
  ctx.runtime.frameTokens -= 1
  ctx.runtime.byteTokens -= frameBytes
  return undefined
}

const createQueueOverflowFault = (ctx: SocketContext, frameBytes: number, queuedFrames: number): BrowserTransportFault => ({
  _tag: 'InboundQueueOverflow',
  maxBytes: nonNegativeSafeInteger(INBOUND_BYTE_CAPACITY),
  maxFrames: nonNegativeSafeInteger(ctx.inboundCapacity),
  observedBytes: nonNegativeSafeInteger(ctx.inboundAccounting.queuedBytes + frameBytes),
  observedFrames: nonNegativeSafeInteger(queuedFrames + ONE),
})

const offerInboundFrame = (ctx: SocketContext, frame: WireText, frameBytes: number): BrowserTransportFault | undefined => {
  const queuedFrames = Queue.sizeUnsafe(ctx.inbound)
  releaseTakenFrames(ctx.inboundAccounting, queuedFrames)
  if (
    queuedFrames >= ctx.inboundCapacity ||
    ctx.inboundAccounting.queuedBytes + frameBytes > INBOUND_BYTE_CAPACITY
  ) {
    return createQueueOverflowFault(ctx, frameBytes, queuedFrames)
  }
  // The explicit capacity check and positive bounded queue make offer rejection unreachable.
  /* v8 ignore next 3 -- @preserve */
  if (!Queue.offerUnsafe(ctx.inbound, frame)) {
    return createQueueOverflowFault(ctx, frameBytes, queuedFrames)
  }
  ctx.inboundAccounting.frameBytes.push(frameBytes)
  ctx.inboundAccounting.queuedBytes += frameBytes
  return undefined
}

const enqueueInboundFrame = (ctx: SocketContext, frame: WireText, frameBytes: number): void => {
  const overflow = offerInboundFrame(ctx, frame, frameBytes)
  if (overflow !== undefined) {
    terminateWithFault(ctx, overflow)
  }
}

const sendInternalMessage = (ctx: SocketContext, message: NetworkMessage): void => {
  // Liveness replies may race a socket transition before its close event runs.
  if (ctx.runtime.current !== 'open' || ctx.socket.readyState !== WEBSOCKET_OPEN_READY_STATE) {
    return
  }
  const encoded = encodeFrame(message)
  // This helper receives only schema-valid Ping and Pong messages.
  /* v8 ignore next 6 -- @preserve */
  if (Result.isFailure(encoded)) {
    terminateTransport(
      ctx,
      new TransportError({ detail: `websocket internal message could not be encoded: ${encoded.failure.detail}`, reason: 'send-failed' }),
      false,
    )
    return
  }
  const sent = Result.try({
    catch: (cause) => cause,
    try: () => ctx.socket.send(encoded.success),
  })
  if (Result.isFailure(sent)) {
    terminateTransport(ctx, new TransportError({ detail: `websocket send failed: ${String(sent.failure)}`, reason: 'send-failed' }), false)
  }
}

const sendHeartbeatPing = (ctx: SocketContext): void => {
  const nonce = ctx.runtime.nextPingNonce
  ctx.runtime.nextPingNonce = (nonce + ONE) % MAX_SAFE_INTEGER_SUCCESSOR
  ctx.runtime.pendingPingNonce = nonce
  sendInternalMessage(ctx, { _tag: 'Ping', nonce })
}

const heartbeatLoop = (ctx: SocketContext, heartbeatIntervalMs: number): Effect.Effect<void> =>
  Effect.suspend(() => Effect.flatMap(Effect.sleep(Duration.millis(heartbeatIntervalMs)), () => {
      if (ctx.runtime.awaitingResume) {
        return heartbeatLoop(ctx, heartbeatIntervalMs)
      }
      const pendingNonce = ctx.runtime.pendingPingNonce
      if (pendingNonce !== undefined) {
        terminateWithFault(ctx, { _tag: 'HeartbeatTimeout', nonce: nonNegativeSafeInteger(pendingNonce) })
        return Effect.void
      }
      sendHeartbeatPing(ctx)
      return heartbeatLoop(ctx, heartbeatIntervalMs)
    }))

const idleTimeoutLoop = (ctx: SocketContext, idleTimeoutMs: number): Effect.Effect<void> =>
  Effect.suspend(() => {
    const elapsedNanos = currentMonotonicNanos(ctx) - ctx.runtime.lastInboundNanos
    const remainingMillis = idleTimeoutMs - Number(elapsedNanos) / NANOSECONDS_PER_MILLISECOND
    if (remainingMillis <= ZERO) {
      terminateWithFault(ctx, { _tag: 'IdleTimeout', idleTimeoutMs: nonNegativeSafeInteger(idleTimeoutMs) })
      return Effect.void
    }
    const sleepMillis = Math.max(ONE, Math.ceil(remainingMillis))
    return Effect.flatMap(Effect.sleep(Duration.millis(sleepMillis)), () => idleTimeoutLoop(ctx, idleTimeoutMs))
  })

const startLiveness = (ctx: SocketContext): void => {
  if (ctx.runtime.livenessStarted) {
    return
  }
  ctx.runtime.livenessStarted = true
  Deferred.doneUnsafe(ctx.livenessStarted, Effect.succeed(undefined))
}

const validateInboundFrameSize = (ctx: SocketContext, frame: string): number | undefined => {
  if (frame.length > MAX_FRAME_CODE_UNITS) {
    terminateWithFault(
      ctx,
      new ProtocolError({
        detail: `frame exceeds the ${MAX_FRAME_CODE_UNITS}-code-unit transport ceiling`,
        reason: 'frame-too-large',
      }),
    )
    return undefined
  }
  const frameBytes = wireFrameByteLength(frame)
  // At this code-unit cap, even three UTF-8 bytes per unit stay below the 4 MiB byte cap.
  /* v8 ignore next 3 -- @preserve */
  if (frameBytes > GLOBAL_FRAME_BYTE_LIMIT) {
    terminateWithFault(
      ctx,
      new ProtocolError({ detail: `frame exceeds the ${GLOBAL_FRAME_BYTE_LIMIT}-byte transport ceiling`, reason: 'frame-too-large' }),
    )
    return undefined
  }
  return frameBytes
}

const acceptRateBudget = (ctx: SocketContext, frameBytes: number): boolean => {
  const rateFault = consumeRateBudget(ctx, frameBytes, currentMonotonicNanos(ctx))
  if (rateFault === undefined) {
    return true
  }
  terminateWithFault(ctx, rateFault)
  return false
}

type PreparedInboundFrame = { readonly frame: string; readonly frameBytes: number }

const prepareInboundFrame = (event: WebSocketMessageEventLike, ctx: SocketContext): PreparedInboundFrame | undefined => {
  if (ctx.runtime.current !== 'open') {
    return undefined
  }
  if (typeof event.data !== 'string') {
    terminateWithFault(ctx, { _tag: 'NonTextFrame' })
    return undefined
  }
  const frameBytes = validateInboundFrameSize(ctx, event.data)
  if (frameBytes === undefined || !acceptRateBudget(ctx, frameBytes)) {
    return undefined
  }
  return { frame: event.data, frameBytes }
}

const consumeResumeCandidate = (
  ctx: SocketContext,
  reconnectAuth: ReconnectAuthOptions | undefined,
  frame: string,
): boolean => {
  const candidate = resolveResumeCandidate(reconnectAuth, frame)
  if (candidate === undefined || reconnectAuth === undefined) {
    return false
  }
  const accepted = decodePlayerResumeAccepted(candidate)
  receiveResumeHandshake(ctx, reconnectAuth, candidate)
  if (accepted !== undefined && accepted.player === reconnectAuth.playerId && ctx.runtime.current === 'open' && ctx.runtime.authenticated) {
    ctx.runtime.lastInboundNanos = currentMonotonicNanos(ctx)
  }
  return true
}

const clearPendingHeartbeat = (ctx: SocketContext, nonce: number): void => {
  if (ctx.runtime.pendingPingNonce === nonce) {
    ctx.runtime.pendingPingNonce = undefined
  }
}

const consumeLivenessMessage = (ctx: SocketContext, decoded: ReturnType<typeof decodeFrame>): boolean => {
  if (Result.isFailure(decoded)) {
    return false
  }
  ctx.runtime.lastInboundNanos = currentMonotonicNanos(ctx)
  if (decoded.success._tag === 'Ping') {
    sendInternalMessage(ctx, { _tag: 'Pong', nonce: decoded.success.nonce })
    return true
  }
  if (decoded.success._tag === 'Pong') {
    clearPendingHeartbeat(ctx, decoded.success.nonce)
    return true
  }
  return false
}

const decodeInboundFrame = (ctx: SocketContext, frame: string): ReturnType<typeof decodeFrame> | undefined => {
  const decoded = decodeFrame(frame)
  if (Result.isFailure(decoded) && decoded.failure.reason === 'frame-too-large') {
    terminateWithFault(ctx, decoded.failure)
    return undefined
  }
  return decoded
}

const handlePreparedInboundFrame = (
  ctx: SocketContext,
  reconnectAuth: ReconnectAuthOptions | undefined,
  prepared: PreparedInboundFrame,
): void => {
  const decoded = decodeInboundFrame(ctx, prepared.frame)
  if (decoded === undefined) {
    return
  }
  if (consumeResumeCandidate(ctx, reconnectAuth, prepared.frame)) {
    return
  }
  if (consumeLivenessMessage(ctx, decoded)) {
    return
  }
  enqueueInboundFrame(ctx, prepared.frame, prepared.frameBytes)
}

const receiveSocketMessage = (
  event: WebSocketMessageEventLike,
  ctx: SocketContext,
  reconnectAuth: ReconnectAuthOptions | undefined,
): void => {
  const prepared = prepareInboundFrame(event, ctx)
  if (prepared === undefined) {
    return
  }
  handlePreparedInboundFrame(ctx, reconnectAuth, prepared)
}

const closeCodeLabel = (event: WebSocketCloseEventLike): string => {
  if (event.code === undefined) {
    return 'unknown'
  }
  return String(event.code)
}

const closeReasonLabel = (event: WebSocketCloseEventLike): string => {
  if (event.reason === undefined || event.reason === '') {
    return 'no reason'
  }
  return event.reason
}

const closeDetail = (event: WebSocketCloseEventLike): string =>
  `websocket closed (${closeCodeLabel(event)}: ${closeReasonLabel(event)})`

const createSocketHandlers = (ctx: SocketContext, options: BrowserWebSocketTransportOptions): SocketHandlers => {
  const handleOpen = (): void => {
    beginConnection(ctx, options.reconnectAuth)
    if (ctx.runtime.current === 'open') {
      ctx.runtime.lastInboundNanos = currentMonotonicNanos(ctx)
      startLiveness(ctx)
    }
  }
  const handleMessage = (event: WebSocketMessageEventLike): void =>
    receiveSocketMessage(event, ctx, options.reconnectAuth)
  const handleClose = (event: WebSocketCloseEventLike): void =>
    terminateTransport(ctx, new TransportError({ detail: closeDetail(event), reason: 'closed' }), false)
  const handleError = (): void =>
    terminateTransport(ctx, new TransportError({ detail: 'websocket emitted an error event', reason: 'send-failed' }), false)
  const handlers: SocketHandlers = { handleClose, handleError, handleMessage, handleOpen }
  ctx.runtime.handlers = handlers
  return handlers
}

const attachSocketListeners = (socket: WebSocketLike, handlers: SocketHandlers): void => {
  socket.addEventListener('open', handlers.handleOpen)
  socket.addEventListener('message', handlers.handleMessage)
  socket.addEventListener('close', handlers.handleClose)
  socket.addEventListener('error', handlers.handleError)
}

const sendRejectionDetail = (awaitingResume: boolean): string => {
  if (awaitingResume) {
    return 'send attempted before websocket resume authentication completed'
  }
  return 'send attempted while websocket was not open'
}

const rejectUnlessOpen = (ctx: SocketContext): TransportError | undefined => {
  if (ctx.runtime.current !== 'open' || ctx.socket.readyState !== WEBSOCKET_OPEN_READY_STATE || ctx.runtime.awaitingResume) {
    return new TransportError({ detail: sendRejectionDetail(ctx.runtime.awaitingResume), reason: 'not-connected' })
  }
  return undefined
}

const sendFrame = (ctx: SocketContext, frame: WireText): Effect.Effect<void, TransportError> => {
  if (ctx.runtime.current === 'closed') {
    return Effect.fail(ctx.runtime.terminalError)
  }
  const rejection = rejectUnlessOpen(ctx)
  if (rejection !== undefined) {
    return Effect.fail(rejection)
  }
  return Effect.try({
    catch: (cause) => {
      const error = new TransportError({ detail: `websocket send failed: ${String(cause)}`, reason: 'send-failed' })
      terminateTransport(ctx, error, false)
      return error
    },
    try: () => ctx.socket.send(frame),
  })
}

const makeSend = (ctx: SocketContext): ((frame: WireText) => Effect.Effect<void, TransportError>) => (frame) =>
  Effect.suspend(() => sendFrame(ctx, frame))

const shouldCloseReadyState = (readyState: number): boolean =>
  readyState === WEBSOCKET_CONNECTING_READY_STATE || readyState === WEBSOCKET_OPEN_READY_STATE

const makeClose = (ctx: SocketContext): Effect.Effect<void> =>
  Effect.sync(() => {
    if (ctx.runtime.disposed) {
      return
    }
    ctx.runtime.disposed = true
    const shouldCloseSocket = shouldCloseReadyState(ctx.socket.readyState)
    terminateTransport(ctx, new TransportError({ detail: 'websocket transport disposed locally', reason: 'closed' }), true)
    if (shouldCloseSocket) {
      ctx.socket.close(NORMAL_CLOSURE_CODE, 'transport disposed')
    }
  })

const validatePositiveConfig = (name: string, value: number): TransportError | undefined => {
  if (Number.isSafeInteger(value) && value > ZERO) {
    return undefined
  }
  return new TransportError({ detail: `${name} must be a positive safe integer, received ${String(value)}`, reason: 'not-connected' })
}

const validateInboundCapacity = (capacity: number): TransportError | undefined => {
  if (Number.isSafeInteger(capacity) && capacity > ZERO && capacity <= MAX_INBOUND_CAPACITY) {
    return undefined
  }
  return new TransportError({
    detail: `inboundCapacity must be a positive integer no greater than ${MAX_INBOUND_CAPACITY}, received ${String(capacity)}`,
    reason: 'not-connected',
  })
}

const openSocket = (options: BrowserWebSocketTransportOptions): Effect.Effect<WebSocketLike, TransportError> =>
  Effect.try({
    catch: (cause) => new TransportError({ detail: `websocket construction failed: ${String(cause)}`, reason: 'not-connected' }),
    try: () => options.socketFactory(options.url),
  })

const startTransport = (ctx: SocketContext, options: BrowserWebSocketTransportOptions): Effect.Effect<BrowserWebSocketTransport> =>
  Effect.gen(function* () {
    const handlers = createSocketHandlers(ctx, options)
    attachSocketListeners(ctx.socket, handlers)
    const opened = Effect.flatMap(Deferred.await(ctx.livenessStarted), () =>
      Effect.raceFirst(heartbeatLoop(ctx, options.heartbeatIntervalMs), Deferred.await(ctx.completed)),
    )
    const idle = Effect.flatMap(Deferred.await(ctx.livenessStarted), () =>
      Effect.raceFirst(idleTimeoutLoop(ctx, options.idleTimeoutMs), Deferred.await(ctx.completed)),
    )
    yield* Effect.forkDetach(Effect.provideService(opened, Clock.Clock, ctx.clock))
    yield* Effect.forkDetach(Effect.provideService(idle, Clock.Clock, ctx.clock))
    return {
      close: makeClose(ctx),
      fault: () => ctx.runtime.fault,
      inbound: ctx.inbound,
      isAuthenticated: () => ctx.runtime.authenticated,
      send: makeSend(ctx),
      state: () => ctx.runtime.current,
    }
  })

const validateBrowserTransportConfig = (options: BrowserWebSocketTransportOptions): Effect.Effect<number, TransportError> =>
  Effect.gen(function* () {
    const capacity = options.inboundCapacity ?? DEFAULT_INBOUND_CAPACITY
    const errors = [
      validateInboundCapacity(capacity),
      validatePositiveConfig('heartbeatIntervalMs', options.heartbeatIntervalMs),
      validatePositiveConfig('idleTimeoutMs', options.idleTimeoutMs),
    ]
    const firstError = errors.find((error) => error !== undefined)
    if (firstError !== undefined) {
      return yield* Effect.fail(firstError)
    }
    return capacity
  })

/**
 * A `TransportPort` implementation over a real WebSocket.
 *
 * `inbound` carries raw `WireText` after bounded codec preflight. Ping/Pong are
 * consumed for transport liveness; other protocol failures remain visible to
 * `receiveMessage`. A `reconnectAuth` option gates ordinary sends behind a
 * `PlayerResume` / `PlayerResumeAccepted` handshake completing first.
 */
export const makeBrowserWebSocketTransport = (
  options: BrowserWebSocketTransportOptions,
): Effect.Effect<BrowserWebSocketTransport, TransportError> =>
  Effect.gen(function* () {
    const capacity = yield* validateBrowserTransportConfig(options)
    const inbound = yield* Queue.bounded<WireText>(capacity)
    const completed = yield* Deferred.make<void>()
    const livenessStarted = yield* Deferred.make<void>()
    const clock = yield* Clock.Clock
    const socket = yield* openSocket(options)
    const ctx: SocketContext = {
      clock,
      completed,
      inbound,
      inboundAccounting: { frameBytes: [], queuedBytes: 0 },
      inboundCapacity: capacity,
      livenessStarted,
      runtime: createRuntimeState(options.reconnectAuth, clock.monotonicTimeNanosUnsafe()),
      socket,
    }
    return yield* startTransport(ctx, options)
  })

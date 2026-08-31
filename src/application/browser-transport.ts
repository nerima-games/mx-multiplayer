/**
 * The browser adapter for `TransportPort`: a real WebSocket in, `WireText` out.
 *
 * Lowered from the composing app's `web/multiplayer-url.ts` and
 * `web/multiplayer-websocket.ts`. Only the URL-validation and connection-
 * lifecycle judgment moved here; the per-message wire formats that the
 * composing app's `multiplayer-shared/*-network.ts` files hand-rolled around
 * this transport belong to `domain/protocol/*.ts` and the shared
 * `NetworkMessage` codec (`domain/codec.ts`), not to this file — a transport
 * Port does not get to know a message tag.
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
 * It does not know a single `NetworkMessage` tag. `TransportService` moves
 * `WireText`; `sendMessage` / `receiveMessage` in `domain/transport.ts` own
 * the codec boundary. This file's only judgment is: how to represent a
 * WebSocket connection's states as `TransportError`s to that Port, and when a
 * resume handshake must complete before ordinary traffic may send. The resume
 * handshake's `PlayerResume` / `PlayerResumeAccepted` envelope is deliberately
 * NOT a `NetworkMessage` — it authenticates the connection the protocol will
 * run over, so it has to be decodable before a peer has proven which protocol
 * version, if any, it speaks. Its shape belongs with whatever session-token
 * issuance replaces `multiplayer-server/reconnect-auth.ts`; this file only
 * consumes it.
 */
import { Effect, Queue } from 'effect'
import { TransportError } from '../domain/errors.js'
import type { TransportService } from '../domain/transport.js'
import type { WireText } from '../domain/codec.js'

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

const tryParseJson = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return JSON_PARSE_FAILED
  }
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
  try {
    return new UrlConstructor(value)
  } catch {
    return undefined
  }
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

export type ReconnectAuthOptions = {
  readonly clearRegistrationToken?: () => void
  readonly loadRegistrationToken?: () => string | undefined
  readonly loadToken: () => string | undefined
  readonly playerId: string
  readonly saveToken: (token: string) => void
}

export type BrowserWebSocketTransportOptions = {
  readonly inboundCapacity?: number
  readonly reconnectAuth?: ReconnectAuthOptions
  /** The caller's real `WebSocket` constructor — see the file header for why this is not read from `globalThis`. */
  readonly socketFactory: (url: string) => WebSocketLike
  readonly url: string
}

export type BrowserWebSocketTransport = TransportService & {
  readonly close: Effect.Effect<void>
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
  handlers?: SocketHandlers
  sentRegistrationToken: boolean
  terminalError: TransportError
}

/** Everything a connection-lifecycle helper needs, bundled so no function here takes more than three parameters. */
type SocketContext = {
  readonly inbound: Queue.Queue<WireText>
  readonly runtime: RuntimeState
  readonly socket: WebSocketLike
}

const createRuntimeState = (reconnectAuth: ReconnectAuthOptions | undefined): RuntimeState => ({
  authenticated: false,
  awaitingResume: reconnectAuth !== undefined,
  current: 'connecting',
  disposed: false,
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
  if (shutdownInbound) {
    Effect.runSync(Queue.shutdown(ctx.inbound))
  }
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
  try {
    const token = reconnectAuth.loadToken()
    const registrationToken = resolveRegistrationToken(token, reconnectAuth)
    ctx.runtime.sentRegistrationToken = registrationToken !== undefined
    ctx.socket.send(JSON.stringify({ _tag: 'PlayerResume', player: reconnectAuth.playerId, registrationToken, token }))
  } catch (cause) {
    const detail = `websocket resume authentication failed: ${String(cause)}`
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
  try {
    reconnectAuth.saveToken(accepted.token)
    if (ctx.runtime.sentRegistrationToken) {
      reconnectAuth.clearRegistrationToken?.()
    }
  } catch (cause) {
    rejectResumeToken(ctx, `failed to persist websocket resume token: ${String(cause)}`)
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

const receiveSocketMessage = (
  event: WebSocketMessageEventLike,
  ctx: SocketContext,
  reconnectAuth: ReconnectAuthOptions | undefined,
): void => {
  if (ctx.runtime.current !== 'open' || typeof event.data !== 'string') {
    return
  }
  const resumeCandidate = resolveResumeCandidate(reconnectAuth, event.data)
  if (resumeCandidate !== undefined && reconnectAuth !== undefined) {
    receiveResumeHandshake(ctx, reconnectAuth, resumeCandidate)
    return
  }
  Queue.unsafeOffer(ctx.inbound, event.data)
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
  const handleOpen = (): void => beginConnection(ctx, options.reconnectAuth)
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

/** A positive `inboundCapacity` floor: zero would make every inbound frame block forever. */
const MIN_INBOUND_CAPACITY = 1
/** The original compose adapter's default queue depth, kept for behavioural parity. */
const DEFAULT_INBOUND_CAPACITY = 256

const validateInboundCapacity = (capacity: number): TransportError | undefined => {
  if (Number.isInteger(capacity) && capacity >= MIN_INBOUND_CAPACITY) {
    return undefined
  }
  return new TransportError({
    detail: `inboundCapacity must be a positive integer, received ${String(capacity)}`,
    reason: 'not-connected',
  })
}

const openSocket = (options: BrowserWebSocketTransportOptions): Effect.Effect<WebSocketLike, TransportError> =>
  Effect.try({
    catch: (cause) => new TransportError({ detail: `websocket construction failed: ${String(cause)}`, reason: 'not-connected' }),
    try: () => options.socketFactory(options.url),
  })

const startTransport = (ctx: SocketContext, options: BrowserWebSocketTransportOptions): BrowserWebSocketTransport => {
  const handlers = createSocketHandlers(ctx, options)
  attachSocketListeners(ctx.socket, handlers)
  return {
    close: makeClose(ctx),
    inbound: ctx.inbound,
    isAuthenticated: () => ctx.runtime.authenticated,
    send: makeSend(ctx),
    state: () => ctx.runtime.current,
  }
}

/**
 * A `TransportPort` implementation over a real WebSocket.
 *
 * `inbound` carries `WireText` only — no message ever bypasses
 * `domain/codec.ts`. A `reconnectAuth` option gates ordinary sends behind a
 * `PlayerResume` / `PlayerResumeAccepted` handshake completing first, so a
 * frame cannot leak onto an unauthenticated connection.
 */
export const makeBrowserWebSocketTransport = (
  options: BrowserWebSocketTransportOptions,
): Effect.Effect<BrowserWebSocketTransport, TransportError> =>
  Effect.gen(function* () {
    const capacity = options.inboundCapacity ?? DEFAULT_INBOUND_CAPACITY
    const capacityError = validateInboundCapacity(capacity)
    if (capacityError !== undefined) {
      return yield* Effect.fail(capacityError)
    }
    const inbound = yield* Queue.unbounded<WireText>()
    const socket = yield* openSocket(options)
    const ctx: SocketContext = { inbound, runtime: createRuntimeState(options.reconnectAuth), socket }
    return startTransport(ctx, options)
  })

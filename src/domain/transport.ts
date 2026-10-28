/**
 * The transport Port, and an in-memory loopback implementation of it.
 *
 * PRE-AUDIT FIRST CUT (叩き台).
 *
 * ---------------------------------------------------------------------------
 * Why the Port carries TEXT
 * ---------------------------------------------------------------------------
 *
 * `TransportService` moves `WireText`, not `NetworkMessage`. Keeping the codec
 * outside the Port is what makes the loopback implementation below a real test
 * double: a loopback that passed `NetworkMessage` values through untouched
 * would never exercise encode or decode, and every protocol bug would survive
 * every loopback test. Here a message genuinely goes to text and back, which is
 * what plan.md §3.14's "ループバック同期テスト" is for.
 *
 * ---------------------------------------------------------------------------
 * What is deliberately NOT here
 * ---------------------------------------------------------------------------
 *
 * No WebSocket, no `ws`, no reconnection schedule, no server process. Those are
 * adapters over this Port and belong with the platform, exactly as
 * `@nerima-games/mc-kernel`'s `ClockPort` ships a `fixedClock` and no real
 * clock. The reference implementation kept its browser client, its Node server
 * and a `scripts/multiplayer-server.ts` entry point inside `packages/network`;
 * splitting the Port from its adapters is what lets this repository's whole
 * test suite run in a plain Node vitest pool with no sockets.
 */
import { type ConnectionState, canSend } from './connection.js'
import { Context, Effect, Layer, Queue } from 'effect'
import { type ProtocolError, TransportError } from './errors.js'
import { type WireText, decodeFrame, encodeFrame, wireFrameByteLength } from './codec.js'
import type { NetworkMessage } from './protocol.js'

const INBOUND_QUEUE_CAPACITY = 80
const INBOUND_QUEUE_BYTE_CAPACITY = 3_486_960

type InboundQueueAccounting = {
  readonly frameBytes: Array<number>
  queuedBytes: number
}

const releaseTakenFrames = (accounting: InboundQueueAccounting, queuedFrames: number): void => {
  if (accounting.frameBytes.length <= queuedFrames) {
    return
  }
  const takenFrames = accounting.frameBytes.splice(0, accounting.frameBytes.length - queuedFrames)
  for (const frameBytes of takenFrames) {
    accounting.queuedBytes -= frameBytes
  }
}

type LoopbackQueueOverflow = {
  readonly _tag: 'InboundQueueOverflow'
  readonly maxBytes: number
  readonly maxFrames: number
  readonly observedBytes: number
  readonly observedFrames: number
}

const overflowFault = (accounting: InboundQueueAccounting, queuedFrames: number, frameBytes: number): LoopbackQueueOverflow => ({
  _tag: 'InboundQueueOverflow',
  maxBytes: INBOUND_QUEUE_BYTE_CAPACITY,
  maxFrames: INBOUND_QUEUE_CAPACITY,
  observedBytes: accounting.queuedBytes + frameBytes,
  observedFrames: queuedFrames + 1,
})

export type TransportService = {
  /** Write one frame. Fails, rather than buffering, when not connected. */
  readonly send: (frame: WireText) => Effect.Effect<void, TransportError>
  /**
   * Frames received from the peer, in arrival order.
   *
   * The bounded `Dequeue` makes queue pressure explicit: a producer that
   * exceeds the frame or byte cap receives a typed send failure with observed
   * counts in its detail.
   */
  readonly inbound: Queue.Dequeue<WireText>
}

// `isolatedDeclarations` (TS 7) rejects a class expression directly in an
// `extends` clause (TS9021); naming the base with its own explicit
// `Context.ServiceClass` type is the same pattern mc-kernel uses for `ClockPort`.
const TransportPortBase: Context.ServiceClass<TransportPort, '@nerima-games/mx-multiplayer/TransportPort', TransportService> =
  Context.Service<TransportPort, TransportService>()('@nerima-games/mx-multiplayer/TransportPort')

export class TransportPort extends TransportPortBase {}

/**
 * Decorate a transport so every send observes the current connection state.
 *
 * The state is an Effect rather than a snapshot: passing `Ref.get(ref)` checks
 * the Ref again for each send. Adapters should provide this decorated service
 * as `TransportPort`; the undecorated service remains available for handshake
 * traffic and for backward compatibility.
 */
export const connectionGatedTransport = (
  state: Effect.Effect<ConnectionState>,
  transport: TransportService,
): TransportService => ({
  inbound: transport.inbound,
  send: (frame) =>
    Effect.flatMap(state, (current) => {
      if (canSend(current)) {
        return transport.send(frame)
      }
      return Effect.fail(
        new TransportError({
          detail: `send attempted while connection state was ${current._tag}`,
          reason: 'not-connected',
        }),
      )
    }),
})

/** Encode and send. The ordinary way to talk to a peer. */
export const sendMessage = (
  message: NetworkMessage,
): Effect.Effect<void, ProtocolError | TransportError, TransportPort> =>
  Effect.gen(function* () {
    const transport = yield* TransportPort
    const frame = yield* Effect.fromResult(encodeFrame(message))
    yield* transport.send(frame)
  })

/** Take the next frame and decode it. Blocks until one arrives. */
export const receiveMessage: Effect.Effect<NetworkMessage, ProtocolError, TransportPort> =
  Effect.gen(function* () {
    const transport = yield* TransportPort
    const frame = yield* Queue.take(transport.inbound)
    return yield* Effect.fromResult(decodeFrame(frame))
  })

const offerLoopbackFrame = (
  target: Queue.Queue<WireText>,
  accounting: InboundQueueAccounting,
  frame: WireText,
): LoopbackQueueOverflow | undefined => {
  const queuedFrames = Queue.sizeUnsafe(target)
  releaseTakenFrames(accounting, queuedFrames)
  const frameBytes = wireFrameByteLength(frame)
  if (
    queuedFrames >= INBOUND_QUEUE_CAPACITY ||
    accounting.queuedBytes + frameBytes > INBOUND_QUEUE_BYTE_CAPACITY
  ) {
    return overflowFault(accounting, queuedFrames, frameBytes)
  }
  // The synchronous capacity check and open-state check make queue rejection unreachable here.
  /* v8 ignore next 3 -- @preserve */
  if (!Queue.offerUnsafe(target, frame)) {
    return overflowFault(accounting, queuedFrames, frameBytes)
  }
  accounting.frameBytes.push(frameBytes)
  accounting.queuedBytes += frameBytes
  return undefined
}

const sendLoopbackFrame = (
  target: Queue.Queue<WireText>,
  accounting: InboundQueueAccounting,
  frame: WireText,
): Effect.Effect<void, TransportError> => {
  // TransportService exposes only the Dequeue, so callers cannot shut this queue down.
  /* v8 ignore next 3 -- @preserve */
  if (target.state._tag !== 'Open') {
    return Effect.fail(new TransportError({ detail: 'loopback inbound queue is closed', reason: 'closed' }))
  }
  const overflow = offerLoopbackFrame(target, accounting, frame)
  if (overflow !== undefined) {
    return Effect.fail(
      new TransportError({
        detail: `loopback inbound queue overflow: ${overflow.observedFrames}/${overflow.maxFrames} frames, ${overflow.observedBytes}/${overflow.maxBytes} bytes`,
        reason: 'send-failed',
      }),
    )
  }
  return Effect.void
}

const makeLoopbackSide = (target: Queue.Queue<WireText>, inbound: Queue.Dequeue<WireText>): TransportService => {
  const accounting: InboundQueueAccounting = { frameBytes: [], queuedBytes: 0 }
  return {
    inbound,
    send: (frame) => Effect.suspend(() => sendLoopbackFrame(target, accounting, frame)),
  }
}

/**
 * A directly wired pair of transports: whatever one side sends, the other side
 * receives.
 *
 * This is the test double for the whole repository. It is a *pair* rather than
 * an echo because an echo cannot catch a message the sender is not supposed to
 * be able to handle, and because the two ends want to be provided to two
 * different Effects (one acting as client, one as server).
 *
 * Both directions use the same frame and byte bounds as the browser ingress.
 * An overfull queue fails the sending Effect with a typed fault instead of
 * blocking or silently discarding a frame.
 */
export const makeLoopbackPair: Effect.Effect<
  readonly [TransportService, TransportService]
> = Effect.gen(function* () {
  const leftInbound = yield* Queue.bounded<WireText>(INBOUND_QUEUE_CAPACITY)
  const rightInbound = yield* Queue.bounded<WireText>(INBOUND_QUEUE_CAPACITY)

  return [
    makeLoopbackSide(rightInbound, leftInbound),
    makeLoopbackSide(leftInbound, rightInbound),
  ] as const
})

/** One end of a loopback pair, as a Layer, for tests that only need one side. */
export const LoopbackTransportLayer = (service: TransportService): Layer.Layer<TransportPort> =>
  Layer.succeed(TransportPort, service)

/**
 * A transport that refuses every send.
 *
 * Used to prove that the failure path is reachable and typed: a caller must
 * handle `TransportError` even when the happy path is all it ever tests.
 */
export const disconnectedTransport: Effect.Effect<TransportService> = Effect.gen(function* () {
  const inbound = yield* Queue.bounded<WireText>(INBOUND_QUEUE_CAPACITY)
  return {
    inbound,
    send: () =>
      Effect.fail(
        new TransportError({
          detail: 'send attempted while the connection was not in Connected',
          reason: 'not-connected',
        }),
      ),
  }
})

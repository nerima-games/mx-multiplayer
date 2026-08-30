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
import { type WireText, decodeFrame, encodeFrame } from './codec.js'
import type { NetworkMessage } from './protocol.js'

export type TransportService = {
  /** Write one frame. Fails, rather than buffering, when not connected. */
  readonly send: (frame: WireText) => Effect.Effect<void, TransportError>
  /**
   * Frames received from the peer, in arrival order.
   *
   * A `Dequeue` rather than a callback so that back-pressure is expressible:
   * a consumer that cannot keep up blocks the producer instead of growing an
   * unbounded queue behind the scenes.
   */
  readonly inbound: Queue.Dequeue<WireText>
}

// `isolatedDeclarations` (TS 7) rejects a class expression directly in an
// `extends` clause (TS9021); naming the base with its own explicit
// `Context.TagClass` type is the same pattern mc-kernel uses for `ClockPort`.
const TransportPortBase: Context.TagClass<TransportPort, '@nerima-games/mx-multiplayer/TransportPort', TransportService> =
  Context.Tag('@nerima-games/mx-multiplayer/TransportPort')<TransportPort, TransportService>()

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
    const frame = yield* encodeFrame(message)
    yield* transport.send(frame)
  })

/** Take the next frame and decode it. Blocks until one arrives. */
export const receiveMessage: Effect.Effect<NetworkMessage, ProtocolError, TransportPort> =
  Effect.gen(function* () {
    const transport = yield* TransportPort
    const frame = yield* Queue.take(transport.inbound)
    return yield* decodeFrame(frame)
  })

/**
 * A directly wired pair of transports: whatever one side sends, the other side
 * receives.
 *
 * This is the test double for the whole repository. It is a *pair* rather than
 * an echo because an echo cannot catch a message the sender is not supposed to
 * be able to handle, and because the two ends want to be provided to two
 * different Effects (one acting as client, one as server).
 *
 * Queues are unbounded here: a bounded queue would make a test that sends more
 * frames than it reads deadlock rather than fail, which is a much worse failure
 * to debug. Real adapters should bound theirs.
 */
export const makeLoopbackPair: Effect.Effect<
  readonly [TransportService, TransportService]
> = Effect.gen(function* () {
  const leftInbound = yield* Queue.unbounded<WireText>()
  const rightInbound = yield* Queue.unbounded<WireText>()

  const sideSending = (target: Queue.Enqueue<WireText>, inbound: Queue.Dequeue<WireText>): TransportService => ({
    inbound,
    send: (frame) =>
      Queue.offer(target, frame).pipe(
        Effect.asVoid,
        // Verified empirically: offering to a queue after `Queue.shutdown`
        // Fails the fiber through interruption, not a defect — there is no
        // Legitimate use of `Queue`'s public API that reaches `catchAllDefect`
        // Here. This guards a failure mode internal to Effect's `Queue`
        // Implementation, not one this repository's callers can construct.
        /* v8 ignore next 3 -- @preserve */
        Effect.catchAllDefect((defect) =>
          Effect.fail(new TransportError({ detail: String(defect), reason: 'send-failed' })),
        ),
      ),
  })

  return [
    sideSending(rightInbound, leftInbound),
    sideSending(leftInbound, rightInbound),
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
  const inbound = yield* Queue.unbounded<WireText>()
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

/**
 * mx-multiplayer's contribution to the frame (plan.md §4.1).
 *
 * ---------------------------------------------------------------------------
 * Read `stage-ids.ts` first
 * ---------------------------------------------------------------------------
 *
 * It carries the measurement that matters more than anything in this file:
 * mc-compose's `STANDARD_STAGE_SKELETON` has no phase that claims either of
 * these ids, so today both run at the END of the frame, after the HUD. It also
 * names the two phases mc-compose needs, and says why neither can be supplied
 * from here.
 *
 * ---------------------------------------------------------------------------
 * What a stage in THIS repository is allowed to do
 * ---------------------------------------------------------------------------
 *
 * plan.md §3.14 confines mx-multiplayer to transport and protocol. So these two
 * stages MOVE FRAMES and nothing else:
 *
 *   - `multiplayer:inbound` takes whatever text arrived, decodes it, and puts
 *     the decoded messages where the seam into mc-sim will read them.
 *   - `multiplayer:outbound` takes whatever messages were handed to it, encodes
 *     them, and writes them — if the connection state permits.
 *
 * Neither looks inside a message. A `BlockBreak` is a value that gets carried;
 * what a broken block drops is mx-gameplay's, and which of two players wins a
 * contested pickup is mc-sim's and mx-gameplay's (docs/responsibility.md §4,
 * DN-9). The reference implementation put first-come claim arbitration in
 * `packages/network/application/server-handlers.ts` and the consequence was that
 * changing an inventory rule meant editing the network layer.
 *
 * ---------------------------------------------------------------------------
 * The seam, and what is FIRST CUT
 * ---------------------------------------------------------------------------
 *
 * "Apply a decoded message" means "write through an mc-sim service"
 * (`index.ts`, docs/responsibility.md §2). mc-sim is not published — plan.md §6
 * Step 3 is bottom-up publish-then-pin — so the seam is two `Ref`s that a
 * preview or a test drives, in exactly the shape mx-gameplay uses for its
 * outbox and mx-ui for its snapshot. When mc-sim publishes, the services are
 * acquired in `makeMultiplayerStages` alongside `TransportPort` and the `Ref`s
 * become an implementation detail of the previews.
 *
 * What is NOT first cut is the part this repository can decide alone and which
 * the frame position depends on: the ids, the single `after` edge, the `canSend`
 * guard, and the drop policies below. Those are settled.
 */
import { Chunk, Effect, Either, Layer, Queue, Ref } from 'effect'
import { decodeFrame, encodeFrame } from '../domain/codec'
import {
  canSend,
  initialConnectionState,
  transition,
  type ConnectionEvent,
  type ConnectionState,
} from '../domain/connection'
import type { ProtocolError } from '../domain/errors'
import type { GameModule, StageRegistration } from '../domain/frame-contract'
import type { NetworkMessage } from '../domain/protocol'
import { TransportPort, type TransportService } from '../domain/transport'
import { MULTIPLAYER_STAGE_IDS, UPSTREAM_STAGE_IDS } from './stage-ids'

/**
 * What one frame's worth of network work did.
 *
 * Counters rather than logs, and DN-2's two failure channels stay APART: a
 * protocol failure means "retrying is pointless, drop the frame or the peer" and
 * a transport failure means "retrying is exactly right". A single number would
 * force every reader to re-derive the distinction, which is how "reconnect on a
 * malformed packet" loops get written.
 *
 * They exist for the same reason `GameLoop.framesDropped` does in mc-sim:
 * dropping is the correct behaviour here and dropping SILENTLY is not. Nothing
 * else can compute these — the sender's count and the receiver's count differ by
 * exactly the frames that were thrown away, so neither side can subtract its way
 * to the answer.
 */
export type NetworkFrameCounters = {
  /** Frames decoded and handed to the seam. */
  readonly received: number
  /** Frames that were not JSON, or not a known message. Frame dropped. */
  readonly malformed: number
  /**
   * Frames from a protocol version this build does not speak.
   *
   * Counted apart from `malformed` because DN-1 says the correct response
   * differs: a malformed frame costs a frame, a version mismatch costs the PEER
   * and the user has to be told. Merging them makes a rolling upgrade
   * indistinguishable from corruption, which is the exact defect the versioned
   * envelope was introduced to fix.
   */
  readonly versionMismatched: number
  /** Messages sent. */
  readonly sent: number
  /** Messages that could not be encoded. A local bug; the message is dropped. */
  readonly unencodable: number
  /** Sends the transport rejected. Retrying is the right response — see DN-2. */
  readonly sendFailed: number
  /**
   * Messages discarded because `canSend` said the connection was not `Connected`.
   *
   * See `multiplayer:outbound` below for why they are discarded rather than
   * held.
   */
  readonly droppedWhileNotConnected: number
}

export const NO_NETWORK_FRAMES: NetworkFrameCounters = {
  received: 0,
  malformed: 0,
  versionMismatched: 0,
  sent: 0,
  unencodable: 0,
  sendFailed: 0,
  droppedWhileNotConnected: 0,
}

export type MultiplayerFrameState = {
  /**
   * The connection lifecycle, as `domain/connection.ts` models it.
   *
   * Held rather than derived: `canSend` is a question about a STATE, and until
   * something held one there was nothing to ask (finding M4). It is advanced by
   * `transition`, by whoever owns the socket — this repository ships no adapter
   * — and read here.
   */
  readonly connection: Ref.Ref<ConnectionState>
  /**
   * Messages waiting to go out, in the order they were offered.
   *
   * FIRST CUT: filled by a preview or a test today. When mc-sim publishes, the
   * local session's per-frame intent is read from its services here instead —
   * still without interpreting it, because "read the player's position and put
   * it in a `PlayerMove`" is a projection, not a rule.
   */
  readonly outbox: Ref.Ref<ReadonlyArray<NetworkMessage>>
  /**
   * Messages decoded this frame and not yet applied to the world.
   *
   * FIRST CUT: this IS the seam. Today it accumulates and a preview or a test
   * drains it; when mc-sim publishes, `multiplayer:inbound` writes each message
   * through an mc-sim service in the same place it currently appends here, and
   * this `Ref` disappears.
   */
  readonly inbound: Ref.Ref<ReadonlyArray<NetworkMessage>>
  readonly counters: Ref.Ref<NetworkFrameCounters>
}

/**
 * An Effect rather than a constant, so a test, each preview and the game can
 * hold their own.
 *
 * plan.md §3.8 records app-scope singletons as among the reference's worst bug
 * sources, and this repository's preview runs TWO sessions in one process on
 * purpose (`apps/preview-two-clients`). A shared outbox between them would not
 * be a subtle bug; it would be one client sending the other's frames.
 */
export const makeMultiplayerFrameState: Effect.Effect<MultiplayerFrameState> = Effect.gen(
  function* () {
    const connection = yield* Ref.make(initialConnectionState)
    const outbox = yield* Ref.make<ReadonlyArray<NetworkMessage>>([])
    const inbound = yield* Ref.make<ReadonlyArray<NetworkMessage>>([])
    const counters = yield* Ref.make(NO_NETWORK_FRAMES)

    return { connection, outbox, inbound, counters }
  },
)

const countProtocolFailure = (
  state: MultiplayerFrameState,
  error: ProtocolError,
): Effect.Effect<void> =>
  Ref.update(state.counters, (current) =>
    error.reason === 'unsupported-protocol-version'
      ? { ...current, versionMismatched: current.versionMismatched + 1 }
      : { ...current, malformed: current.malformed + 1 },
  )

/**
 * The two stages mx-multiplayer registers.
 *
 * Neither resolves an order; each carries `after` constraints and mc-compose
 * sorts the union (plan.md §2.3-3). The array order here is for human reading,
 * and it is deliberately NOT the frame order the ids ask for — `inbound` wants
 * to be near the front of the frame and `outbound` near the end, and nothing
 * about writing them adjacently says so.
 */
export const multiplayerStages = (
  state: MultiplayerFrameState,
  transport: TransportService,
): ReadonlyArray<StageRegistration> => [
  {
    id: MULTIPLAYER_STAGE_IDS.inbound,
    // No `after`. Its requirement is to run BEFORE `sim:physics`, and the
    // contract has no `before` — see `stage-ids.ts`. This is `render:input`'s
    // situation exactly, and `render:input` declares no `after` either.
    run: () =>
      Effect.gen(function* () {
        // `takeAll`, not `take`: `take` blocks until a frame arrives, and a
        // stage that blocks stops the frame. Draining whatever is there is also
        // what makes the queue's back-pressure meaningful — the consumer keeps
        // up by definition, once per frame.
        //
        // Everything that had arrived by the time this frame started is applied
        // in this frame. A frame that lands mid-drain is taken next frame, which
        // is the same "belongs to the frame that saw it" rule mc-render's
        // `render:input` applies to input edges.
        const frames = yield* Queue.takeAll(transport.inbound)

        yield* Effect.forEach(
          Chunk.toReadonlyArray(frames),
          (frame) =>
            Either.match(decodeFrame(frame), {
              // A frame this build cannot read is DROPPED, not retried:
              // `ProtocolError` means the bytes arrived intact and do not mean
              // what this build thinks they mean, so a resend produces the same
              // bytes (DN-2). What the counter separates is whether the right
              // response is to drop the frame or the peer (DN-1).
              onLeft: (error) => countProtocolFailure(state, error),
              // The seam. FIRST CUT: appended for a preview or a test to drain;
              // when mc-sim publishes, this line writes through an mc-sim
              // service instead. Either way this stage does not look inside the
              // message — plan.md §3.14.
              onRight: (message) =>
                Ref.update(state.inbound, (pending) => [...pending, message]).pipe(
                  Effect.zipRight(
                    Ref.update(state.counters, (current) => ({
                      ...current,
                      received: current.received + 1,
                    })),
                  ),
                ),
            }),
          { discard: true },
        )
      }),
  },
  {
    id: MULTIPLAYER_STAGE_IDS.outbound,
    after: [UPSTREAM_STAGE_IDS.simPhysics],
    // Publish the position the simulation RESOLVED this frame. Publishing the
    // pre-integration one puts every peer's view of this player a frame behind,
    // which reads as network lag rather than as a bug — mc-render's argument for
    // `render:camera-mirror`, pointed outwards.
    run: () =>
      Effect.gen(function* () {
        const connection = yield* Ref.get(state.connection)

        // Drained unconditionally, and that is the drop policy rather than an
        // oversight.
        //
        // A message in this outbox describes THIS frame. Holding it across a
        // disconnect means replaying a stale world on reconnect — every position
        // the player passed through, in order, as fast as the socket allows —
        // and mx-multiplayer cannot tell a stale message from a durable one
        // without reading it, which plan.md §3.14 forbids. So the policy has to
        // be content-independent, and of the two content-independent policies
        // "drop" is the one that cannot produce a replay. Anything that must
        // survive a disconnect is re-offered by its owner after the handshake,
        // which is the only party that knows it must.
        //
        // Same argument as `application/game-loop.ts`'s dropping frame queue in
        // mc-sim: under adverse conditions, lose work rather than accumulate a
        // backlog the world then replays in fast-forward.
        const pending = yield* Ref.getAndSet(state.outbox, [])

        // Finding M4's answer. `canSend` was exported and called nowhere; the
        // frame stage is the one place that holds both the state and the
        // messages, so it is where the invariant can be enforced without a Port
        // learning about a state machine.
        if (!canSend(connection)) {
          yield* Ref.update(state.counters, (current) => ({
            ...current,
            droppedWhileNotConnected: current.droppedWhileNotConnected + pending.length,
          }))
          return
        }

        yield* Effect.forEach(
          pending,
          (message) =>
            Either.match(encodeFrame(message), {
              // A message that will not encode is a LOCAL bug — a branded
              // invariant was violated on this side — so there is nothing to
              // resend and nobody to blame for it at the far end. Counted apart
              // from `sendFailed` for that reason.
              onLeft: () =>
                Ref.update(state.counters, (current) => ({
                  ...current,
                  unencodable: current.unencodable + 1,
                })),
              onRight: (frame) =>
                transport.send(frame).pipe(
                  Effect.matchEffect({
                    // `TransportError`: the bytes did not get through and the
                    // message is still valid. Retrying is the right response and
                    // it belongs to whoever owns the socket's `Schedule` (DN-8
                    // keeps retry policy out of this repository's domain), so
                    // the stage records it and moves on rather than blocking the
                    // frame on a socket.
                    onFailure: () =>
                      Ref.update(state.counters, (current) => ({
                        ...current,
                        sendFailed: current.sendFailed + 1,
                      })),
                    onSuccess: () =>
                      Ref.update(state.counters, (current) => ({
                        ...current,
                        sent: current.sent + 1,
                      })),
                  }),
                ),
            }),
          { discard: true },
        )
      }),
  },
]

/**
 * Build the module's state and its stages together, acquiring the transport.
 *
 * `TransportPort` is acquired HERE, at registration time, which is the whole
 * reason kernel made `frameStages` an Effect. It is also why this repository is
 * the clearest illustration of `RRegister` being its own type parameter: unlike
 * mc-render's `InputService` and mc-sim's `PlayerService`, `TransportPort` is
 * NOT something this module provides. mx-multiplayer defines the Port and ships
 * only a loopback for tests; the real socket adapter is a platform layer
 * (`domain/transport.ts`). So a host must satisfy `RRegister` from outside,
 * while `ROut` stays `never`.
 */
export const makeMultiplayerStages: Effect.Effect<
  ReadonlyArray<StageRegistration>,
  never,
  TransportPort
> = Effect.gen(function* () {
  const transport = yield* TransportPort
  const state = yield* makeMultiplayerFrameState
  return multiplayerStages(state, transport)
})

/**
 * mx-multiplayer as a `GameModule` (plan.md §4.1).
 *
 *   ROut      = never          — this module provides no service
 *   E         = never
 *   RIn       = never          — nothing has to be given for that (empty) Layer
 *   RRegister = TransportPort  — but registering either stage needs a transport
 *
 * `layers` is `Layer.empty` and is expected to stay that way. Sending and
 * receiving are a Port this repository DEFINES; whoever owns the platform
 * provides it, and a Layer here would be this repository shipping a socket.
 */
export const multiplayerModule: GameModule<never, never, never, TransportPort> = {
  layers: Layer.empty,
  frameStages: makeMultiplayerStages,
}

/**
 * The module's stages together with the state they close over.
 *
 * `makeMultiplayerStages` deliberately does not expose the state — a consumer
 * that could reach into it could push a frame into the inbound seam without it
 * ever having crossed the wire, which is a test double masquerading as a
 * network. Previews and tests need it, so they get it here, explicitly, and the
 * name says what it is for.
 *
 * It runs IN a context and cannot bring its own transport, which is the same
 * discipline mc-render's `makeRenderStagesForPreview` documents: a
 * Layer-returning function in hand is an invitation to provide it separately,
 * and providing `Layer.effect` twice builds two services.
 */
export const makeMultiplayerStagesForPreview: Effect.Effect<
  {
    readonly state: MultiplayerFrameState
    readonly stages: ReadonlyArray<StageRegistration>
  },
  never,
  TransportPort
> = Effect.gen(function* () {
  const transport = yield* TransportPort
  const state = yield* makeMultiplayerFrameState
  return { state, stages: multiplayerStages(state, transport) }
})

/**
 * The capability-limited integration seam for a platform host.
 *
 * Unlike `makeMultiplayerStagesForPreview`, this does not expose the backing
 * `Ref`s. A host may observe and advance the connection lifecycle, enqueue
 * local messages, and drain messages that genuinely crossed the transport,
 * but it cannot replace an inbox or fabricate counters. Returned collections
 * are snapshots, so retaining one cannot mutate a later frame.
 */
export type MultiplayerHost = {
  /** The stages bound to the transport acquired when this host was built. */
  readonly stages: ReadonlyArray<StageRegistration>
  /** A module suitable for hosts that compose modules rather than raw stages. */
  readonly module: GameModule<never, never, never, never>
  /** Atomically take every message decoded by completed inbound stages. */
  readonly drainInbound: Effect.Effect<ReadonlyArray<NetworkMessage>>
  /** Append one local message for the next outbound stage. */
  readonly enqueueOutbound: (message: NetworkMessage) => Effect.Effect<void>
  /** Read an immutable snapshot of the current connection state. */
  readonly connectionSnapshot: Effect.Effect<ConnectionState>
  /** Advance the lifecycle, returning `undefined` without mutation when illegal. */
  readonly transitionConnection: (
    event: ConnectionEvent,
  ) => Effect.Effect<ConnectionState | undefined>
  /** Read an immutable snapshot of the accumulated frame counters. */
  readonly countersSnapshot: Effect.Effect<NetworkFrameCounters>
}

/**
 * Build the production host seam around exactly one transport and state set.
 *
 * Transport acquisition happens once. In particular, `module.frameStages`
 * returns the already-bound stages instead of rebuilding state or acquiring a
 * second transport, which keeps one socket paired with one inbox and outbox.
 */
export const makeMultiplayerHost: Effect.Effect<MultiplayerHost, never, TransportPort> =
  Effect.gen(function* () {
    const transport = yield* TransportPort
    const state = yield* makeMultiplayerFrameState
    const stages = multiplayerStages(state, transport)

    const drainInbound = Ref.getAndSet(state.inbound, []).pipe(
      Effect.map((messages) => [...messages]),
    )
    const enqueueOutbound = (message: NetworkMessage): Effect.Effect<void> =>
      Ref.update(state.outbox, (pending) => [...pending, message])
    const transitionConnection = (
      event: ConnectionEvent,
    ): Effect.Effect<ConnectionState | undefined> =>
      Ref.modify(state.connection, (current) => {
        const next = transition(current, event)
        return [next, next ?? current]
      })

    return {
      stages,
      module: {
        layers: Layer.empty,
        frameStages: Effect.succeed(stages),
      },
      drainInbound,
      enqueueOutbound,
      connectionSnapshot: Ref.get(state.connection),
      transitionConnection,
      countersSnapshot: Ref.get(state.counters),
    }
  })

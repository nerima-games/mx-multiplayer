/**
 * Mx-multiplayer's contribution to the frame (plan.md §4.1).
 *
 * ---------------------------------------------------------------------------
 * Read `stage-ids.ts` first
 * ---------------------------------------------------------------------------
 *
 * mc-compose owns the global frame skeleton. Its network phases place inbound
 * work before simulation and outbound work after authoritative simulation, so
 * this repository only declares the local dependency between its two stages.
 *
 * ---------------------------------------------------------------------------
 * What a stage in THIS repository is allowed to do
 * ---------------------------------------------------------------------------
 *
 * plan.md §3.14 confines mx-multiplayer to transport and protocol. So these two
 * stages move wire frames and the optional protocol-only C4 client cache:
 *
 *   - `multiplayer:inbound` takes whatever text arrived, decodes it, and puts
 *     ordinary messages where the seam into mc-sim will read them. With a C4
 *     client sync context, it validates and applies replicated snapshots and
 *     deltas, consumes transfer-control messages, and queues resync requests.
 *   - `multiplayer:outbound` takes whatever messages were handed to it, encodes
 *     them, and writes them — if the connection state permits.
 *
 * The C4 path handles protocol state only; it does not decide game rules. A
 * `BlockBreak` is a value that gets carried; what a broken block drops is
 * mx-gameplay's, and which of two players wins a contested pickup is mc-sim's
 * and mx-gameplay's (docs/responsibility.md §4,
 * DN-9). The reference implementation put first-come claim arbitration in
 * `packages/network/application/server-handlers.ts` and the consequence was that
 * changing an inventory rule meant editing the network layer.
 *
 * ---------------------------------------------------------------------------
 * The seam
 * ---------------------------------------------------------------------------
 *
 * "Apply a decoded message" means "write through a host/session adapter".
 * That adapter owns the projection to mc-sim and mx-gameplay; these `Ref`s keep
 * the transport boundary explicit for the preview and its contract tests.
 */
import {
  AuthoritativeClientState,
  type ClientSyncTransition,
  type SnapshotTransferFailure,
  SnapshotTransferReceiver,
} from '../domain/authoritative-sync.js'
import type {
  AuthoritativeResyncRequest,
  NetworkMessage,
} from '../domain/protocol.js'
import {
  type ConnectionEvent,
  type ConnectionState,
  canSend,
  initialConnectionState,
  transition,
} from '../domain/connection.js'
import { Effect, Layer, Queue, Ref, Result } from 'effect'
import type { GameModule, StageRegistration } from '@nerima-games/mc-kernel'
import { MULTIPLAYER_STAGE_IDS, UPSTREAM_STAGE_IDS } from './stage-ids.js'
import {
  type ReplicatedOwnerRegistry,
  decodeFrame,
  encodeFrame,
  inspectReplicatedFrameTag,
  wireFrameByteLength,
} from '../domain/codec.js'
import { TransportPort, type TransportService } from '../domain/transport.js'
import type { ProtocolError } from '../domain/errors.js'

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
type NetworkFrameCounters = {
  /** Frames decoded and handled by the inbound protocol stage. */
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
  /** Valid C4 frames that could not be applied and triggered a snapshot request. */
  readonly resyncRequested: number
}

export const NO_NETWORK_FRAMES: NetworkFrameCounters = {
  droppedWhileNotConnected: 0,
  malformed: 0,
  received: 0,
  resyncRequested: 0,
  sendFailed: 0,
  sent: 0,
  unencodable: 0,
  versionMismatched: 0,
}

/** Every counter field on `NetworkFrameCounters` advances by exactly one per event. */
const COUNTER_INCREMENT = 1

export type MultiplayerFrameState = {
  /**
   * The connection lifecycle, as `domain/connection.ts` models it.
   *
   * Held rather than derived: `canSend` is a question about a STATE. It is
   * advanced by `transition`, by whoever owns the socket, and read here. Socket
   * adapters can expose the same live state through `connectionGatedTransport`.
   */
  readonly connection: Ref.Ref<ConnectionState>
  /**
   * Messages waiting to go out, in the order they were offered.
   *
   * Filled by the host/session adapter with projected command messages. The
   * stage still does not interpret them: projection is not a game rule.
   */
  readonly outbox: Ref.Ref<ReadonlyArray<NetworkMessage>>
  /**
   * Messages ready for the host/session adapter to apply to the game world.
   *
   * This is the transport seam. With C4 sync enabled, validated replication
   * messages reach the host only after the protocol cache accepts them; the
   * host/session adapter still applies game rules through mc-sim and mx-gameplay.
   */
  readonly inbound: Ref.Ref<ReadonlyArray<NetworkMessage>>
  readonly counters: Ref.Ref<NetworkFrameCounters>
}

/** State and owner schemas needed to apply the C4 client replication stream. */
export type MultiplayerClientSync = Readonly<{
  readonly owners: ReplicatedOwnerRegistry
  readonly state: AuthoritativeClientState
  readonly transfers: SnapshotTransferReceiver
}>

const appendInbound = (
  state: MultiplayerFrameState,
  messages: ReadonlyArray<NetworkMessage>,
): Effect.Effect<void> => Ref.update(state.inbound, (pending) => [...pending, ...messages])

const enqueueResync = (
  state: MultiplayerFrameState,
  request: AuthoritativeResyncRequest,
): Effect.Effect<void> =>
  Ref.update(state.outbox, (pending) => [...pending, request]).pipe(
    Effect.andThen(
      Ref.update(state.counters, (current) => ({
        ...current,
        resyncRequested: current.resyncRequested + COUNTER_INCREMENT,
      })),
    ),
  )

const syncRejection = (syncTransition: ClientSyncTransition): AuthoritativeResyncRequest | undefined => {
  if (syncTransition.accepted) {
    return undefined
  }
  return syncTransition.request
}

const resyncForConnection = (
  state: MultiplayerFrameState,
  sync: MultiplayerClientSync,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const connection = yield* Ref.get(state.connection)
    if (connection._tag !== 'Connected') {
      return
    }
    const revision = sync.state.world(connection.world)?.revision
    if (revision === undefined) {
      yield* enqueueResync(state, { _tag: 'AuthoritativeResyncRequest', world: connection.world })
      return
    }
    yield* enqueueResync(state, {
      _tag: 'AuthoritativeResyncRequest',
      lastKnownRevision: revision,
      world: connection.world,
    })
  })

const resyncForTransferFailure = (
  state: MultiplayerFrameState,
  sync: MultiplayerClientSync,
  failure: SnapshotTransferFailure,
): Effect.Effect<void> => {
  if (failure.request === undefined) {
    return resyncForConnection(state, sync)
  }
  return enqueueResync(state, failure.request)
}

type C4ApplyContext = Readonly<{
  state: MultiplayerFrameState,
  sync: MultiplayerClientSync,
  frame: string,
}>

const applySnapshotMessage = (
  context: C4ApplyContext,
  message: Extract<NetworkMessage, { readonly _tag: 'ReplicatedWorldSnapshot' }>,
): Effect.Effect<void> => {
  const syncTransition = context.sync.state.applySnapshot(message)
  const request = syncRejection(syncTransition)
  if (request !== undefined) {
    return enqueueResync(context.state, request)
  }
  return appendInbound(context.state, [message])
}

const queueDeltaForTransfer = (
  context: C4ApplyContext,
  message: Extract<NetworkMessage, { readonly _tag: 'ReplicatedWorldDelta' }>,
): Effect.Effect<void> | undefined => {
  if (!context.sync.transfers.isReceiving) {
    return undefined
  }
  const queued = context.sync.transfers.queueDelta(message, wireFrameByteLength(context.frame))
  if (!queued.accepted) {
    return resyncForTransferFailure(context.state, context.sync, queued)
  }
  return Effect.void
}

const applyDeltaMessage = (
  context: C4ApplyContext,
  message: Extract<NetworkMessage, { readonly _tag: 'ReplicatedWorldDelta' }>,
): Effect.Effect<void> => {
  const queueResult = queueDeltaForTransfer(context, message)
  if (queueResult !== undefined) {
    return queueResult
  }
  const syncTransition = context.sync.state.applyDelta(message)
  const request = syncRejection(syncTransition)
  if (request !== undefined) {
    return enqueueResync(context.state, request)
  }
  return appendInbound(context.state, [message])
}

const beginSnapshotTransfer = (
  context: C4ApplyContext,
  message: Extract<NetworkMessage, { readonly _tag: 'ReplicatedWorldSnapshotStart' }>,
): Effect.Effect<void> => {
  const revision = context.sync.state.world(message.world)?.revision
  const result = context.sync.transfers.begin(message, revision)
  if (result.accepted) {
    return Effect.void
  }
  return resyncForTransferFailure(context.state, context.sync, result)
}

const appendSnapshotTransferChunk = (
  context: C4ApplyContext,
  message: Extract<NetworkMessage, { readonly _tag: 'ReplicatedWorldSnapshotChunk' }>,
): Effect.Effect<void> => {
  const result = context.sync.transfers.append(message)
  if (result.accepted) {
    return Effect.void
  }
  return resyncForTransferFailure(context.state, context.sync, result)
}

const finishSnapshotTransfer = (
  context: C4ApplyContext,
  message: Extract<NetworkMessage, { readonly _tag: 'ReplicatedWorldSnapshotEnd' }>,
): Effect.Effect<void> => {
  const result = context.sync.transfers.finish(message)
  if (!result.accepted) {
    return resyncForTransferFailure(context.state, context.sync, result)
  }
  const syncTransition = context.sync.state.applyTransfer(result.completion, context.sync.owners)
  if (!syncTransition.accepted) {
    return enqueueResync(context.state, syncTransition.request)
  }
  return appendInbound(context.state, syncTransition.appliedMessages)
}

const applyC4Message = (
  context: C4ApplyContext,
  message: NetworkMessage,
): Effect.Effect<void> => {
  switch (message._tag) {
    case 'ReplicatedWorldSnapshot':
      return applySnapshotMessage(context, message)
    case 'ReplicatedWorldDelta':
      return applyDeltaMessage(context, message)
    case 'ReplicatedWorldSnapshotStart':
      return beginSnapshotTransfer(context, message)
    case 'ReplicatedWorldSnapshotChunk':
      return appendSnapshotTransferChunk(context, message)
    case 'ReplicatedWorldSnapshotEnd':
      return finishSnapshotTransfer(context, message)
    default:
      return appendInbound(context.state, [message])
  }
}

type DecodedFrameContext = Readonly<{
  readonly sync: MultiplayerClientSync | undefined
  readonly frame: string
  readonly message: NetworkMessage
}>

const applyDecodedFrame = (
  state: MultiplayerFrameState,
  decoded: DecodedFrameContext,
): Effect.Effect<void> => {
  if (decoded.sync === undefined) {
    return appendInbound(state, [decoded.message])
  }
  return applyC4Message({ frame: decoded.frame, state, sync: decoded.sync }, decoded.message)
}

const handleDecodedFrame = (
  state: MultiplayerFrameState,
  decoded: DecodedFrameContext,
): Effect.Effect<void> =>
  Ref.update(state.counters, (current) => ({
    ...current,
    received: current.received + COUNTER_INCREMENT,
  })).pipe(Effect.andThen(applyDecodedFrame(state, decoded)))

const resyncMalformedC4Frame = (
  state: MultiplayerFrameState,
  sync: MultiplayerClientSync | undefined,
  frame: string,
): Effect.Effect<void> => {
  if (sync === undefined) {
    return Effect.void
  }
  return Result.match(inspectReplicatedFrameTag(frame), {
    onFailure: () => Effect.void,
    onSuccess: (tag) => {
      if (tag === undefined) {
        return Effect.void
      }
      sync.transfers.discard()
      return resyncForConnection(state, sync)
    },
  })
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

    return { connection, counters, inbound, outbox }
  },
)

const countProtocolFailure = (
  state: MultiplayerFrameState,
  error: ProtocolError,
): Effect.Effect<void> =>
  Ref.update(state.counters, (current) => {
    if (error.reason === 'unsupported-protocol-version') {
      return { ...current, versionMismatched: current.versionMismatched + COUNTER_INCREMENT }
    }
    return { ...current, malformed: current.malformed + COUNTER_INCREMENT }
  })

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
  sync?: MultiplayerClientSync,
): ReadonlyArray<StageRegistration> => [
  {
    id: MULTIPLAYER_STAGE_IDS.inbound,
    // No `after`. Its requirement is to run BEFORE `sim:physics`, and the
    // Contract has no `before` — see `stage-ids.ts`. This is `render:input`'s
    // Situation exactly, and `render:input` declares no `after` either.
    run: () =>
      Effect.gen(function* () {
        // `clear`, not `takeAll`: `takeAll` blocks until a frame arrives, and a
        // Stage that blocks stops the frame. Draining whatever is there is also
        // What makes the queue's back-pressure meaningful — the consumer keeps
        // Up by definition, once per frame.
        //
        // Everything that had arrived by the time this frame started is applied
        // In this frame. A frame that lands mid-drain is taken next frame, which
        // Is the same "belongs to the frame that saw it" rule mc-render's
        // `render:input` applies to input edges.
        const frames = yield* Queue.clear(transport.inbound)

        yield* Effect.forEach(
          frames,
          (frame) =>
            Result.match(decodeFrame(frame, sync?.owners), {
              // A frame this build cannot read is DROPPED, not retried:
              // `ProtocolError` means the bytes arrived intact and do not mean
              // What this build thinks they mean, so a resend produces the same
              // Bytes (DN-2). What the counter separates is whether the right
              // Response is to drop the frame or the peer (DN-1).
              onFailure: (error) => countProtocolFailure(state, error).pipe(
                Effect.andThen(resyncMalformedC4Frame(state, sync, frame)),
              ),
              // The transport seam. The host/session adapter drains this queue
              // And applies the message through mc-sim and mx-gameplay.
              onSuccess: (message) => handleDecodedFrame(state, { frame, message, sync }),
            }),
          { discard: true },
        )
      }),
  },
  {
    after: [UPSTREAM_STAGE_IDS.simPhysics],
    id: MULTIPLAYER_STAGE_IDS.outbound,
    // Publish the position the simulation RESOLVED this frame. Publishing the
    // Pre-integration one puts every peer's view of this player a frame behind,
    // Which reads as network lag rather than as a bug — mc-render's argument for
    // `render:camera-mirror`, pointed outwards.
    run: () =>
      Effect.gen(function* () {
        const connection = yield* Ref.get(state.connection)

        // Drained unconditionally, and that is the drop policy rather than an
        // Oversight.
        //
        // A message in this outbox describes THIS frame. Holding it across a
        // Disconnect means replaying a stale world on reconnect — every position
        // The player passed through, in order, as fast as the socket allows —
        // And mx-multiplayer cannot tell a stale message from a durable one
        // Without reading it, which plan.md §3.14 forbids. So the policy has to
        // Be content-independent, and of the two content-independent policies
        // "drop" is the one that cannot produce a replay. Anything that must
        // Survive a disconnect is re-offered by its owner after the handshake,
        // Which is the only party that knows it must.
        //
        // Same argument as `application/game-loop.ts`'s dropping frame queue in
        // Mc-sim: under adverse conditions, lose work rather than accumulate a
        // Backlog the world then replays in fast-forward.
        const pending = yield* Ref.getAndSet(state.outbox, [])

        // Avoid queueing work while disconnected even when the supplied
        // Transport also applies the Connected-only boundary gate.
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
              Result.match(encodeFrame(message, sync?.owners), {
              // A message that will not encode is a LOCAL bug — a branded
              // Invariant was violated on this side — so there is nothing to
              // Resend and nobody to blame for it at the far end. Counted apart
              // From `sendFailed` for that reason.
              onFailure: () =>
                Ref.update(state.counters, (current) => ({
                  ...current,
                  unencodable: current.unencodable + COUNTER_INCREMENT,
                })),
              onSuccess: (frame) =>
                transport.send(frame).pipe(
                  Effect.matchEffect({
                    // `TransportError`: the bytes did not get through and the
                    // Message is still valid. Retrying is the right response and
                    // It belongs to whoever owns the socket's `Schedule` (DN-8
                    // Keeps retry policy out of this repository's domain), so
                    // The stage records it and moves on rather than blocking the
                    // Frame on a socket.
                    onFailure: () =>
                      Ref.update(state.counters, (current) => ({
                        ...current,
                        sendFailed: current.sendFailed + COUNTER_INCREMENT,
                      })),
                    onSuccess: () =>
                      Ref.update(state.counters, (current) => ({
                        ...current,
                        sent: current.sent + COUNTER_INCREMENT,
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
 * Mx-multiplayer as a `GameModule` (plan.md §4.1).
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
  frameStages: makeMultiplayerStages,
  layers: Layer.empty,
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
  return { stages: multiplayerStages(state, transport), state }
})

/** Build preview stages with C4 client application and snapshot-transfer handling enabled. */
export const makeMultiplayerStagesForClientPreview = (
  sync: MultiplayerClientSync,
): Effect.Effect<
  {
    readonly state: MultiplayerFrameState
    readonly stages: ReadonlyArray<StageRegistration>
  },
  never,
  TransportPort
> => Effect.gen(function* () {
  const transport = yield* TransportPort
  const state = yield* makeMultiplayerFrameState
  return { stages: multiplayerStages(state, transport, sync), state }
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
  /** Atomically take every message handed to the host/session adapter. */
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
const buildMultiplayerHost = (
  sync?: MultiplayerClientSync,
): Effect.Effect<MultiplayerHost, never, TransportPort> =>
  Effect.gen(function* () {
    const transport = yield* TransportPort
    const state = yield* makeMultiplayerFrameState
    const stages = multiplayerStages(state, transport, sync)

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
      connectionSnapshot: Ref.get(state.connection),
      countersSnapshot: Ref.get(state.counters),
      drainInbound,
      enqueueOutbound,
      module: {
        frameStages: Effect.succeed(stages),
        layers: Layer.empty,
      },
      stages,
      transitionConnection,
    }
  })

export const makeMultiplayerHost: Effect.Effect<MultiplayerHost, never, TransportPort> =
  buildMultiplayerHost()

/** Build a host whose frame stages validate and apply the C4 client replication stream. */
export const makeMultiplayerHostWithClientSync = (
  sync: MultiplayerClientSync,
): Effect.Effect<MultiplayerHost, never, TransportPort> =>
  buildMultiplayerHost(sync)

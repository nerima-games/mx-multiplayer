/**
 * Named regression tests for the frame contract.
 *
 * Three things are being pinned, and none of them is visible to `tsc` or to
 * ordinary typechecking:
 *
 *   - plan.md §2.3-1 / §2.3-3 — what is declared. Both rules are violated with
 *     STRINGS rather than with imports, so only a test can see it.
 *   - the stages move frames and do not read them. plan.md §3.14 confines this
 *     repository to transport and protocol, and DN-9 records what the reference
 *     implementation lost by not holding that line.
 *   - the stage applies the same `canSend` invariant as the public transport
 *     decorator, dropping queued gameplay messages before encoding them.
 */
import { describe, expect, it } from '@effect/vitest'
import { Effect, Result, Queue, Ref, Schema } from 'effect'
import {
  createReplicatedOwnerRegistry,
  decodeFrame,
  encodeFrame,
  encodeFrameAsVersion,
  ReplicatedOwnerRegistryLimitsSchema,
  type ReplicatedOwnerRegistryLimits,
} from '../src/domain/codec'
import { AuthoritativeClientState, sha256Hex, SnapshotTransferReceiver } from '../src/domain/authoritative-sync'
import { type ConnectionState, canSend } from '../src/domain/connection'
import {
  DeltaTimeSecs,
  EpochMillis,
  FixedClockLayer,
  type GameModule,
  MonotonicTimeSecs,
  StageId,
  type StageRegistration,
  WorldRevisionSchema,
} from '@nerima-games/mc-kernel'
import {
  BlockPlace,
  Base64Schema,
  Chat,
  type NetworkMessage,
  PROTOCOL_VERSION,
  PlayerId,
  PlayerMove,
  TransferIdSchema,
  WorldId,
} from '../src/domain/protocol'
import {
  TransportPort,
  type TransportService,
  disconnectedTransport,
  makeLoopbackPair,
} from '../src/domain/transport'
import {
  type MultiplayerFrameState,
  NO_NETWORK_FRAMES,
  makeMultiplayerFrameState,
  makeMultiplayerHost,
  makeMultiplayerHostWithClientSync,
  makeMultiplayerStages,
  makeMultiplayerStagesForClientPreview,
  makeMultiplayerStagesForPreview,
  multiplayerModule,
  multiplayerStages,
  type MultiplayerClientSync,
} from '../src/stages/registration'
import {
  EXPERIENCE_MODULE_STAGE_PREFIXES,
  MULTIPLAYER_STAGE_IDS,
  OWN_STAGE_PREFIX,
  UPSTREAM_STAGE_IDS,
} from '../src/stages/stage-ids'

const MAXIMUM_FRAME_JSON_DEPTH = 13
const MAXIMUM_FRAME_COLLECTION_ITEMS = 31_149

const EMPTY_C4_OWNER_LIMITS: ReplicatedOwnerRegistryLimits = Schema.decodeUnknownSync(ReplicatedOwnerRegistryLimitsSchema)({
  maxRegisteredOwners: 0,
  maxDeltaBlockChanges: 256,
  maxSnapshotBlockReads: MAXIMUM_FRAME_COLLECTION_ITEMS,
  maxDepth: MAXIMUM_FRAME_JSON_DEPTH,
  maxCollectionItems: MAXIMUM_FRAME_COLLECTION_ITEMS,
  maxDeltaFrameBytes: 1_048_576,
  maxSnapshotFrameBytes: 8_388_608,
  ownerStates: [],
})

const ZERO_DT = DeltaTimeSecs(0)
const ONE_FRAME = DeltaTimeSecs(1 / 60)

const alice = PlayerId.make('alice')

const chat: NetworkMessage = Chat.make({ player: alice, text: 'hello' })
const move: NetworkMessage = PlayerMove.make({
  at: { x: 1, y: 2, z: 3 },
  facing: { pitchRadians: -0.25, yawRadians: 0.5 },
  player: alice,
})

const connected: ConnectionState = {
  _tag: 'Connected',
  player: alice,
  world: WorldId.make('overworld'),
}

const makeClientSync = (maxQueuedDeltaCount = 8): MultiplayerClientSync => ({
  owners: Result.getOrThrow(createReplicatedOwnerRegistry([], EMPTY_C4_OWNER_LIMITS)),
  state: new AuthoritativeClientState(),
  transfers: Result.getOrThrow(SnapshotTransferReceiver.make({
    maxChunkBytes: 4096,
    maxChunkCount: 64,
    maxQueuedDeltaBytes: 8192,
    maxQueuedDeltaCount,
    maxTotalBytes: 65536,
  })),
})

const snapshotForRevision = (revision: number): NetworkMessage => ({
  _tag: 'ReplicatedWorldSnapshot',
  blocks: [],
  owners: [],
  revision: Schema.decodeUnknownSync(WorldRevisionSchema)(revision),
  world: connected.world,
})

const deltaForRevision = (revision: number): NetworkMessage => ({
  _tag: 'ReplicatedWorldDelta',
  blockChanges: [],
  changes: [],
  revision: Schema.decodeUnknownSync(WorldRevisionSchema)(revision),
  world: connected.world,
})

const encodeForSync = (message: NetworkMessage, sync: MultiplayerClientSync): string =>
  Result.getOrThrow(encodeFrame(message, sync.owners))

const snapshotTransferFor = (sync: MultiplayerClientSync, revision: number): ReadonlyArray<NetworkMessage> => {
  const snapshot = snapshotForRevision(revision)
  const snapshotFrame = encodeForSync(snapshot, sync)
  const bytes = Buffer.from(snapshotFrame, 'utf8')
  const transferId = Schema.decodeUnknownSync(TransferIdSchema)(`transfer-${revision}`)
  return [
    {
      _tag: 'ReplicatedWorldSnapshotStart',
      chunkCount: 1,
      revision: Schema.decodeUnknownSync(WorldRevisionSchema)(revision),
      sha256: Result.getOrThrow(sha256Hex(bytes)),
      totalBytes: bytes.length,
      transferId,
      world: connected.world,
    },
    {
      _tag: 'ReplicatedWorldSnapshotChunk',
      data: Schema.decodeUnknownSync(Base64Schema)(bytes.toString('base64')),
      index: 0,
      transferId,
    },
    { _tag: 'ReplicatedWorldSnapshotEnd', transferId },
  ]
}

const sendMessages = (
  peer: TransportService,
  messages: ReadonlyArray<NetworkMessage>,
  sync: MultiplayerClientSync,
) =>
  Effect.forEach(messages, (message) => peer.send(encodeForSync(message, sync)), { discard: true })

/**
 * A registered pair of stages plus both ends of the wire.
 *
 * `left` is the side the stages are registered against; `peer` is the far end,
 * used to put frames on the wire and to read what came off it.
 */
const registered = Effect.gen(function* () {
  const [left, peer] = yield* makeLoopbackPair
  const { state, stages } = yield* makeMultiplayerStagesForPreview.pipe(
    Effect.provideService(TransportPort, left),
  )
  const byId = new Map(stages.map((stage) => [stage.id, stage]))
  return {
    inbound: byId.get(MULTIPLAYER_STAGE_IDS.inbound),
    outbound: byId.get(MULTIPLAYER_STAGE_IDS.outbound),
    peer,
    stages,
    state,
  }
})

// `StageRegistration.run` is declared against kernel's `FrameServices` (=
// `ClockPort`), even though neither stage in this repository reads a clock
// (DN-3 bans one outright). Discharged here, once, so every call site below
// stays untyped for it.
const TEST_CLOCK = FixedClockLayer({
  monotonicSecs: MonotonicTimeSecs(0),
  wallClockEpochMillis: EpochMillis(0),
})

const runStage = (stage: StageRegistration | undefined, dt = ONE_FRAME): Effect.Effect<void> =>
  (stage?.run(dt) ?? Effect.void).pipe(Effect.provide(TEST_CLOCK))

const drainPeer = (peer: TransportService): Effect.Effect<ReadonlyArray<string>> =>
  Effect.map(Queue.clear(peer.inbound), (frames) => Array.from(frames))

const countersOf = (state: MultiplayerFrameState) => Ref.get(state.counters)

const allAfterEdges = (stages: ReadonlyArray<StageRegistration>): ReadonlyArray<string> =>
  stages.flatMap((stage) => [...(stage.after ?? [])])

describe('§2.3-1 zero edges between experience modules', () => {
  it.effect(
    'REGRESSION: no `after` edge names another experience module, even though remote state feeds gameplay and the HUD',
    () =>
      Effect.gen(function* () {
        const { stages } = yield* registered
        const foreign = allAfterEdges(stages).filter((edge) =>
          EXPERIENCE_MODULE_STAGE_PREFIXES.some(
            (prefix) => prefix !== OWN_STAGE_PREFIX && edge.startsWith(prefix),
          ),
        )

        // A peer's `BlockBreak` ends up changing what mx-gameplay simulates and
        // What mx-ui draws, so an edge to `gameplay:interactions` or
        // `ui:hud-sync` would read as obviously correct. It would also pass
        // a typecheck — it is a string — while coupling this repository's
        // Frame position to a sibling's existence. §2.3-1 forbids it and the
        // Total order is mc-compose's (§2.3-3).
        expect(foreign).toStrictEqual([])
      }),
  )

  it.effect('REGRESSION: every declared upstream stage belongs to a foundation repository', () =>
    Effect.sync(() => {
      for (const id of Object.values(UPSTREAM_STAGE_IDS)) {
        const isSibling = EXPERIENCE_MODULE_STAGE_PREFIXES.some(
          (prefix) => prefix !== OWN_STAGE_PREFIX && id.startsWith(prefix),
        )
        expect(isSibling).toBe(false)
      }
      // Mc-sim is this repository's one declared parent (plan.md §2.1), so it is
      // The only repository whose stages may legally appear here at all.
      expect(Object.values(UPSTREAM_STAGE_IDS)).toStrictEqual([StageId('sim:physics')])
    }),
  )
})

describe('§2.3-3 the total order belongs to mc-compose', () => {
  it.effect('registers `multiplayer:inbound` and `multiplayer:outbound`, with the edges argued for in stage-ids.ts', () =>
    Effect.gen(function* () {
      const { stages } = yield* registered
      const byId = new Map(stages.map((stage) => [stage.id, stage]))

      expect(stages.map((stage) => stage.id)).toStrictEqual([
        MULTIPLAYER_STAGE_IDS.inbound,
        MULTIPLAYER_STAGE_IDS.outbound,
      ])

      // `inbound` must run BEFORE `sim:physics`, and `StageRegistration` has no
      // `before`. So it declares nothing and its position is the skeleton's to
      // Give — `render:input`'s situation exactly. The property is ABSENT rather
      // Than `undefined`: `exactOptionalPropertyTypes` is on and mc-compose's
      // Roster manifest transcribes the distinction.
      const inbound = byId.get(MULTIPLAYER_STAGE_IDS.inbound)
      expect(Object.keys(inbound ?? {}).sort()).toStrictEqual(['id', 'run'])
      expect('after' in (inbound ?? {})).toBe(false)

      // `outbound` publishes the position the simulation resolved this frame.
      expect(byId.get(MULTIPLAYER_STAGE_IDS.outbound)?.after).toStrictEqual([
        UPSTREAM_STAGE_IDS.simPhysics,
      ])
    }),
  )

  it.effect('REGRESSION: the two stages declare no edge to EACH OTHER', () =>
    Effect.gen(function* () {
      const { stages } = yield* registered
      const ownEdges = allAfterEdges(stages).filter((edge) => edge.startsWith(OWN_STAGE_PREFIX))

      // They belong to different phases, so once mc-compose has phases for them
      // The skeleton chain orders them and an edge here would be redundant — and
      // A redundant edge is a claim about the global order (mx-gameplay's
      // Stages/stage-ids.ts:50-58). Neither stage's correctness depends on the
      // Other: they touch disjoint state.
      expect(ownEdges).toStrictEqual([])
    }),
  )

  it.effect('REGRESSION: a registration carries constraints and nothing else — no priority, no index', () =>
    Effect.gen(function* () {
      const { stages } = yield* registered
      for (const stage of stages) {
        for (const key of Object.keys(stage)) {
          expect(['id', 'after', 'run']).toContain(key)
        }
      }
    }),
  )

  it.effect('StageId rejects a blank id', () =>
    Effect.sync(() => {
      expect(() => StageId('  ')).toThrow()
      expect(StageId('multiplayer:inbound')).toBe('multiplayer:inbound')
    }),
  )

  it.effect('DeltaTimeSecs accepts zero and rejects a negative delta', () =>
    Effect.sync(() => {
      expect(() => DeltaTimeSecs(-1)).toThrow()
      expect(DeltaTimeSecs(0)).toBe(0)
    }),
  )

  it.effect('builds client-preview stages with the supplied sync state', () =>
    Effect.gen(function* () {
      const [transport] = yield* makeLoopbackPair
      const sync = makeClientSync()
      const preview = yield* makeMultiplayerStagesForClientPreview(sync).pipe(
        Effect.provideService(TransportPort, transport),
      )

      expect(preview.stages.map((stage) => stage.id)).toStrictEqual([
        MULTIPLAYER_STAGE_IDS.inbound,
        MULTIPLAYER_STAGE_IDS.outbound,
      ])
      expect(preview.state).not.toBe(sync.state)
    }),
  )
})

describe('multiplayer:inbound — decode, do not interpret', () => {
  it.effect('drains everything the transport had and hands the decoded messages to the seam', () =>
    Effect.gen(function* () {
      const { state, peer, inbound } = yield* registered

      for (const message of [chat, move]) {
        yield* Result.match(encodeFrame(message), {
          onFailure: () => Effect.void,
          onSuccess: (frame) => peer.send(frame),
        })
      }

      yield* runStage(inbound)

      // Value equality, not identity: the messages genuinely went to text and
      // Back through the codec, which is what makes a loopback a real test
      // Double rather than a pass-through (domain/transport.ts's header).
      expect(yield* Ref.get(state.inbound)).toStrictEqual([chat, move])
      expect((yield* countersOf(state)).received).toBe(2)
    }),
  )

  it.effect('REGRESSION: `clear`, not `take` — an empty queue must not block the frame', () =>
    Effect.gen(function* () {
      const { state, inbound } = yield* registered

      // If this stage used `Queue.take` the test would hang rather than fail,
      // Which is the worst way for a frame stage to be wrong: a blocked stage
      // Stops the whole frame and every later stage looks broken.
      yield* runStage(inbound, ZERO_DT)

      expect(yield* Ref.get(state.inbound)).toStrictEqual([])
      expect(yield* countersOf(state)).toStrictEqual(NO_NETWORK_FRAMES)
    }),
  )

  it.effect('REGRESSION: a malformed frame is dropped and counted, and does not take the good ones with it', () =>
    Effect.gen(function* () {
      const { state, peer, inbound } = yield* registered

      yield* peer.send('{not json')
      yield* Result.match(encodeFrame(chat), {
        onFailure: () => Effect.void,
        onSuccess: (frame) => peer.send(frame),
      })

      yield* runStage(inbound)

      const counters = yield* countersOf(state)
      expect(counters.malformed).toBe(1)
      expect(counters.received).toBe(1)
      expect(yield* Ref.get(state.inbound)).toStrictEqual([chat])
    }),
  )

  it.effect('REGRESSION: a version mismatch is counted APART from a malformed frame (DN-1)', () =>
    Effect.gen(function* () {
      const { state, peer, inbound } = yield* registered

      yield* Result.match(encodeFrameAsVersion(PROTOCOL_VERSION + 1, chat), {
        onFailure: () => Effect.void,
        onSuccess: (frame) => peer.send(frame),
      })

      yield* runStage(inbound)

      // The two need different handling — drop the frame vs drop the PEER and
      // Tell the user — so a single counter would make a rolling upgrade
      // Indistinguishable from corruption, which is the defect the versioned
      // Envelope exists to fix.
      const counters = yield* countersOf(state)
      expect(counters.versionMismatched).toBe(1)
      expect(counters.malformed).toBe(0)
      expect(yield* Ref.get(state.inbound)).toStrictEqual([])
    }),
  )

  it.effect('REGRESSION: a block name this build does not know reaches the seam untouched (DN-6)', () =>
    Effect.gen(function* () {
      const { state, peer, inbound } = yield* registered
      const fromNewerPeer: NetworkMessage = BlockPlace.make({
        at: { x: 0, y: 0, z: 0 },
        block: 'SCULK_SHRIEKER_FROM_A_NEWER_BUILD',
        player: alice,
      })

      yield* Result.match(encodeFrame(fromNewerPeer), {
        onFailure: () => Effect.void,
        onSuccess: (frame) => peer.send(frame),
      })
      yield* runStage(inbound)

      // "Your client is older than mine" must not become a parse error, and the
      // Stage must not be the thing that decides an unknown block is a problem —
      // That judgement belongs to whoever owns the block vocabulary. Carried
      // Verbatim is the whole behaviour.
      expect(yield* Ref.get(state.inbound)).toStrictEqual([fromNewerPeer])
    }),
  )

  it.effect('a C4 revision gap preserves the last applied view and queues a resync request', () =>
    Effect.gen(function* () {
      const [local, peer] = yield* makeLoopbackPair
      const state = yield* makeMultiplayerFrameState
      const sync: MultiplayerClientSync = {
        owners: Result.getOrThrow(createReplicatedOwnerRegistry([], EMPTY_C4_OWNER_LIMITS)),
        state: new AuthoritativeClientState(),
        transfers: Result.getOrThrow(SnapshotTransferReceiver.make({
          maxChunkBytes: 4096,
          maxChunkCount: 64,
          maxQueuedDeltaBytes: 8192,
          maxQueuedDeltaCount: 8,
          maxTotalBytes: 65536,
        })),
      }
      const stages = multiplayerStages(state, local, sync)
      const baseline = {
        _tag: 'ReplicatedWorldSnapshot',
        blocks: [],
        owners: [],
        revision: Schema.decodeUnknownSync(WorldRevisionSchema)(3),
        world: connected.world,
      } as const
      const gap = {
        _tag: 'ReplicatedWorldDelta',
        blockChanges: [],
        changes: [],
        revision: Schema.decodeUnknownSync(WorldRevisionSchema)(5),
        world: connected.world,
      } as const

      yield* Ref.set(state.connection, connected)
      for (const message of [baseline, gap]) {
        yield* peer.send(Result.getOrThrow(encodeFrame(message, sync.owners)))
      }
      yield* runStage(stages[0])

      expect(sync.state.world(connected.world)?.revision).toBe(baseline.revision)
      expect(yield* Ref.get(state.inbound)).toStrictEqual([baseline])
      expect(yield* Ref.get(state.outbox)).toStrictEqual([{
        _tag: 'AuthoritativeResyncRequest',
        lastKnownRevision: baseline.revision,
        world: connected.world,
      }])
      expect((yield* countersOf(state)).resyncRequested).toBe(1)
    }),
  )

  it.effect('a malformed C4 payload requests a fresh snapshot for the connected world', () =>
    Effect.gen(function* () {
      const [local, peer] = yield* makeLoopbackPair
      const state = yield* makeMultiplayerFrameState
      const sync: MultiplayerClientSync = {
        owners: Result.getOrThrow(createReplicatedOwnerRegistry([], EMPTY_C4_OWNER_LIMITS)),
        state: new AuthoritativeClientState(),
        transfers: Result.getOrThrow(SnapshotTransferReceiver.make({
          maxChunkBytes: 4096,
          maxChunkCount: 64,
          maxQueuedDeltaBytes: 8192,
          maxQueuedDeltaCount: 8,
          maxTotalBytes: 65536,
        })),
      }
      const stages = multiplayerStages(state, local, sync)

      yield* Ref.set(state.connection, connected)
      yield* peer.send('{"protocolVersion":10,"message":{"_tag":"ReplicatedWorldDelta","world":"overworld","revision":1,"changes":[]}}')
      yield* runStage(stages[0])

      expect(yield* Ref.get(state.inbound)).toStrictEqual([])
      expect(yield* Ref.get(state.outbox)).toStrictEqual([{
        _tag: 'AuthoritativeResyncRequest',
        world: connected.world,
      }])
      expect(yield* countersOf(state)).toMatchObject({ malformed: 1, resyncRequested: 1 })
    }),
  )

  it.effect('applies a valid snapshot and its next delta before exposing them to the host', () =>
    Effect.gen(function* () {
      const [local, peer] = yield* makeLoopbackPair
      const state = yield* makeMultiplayerFrameState
      const sync = makeClientSync()
      const stages = multiplayerStages(state, local, sync)
      const snapshot = snapshotForRevision(3)
      const delta = deltaForRevision(4)

      yield* Ref.set(state.connection, connected)
      yield* sendMessages(peer, [snapshot, delta], sync)
      yield* runStage(stages[0])

      expect(sync.state.world(connected.world)?.revision).toBe(Schema.decodeUnknownSync(WorldRevisionSchema)(4))
      expect(yield* Ref.get(state.inbound)).toStrictEqual([snapshot, delta])
      expect(yield* Ref.get(state.outbox)).toStrictEqual([])
    }),
  )

  it.effect('queues a live delta during transfer and applies the snapshot group atomically', () =>
    Effect.gen(function* () {
      const [local, peer] = yield* makeLoopbackPair
      const state = yield* makeMultiplayerFrameState
      const sync = makeClientSync()
      const stages = multiplayerStages(state, local, sync)
      const [start, chunk, end] = snapshotTransferFor(sync, 3)
      if (start === undefined || chunk === undefined || end === undefined) {
        throw new Error('snapshot transfer fixture did not contain all three frames')
      }
      const snapshot = snapshotForRevision(3)
      const delta = deltaForRevision(4)

      yield* Ref.set(state.connection, connected)
      yield* sendMessages(peer, [start, delta, chunk, end], sync)
      yield* runStage(stages[0])

      expect(sync.state.world(connected.world)?.revision).toBe(Schema.decodeUnknownSync(WorldRevisionSchema)(4))
      expect(yield* Ref.get(state.inbound)).toStrictEqual([snapshot, delta])
      expect(yield* Ref.get(state.outbox)).toStrictEqual([])
      expect(sync.transfers.isReceiving).toBe(false)
    }),
  )

  it.effect('rejects a stale snapshot without replacing the applied projection', () =>
    Effect.gen(function* () {
      const [local, peer] = yield* makeLoopbackPair
      const state = yield* makeMultiplayerFrameState
      const sync = makeClientSync()
      const stages = multiplayerStages(state, local, sync)
      const current = snapshotForRevision(3)
      const stale = snapshotForRevision(2)

      yield* Ref.set(state.connection, connected)
      yield* sendMessages(peer, [current, stale], sync)
      yield* runStage(stages[0])

      expect(sync.state.world(connected.world)?.revision).toBe(Schema.decodeUnknownSync(WorldRevisionSchema)(3))
      expect(yield* Ref.get(state.inbound)).toStrictEqual([current])
      expect(yield* Ref.get(state.outbox)).toStrictEqual([{
        _tag: 'AuthoritativeResyncRequest',
        lastKnownRevision: Schema.decodeUnknownSync(WorldRevisionSchema)(3),
        world: connected.world,
      }])
    }),
  )

  it.effect('requests resync when a delta exceeds the transfer queue bound', () =>
    Effect.gen(function* () {
      const [local, peer] = yield* makeLoopbackPair
      const state = yield* makeMultiplayerFrameState
      const sync = makeClientSync(0)
      const stages = multiplayerStages(state, local, sync)
      const [start] = snapshotTransferFor(sync, 3)
      if (start === undefined) {
        throw new Error('snapshot transfer fixture did not contain its start frame')
      }

      yield* Ref.set(state.connection, connected)
      yield* sendMessages(peer, [start, deltaForRevision(4)], sync)
      yield* runStage(stages[0])

      expect(sync.transfers.isReceiving).toBe(false)
      expect(yield* Ref.get(state.inbound)).toStrictEqual([])
      expect(yield* Ref.get(state.outbox)).toStrictEqual([{
        _tag: 'AuthoritativeResyncRequest',
        world: connected.world,
      }])
    }),
  )

  it.effect('does not request resync when an uncorrelated transfer end arrives while disconnected', () =>
    Effect.gen(function* () {
      const [local, peer] = yield* makeLoopbackPair
      const state = yield* makeMultiplayerFrameState
      const sync = makeClientSync()
      const stages = multiplayerStages(state, local, sync)
      const transfer = snapshotTransferFor(sync, 3)
      const end = transfer[2]
      if (end === undefined) {
        throw new Error('snapshot transfer fixture did not contain its end frame')
      }

      yield* peer.send(encodeForSync(end, sync))
      yield* runStage(stages[0])

      expect(yield* Ref.get(state.connection)).toStrictEqual({ _tag: 'Disconnected' })
      expect(yield* Ref.get(state.outbox)).toStrictEqual([])
      expect((yield* countersOf(state)).resyncRequested).toBe(0)
    }),
  )

  it.effect('discards an active transfer and requests the last applied revision after a malformed C4 frame', () =>
    Effect.gen(function* () {
      const [local, peer] = yield* makeLoopbackPair
      const state = yield* makeMultiplayerFrameState
      const sync = makeClientSync()
      const stages = multiplayerStages(state, local, sync)
      const baseline = snapshotForRevision(3)
      const [start] = snapshotTransferFor(sync, 4)
      if (start === undefined) {
        throw new Error('snapshot transfer fixture did not contain its start frame')
      }

      yield* Ref.set(state.connection, connected)
      yield* sendMessages(peer, [baseline, start], sync)
      yield* peer.send('{"protocolVersion":10,"message":{"_tag":"ReplicatedWorldDelta","world":"overworld","revision":4,"changes":[]}}')
      yield* runStage(stages[0])

      expect(sync.transfers.isReceiving).toBe(false)
      expect(sync.state.world(connected.world)?.revision).toBe(Schema.decodeUnknownSync(WorldRevisionSchema)(3))
      expect(yield* Ref.get(state.inbound)).toStrictEqual([baseline])
      expect(yield* Ref.get(state.outbox)).toStrictEqual([{
        _tag: 'AuthoritativeResyncRequest',
        lastKnownRevision: Schema.decodeUnknownSync(WorldRevisionSchema)(3),
        world: connected.world,
      }])
    }),
  )

  it.effect('drops malformed and unknown frames without scheduling a C4 resync', () =>
    Effect.gen(function* () {
      const [local, peer] = yield* makeLoopbackPair
      const state = yield* makeMultiplayerFrameState
      const sync = makeClientSync()
      const stages = multiplayerStages(state, local, sync)

      yield* Ref.set(state.connection, connected)
      yield* peer.send('{not json')
      yield* peer.send(JSON.stringify({ protocolVersion: PROTOCOL_VERSION, message: { _tag: 'FutureUnknown' } }))
      yield* runStage(stages[0])

      expect(yield* Ref.get(state.inbound)).toStrictEqual([])
      expect(yield* Ref.get(state.outbox)).toStrictEqual([])
      expect((yield* countersOf(state)).malformed).toBe(2)
    }),
  )

  it.effect('passes ordinary protocol messages through the client-sync stage', () =>
    Effect.gen(function* () {
      const [local, peer] = yield* makeLoopbackPair
      const state = yield* makeMultiplayerFrameState
      const sync = makeClientSync()
      const stages = multiplayerStages(state, local, sync)

      yield* sendMessages(peer, [chat], sync)
      yield* runStage(stages[0])

      expect(yield* Ref.get(state.inbound)).toStrictEqual([chat])
      expect(yield* Ref.get(state.outbox)).toStrictEqual([])
    }),
  )

  it.effect('rejects a stale transferred snapshot and keeps the current world projection', () =>
    Effect.gen(function* () {
      const [local, peer] = yield* makeLoopbackPair
      const state = yield* makeMultiplayerFrameState
      const sync = makeClientSync()
      const stages = multiplayerStages(state, local, sync)
      const baseline = snapshotForRevision(5)

      yield* Ref.set(state.connection, connected)
      yield* sendMessages(peer, [baseline, ...snapshotTransferFor(sync, 4)], sync)
      yield* runStage(stages[0])

      expect(sync.state.world(connected.world)?.revision).toBe(Schema.decodeUnknownSync(WorldRevisionSchema)(5))
      expect(yield* Ref.get(state.inbound)).toStrictEqual([baseline])
      expect(yield* Ref.get(state.outbox)).toStrictEqual([{
        _tag: 'AuthoritativeResyncRequest',
        lastKnownRevision: Schema.decodeUnknownSync(WorldRevisionSchema)(5),
        world: connected.world,
      }])
      expect(sync.transfers.isReceiving).toBe(false)
    }),
  )

  it.effect('rejects a second snapshot transfer start and requests a fresh snapshot', () =>
    Effect.gen(function* () {
      const [local, peer] = yield* makeLoopbackPair
      const state = yield* makeMultiplayerFrameState
      const sync = makeClientSync()
      const stages = multiplayerStages(state, local, sync)
      const [start] = snapshotTransferFor(sync, 3)
      if (start === undefined) {
        throw new Error('snapshot transfer fixture did not contain its start frame')
      }

      yield* Ref.set(state.connection, connected)
      yield* sendMessages(peer, [start, start], sync)
      yield* runStage(stages[0])

      expect(sync.transfers.isReceiving).toBe(false)
      expect(yield* Ref.get(state.outbox)).toStrictEqual([{
        _tag: 'AuthoritativeResyncRequest',
        world: connected.world,
      }])
      expect((yield* countersOf(state)).resyncRequested).toBe(1)
    }),
  )

  it.effect('rejects an out-of-order transfer chunk and requests a fresh snapshot', () =>
    Effect.gen(function* () {
      const [local, peer] = yield* makeLoopbackPair
      const state = yield* makeMultiplayerFrameState
      const sync = makeClientSync()
      const stages = multiplayerStages(state, local, sync)
      const [start, chunk] = snapshotTransferFor(sync, 3)
      if (start === undefined || chunk === undefined || chunk._tag !== 'ReplicatedWorldSnapshotChunk') {
        throw new Error('snapshot transfer fixture did not contain its first chunk')
      }
      const outOfOrderChunk: NetworkMessage = { ...chunk, index: 1 }

      yield* Ref.set(state.connection, connected)
      yield* sendMessages(peer, [start, outOfOrderChunk], sync)
      yield* runStage(stages[0])

      expect(sync.transfers.isReceiving).toBe(false)
      expect(yield* Ref.get(state.inbound)).toStrictEqual([])
      expect(yield* Ref.get(state.outbox)).toStrictEqual([{
        _tag: 'AuthoritativeResyncRequest',
        world: connected.world,
      }])
    }),
  )
})

describe('multiplayer:outbound — queue-level connection gate', () => {
  it.effect('sends the outbox when the connection is Connected, and the far end can decode it', () =>
    Effect.gen(function* () {
      const { state, peer, outbound } = yield* registered

      yield* Ref.set(state.connection, connected)
      yield* Ref.set(state.outbox, [chat, move])
      yield* runStage(outbound)

      const onTheWire = yield* drainPeer(peer)
      expect(onTheWire).toHaveLength(2)
      expect(onTheWire.map((frame) => decodeFrame(frame))).toStrictEqual([
        Result.succeed(chat),
        Result.succeed(move),
      ])
      expect((yield* countersOf(state)).sent).toBe(2)
      expect(yield* Ref.get(state.outbox)).toStrictEqual([])
    }),
  )

  it.effect(
    'does not drain a frame from Connecting — `canSend` is consulted before transport',
    () =>
      Effect.gen(function* () {
        const { state, peer, outbound } = yield* registered
        const connecting: ConnectionState = { _tag: 'Connecting', attempt: 1 }

        expect(canSend(connecting)).toBe(false)

        yield* Ref.set(state.connection, connecting)
        yield* Ref.set(state.outbox, [chat])
        yield* runStage(outbound)

        // The stage drops before encoding; adapters independently enforce the
        // Same invariant by providing `connectionGatedTransport` as the Port.
        expect(yield* drainPeer(peer)).toStrictEqual([])
        expect((yield* countersOf(state)).droppedWhileNotConnected).toBe(1)
      }),
  )

  it.effect('REGRESSION: nothing is sent from Closed either, and the default state sends nothing', () =>
    Effect.gen(function* () {
      const { state, peer, outbound } = yield* registered

      // `Disconnected` — the state a freshly-registered module is in.
      yield* Ref.set(state.outbox, [chat])
      yield* runStage(outbound)

      yield* Ref.set(state.connection, { _tag: 'Closed', reason: 'closed' })
      yield* Ref.set(state.outbox, [move])
      yield* runStage(outbound)

      expect(yield* drainPeer(peer)).toStrictEqual([])
      expect((yield* countersOf(state)).droppedWhileNotConnected).toBe(2)
    }),
  )

  it.effect(
    'REGRESSION: a message queued while disconnected is DROPPED, not replayed on the frame after reconnection',
    () =>
      Effect.gen(function* () {
        const { state, peer, outbound } = yield* registered

        yield* Ref.set(state.outbox, [move])
        yield* runStage(outbound) // Disconnected: the frame is discarded.

        yield* Ref.set(state.connection, connected)
        yield* runStage(outbound) // Connected, and the outbox is empty.

        // Holding it would replay a stale world: every position the player
        // Passed through, in order, as fast as the socket allows. This
        // Repository cannot tell a stale message from a durable one without
        // Reading it (plan.md §3.14), so the policy has to be
        // Content-independent — and of the two content-independent policies,
        // Only "drop" cannot produce a replay. Same argument as mc-sim's
        // Dropping frame queue.
        expect(yield* drainPeer(peer)).toStrictEqual([])
        expect((yield* countersOf(state)).sent).toBe(0)
      }),
  )

  it.effect('an empty outbox on a connected session sends nothing and fails nothing', () =>
    Effect.gen(function* () {
      const { state, peer, outbound } = yield* registered

      yield* Ref.set(state.connection, connected)
      yield* runStage(outbound, ZERO_DT)

      expect(yield* drainPeer(peer)).toStrictEqual([])
      expect(yield* countersOf(state)).toStrictEqual(NO_NETWORK_FRAMES)
    }),
  )

  it.effect('counts a message that fails to encode as unencodable, and does not send it', () =>
    Effect.gen(function* () {
      const { state, peer, outbound } = yield* registered
      // Deliberately corrupt a previously validated value to exercise the
      // sender-side codec failure path without a type assertion.
      const unencodable = PlayerMove.make({
        _tag: 'PlayerMove',
        at: { x: 0, y: 0, z: 0 },
        facing: { pitchRadians: 0, yawRadians: 0 },
        player: alice,
      })
      Object.assign(unencodable.at, { x: Number.NaN })

      yield* Ref.set(state.connection, connected)
      yield* Ref.set(state.outbox, [unencodable])
      yield* runStage(outbound)

      expect(yield* drainPeer(peer)).toStrictEqual([])
      expect((yield* countersOf(state)).unencodable).toBe(1)
    }),
  )

  it.effect('counts a transport-rejected send as sendFailed, distinct from unencodable', () =>
    Effect.gen(function* () {
      const state = yield* makeMultiplayerFrameState
      const transport = yield* disconnectedTransport
      const stages = multiplayerStages(state, transport)
      const outbound = stages.find((stage) => stage.id === MULTIPLAYER_STAGE_IDS.outbound)

      yield* Ref.set(state.connection, connected)
      yield* Ref.set(state.outbox, [chat])
      yield* runStage(outbound)

      expect((yield* countersOf(state)).sendFailed).toBe(1)
      expect((yield* countersOf(state)).sent).toBe(0)
    }),
  )
})

describe('the stages are re-entrant and hold nothing globally', () => {
  it.effect('each call to makeMultiplayerFrameState yields independent state', () =>
    Effect.gen(function* () {
      // `apps/preview-two-clients` runs two sessions in one process on purpose.
      // A shared outbox would not be a subtle bug — it would be one client
      // Sending the other's frames.
      const first = yield* makeMultiplayerFrameState
      const second = yield* makeMultiplayerFrameState

      yield* Ref.set(first.outbox, [chat])

      expect(yield* Ref.get(second.outbox)).toStrictEqual([])
      expect(yield* Ref.get(second.connection)).toStrictEqual({ _tag: 'Disconnected' })
    }),
  )

  it.effect('two registrations over one transport do not share a seam', () =>
    Effect.gen(function* () {
      const [left, peer] = yield* makeLoopbackPair
      const first = yield* makeMultiplayerStagesForPreview.pipe(
        Effect.provideService(TransportPort, left),
      )
      const second = yield* makeMultiplayerStagesForPreview.pipe(
        Effect.provideService(TransportPort, left),
      )

      yield* Result.match(encodeFrame(chat), {
        onFailure: () => Effect.void,
        onSuccess: (frame) => peer.send(frame),
      })
      yield* runStage(first.stages[0])

      // The first registration drained the queue, so the second sees nothing —
      // Which is the honest consequence of one transport and two consumers, and
      // Is why a host builds one module rather than two.
      yield* runStage(second.stages[0])

      expect(yield* Ref.get(first.state.inbound)).toStrictEqual([chat])
      expect(yield* Ref.get(second.state.inbound)).toStrictEqual([])
    }),
  )
})

describe('production host integration seam', () => {
  it.effect('builds the host with C4 state application enabled', () =>
    Effect.gen(function* () {
      const [local, peer] = yield* makeLoopbackPair
      const sync = makeClientSync()
      const host = yield* makeMultiplayerHostWithClientSync(sync).pipe(
        Effect.provideService(TransportPort, local),
      )
      const snapshot = snapshotForRevision(3)

      yield* peer.send(encodeForSync(snapshot, sync))
      const inbound = host.stages.find((stage) => stage.id === MULTIPLAYER_STAGE_IDS.inbound)
      yield* runStage(inbound)

      expect(sync.state.world(connected.world)?.revision).toBe(Schema.decodeUnknownSync(WorldRevisionSchema)(3))
      expect(yield* host.drainInbound).toStrictEqual([snapshot])
    }),
  )

  it('shares inbound state across separate Effect runtimes', () => {
    const [left, peer] = Effect.runSync(makeLoopbackPair)
    const host = Effect.runSync(makeMultiplayerHost.pipe(
      Effect.provideService(TransportPort, left),
    ))
    const frame = Result.getOrThrow(encodeFrame(chat))

    Effect.runSync(peer.send(frame))
    expect(Effect.runSync(host.drainInbound)).toStrictEqual([])

    const inbound = host.stages.find((stage) => stage.id === MULTIPLAYER_STAGE_IDS.inbound)
    Effect.runSync(runStage(inbound))

    expect(Effect.runSync(host.drainInbound)).toStrictEqual([chat])
    expect(Effect.runSync(host.drainInbound)).toStrictEqual([])
  })

  it.effect('drains only messages processed by the inbound stage, once', () =>
    Effect.gen(function* () {
      const [left, peer] = yield* makeLoopbackPair
      const host = yield* makeMultiplayerHost.pipe(
        Effect.provideService(TransportPort, left),
      )

      yield* Result.match(encodeFrame(chat), {
        onFailure: () => Effect.void,
        onSuccess: (frame) => peer.send(frame),
      })
      expect(yield* host.drainInbound).toStrictEqual([])

      const inbound = host.stages.find((stage) => stage.id === MULTIPLAYER_STAGE_IDS.inbound)
      yield* runStage(inbound)

      const snapshot = yield* host.drainInbound
      expect(snapshot).toStrictEqual([chat])
      expect(yield* host.drainInbound).toStrictEqual([])
    }),
  )

  it.effect('sends host-enqueued messages on the next outbound stage', () =>
    Effect.gen(function* () {
      const [left, peer] = yield* makeLoopbackPair
      const host = yield* makeMultiplayerHost.pipe(
        Effect.provideService(TransportPort, left),
      )

      expect(
        yield* host.transitionConnection({ _tag: 'ConnectRequested' }),
      ).toStrictEqual({ _tag: 'Connecting', attempt: 1 })
      expect(
        yield* host.transitionConnection({
          _tag: 'HandshakeSucceeded',
          player: alice,
          world: WorldId.make('overworld'),
        }),
      ).toStrictEqual(connected)
      expect(yield* host.connectionSnapshot).toStrictEqual(connected)

      yield* host.enqueueOutbound(chat)
      expect(yield* drainPeer(peer)).toStrictEqual([])

      const outbound = host.stages.find((stage) => stage.id === MULTIPLAYER_STAGE_IDS.outbound)
      yield* runStage(outbound)
      expect((yield* drainPeer(peer)).map((frame) => decodeFrame(frame))).toStrictEqual([
        Result.succeed(chat),
      ])
      expect((yield* host.countersSnapshot).sent).toBe(1)
    }),
  )

  it.effect('rejects an illegal lifecycle transition without changing the snapshot', () =>
    Effect.gen(function* () {
      const [left] = yield* makeLoopbackPair
      const host = yield* makeMultiplayerHost.pipe(
        Effect.provideService(TransportPort, left),
      )

      expect(yield* host.transitionConnection({ _tag: 'PeerClosed' })).toBeUndefined()
      expect(yield* host.connectionSnapshot).toStrictEqual({ _tag: 'Disconnected' })
    }),
  )

  it.effect('binds module.frameStages to the same stage instances and needs no second transport', () =>
    Effect.gen(function* () {
      const [left] = yield* makeLoopbackPair
      const host = yield* makeMultiplayerHost.pipe(
        Effect.provideService(TransportPort, left),
      )

      expect(yield* host.module.frameStages).toBe(host.stages)
    }),
  )
})

describe('mx-multiplayer is a real GameModule', () => {
  it.effect('REGRESSION: exports a GameModule whose RRegister is TransportPort and whose ROut is never', () =>
    Effect.gen(function* () {
      // The clearest case in the roster for `RRegister` being its own parameter:
      // Mc-render acquires a service it PROVIDES, this repository acquires one
      // It merely DEFINES. `ROut` stays `never` — a Layer here would be this
      // Repository shipping a socket.
      const module: GameModule<never, never, never, TransportPort> = multiplayerModule
      const [left] = yield* makeLoopbackPair

      const stages = yield* module.frameStages.pipe(Effect.provideService(TransportPort, left))

      expect(stages.map((stage) => stage.id)).toStrictEqual(Object.values(MULTIPLAYER_STAGE_IDS))
    }),
  )

  it.effect('its frameStages IS the registration Effect this file already exported, and is re-entrant', () =>
    Effect.gen(function* () {
      expect(multiplayerModule.frameStages).toBe(makeMultiplayerStages)

      const [left] = yield* makeLoopbackPair
      const first = yield* makeMultiplayerStages.pipe(Effect.provideService(TransportPort, left))
      const second = yield* makeMultiplayerStages.pipe(Effect.provideService(TransportPort, left))
      expect(first).not.toBe(second)
    }),
  )

  it.effect('multiplayerStages is callable directly with a transport, for a preview that owns one', () =>
    Effect.gen(function* () {
      const [left] = yield* makeLoopbackPair
      const state = yield* makeMultiplayerFrameState

      expect(multiplayerStages(state, left).map((stage) => stage.id)).toStrictEqual([
        MULTIPLAYER_STAGE_IDS.inbound,
        MULTIPLAYER_STAGE_IDS.outbound,
      ])
    }),
  )
})

/**
 * Named regression tests for the frame contract.
 *
 * Three things are being pinned, and none of them is visible to `tsc` or to
 * `pnpm check:deps`:
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
import { Effect, Either, Queue, Ref } from 'effect'
import { decodeFrame, encodeFrame, encodeFrameAsVersion } from '../src/domain/codec'
import { type ConnectionState, canSend } from '../src/domain/connection'
import {
  DeltaTimeSecs,
  type GameModule,
  StageId,
  type StageRegistration,
} from '../src/domain/frame-contract'
import {
  BlockPlace,
  Chat,
  type NetworkMessage,
  PROTOCOL_VERSION,
  PlayerId,
  PlayerMove,
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
  makeMultiplayerStages,
  makeMultiplayerStagesForPreview,
  multiplayerModule,
  multiplayerStages,
} from '../src/stages/registration'
import {
  EXPERIENCE_MODULE_STAGE_PREFIXES,
  MULTIPLAYER_STAGE_IDS,
  OWN_STAGE_PREFIX,
  UPSTREAM_STAGE_IDS,
} from '../src/stages/stage-ids'

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

const runStage = (stage: StageRegistration | undefined, dt = ONE_FRAME): Effect.Effect<void> =>
  stage?.run(dt) ?? Effect.void

const drainPeer = (peer: TransportService): Effect.Effect<ReadonlyArray<string>> =>
  Effect.map(Queue.takeAll(peer.inbound), (frames) => Array.from(frames))

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
        // `pnpm check:deps` — it is a string — while coupling this repository's
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
})

describe('multiplayer:inbound — decode, do not interpret', () => {
  it.effect('drains everything the transport had and hands the decoded messages to the seam', () =>
    Effect.gen(function* () {
      const { state, peer, inbound } = yield* registered

      for (const message of [chat, move]) {
        yield* Either.match(encodeFrame(message), {
          onLeft: () => Effect.void,
          onRight: (frame) => peer.send(frame),
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

  it.effect('REGRESSION: `takeAll`, not `take` — an empty queue must not block the frame', () =>
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
      yield* Either.match(encodeFrame(chat), {
        onLeft: () => Effect.void,
        onRight: (frame) => peer.send(frame),
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

      yield* Either.match(encodeFrameAsVersion(PROTOCOL_VERSION + 1, chat), {
        onLeft: () => Effect.void,
        onRight: (frame) => peer.send(frame),
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

      yield* Either.match(encodeFrame(fromNewerPeer), {
        onLeft: () => Effect.void,
        onRight: (frame) => peer.send(frame),
      })
      yield* runStage(inbound)

      // "Your client is older than mine" must not become a parse error, and the
      // Stage must not be the thing that decides an unknown block is a problem —
      // That judgement belongs to whoever owns the block vocabulary. Carried
      // Verbatim is the whole behaviour.
      expect(yield* Ref.get(state.inbound)).toStrictEqual([fromNewerPeer])
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
        Either.right(chat),
        Either.right(move),
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
      // A branded invariant violated locally (see codec.test.ts and
      // Preview-findings.test.ts's "an invalid value fails at the sender"):
      // `at.x` fails `Vec3`'s `finite()` refinement, so `encodeFrame` returns
      // `Left`. `as` bypasses the type system the same way a bug that produced
      // This value in production would.
      const unencodable = {
        _tag: 'PlayerMove',
        at: { x: Number.NaN, y: 0, z: 0 },
        facing: { pitchRadians: 0, yawRadians: 0 },
        player: alice,
      } as NetworkMessage

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

      yield* Either.match(encodeFrame(chat), {
        onLeft: () => Effect.void,
        onRight: (frame) => peer.send(frame),
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
  it('shares inbound state across separate Effect runtimes', () => {
    const [left, peer] = Effect.runSync(makeLoopbackPair)
    const host = Effect.runSync(makeMultiplayerHost.pipe(
      Effect.provideService(TransportPort, left),
    ))
    const frame = Either.getOrThrow(encodeFrame(chat))

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

      yield* Either.match(encodeFrame(chat), {
        onLeft: () => Effect.void,
        onRight: (frame) => peer.send(frame),
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
        Either.right(chat),
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

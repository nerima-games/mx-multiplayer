/**
 * The findings `apps/preview-two-clients --stats` produced, pinned.
 *
 * ---------------------------------------------------------------------------
 * Why these are here and not only in the report
 * ---------------------------------------------------------------------------
 *
 * `--stats` measures everything at run time and records no expected value,
 * which is deliberate: a finding that is fixed disappears from the report rather
 * than turning green. That is the right property for a search tool and the wrong
 * one for a record. A report has to be read to work; a test falls over on its
 * own.
 *
 * So every confirmed finding gets an assertion here. Two kinds live in this file
 * and the distinction is written into each test's name:
 *
 *   - `pins the current behaviour` — the defect is still present. The assertion
 *     describes what the code does today, so that fixing it makes this test fail
 *     and forces whoever fixes it to come here and invert it. Deleting the test
 *     instead is also fine; leaving it passing is not.
 *   - everything else — the property held when it was measured, and the test
 *     keeps it held.
 *
 * There is no `REGRESSION:` prefix anywhere in this file. `docs/testing.md` §4
 * ties that word to a named entry in `docs/design-notes.md`, i.e. to something
 * that happened in the reference implementation's production. None of these did:
 * they were found here, by running two of this repository's own peers against
 * each other and injecting faults.
 */
import { describe, expect, it } from '@effect/vitest'
import { Effect, Either, Queue } from 'effect'
import { decodeFrame, encodeFrame, encodeFrameAsVersion } from '../src/domain/codec'
import {
  canSend,
  initialConnectionState,
  runTransitions,
  transition,
  type ConnectionEvent,
  type ConnectionState,
} from '../src/domain/connection'
import {
  LoopbackTransportLayer,
  makeLoopbackPair,
  sendMessage,
} from '../src/domain/transport'
import { PROTOCOL_VERSION, PlayerId, WorldId, type NetworkMessage } from '../src/domain/protocol'

const alice = PlayerId.make('alice')
const overworld = WorldId.make('overworld')

const chat: NetworkMessage = { _tag: 'Chat', player: alice, text: 'hello' }
const ping: NetworkMessage = { _tag: 'Ping', nonce: 7 }

const reasonOf = (text: string): string => {
  const result = decodeFrame(text)
  return Either.isLeft(result) ? result.left.reason : 'accepted'
}

describe('M1 — the version is checked before the message shape', () => {
  // DN-1: 「バージョンはメッセージの外側に置く。内側に置くと、未知バージョンの
  // フレームを弾くためにまず『もう存在しないかもしれないメッセージ形状』を
  // パースする必要が生じるため」。`domain/protocol.ts:205-211` repeats it.
  //
  // `decodeFrame` decodes only this stable envelope first and deliberately
  // leaves `message` opaque. A supported version then enters the current
  // `NetworkMessage` decoder; an unsupported version never does.
  const fromTheFuture = (message: unknown): string =>
    JSON.stringify({ protocolVersion: PROTOCOL_VERSION + 1, message })

  it.effect('a v+1 frame carrying a new tag reads as an unsupported version', () =>
    Effect.sync(() => {
      // Exactly what a build one version ahead would put on the wire when it
      // adds a message. `docs/design-notes.md` lists `EntitySnapshot` among the
      // reference's 18 message types, so this is the likely first addition.
      expect(reasonOf(fromTheFuture({ _tag: 'EntitySnapshot', entities: [] }))).toBe(
        'unsupported-protocol-version',
      )
    }),
  )

  it.effect('a v+1 frame that renamed a field reads as an unsupported version', () =>
    Effect.sync(() => {
      expect(reasonOf(fromTheFuture({ _tag: 'Ping', requestId: 7 }))).toBe(
        'unsupported-protocol-version',
      )
    }),
  )

  it.effect('a v+1 frame that widened a field reads as an unsupported version', () =>
    Effect.sync(() => {
      // `WorldInfo.seed` is `int()` here. A newer build allowing a fractional
      // seed must still be identified as newer before this schema is applied.
      expect(reasonOf(fromTheFuture({ _tag: 'WorldInfo', world: 'overworld', seed: 1.5 }))).toBe(
        'unsupported-protocol-version',
      )
    }),
  )

  it.effect('also rejects a version bump whose message still has a known shape', () =>
    Effect.sync(() => {
      const knownShape = Either.getOrThrow(encodeFrameAsVersion(PROTOCOL_VERSION + 1, ping))
      expect(reasonOf(knownShape)).toBe('unsupported-protocol-version')
    }),
  )
})

describe('M2 — `Connecting.attempt` is a constant, not a counter', () => {
  // There are exactly two producers of `Connecting`, at `domain/connection.ts:80`
  // and `:116`, and both write the literal `1`. Nothing reads the incoming
  // state's attempt and nothing increments it.
  //
  // The field is exported and appears in `api-lock.md`, so mx-ui can render an
  // attempt counter against a value that never moves.
  //
  // DN-8 point 3 is right that the machine must hold no retry BUDGET — a budget
  // is a `Schedule` and belongs to the adapter. The ordinal of the attempt in
  // flight is a different thing, and the adapter cannot supply it, because the
  // machine overwrites it on the way in.
  it.effect('pins the current behaviour: seven attempts all report attempt 1', () =>
    Effect.sync(() => {
      const observed: Array<number> = []
      let state: ConnectionState = initialConnectionState

      const record = (): void => {
        if (state._tag === 'Connecting') {
          observed.push(state.attempt)
        }
      }

      state = transition(state, { _tag: 'ConnectRequested' }) ?? state
      record()
      for (let round = 0; round < 6; round += 1) {
        state = transition(state, { _tag: 'HandshakeFailed' }) ?? state
        state = transition(state, { _tag: 'RetryRequested' }) ?? state
        record()
      }

      expect(observed).toStrictEqual([1, 1, 1, 1, 1, 1, 1])
    }),
  )
})

describe('M3 — a settled connection rejects the events a real socket delivers next', () => {
  // `domain/connection.ts:16-21`: "a caller that gets `undefined` has found a bug
  // in its own logic". These three sequences contain no bug. A socket delivers
  // BOTH a write failure and, moments later, its own close event; a handshake
  // that times out locally is routinely followed by the peer's close arriving on
  // the wire; a user may press Disconnect twice.
  //
  // The preview reaches the first of these by arming `kill-transport` before the
  // handshake step:
  //
  //     pnpm preview --once --ascii --script --fault kill-transport --fault-at 1 --view machine
  //
  // and the machine view then shows five consecutive REJECTED rows for one dead
  // socket.
  //
  // This is a contract question rather than a wrong transition: either these
  // events are legal and idempotent once settled, or `undefined` needs a third
  // meaning ("already handled") and every adapter has to filter by state before
  // forwarding. Whichever is chosen, `domain/connection.ts`'s header currently
  // documents the other one.
  it.effect('pins the current behaviour: a close after a write failure is illegal', () =>
    Effect.sync(() => {
      const events: ReadonlyArray<ConnectionEvent> = [
        { _tag: 'ConnectRequested' },
        { _tag: 'TransportFailed', reason: 'send-failed' },
        { _tag: 'PeerClosed' },
      ]
      const { state, rejectedAt } = runTransitions(initialConnectionState, events)

      expect(rejectedAt).toBe(2)
      expect(state).toStrictEqual({ _tag: 'Closed', reason: 'send-failed' })
    }),
  )

  it.effect('pins the current behaviour: a peer close after a local handshake timeout is illegal', () =>
    Effect.sync(() => {
      const { rejectedAt } = runTransitions(initialConnectionState, [
        { _tag: 'ConnectRequested' },
        { _tag: 'HandshakeFailed' },
        { _tag: 'PeerClosed' },
      ])
      expect(rejectedAt).toBe(2)
    }),
  )

  it.effect('pins the current behaviour: pressing Disconnect twice is illegal', () =>
    Effect.sync(() => {
      const { rejectedAt } = runTransitions(initialConnectionState, [
        { _tag: 'ConnectRequested' },
        { _tag: 'HandshakeSucceeded', player: alice, world: overworld },
        { _tag: 'CloseRequested' },
        { _tag: 'CloseRequested' },
      ])
      expect(rejectedAt).toBe(3)
    }),
  )
})

describe('M4 — nothing enforces "frames may only be sent from Connected"', () => {
  // `domain/connection.ts:59` says the invariant is "Enforced by
  // `TransportPort`". `makeLoopbackPair` holds no `ConnectionState` and cannot
  // enforce anything; `sendMessage` (`domain/transport.ts:53-60`) encodes and
  // writes without consulting one. `disconnectedTransport` refuses every send
  // unconditionally, which proves the failure path is typed — a different
  // property.
  //
  // `canSend` is exported, expresses the invariant exactly, and is called
  // nowhere in the repository.
  it.effect('pins the current behaviour: a frame sent from Connecting is delivered anyway', () =>
    Effect.gen(function* () {
      const [client, server] = yield* makeLoopbackPair
      const connecting: ConnectionState = { _tag: 'Connecting', attempt: 1 }

      expect(canSend(connecting)).toBe(false)

      yield* sendMessage(chat).pipe(Effect.provide(LoopbackTransportLayer(client)))

      // The transport neither knew nor asked.
      expect(yield* Queue.size(server.inbound)).toBe(1)
    }),
  )

  it.effect('pins the current behaviour: a frame sent from Closed is delivered anyway', () =>
    Effect.gen(function* () {
      const [client, server] = yield* makeLoopbackPair
      const closed: ConnectionState = { _tag: 'Closed', reason: 'closed' }

      expect(canSend(closed)).toBe(false)

      yield* sendMessage(chat).pipe(Effect.provide(LoopbackTransportLayer(client)))
      const arrived = Array.from(yield* Queue.takeAll(server.inbound))

      expect(arrived).toHaveLength(1)
      expect(Either.isRight(decodeFrame(arrived[0] ?? ''))).toBe(true)
    }),
  )
})

describe('checks the preview kept after they passed', () => {
  // A check deleted once it goes green inspects the code exactly once. These two
  // came out of `--stats` and were worth keeping in the suite, not just in the
  // report.

  // The encode direction validates too. That is what makes DN-5's argument true
  // — "失敗するのは送信側の `encodeFrame` であり、原因が手元にある" — and it is a
  // property of `Schema.encodeEither`, not of the schema, so it deserves an
  // assertion of its own rather than being assumed by the round-trip tests.
  it.effect('an invalid value fails at the sender, where the originating code still is', () =>
    Effect.sync(() => {
      const rejected = (message: NetworkMessage): string => {
        const result = encodeFrame(message)
        return Either.isLeft(result) ? result.left.reason : 'ENCODED'
      }

      expect(
        rejected({
          _tag: 'PlayerMove',
          player: alice,
          at: { x: Number.NaN, y: 0, z: 0 },
          facing: { yawRadians: 0, pitchRadians: 0 },
        }),
      ).toBe('unencodable-message')

      expect(
        rejected({
          _tag: 'PlayerMove',
          player: alice,
          at: { x: 0, y: 0, z: 0 },
          facing: { yawRadians: 0, pitchRadians: 3.2 },
        }),
      ).toBe('unencodable-message')

      expect(rejected({ _tag: 'Chat', player: alice, text: 'x'.repeat(300) })).toBe('unencodable-message')
      expect(rejected({ _tag: 'BlockBreak', player: alice, at: { x: 0.5, y: 1, z: 2 } })).toBe(
        'unencodable-message',
      )
    }),
  )

  // DN-3's missing test, which `docs/testing.md` §7 parks behind "メッセージ集合の
  // 確定". It does not need the message set to be final: sweeping whatever the
  // union holds today answers the question today, and keeps answering it as the
  // set grows. The reference implementation put `timestamp` on a REQUIRED base
  // struct and filled it from `Date.now()` in 17 places.
  it.effect('no message schema declares a wall-clock field', () =>
    Effect.sync(() => {
      const suspicious = ['timestamp', 'time', 'sentat', 'now', 'epoch', 'clock', 'millis']
      const samples: ReadonlyArray<NetworkMessage> = [
        chat,
        ping,
        { _tag: 'Pong', nonce: 7 },
        { _tag: 'PlayerLeave', player: alice },
        { _tag: 'WorldInfo', world: overworld, seed: 1 },
        { _tag: 'BlockBreak', player: alice, at: { x: 0, y: 0, z: 0 } },
        { _tag: 'BlockPlace', player: alice, at: { x: 0, y: 0, z: 0 }, block: 'stone' },
      ]

      const offenders: Array<string> = []
      for (const message of samples) {
        const encoded = Either.getOrThrow(encodeFrame(message))
        const parsed = JSON.parse(encoded) as { readonly message: Record<string, unknown> }
        for (const key of Object.keys(parsed.message)) {
          if (suspicious.some((needle) => key.toLowerCase().includes(needle))) {
            offenders.push(`${message._tag}.${key}`)
          }
        }
      }

      expect(offenders).toStrictEqual([])
    }),
  )

  // The forward-compatibility half of DN-6, which nothing asserted: Schema
  // ignores excess properties by default, so a field added in a newer build is
  // dropped rather than treated as corruption. That is the behaviour DN-6 wants
  // and it is currently a DEFAULT rather than a decision — switching to
  // `onExcessProperty: 'error'` would turn every forward-compatible frame into a
  // parse failure with nothing to catch it.
  it.effect('a field this build has never seen is ignored, not treated as corruption', () =>
    Effect.sync(() => {
      const text = JSON.stringify({
        protocolVersion: PROTOCOL_VERSION,
        message: { _tag: 'Ping', nonce: 4, sentFromChannel: 'team' },
      })
      const decoded = decodeFrame(text)

      expect(Either.isRight(decoded)).toBe(true)
      expect(Either.getOrThrow(decoded)).toStrictEqual({ _tag: 'Ping', nonce: 4 })
    }),
  )
})

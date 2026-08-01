import { describe, expect, it } from '@effect/vitest'
import { Effect, Queue } from 'effect'
import {
  LoopbackTransportLayer,
  disconnectedTransport,
  makeLoopbackPair,
  receiveMessage,
  sendMessage,
} from '../src/domain/transport'
import { PROTOCOL_VERSION, PlayerId, PlayerName, WorldId, type NetworkMessage } from '../src/domain/protocol'

const alice = PlayerId.make('alice')

const join: NetworkMessage = {
  _tag: 'PlayerJoin',
  player: alice,
  name: PlayerName.make('Alice'),
  at: { x: 0.5, y: 65, z: 0.5 },
}

const move: NetworkMessage = {
  _tag: 'PlayerMove',
  player: alice,
  at: { x: 1.25, y: 65, z: -2.5 },
  facing: { yawRadians: 0.5, pitchRadians: -0.25 },
}

const worldInfo: NetworkMessage = {
  _tag: 'WorldInfo',
  world: WorldId.make('overworld'),
  seed: 42,
}

describe('loopback synchronisation', () => {
  // plan.md §3.14: "プロトコルのユニットテスト + ループバック同期テスト".
  // The pair is genuinely two transports, so this exercises encode on one side
  // and decode on the other — an echo would exercise neither.
  it.effect('delivers a message from one side to the other, decoded and equal', () =>
    Effect.gen(function* () {
      const [client, server] = yield* makeLoopbackPair

      yield* sendMessage(join).pipe(Effect.provide(LoopbackTransportLayer(client)))
      const received = yield* receiveMessage.pipe(Effect.provide(LoopbackTransportLayer(server)))

      expect(received).toStrictEqual(join)
    }),
  )

  it.effect('is bidirectional: the server can answer on the same pair', () =>
    Effect.gen(function* () {
      const [client, server] = yield* makeLoopbackPair
      const asClient = LoopbackTransportLayer(client)
      const asServer = LoopbackTransportLayer(server)

      yield* sendMessage(join).pipe(Effect.provide(asClient))
      expect(yield* receiveMessage.pipe(Effect.provide(asServer))).toStrictEqual(join)

      yield* sendMessage(worldInfo).pipe(Effect.provide(asServer))
      expect(yield* receiveMessage.pipe(Effect.provide(asClient))).toStrictEqual(worldInfo)
    }),
  )

  // REGRESSION: "frames arrive in send order". Position updates are absolute,
  // so a reordered pair leaves a peer avatar at the older position permanently
  // rather than transiently.
  it.effect('preserves send order', () =>
    Effect.gen(function* () {
      const [client, server] = yield* makeLoopbackPair
      const asServer = LoopbackTransportLayer(server)

      yield* Effect.forEach([join, move, worldInfo], (message) =>
        sendMessage(message).pipe(Effect.provide(LoopbackTransportLayer(client))),
      )

      const received = yield* Effect.forEach([0, 1, 2], () => receiveMessage.pipe(Effect.provide(asServer)))
      expect(received).toStrictEqual([join, move, worldInfo])
    }),
  )

  // REGRESSION: "the Port carries text, not values". If `send` took a
  // NetworkMessage the loopback would pass the object through by reference and
  // every codec bug would survive every loopback test.
  it.effect('really serialises: what crosses the queue is protocol text, not the original object', () =>
    Effect.gen(function* () {
      const [client, server] = yield* makeLoopbackPair

      yield* sendMessage(move).pipe(Effect.provide(LoopbackTransportLayer(client)))
      const raw = yield* Queue.take(server.inbound)

      expect(typeof raw).toBe('string')
      expect(JSON.parse(raw)).toStrictEqual({ protocolVersion: PROTOCOL_VERSION, message: move })
    }),
  )

  it.effect('leaves the far side empty until something is actually sent', () =>
    Effect.gen(function* () {
      const [, server] = yield* makeLoopbackPair
      expect(yield* Queue.size(server.inbound)).toBe(0)
    }),
  )
})

describe('transport failure', () => {
  it.effect('surfaces a refused send as a typed TransportError rather than a defect', () =>
    Effect.gen(function* () {
      const transport = yield* disconnectedTransport

      const result = yield* sendMessage(join).pipe(
        Effect.provide(LoopbackTransportLayer(transport)),
        Effect.either,
      )

      expect(result._tag).toBe('Left')
      if (result._tag === 'Left') {
        expect(result.left._tag).toBe('TransportError')
      }
    }),
  )

  // REGRESSION: "a protocol failure and a transport failure stay distinct".
  // The reference implementation had one NetworkError for both, which is how a
  // malformed packet ends up triggering a reconnect.
  it.effect('keeps the two failure channels distinguishable at the call site', () =>
    Effect.gen(function* () {
      const [client, server] = yield* makeLoopbackPair

      yield* client.send('not a frame at all')
      const result = yield* receiveMessage.pipe(
        Effect.provide(LoopbackTransportLayer(server)),
        Effect.either,
      )

      expect(result._tag).toBe('Left')
      if (result._tag === 'Left') {
        expect(result.left._tag).toBe('ProtocolError')
        expect(result.left.reason).toBe('malformed-frame')
      }
    }),
  )
})

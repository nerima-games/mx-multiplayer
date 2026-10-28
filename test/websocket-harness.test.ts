import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import type { Duplex } from 'node:stream'
import { describe, expect, it } from '@effect/vitest'
import { Duration, Effect, Queue, Result, type Scope } from 'effect'
import * as TestClock from 'effect/testing/TestClock'
import {
  makeBrowserWebSocketTransport,
  type BrowserWebSocketTransport,
} from '../src/application/browser-transport'
import { PositiveSafeIntegerSchema, decodeFrame, encodeFrame } from '../src/domain/codec'
import type { TransportError } from '../src/domain/errors'
import { PlayerId } from '../src/domain/protocol'
import { LoopbackTransportLayer, receiveMessage } from '../src/domain/transport'

const WEBSOCKET_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const DEFAULT_HEARTBEAT_INTERVAL_MS = 60_000
const DEFAULT_IDLE_TIMEOUT_MS = 120_000
const GLOBAL_FRAME_BYTE_LIMIT = 4_194_304
const FRAME_RATE_BURST = 80
const BYTE_RATE_BURST = 3_486_960
const BYTE_RATE_TEST_FRAME_BYTES = 1_000_000
const HIGH_BIT_VALUE = 128
const OPCODE_NIBBLE_MODULUS = 16
const BINARY_RADIX = 2

type ClientTextFrame = {
  readonly masked: boolean
  readonly text: string
}

type ClientCloseEvent = { readonly code: number; readonly reason: string }

type ServerPeer = {
  readonly closed: Promise<void>
  readonly sendText: (text: string) => Promise<void>
  readonly waitForText: () => Promise<ClientTextFrame>
}

type WebSocketHarness = {
  readonly nextPeer: () => Promise<ServerPeer>
  readonly url: string
  readonly close: () => Promise<void>
}

const encodePing = (tag: 'Ping' | 'Pong', nonce: number): string =>
  Result.getOrThrow(encodeFrame({ _tag: tag, nonce }))

const FUZZ_VALID_FRAME = Result.getOrThrow(encodeFrame({
  _tag: 'Chat',
  player: PlayerId.make('fuzzer'),
  text: 'fast-check valid frame',
}))

const readEnvelopeMessage = (text: string): unknown => {
  const envelope: unknown = JSON.parse(text)
  if (typeof envelope !== 'object' || envelope === null || !('message' in envelope)) {
    throw new Error('WebSocket frame did not contain a protocol envelope')
  }
  return envelope.message
}

type ServerFrameOpcode = 0x1 | 0x8 | 0xa

// Decode XOR by binary place value to keep bitwise operators out of the harness.
const xorByteValues = (left: number, right: number): number => {
  let leftRemainder = left
  let rightRemainder = right
  let placeValue = 1
  let result = 0
  while (leftRemainder > 0 || rightRemainder > 0) {
    if (leftRemainder % BINARY_RADIX !== rightRemainder % BINARY_RADIX) {
      result += placeValue
    }
    leftRemainder = Math.floor(leftRemainder / BINARY_RADIX)
    rightRemainder = Math.floor(rightRemainder / BINARY_RADIX)
    placeValue *= BINARY_RADIX
  }
  return result
}

const encodeServerFrame = (opcode: ServerFrameOpcode, payload: Buffer): Buffer => {
  const headerLength = payload.length < 126 ? 2 : payload.length <= 0xffff ? 4 : 10
  const frame = Buffer.allocUnsafe(headerLength + payload.length)
  frame[0] = HIGH_BIT_VALUE + opcode
  if (headerLength === 2) {
    frame[1] = payload.length
  } else if (headerLength === 4) {
    frame[1] = 126
    frame.writeUInt16BE(payload.length, 2)
  } else {
    frame[1] = 127
    frame.writeBigUInt64BE(BigInt(payload.length), 2)
  }
  payload.copy(frame, headerLength)
  return frame
}

const makeServerPeer = (socket: Duplex, initialData: Buffer): ServerPeer => {
  let buffered: Buffer<ArrayBufferLike> = Buffer.alloc(0)
  const queuedFrames: ClientTextFrame[] = []
  const frameWaiters: Array<(frame: ClientTextFrame) => void> = []
  let resolveClosed: () => void = () => undefined
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve
  })
  socket.once('close', resolveClosed)

  const publishTextFrame = (frame: ClientTextFrame): void => {
    const waiter = frameWaiters.shift()
    if (waiter === undefined) {
      queuedFrames.push(frame)
      return
    }
    waiter(frame)
  }

  const consumeFrames = (): void => {
    while (buffered.length >= 2) {
      const first = buffered[0]
      const second = buffered[1]
      if (first === undefined || second === undefined) {
        return
      }
      const opcode = first % OPCODE_NIBBLE_MODULUS
      const masked = second >= HIGH_BIT_VALUE
      const lengthCode = second % HIGH_BIT_VALUE
      let headerLength = 2
      let payloadLength = lengthCode
      if (lengthCode === 126) {
        headerLength = 4
        if (buffered.length < headerLength) {
          return
        }
        payloadLength = buffered.readUInt16BE(2)
      } else if (lengthCode === 127) {
        headerLength = 10
        if (buffered.length < headerLength) {
          return
        }
        const longLength = buffered.readBigUInt64BE(2)
        if (longLength > BigInt(Number.MAX_SAFE_INTEGER)) {
          socket.destroy()
          return
        }
        payloadLength = Number(longLength)
      }

      const maskLength = masked ? 4 : 0
      const payloadOffset = headerLength + maskLength
      const frameLength = payloadOffset + payloadLength
      if (buffered.length < frameLength) {
        return
      }

      const payload = Buffer.from(buffered.subarray(payloadOffset, frameLength))
      if (masked) {
        const mask = buffered.subarray(headerLength, payloadOffset)
        for (let index = 0; index < payload.length; index += 1) {
          const maskByte = mask[index % 4]
          const payloadByte = payload[index]
          if (maskByte !== undefined && payloadByte !== undefined) {
            payload[index] = xorByteValues(payloadByte, maskByte)
          }
        }
      }
      buffered = buffered.subarray(frameLength)

      if (opcode === 0x1) {
        publishTextFrame({ masked, text: payload.toString('utf8') })
      } else if (opcode === 0x8) {
        socket.write(encodeServerFrame(0x8, payload))
        socket.end()
      } else if (opcode === 0x9) {
        socket.write(encodeServerFrame(0xa, payload))
      }
    }
  }

  socket.on('data', (chunk: Buffer) => {
    buffered = Buffer.concat([buffered, chunk])
    consumeFrames()
  })
  if (initialData.length > 0) {
    buffered = initialData
    consumeFrames()
  }

  return {
    closed,
    sendText: (text) => new Promise<void>((resolve, reject) => {
      socket.write(encodeServerFrame(0x1, Buffer.from(text, 'utf8')), (error) => {
        if (error !== null && error !== undefined) {
          reject(error)
          return
        }
        resolve()
      })
    }),
    waitForText: () => new Promise((resolve) => {
      const frame = queuedFrames.shift()
      if (frame !== undefined) {
        resolve(frame)
        return
      }
      frameWaiters.push(resolve)
    }),
  }
}

const makeWebSocketHarness = async (): Promise<WebSocketHarness> => {
  const server = createServer()
  const sockets = new Set<Duplex>()
  const queuedPeers: ServerPeer[] = []
  const peerWaiters: Array<(peer: ServerPeer) => void> = []

  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })
  server.on('upgrade', (request, socket, head) => {
    const key = request.headers['sec-websocket-key']
    if (typeof key !== 'string') {
      socket.destroy()
      return
    }
    const accept = createHash('sha1').update(key + WEBSOCKET_GUID).digest('base64')
    socket.write([
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`,
      '\r\n',
    ].join('\r\n'))

    const peer = makeServerPeer(socket, head)
    const waiter = peerWaiters.shift()
    if (waiter === undefined) {
      queuedPeers.push(peer)
    } else {
      waiter(peer)
    }
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })

  const address = server.address()
  if (address === null || typeof address === 'string') {
    await new Promise<void>((resolve) => {
      server.close(() => resolve())
    })
    throw new Error('local WebSocket server did not receive a TCP address')
  }

  return {
    url: `ws://127.0.0.1:${address.port}`,
    nextPeer: () => new Promise((resolve) => {
      const peer = queuedPeers.shift()
      if (peer !== undefined) {
        resolve(peer)
        return
      }
      peerWaiters.push(resolve)
    }),
    close: async () => {
      for (const socket of sockets) {
        socket.destroy()
      }
      if (server.listening) {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error !== undefined) {
              reject(error)
              return
            }
            resolve()
          })
        })
      }
    },
  }
}

const waitForOpen = (socket: WebSocket): Promise<void> => new Promise((resolve, reject) => {
  if (socket.readyState === WebSocket.OPEN) {
    resolve()
    return
  }
  socket.addEventListener('open', () => resolve(), { once: true })
  socket.addEventListener('error', () => reject(new Error('local WebSocket connection failed')), { once: true })
})

const waitForMessage = (socket: WebSocket): Promise<void> => new Promise((resolve, reject) => {
  const controller = new AbortController()
  const onMessage = (): void => {
    controller.abort()
    resolve()
  }
  const onClose = (): void => {
    controller.abort()
    reject(new Error('WebSocket closed before delivering the expected frame'))
  }
  socket.addEventListener('message', onMessage, { once: true, signal: controller.signal })
  socket.addEventListener('close', onClose, { once: true, signal: controller.signal })
})

const waitForClose = (socket: WebSocket): Promise<ClientCloseEvent> => new Promise((resolve) => {
  socket.addEventListener('close', (event) => resolve({ code: event.code, reason: event.reason }), { once: true })
})

const withWebSocketHarness = <A, E, R>(
  use: (harness: WebSocketHarness) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R | Scope.Scope> =>
  Effect.acquireRelease(
    Effect.promise(makeWebSocketHarness),
    (harness) => Effect.promise(() => harness.close()),
  ).pipe(Effect.flatMap(use))

type SessionOverrides = Omit<
  Partial<Pick<Parameters<typeof makeBrowserWebSocketTransport>[0], 'heartbeatIntervalMs' | 'idleTimeoutMs' | 'inboundCapacity'>>,
  'heartbeatIntervalMs' | 'idleTimeoutMs'
> & {
  readonly heartbeatIntervalMs?: number
  readonly idleTimeoutMs?: number
}

const openSession = (
  harness: WebSocketHarness,
  overrides: SessionOverrides = {},
): Effect.Effect<{
  readonly peer: ServerPeer
  readonly socket: WebSocket
  readonly transport: BrowserWebSocketTransport
}, TransportError, Scope.Scope> => Effect.gen(function* () {
  const socket = yield* Effect.sync(() => new WebSocket(harness.url))
  const opened = waitForOpen(socket)
  const { heartbeatIntervalMs, idleTimeoutMs, ...otherOverrides } = overrides
  const transport = yield* Effect.acquireRelease(
    makeBrowserWebSocketTransport({
      heartbeatIntervalMs: PositiveSafeIntegerSchema.make(heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS),
      idleTimeoutMs: PositiveSafeIntegerSchema.make(idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS),
      socketFactory: () => socket,
      url: harness.url,
      ...otherOverrides,
    }),
    (current) => current.close,
  )
  yield* Effect.promise(() => opened)
  const peer = yield* Effect.promise(() => harness.nextPeer())
  return { peer, socket, transport }
})

const assertInboundAlreadyShutdown = (transport: BrowserWebSocketTransport): Effect.Effect<void> =>
  Effect.sync(() => {
    expect(transport.inbound.state._tag).toBe('Done')
  })

describe('real WebSocket transport harness', () => {
  it.effect('carries text over a masked client frame and reports malformed protocol data as a typed error without dropping the socket', () =>
    withWebSocketHarness((harness) => Effect.gen(function* () {
      const { peer, socket, transport } = yield* openSession(harness)
      const outgoing = peer.waitForText()
      yield* transport.send('outbound-over-real-websocket')
      const sent = yield* Effect.promise(() => outgoing)
      expect(sent).toStrictEqual({ masked: true, text: 'outbound-over-real-websocket' })

      yield* Effect.promise(() => peer.sendText('not JSON'))
      const received = yield* receiveMessage.pipe(
        Effect.provide(LoopbackTransportLayer(transport)),
        Effect.result,
      )
      expect(received._tag).toBe('Failure')
      if (received._tag === 'Failure') {
        expect(received.failure).toMatchObject({ _tag: 'ProtocolError', reason: 'malformed-frame' })
      }
      const ordinaryMessage = { _tag: 'Chat', player: PlayerId.make('harness'), text: 'socket still open' } as const
      const ordinaryDelivery = waitForMessage(socket)
      yield* Effect.promise(() => peer.sendText(Result.getOrThrow(encodeFrame(ordinaryMessage))))
      yield* Effect.promise(() => ordinaryDelivery)
      const ordinaryReceived = yield* receiveMessage.pipe(
        Effect.provide(LoopbackTransportLayer(transport)),
        Effect.result,
      )
      expect(Result.isSuccess(ordinaryReceived)).toBe(true)
      expect(Result.getOrThrow(ordinaryReceived)).toStrictEqual(ordinaryMessage)
      expect(transport.state()).toBe('open')
      expect(transport.fault()).toBeUndefined()
    })),
  )

  it.effect('answers an incoming Ping with the same nonce and sends heartbeat frames when TestClock advances', () =>
    withWebSocketHarness((harness) => Effect.gen(function* () {
      const { peer, socket, transport } = yield* openSession(harness, {
        heartbeatIntervalMs: 25,
        idleTimeoutMs: 2_000,
      })
      const heartbeat = peer.waitForText()
      yield* TestClock.adjust(Duration.millis(25))
      const sentHeartbeat = yield* Effect.promise(() => heartbeat)
      const heartbeatMessage = readEnvelopeMessage(sentHeartbeat.text)
      expect(sentHeartbeat.masked).toBe(true)
      expect(heartbeatMessage).toMatchObject({ _tag: 'Ping' })
      if (
        typeof heartbeatMessage !== 'object'
        || heartbeatMessage === null
        || !('nonce' in heartbeatMessage)
        || typeof heartbeatMessage.nonce !== 'number'
      ) {
        throw new Error('heartbeat Ping did not carry a numeric nonce')
      }
      const heartbeatNonce = heartbeatMessage.nonce

      const heartbeatPongDelivery = waitForMessage(socket)
      yield* Effect.promise(() => peer.sendText(encodePing('Pong', heartbeatNonce)))
      yield* Effect.promise(() => heartbeatPongDelivery)

      const response = peer.waitForText()
      const delivered = waitForMessage(socket)
      yield* Effect.promise(() => peer.sendText(encodePing('Ping', 713)))
      yield* Effect.promise(() => delivered)
      const pong = yield* Effect.promise(() => response)
      expect(pong.masked).toBe(true)
      expect(readEnvelopeMessage(pong.text)).toStrictEqual({ _tag: 'Pong', nonce: 713 })

      const nextHeartbeat = peer.waitForText()
      yield* TestClock.adjust(Duration.millis(25))
      expect(readEnvelopeMessage((yield* Effect.promise(() => nextHeartbeat)).text)).toMatchObject({ _tag: 'Ping' })
      expect(transport.fault()).toBeUndefined()
    })),
  )

  it.effect('closes the real socket when a heartbeat Ping has no matching Pong by the next tick', () =>
    withWebSocketHarness((harness) => Effect.gen(function* () {
      const { peer, socket, transport } = yield* openSession(harness, {
        heartbeatIntervalMs: 25,
        idleTimeoutMs: 2_000,
      })
      const heartbeat = peer.waitForText()
      yield* TestClock.adjust(Duration.millis(25))
      expect(readEnvelopeMessage((yield* Effect.promise(() => heartbeat)).text)).toMatchObject({ _tag: 'Ping' })

      const socketClosed = waitForClose(socket)
      yield* TestClock.adjust(Duration.millis(25))
      expect(transport.fault()).toMatchObject({ _tag: 'HeartbeatTimeout' })
      expect(transport.state()).toBe('closed')
      expect(yield* Effect.promise(() => socketClosed)).toMatchObject({ code: 4008, reason: 'HeartbeatTimeout' })
      yield* Effect.promise(() => peer.closed)
      yield* assertInboundAlreadyShutdown(transport)
    })),
  )

  it.effect('closes the real socket with a typed inbound queue overflow fault', () =>
    withWebSocketHarness((harness) => Effect.gen(function* () {
      const { peer, socket, transport } = yield* openSession(harness, { inboundCapacity: 1 })
      const firstDelivery = waitForMessage(socket)
      yield* Effect.promise(() => peer.sendText('first'))
      yield* Effect.promise(() => firstDelivery)
      expect(yield* Queue.size(transport.inbound)).toBe(1)

      const socketClosed = waitForClose(socket)
      const secondDelivery = waitForMessage(socket)
      yield* Effect.promise(() => peer.sendText('second'))
      yield* Effect.promise(() => secondDelivery)

      const closeEvent = yield* Effect.promise(() => socketClosed)
      expect(transport.fault()).toMatchObject({ _tag: 'InboundQueueOverflow' })
      expect(transport.state()).toBe('closed')
      expect(socket.readyState).toBe(WebSocket.CLOSED)
      expect(closeEvent).toMatchObject({ code: 4008, reason: 'InboundQueueOverflow' })
      yield* Effect.promise(() => peer.closed)
      yield* assertInboundAlreadyShutdown(transport)
    })),
  )

  it.effect('rejects an over-limit frame as a typed preflight fault and closes the real socket', () =>
    withWebSocketHarness((harness) => Effect.gen(function* () {
      const { peer, socket, transport } = yield* openSession(harness)
      const overLimitDelivery = waitForMessage(socket)
      const socketClosed = waitForClose(socket)
      yield* Effect.promise(() => peer.sendText('x'.repeat(GLOBAL_FRAME_BYTE_LIMIT + 1)))
      yield* Effect.promise(() => overLimitDelivery)

      expect(transport.fault()).toMatchObject({
        _tag: 'ProtocolError',
        reason: 'frame-too-large',
      })
      expect(transport.state()).toBe('closed')
      expect(yield* Effect.promise(() => socketClosed)).toMatchObject({ code: 4009, reason: 'ProtocolError' })
      yield* Effect.promise(() => peer.closed)
      yield* assertInboundAlreadyShutdown(transport)
    })),
  )

  it.effect('times out an idle peer on TestClock and closes its real socket', () =>
    withWebSocketHarness((harness) => Effect.gen(function* () {
      const { peer, socket, transport } = yield* openSession(harness, {
        heartbeatIntervalMs: 10_000,
        idleTimeoutMs: 100,
      })
      const socketClosed = waitForClose(socket)
      yield* TestClock.adjust(Duration.millis(101))
      expect(transport.fault()).toMatchObject({ _tag: 'IdleTimeout' })
      expect(transport.state()).toBe('closed')
      expect(yield* Effect.promise(() => socketClosed)).toMatchObject({ code: 4008, reason: 'IdleTimeout' })
      yield* Effect.promise(() => peer.closed)
      yield* assertInboundAlreadyShutdown(transport)
    })),
  )

  it('fuzzes arbitrary text through the real WebSocket and observes only typed decode outcomes', async () => {
    const fc = await import('fast-check')
    const harness = await makeWebSocketHarness()
    try {
      await fc.assert(fc.asyncProperty(
        fc.array(fc.oneof(fc.string({ maxLength: 32 }), fc.constant(FUZZ_VALID_FRAME)), { minLength: 8, maxLength: 16 }),
        async (frames: Array<string>) => {
          const socket = new WebSocket(harness.url)
          const opened = waitForOpen(socket)
          const transport = await Effect.runPromise(makeBrowserWebSocketTransport({
            heartbeatIntervalMs: PositiveSafeIntegerSchema.make(DEFAULT_HEARTBEAT_INTERVAL_MS),
            idleTimeoutMs: PositiveSafeIntegerSchema.make(DEFAULT_IDLE_TIMEOUT_MS),
            socketFactory: () => socket,
            url: harness.url,
          }))
          try {
            await opened
            const peer = await harness.nextPeer()
            return await frames.reduce<Promise<boolean>>(
              (previous, frame) => previous.then(async (continueRun) => {
                if (!continueRun) {
                  return false
                }
                const wireFrame = Buffer.from(frame, 'utf8').toString('utf8')
                const delivered = waitForMessage(socket)
                await peer.sendText(frame)
                await delivered
                const decoded = await Effect.runPromise(
                  receiveMessage.pipe(
                    Effect.provide(LoopbackTransportLayer(transport)),
                    Effect.result,
                  ),
                )
                const expected = decodeFrame(wireFrame)
                if (Result.isFailure(expected)) {
                  return decoded._tag === 'Failure'
                    && decoded.failure._tag === 'ProtocolError'
                    && decoded.failure.reason === expected.failure.reason
                    && transport.state() === 'open'
                    && transport.fault() === undefined
                }
                if (decoded._tag !== 'Success') {
                  return false
                }
                expect(decoded.success).toStrictEqual(expected.success)
                return transport.state() === 'open' && transport.fault() === undefined
              }),
              Promise.resolve(true),
            )
          } finally {
            await Effect.runPromise(transport.close)
          }
        },
      ), { numRuns: 4, seed: 0x57ea3 })
    } finally {
      await harness.close()
    }
  })

  it.effect('enforces the frame burst limit while keeping queue occupancy below its bound', () =>
    withWebSocketHarness((harness) => Effect.gen(function* () {
      const { peer, socket, transport } = yield* openSession(harness)
      for (let index = 0; index < FRAME_RATE_BURST; index += 1) {
        const delivered = waitForMessage(socket)
        yield* Effect.promise(() => peer.sendText(`frame-${index}`))
        yield* Effect.promise(() => delivered)
        expect(yield* Queue.take(transport.inbound)).toBe(`frame-${index}`)
      }
      expect(transport.fault()).toBeUndefined()

      const socketClosed = waitForClose(socket)
      const excessDelivery = waitForMessage(socket)
      yield* Effect.promise(() => peer.sendText('frame-over-burst'))
      yield* Effect.promise(() => excessDelivery)
      expect(transport.fault()).toMatchObject({ _tag: 'FrameRateExceeded' })
      expect(transport.state()).toBe('closed')
      expect(yield* Effect.promise(() => socketClosed)).toMatchObject({ code: 4008, reason: 'FrameRateExceeded' })
      yield* Effect.promise(() => peer.closed)
      yield* assertInboundAlreadyShutdown(transport)
    })),
  )

  it.effect('enforces the byte burst boundary before accepting one more byte', () =>
    withWebSocketHarness((harness) => Effect.gen(function* () {
      const { peer, socket, transport } = yield* openSession(harness)
      const fullFrames = Math.floor(BYTE_RATE_BURST / BYTE_RATE_TEST_FRAME_BYTES)
      const remainingBytes = BYTE_RATE_BURST - fullFrames * BYTE_RATE_TEST_FRAME_BYTES
      const frames = [
        ...Array.from({ length: fullFrames }, () => 'x'.repeat(BYTE_RATE_TEST_FRAME_BYTES)),
        'x'.repeat(remainingBytes),
      ]
      for (const frame of frames) {
        const delivery = waitForMessage(socket)
        yield* Effect.promise(() => peer.sendText(frame))
        yield* Effect.promise(() => delivery)
        expect((yield* Queue.take(transport.inbound)).length).toBe(frame.length)
      }
      expect(transport.fault()).toBeUndefined()

      const socketClosed = waitForClose(socket)
      const excessDelivery = waitForMessage(socket)
      yield* Effect.promise(() => peer.sendText('x'))
      yield* Effect.promise(() => excessDelivery)
      expect(transport.fault()).toMatchObject({ _tag: 'ByteRateExceeded' })
      expect(transport.state()).toBe('closed')
      expect(yield* Effect.promise(() => socketClosed)).toMatchObject({ code: 4008, reason: 'ByteRateExceeded' })
      yield* Effect.promise(() => peer.closed)
      yield* assertInboundAlreadyShutdown(transport)
    })),
  )
})

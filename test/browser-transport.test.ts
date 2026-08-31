import { describe, expect, it } from '@effect/vitest'
import { Effect, Queue } from 'effect'
import {
  type BrowserWebSocketTransport,
  type BrowserWebSocketTransportOptions,
  type ReconnectAuthOptions,
  type UrlLike,
  type WebSocketLike,
  makeBrowserWebSocketTransport,
  validateMultiplayerUrl,
} from '../src/application/browser-transport'
import type { TransportError } from '../src/domain/errors'

// ---------------------------------------------------------------------------
// Test doubles for the platform surface this file structurally describes.
// ---------------------------------------------------------------------------

/** A minimal, real `UrlLike`: `scheme://host[:port]`. Throws on anything else, like a real `URL` would. */
class FakeUrl implements UrlLike {
  readonly href: string
  readonly hostname: string
  readonly protocol: string

  constructor(input: string) {
    const match = /^(?<protocol>[a-z]+:)\/\/(?<hostname>\[[0-9a-fA-F:]+\]|[^/:]+)(?::\d+)?\/?$/u.exec(input)
    const protocol = match?.groups?.['protocol']
    const hostname = match?.groups?.['hostname']
    if (protocol === undefined || hostname === undefined) {
      throw new Error(`invalid url: ${input}`)
    }
    this.protocol = protocol
    this.hostname = hostname
    this.href = input
  }
}

type FakeCloseEvent = { readonly code?: number; readonly reason?: string }
type FakeMessageEvent = { readonly data: unknown }

const READY_STATE_CONNECTING = 0
const READY_STATE_OPEN = 1
const READY_STATE_CLOSED = 3

/**
 * Shaped exactly like `WebSocketLike`'s own (private) event map, so
 * `addEventListener<K>(type: K, listener: (event: FakeSocketEventMap[K]) => void)`
 * below has the identical generic form as the interface it implements. That
 * identity is what makes the implementation check pass structurally — a
 * differently-shaped conditional type here (one keyed on the four event names
 * directly, tried first) is NOT accepted as implementing the interface's own
 * `<K extends keyof M>(type: K, listener: (event: M[K]) => void)` method,
 * because interface-method compatibility is checked per-instantiation, not by
 * final result shape. `open` and `error` stay `unknown`, matching the real
 * `WebSocket`, where those events carry no data this file reads.
 */
type FakeSocketEventMap = {
  readonly close: FakeCloseEvent
  readonly error: unknown
  readonly message: FakeMessageEvent
  readonly open: unknown
}

/**
 * One `Set` per event name, addressed through a mapped type over
 * `FakeSocketEventMap` rather than a single `Map<string, Set<Function>>`, so
 * `#listeners[type].add(listener)` type-checks without ever narrowing `type`
 * at runtime — narrowing a generic parameter from an `if` on its own value is
 * a real TypeScript limitation, and reaching for a cast to route around it is
 * exactly what `no-type-assertion` exists to catch.
 */
class FakeSocket implements WebSocketLike {
  readyState = READY_STATE_CONNECTING
  readonly sent: string[] = []
  readonly closes: Array<{ code: number | undefined; reason: string | undefined }> = []
  sendShouldThrow = false
  closeShouldThrow = false

  readonly #listeners: { [K in keyof FakeSocketEventMap]: Set<(event: FakeSocketEventMap[K]) => void> } = {
    close: new Set(),
    error: new Set(),
    message: new Set(),
    open: new Set(),
  }

  addEventListener<K extends keyof FakeSocketEventMap>(
    type: K,
    listener: (event: FakeSocketEventMap[K]) => void,
  ): void {
    this.#listeners[type].add(listener)
  }

  removeEventListener<K extends keyof FakeSocketEventMap>(
    type: K,
    listener: (event: FakeSocketEventMap[K]) => void,
  ): void {
    this.#listeners[type].delete(listener)
  }

  send(data: string): void {
    if (this.sendShouldThrow) {
      throw new Error('send failed (fake)')
    }
    this.sent.push(data)
  }

  close(code?: number, reason?: string): void {
    if (this.closeShouldThrow) {
      throw new Error('close failed (fake)')
    }
    this.closes.push({ code, reason })
  }

  emitOpen(): void {
    for (const listener of this.#listeners.open) {
      listener(undefined)
    }
  }

  emitMessage(event: FakeMessageEvent): void {
    for (const listener of this.#listeners.message) {
      listener(event)
    }
  }

  emitClose(event: FakeCloseEvent): void {
    for (const listener of this.#listeners.close) {
      listener(event)
    }
  }

  emitError(): void {
    for (const listener of this.#listeners.error) {
      listener(undefined)
    }
  }

  messageListenerCount(): number {
    return this.#listeners.message.size
  }
}

const openTransport = (
  overrides: Partial<BrowserWebSocketTransportOptions> = {},
): Effect.Effect<{ readonly socket: FakeSocket; readonly transport: BrowserWebSocketTransport }, TransportError> =>
  Effect.gen(function* () {
    const socket = new FakeSocket()
    const transport = yield* makeBrowserWebSocketTransport({
      socketFactory: () => socket,
      url: 'ws://localhost:9000',
      ...overrides,
    })
    return { socket, transport }
  })

// ---------------------------------------------------------------------------
// validateMultiplayerUrl
// ---------------------------------------------------------------------------

describe('validateMultiplayerUrl', () => {
  it('rejects text that is not a URL at all', () => {
    const result = validateMultiplayerUrl('not a url', 'http://localhost:8080', FakeUrl)
    expect(result).toStrictEqual({ message: 'Enter a valid multiplayer server URL.', ok: false })
  })

  it('rejects a non-websocket protocol', () => {
    const result = validateMultiplayerUrl('http://example.com', 'http://localhost:8080', FakeUrl)
    expect(result).toStrictEqual({ message: 'Multiplayer server must use ws:// or wss://.', ok: false })
  })

  it('accepts wss:// regardless of the page origin', () => {
    const result = validateMultiplayerUrl('wss://example.com', 'https://example.com', FakeUrl)
    expect(result.ok).toBe(true)
  })

  it('accepts wss:// with the page URL given as an already-parsed UrlLike', () => {
    const page = new FakeUrl('https://example.com')
    const result = validateMultiplayerUrl('wss://example.com', page, FakeUrl)
    expect(result.ok).toBe(true)
  })

  it('rejects ws:// when the page cannot be parsed', () => {
    const result = validateMultiplayerUrl('ws://localhost:9000', 'not a url', FakeUrl)
    expect(result).toStrictEqual({ message: 'Enter a valid multiplayer server URL.', ok: false })
  })

  it('rejects ws:// from an https page (secure-context downgrade)', () => {
    const result = validateMultiplayerUrl('ws://localhost:9000', 'https://localhost:8080', FakeUrl)
    expect(result).toStrictEqual({ message: 'HTTPS pages require a secure wss:// multiplayer server.', ok: false })
  })

  it('rejects ws:// when the page is non-loopback', () => {
    const result = validateMultiplayerUrl('ws://localhost:9000', 'http://example.com', FakeUrl)
    expect(result.ok).toBe(false)
  })

  it('rejects ws:// when the server is non-loopback', () => {
    const result = validateMultiplayerUrl('ws://example.com', 'http://localhost:8080', FakeUrl)
    expect(result.ok).toBe(false)
  })

  it('accepts ws:// when both page and server are loopback', () => {
    const result = validateMultiplayerUrl('ws://127.0.0.1:9000', 'http://localhost:8080', FakeUrl)
    expect(result).toStrictEqual({ ok: true, url: new FakeUrl('ws://127.0.0.1:9000') })
  })

  it('accepts ws:// with an IPv6 loopback literal on both sides', () => {
    const result = validateMultiplayerUrl('ws://[::1]:9000', 'http://[::1]:8080', FakeUrl)
    expect(result.ok).toBe(true)
  })

  it('accepts ws:// when the page URL is given as an already-parsed UrlLike', () => {
    const page = new FakeUrl('http://localhost:8080')
    const result = validateMultiplayerUrl('ws://127.0.0.1:9000', page, FakeUrl)
    expect(result.ok).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// makeBrowserWebSocketTransport: construction
// ---------------------------------------------------------------------------

describe('makeBrowserWebSocketTransport construction', () => {
  it.effect('fails when inboundCapacity is not a positive integer (non-integer)', () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        makeBrowserWebSocketTransport({ inboundCapacity: 1.5, socketFactory: () => new FakeSocket(), url: 'ws://localhost' }),
      )
      expect(exit._tag).toBe('Failure')
    }),
  )

  it.effect('fails when inboundCapacity is zero', () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        makeBrowserWebSocketTransport({ inboundCapacity: 0, socketFactory: () => new FakeSocket(), url: 'ws://localhost' }),
      )
      expect(exit._tag).toBe('Failure')
    }),
  )

  it.effect('succeeds with the default inboundCapacity', () =>
    Effect.gen(function* () {
      const { transport } = yield* openTransport()
      expect(transport.state()).toBe('connecting')
    }),
  )

  it.effect('fails when socketFactory throws', () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        makeBrowserWebSocketTransport({
          socketFactory: () => {
            throw new Error('no socket available')
          },
          url: 'ws://localhost',
        }),
      )
      expect(exit._tag).toBe('Failure')
    }),
  )
})

// ---------------------------------------------------------------------------
// Connection lifecycle without reconnectAuth
// ---------------------------------------------------------------------------

describe('connection lifecycle (no reconnectAuth)', () => {
  it.effect('is authenticated as soon as open fires', () =>
    Effect.gen(function* () {
      const { socket, transport } = yield* openTransport()
      expect(transport.isAuthenticated()).toBe(false)
      socket.readyState = READY_STATE_OPEN
      socket.emitOpen()
      expect(transport.state()).toBe('open')
      expect(transport.isAuthenticated()).toBe(true)
    }),
  )

  it.effect('a second open event is ignored', () =>
    Effect.gen(function* () {
      const { socket, transport } = yield* openTransport()
      socket.readyState = READY_STATE_OPEN
      socket.emitOpen()
      socket.emitOpen()
      expect(transport.state()).toBe('open')
    }),
  )

  it.effect('rejects a send before the socket is open', () =>
    Effect.gen(function* () {
      const { transport } = yield* openTransport()
      const exit = yield* Effect.exit(transport.send('hello'))
      expect(exit._tag).toBe('Failure')
    }),
  )

  it.effect('sends a frame once open', () =>
    Effect.gen(function* () {
      const { socket, transport } = yield* openTransport()
      socket.readyState = READY_STATE_OPEN
      socket.emitOpen()
      yield* transport.send('hello')
      expect(socket.sent).toStrictEqual(['hello'])
    }),
  )

  it.effect('a send that the socket rejects terminates the transport', () =>
    Effect.gen(function* () {
      const { socket, transport } = yield* openTransport()
      socket.readyState = READY_STATE_OPEN
      socket.emitOpen()
      socket.sendShouldThrow = true
      const exit = yield* Effect.exit(transport.send('hello'))
      expect(exit._tag).toBe('Failure')
      expect(transport.state()).toBe('closed')
    }),
  )

  it.effect('a send after the transport is closed fails with the terminal error', () =>
    Effect.gen(function* () {
      const { socket, transport } = yield* openTransport()
      socket.readyState = READY_STATE_OPEN
      socket.emitOpen()
      socket.emitClose({ code: 1006, reason: 'lost' })
      const exit = yield* Effect.exit(transport.send('hello'))
      expect(exit._tag).toBe('Failure')
    }),
  )

  it.effect('a close event with no code or reason still terminates cleanly', () =>
    Effect.gen(function* () {
      const { socket, transport } = yield* openTransport()
      socket.readyState = READY_STATE_OPEN
      socket.emitOpen()
      socket.emitClose({})
      expect(transport.state()).toBe('closed')
    }),
  )

  it.effect('an error event terminates the transport', () =>
    Effect.gen(function* () {
      const { socket, transport } = yield* openTransport()
      socket.readyState = READY_STATE_OPEN
      socket.emitOpen()
      socket.emitError()
      expect(transport.state()).toBe('closed')
    }),
  )

  it.effect('inbound frames land on the queue in order', () =>
    Effect.gen(function* () {
      const { socket, transport } = yield* openTransport()
      socket.readyState = READY_STATE_OPEN
      socket.emitOpen()
      socket.emitMessage({ data: 'first' })
      socket.emitMessage({ data: 'second' })
      expect(yield* Queue.take(transport.inbound)).toBe('first')
      expect(yield* Queue.take(transport.inbound)).toBe('second')
    }),
  )

  it.effect('a message received before open is dropped', () =>
    Effect.gen(function* () {
      const { socket, transport } = yield* openTransport()
      socket.emitMessage({ data: 'too-early' })
      socket.readyState = READY_STATE_OPEN
      socket.emitOpen()
      const size = yield* Queue.size(transport.inbound)
      expect(size).toBe(0)
    }),
  )

  it.effect('a message whose data is not a string is dropped', () =>
    Effect.gen(function* () {
      const { socket, transport } = yield* openTransport()
      socket.readyState = READY_STATE_OPEN
      socket.emitOpen()
      socket.emitMessage({ data: 42 })
      const size = yield* Queue.size(transport.inbound)
      expect(size).toBe(0)
    }),
  )

  it.effect('close() disposes the transport and closes an open socket', () =>
    Effect.gen(function* () {
      const { socket, transport } = yield* openTransport()
      socket.readyState = READY_STATE_OPEN
      socket.emitOpen()
      yield* transport.close
      expect(transport.state()).toBe('closed')
      expect(socket.closes).toStrictEqual([{ code: 1000, reason: 'transport disposed' }])
    }),
  )

  it.effect('close() does not re-close a socket that already reported closed', () =>
    Effect.gen(function* () {
      const { socket, transport } = yield* openTransport()
      socket.readyState = READY_STATE_CLOSED
      yield* transport.close
      expect(socket.closes).toStrictEqual([])
    }),
  )

  it.effect('close() is idempotent', () =>
    Effect.gen(function* () {
      const { socket, transport } = yield* openTransport()
      socket.readyState = READY_STATE_OPEN
      socket.emitOpen()
      yield* transport.close
      yield* transport.close
      expect(socket.closes.length).toBe(1)
    }),
  )

  it.effect('close() after the socket already closed itself does not re-run termination', () =>
    Effect.gen(function* () {
      const { socket, transport } = yield* openTransport()
      socket.readyState = READY_STATE_OPEN
      socket.emitOpen()
      socket.emitClose({ code: 1006, reason: 'lost' })
      // A real WebSocket reports CLOSED by the time its own `close` event fired.
      socket.readyState = READY_STATE_CLOSED
      yield* transport.close
      expect(socket.closes).toStrictEqual([])
    }),
  )

  it.effect('close() detaches listeners so a later socket event is inert', () =>
    Effect.gen(function* () {
      const { socket, transport } = yield* openTransport()
      socket.readyState = READY_STATE_OPEN
      socket.emitOpen()
      yield* transport.close
      expect(socket.messageListenerCount()).toBe(0)
      // `close()` already shut the inbound queue down, so the only observable
      // proof left that this event is inert is that raising it does not throw.
      expect(() => socket.emitMessage({ data: 'after-close' })).not.toThrow()
    }),
  )

  it.effect('a close event after close() does not double-detach', () =>
    Effect.gen(function* () {
      const { socket, transport } = yield* openTransport()
      socket.readyState = READY_STATE_OPEN
      socket.emitOpen()
      yield* transport.close
      // The listener is already detached, so this is a direct call, matching
      // what a slow-to-fire browser close event would still be able to reach.
      expect(() => socket.emitClose({ code: 1000, reason: 'already closed' })).not.toThrow()
      expect(transport.state()).toBe('closed')
    }),
  )
})

// ---------------------------------------------------------------------------
// Connection lifecycle with reconnectAuth
// ---------------------------------------------------------------------------

const makeReconnectAuth = (
  overrides: Partial<ReconnectAuthOptions> = {},
): ReconnectAuthOptions & { readonly savedTokens: string[]; readonly clearedCount: { count: number } } => {
  const savedTokens: string[] = []
  const clearedCount = { count: 0 }
  return {
    clearedCount,
    clearRegistrationToken: () => {
      clearedCount.count += 1
    },
    loadToken: () => undefined,
    playerId: 'alice',
    saveToken: (token) => {
      savedTokens.push(token)
    },
    savedTokens,
    ...overrides,
  }
}

const parseSentFrame = (sent: readonly string[]): unknown => {
  const [first] = sent
  if (first === undefined) {
    throw new Error('expected a frame to have been sent, but none was')
  }
  return JSON.parse(first)
}

describe('connection lifecycle (with reconnectAuth)', () => {
  it.effect('sends a PlayerResume with the loaded token on open', () =>
    Effect.gen(function* () {
      const reconnectAuth = makeReconnectAuth({ loadToken: () => 'existing-token' })
      const { socket, transport } = yield* openTransport({ reconnectAuth })
      socket.readyState = READY_STATE_OPEN
      socket.emitOpen()
      expect(transport.isAuthenticated()).toBe(false)
      const sent: unknown = parseSentFrame(socket.sent)
      expect(sent).toStrictEqual({ _tag: 'PlayerResume', player: 'alice', token: 'existing-token' })
    }),
  )

  it.effect('falls back to the registration token when no resume token is stored', () =>
    Effect.gen(function* () {
      const reconnectAuth = makeReconnectAuth({ loadRegistrationToken: () => 'reg-token' })
      const { socket } = yield* openTransport({ reconnectAuth })
      socket.readyState = READY_STATE_OPEN
      socket.emitOpen()
      const sent: unknown = parseSentFrame(socket.sent)
      expect(sent).toStrictEqual({ _tag: 'PlayerResume', player: 'alice', registrationToken: 'reg-token' })
    }),
  )

  it.effect('sends no registration token when neither a token nor one is available', () =>
    Effect.gen(function* () {
      const reconnectAuth = makeReconnectAuth()
      const { socket } = yield* openTransport({ reconnectAuth })
      socket.readyState = READY_STATE_OPEN
      socket.emitOpen()
      const sent: unknown = parseSentFrame(socket.sent)
      expect(sent).toStrictEqual({ _tag: 'PlayerResume', player: 'alice' })
    }),
  )

  it.effect('terminates when sending the resume request throws', () =>
    Effect.gen(function* () {
      const reconnectAuth = makeReconnectAuth()
      const { socket, transport } = yield* openTransport({ reconnectAuth })
      socket.sendShouldThrow = true
      socket.readyState = READY_STATE_OPEN
      socket.emitOpen()
      expect(transport.state()).toBe('closed')
    }),
  )

  it.effect('blocks ordinary sends until the resume handshake completes', () =>
    Effect.gen(function* () {
      const reconnectAuth = makeReconnectAuth()
      const { socket, transport } = yield* openTransport({ reconnectAuth })
      socket.readyState = READY_STATE_OPEN
      socket.emitOpen()
      const exit = yield* Effect.exit(transport.send('hello'))
      expect(exit._tag).toBe('Failure')
    }),
  )

  it.effect('accepting the resume token authenticates and unblocks sends', () =>
    Effect.gen(function* () {
      const reconnectAuth = makeReconnectAuth()
      const { socket, transport } = yield* openTransport({ reconnectAuth })
      socket.readyState = READY_STATE_OPEN
      socket.emitOpen()
      socket.emitMessage({ data: JSON.stringify({ _tag: 'PlayerResumeAccepted', player: 'alice', token: 'new-token' }) })
      expect(transport.isAuthenticated()).toBe(true)
      expect(reconnectAuth.savedTokens).toStrictEqual(['new-token'])
      yield* transport.send('hello')
      expect(socket.sent[1]).toBe('hello')
    }),
  )

  it.effect('a resume acceptance never lands on the ordinary inbound queue', () =>
    Effect.gen(function* () {
      const reconnectAuth = makeReconnectAuth()
      const { socket, transport } = yield* openTransport({ reconnectAuth })
      socket.readyState = READY_STATE_OPEN
      socket.emitOpen()
      socket.emitMessage({ data: JSON.stringify({ _tag: 'PlayerResumeAccepted', player: 'alice', token: 'new-token' }) })
      const size = yield* Queue.size(transport.inbound)
      expect(size).toBe(0)
    }),
  )

  it.effect('clears the registration token once a resume token was actually sent for it', () =>
    Effect.gen(function* () {
      const reconnectAuth = makeReconnectAuth({ loadRegistrationToken: () => 'reg-token' })
      const { socket } = yield* openTransport({ reconnectAuth })
      socket.readyState = READY_STATE_OPEN
      socket.emitOpen()
      socket.emitMessage({ data: JSON.stringify({ _tag: 'PlayerResumeAccepted', player: 'alice', token: 'new-token' }) })
      expect(reconnectAuth.clearedCount.count).toBe(1)
    }),
  )

  it.effect('does not clear a registration token that was never sent', () =>
    Effect.gen(function* () {
      const reconnectAuth = makeReconnectAuth({ loadToken: () => 'existing-token' })
      const { socket } = yield* openTransport({ reconnectAuth })
      socket.readyState = READY_STATE_OPEN
      socket.emitOpen()
      socket.emitMessage({ data: JSON.stringify({ _tag: 'PlayerResumeAccepted', player: 'alice', token: 'new-token' }) })
      expect(reconnectAuth.clearedCount.count).toBe(0)
    }),
  )

  it.effect('tolerates a reconnectAuth with no clearRegistrationToken callback', () =>
    Effect.gen(function* () {
      // Deliberately omits `clearRegistrationToken` (rather than setting it to
      // `undefined`) so this exercises the option genuinely being absent.
      const savedTokens: string[] = []
      const reconnectAuth: ReconnectAuthOptions = {
        loadRegistrationToken: () => 'reg-token',
        loadToken: () => undefined,
        playerId: 'alice',
        saveToken: (token) => {
          savedTokens.push(token)
        },
      }
      const { socket, transport } = yield* openTransport({ reconnectAuth })
      socket.readyState = READY_STATE_OPEN
      socket.emitOpen()
      socket.emitMessage({ data: JSON.stringify({ _tag: 'PlayerResumeAccepted', player: 'alice', token: 'new-token' }) })
      expect(transport.isAuthenticated()).toBe(true)
    }),
  )

  it.effect('rejects a resume acceptance for a different player', () =>
    Effect.gen(function* () {
      const reconnectAuth = makeReconnectAuth()
      const { socket, transport } = yield* openTransport({ reconnectAuth })
      socket.readyState = READY_STATE_OPEN
      socket.emitOpen()
      socket.emitMessage({ data: JSON.stringify({ _tag: 'PlayerResumeAccepted', player: 'mallory', token: 'new-token' }) })
      expect(transport.state()).toBe('closed')
      expect(transport.isAuthenticated()).toBe(false)
    }),
  )

  it.effect('rejects a malformed resume acceptance (wrong field count)', () =>
    Effect.gen(function* () {
      const reconnectAuth = makeReconnectAuth()
      const { socket, transport } = yield* openTransport({ reconnectAuth })
      socket.readyState = READY_STATE_OPEN
      socket.emitOpen()
      socket.emitMessage({
        data: JSON.stringify({ _tag: 'PlayerResumeAccepted', extra: true, player: 'alice', token: 'new-token' }),
      })
      expect(transport.state()).toBe('closed')
    }),
  )

  it.effect('rejects a malformed resume acceptance (non-string token)', () =>
    Effect.gen(function* () {
      const reconnectAuth = makeReconnectAuth()
      const { socket, transport } = yield* openTransport({ reconnectAuth })
      socket.readyState = READY_STATE_OPEN
      socket.emitOpen()
      socket.emitMessage({ data: JSON.stringify({ _tag: 'PlayerResumeAccepted', player: 'alice', token: 7 }) })
      expect(transport.state()).toBe('closed')
    }),
  )

  it.effect('terminates when persisting the resume token throws', () =>
    Effect.gen(function* () {
      const reconnectAuth = makeReconnectAuth({
        saveToken: () => {
          throw new Error('storage unavailable')
        },
      })
      const { socket, transport } = yield* openTransport({ reconnectAuth })
      socket.readyState = READY_STATE_OPEN
      socket.emitOpen()
      socket.emitMessage({ data: JSON.stringify({ _tag: 'PlayerResumeAccepted', player: 'alice', token: 'new-token' }) })
      expect(transport.state()).toBe('closed')
    }),
  )

  it.effect('a resume-shaped frame arriving after authentication is silently dropped', () =>
    Effect.gen(function* () {
      const reconnectAuth = makeReconnectAuth()
      const { socket, transport } = yield* openTransport({ reconnectAuth })
      socket.readyState = READY_STATE_OPEN
      socket.emitOpen()
      socket.emitMessage({ data: JSON.stringify({ _tag: 'PlayerResumeAccepted', player: 'alice', token: 'first' }) })
      socket.emitMessage({ data: JSON.stringify({ _tag: 'PlayerResumeAccepted', player: 'alice', token: 'second' }) })
      expect(reconnectAuth.savedTokens).toStrictEqual(['first'])
      const size = yield* Queue.size(transport.inbound)
      expect(size).toBe(0)
    }),
  )

  it.effect('ordinary traffic still reaches inbound once authenticated', () =>
    Effect.gen(function* () {
      const reconnectAuth = makeReconnectAuth()
      const { socket, transport } = yield* openTransport({ reconnectAuth })
      socket.readyState = READY_STATE_OPEN
      socket.emitOpen()
      socket.emitMessage({ data: JSON.stringify({ _tag: 'PlayerResumeAccepted', player: 'alice', token: 'tok' }) })
      socket.emitMessage({ data: 'ordinary-frame' })
      expect(yield* Queue.take(transport.inbound)).toBe('ordinary-frame')
    }),
  )
})

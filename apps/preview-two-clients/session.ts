/**
 * Two clients in one process, over one loopback transport pair.
 *
 * A dev application, not shipped API.
 *
 * ---------------------------------------------------------------------------
 * Nothing here reimplements the protocol
 * ---------------------------------------------------------------------------
 *
 * That is the design constraint. Every frame on screen went through
 * `domain/codec.ts`'s `encodeFrame`, crossed `domain/transport.ts`'s
 * `makeLoopbackPair` as TEXT, and came back through `decodeFrame`. Every state
 * on screen came out of `domain/connection.ts`'s `transition`. What this file
 * adds is only the two things the repository does not have and should not have:
 *
 *   1. a HANDSHAKE SCRIPT — which message a peer sends next, and which event it
 *      feeds its own machine when a message arrives. `domain/connection.ts`
 *      deliberately holds no policy (DN-8: "タイマーもスケジュールも試行回数上限も
 *      持たない"), so somebody has to say what a session looks like, and in the
 *      real game that somebody is the adapter that owns the socket.
 *   2. a FAULT INJECTOR. Dropping a frame, corrupting one, forging a frame from
 *      a protocol version this build does not speak, and killing a transport
 *      mid-handshake are the paths DN-1, DN-2 and DN-8 are about, and they are
 *      the paths that are hard to reach in a test and impossible to reach by
 *      hand against a real peer.
 *
 * ---------------------------------------------------------------------------
 * Why the loopback is a real test double and not a shortcut
 * ---------------------------------------------------------------------------
 *
 * `TransportService.send` takes `WireText`. `docs/testing.md` §3 spells out what
 * that buys: an echo, or a Port that carried `NetworkMessage` values, would pass
 * the object through by reference and every codec bug would survive every
 * loopback test. Here `corrupt` can flip a byte in the middle of a frame,
 * because there genuinely is a frame.
 *
 * ---------------------------------------------------------------------------
 * No clock, and that is DN-3
 * ---------------------------------------------------------------------------
 *
 * `Ping`/`Pong` match on a nonce. The nonce here is a counter owned by the
 * session, not a timestamp, and the preview never measures a round trip in
 * milliseconds — there is nothing to measure in one process, and reaching for
 * `Date.now()` to make a prettier number would reintroduce the exact field
 * DN-3 removed from the protocol.
 */
import { Effect, Either, Queue } from 'effect'
import { type WireText, decodeFrame, encodeFrame, encodeFrameAsVersion } from '../../src/domain/codec'
import {
  type ConnectionEvent,
  type ConnectionState,
  canSend,
  initialConnectionState,
  transition,
} from '../../src/domain/connection'
import { ProtocolError, TransportError } from '../../src/domain/errors'
import {
  type TransportService,
  disconnectedTransport,
  makeLoopbackPair,
} from '../../src/domain/transport'
import {
  type NetworkMessage,
  PROTOCOL_VERSION,
  PlayerId,
  PlayerName,
  WorldId,
} from '../../src/domain/protocol'

export type SideName = 'client' | 'server'

export const OTHER: Readonly<Record<SideName, SideName>> = {
  client: 'server',
  server: 'client',
}

/**
 * A frame's life, from the sender's intent to the receiver's verdict.
 *
 * Recorded as ONE row rather than as a send event and a receive event, because
 * the interesting question about every fault below is "what did the far end make
 * of it", and splitting the row is how a reader ends up matching them by eye.
 */
export type WireRow = {
  readonly seq: number
  readonly from: SideName
  readonly tag: string
  readonly version: number
  readonly bytes: number
  /** `undefined` when the send itself failed or the frame never left. */
  readonly text: WireText | undefined
  readonly fault: string | undefined
  /** What actually happened at the far end, in the far end's own words. */
  readonly verdict: string
  readonly failed: boolean
}

export type EventRow = {
  readonly seq: number
  readonly side: SideName
  readonly event: string
  readonly from: string
  readonly to: string
  /** True when `transition` answered `undefined`: the event was illegal here. */
  readonly rejected: boolean
}

export type Peer = {
  readonly name: SideName
  transport: TransportService
  state: ConnectionState
  /** Set once this peer has decided who it is talking to. */
  identity: string | undefined
  rejectedEvents: number
  /** Nonces this peer has sent and not yet seen answered. */
  outstandingPings: ReadonlyArray<number>
}

/**
 * A one-shot modifier applied to the NEXT frame that leaves a peer.
 *
 * One-shot rather than sticky on purpose: a preview where every frame is
 * corrupted shows one failure repeatedly, and the thing worth watching is what a
 * session does with ONE bad frame in the middle of a good one.
 */
export type WireFault =
  | 'none'
  /** The frame is encoded and then not delivered. The sender learns nothing. */
  | 'drop'
  /** One character of the frame text is replaced. */
  | 'corrupt'
  /** Encoded at `PROTOCOL_VERSION + 1` — a peer from a newer build. */
  | 'wrong-version'
  /**
   * A frame from a newer build carrying a message tag THIS build has never
   * heard of. `encodeFrame` cannot produce one (the union is this build's), so
   * the text is written out directly — which is exactly what the newer peer's
   * own codec would put on the wire.
   */
  | 'future-message'
  /** The sender's transport dies before the write. */
  | 'kill-transport'

export const WIRE_FAULTS: ReadonlyArray<WireFault> = [
  'none',
  'drop',
  'corrupt',
  'wrong-version',
  'future-message',
  'kill-transport',
]

export const WIRE_FAULT_HELP: Readonly<Record<WireFault, string>> = {
  corrupt: 'flip one character of the next frame text -> malformed-frame at the far end',
  drop: 'encode the next frame and never deliver it — the sender learns nothing',
  'future-message': 'forge a frame from a newer build carrying a tag this build has never heard of',
  'kill-transport': 'replace the sender`s transport with one that refuses every write',
  none: 'deliver the next frame intact',
  'wrong-version': `encode the next frame at protocol ${String(PROTOCOL_VERSION + 1)} -> unsupported-protocol-version`,
}

export type Session = {
  readonly client: Peer
  readonly server: Peer
  wire: ReadonlyArray<WireRow>
  events: ReadonlyArray<EventRow>
  seq: number
  /** Index into `SCRIPT`. */
  step: number
  armed: WireFault
  nextNonce: number
  note: string
}

const peer = (name: SideName, transport: TransportService): Peer => ({
  identity: undefined,
  name,
  outstandingPings: [],
  rejectedEvents: 0,
  state: initialConnectionState,
  transport,
})

export const makeSession: Effect.Effect<Session> = Effect.gen(function* () {
  const [clientTransport, serverTransport] = yield* makeLoopbackPair
  return {
    armed: 'none',
    client: peer('client', clientTransport),
    events: [],
    nextNonce: 1,
    note: 'press SPACE to advance one step of the handshake, f to arm a fault, ? for help',
    seq: 0,
    server: peer('server', serverTransport),
    step: 0,
    wire: [],
  }
})

export const sideOf = (session: Session, name: SideName): Peer =>
  name === 'client' ? session.client : session.server

const describeState = (state: ConnectionState): string => {
  switch (state._tag) {
    case 'Disconnected':
      return 'Disconnected'
    case 'Connecting':
      return `Connecting(attempt ${String(state.attempt)})`
    case 'Connected':
      return `Connected(${String(state.player)}@${String(state.world)})`
    case 'Closed':
      return `Closed(${state.reason})`
  }
}

export const stateLabel: (state: ConnectionState) => string = describeState

const describeEvent = (event: ConnectionEvent): string => {
  switch (event._tag) {
    case 'TransportFailed':
      return `TransportFailed(${event.reason})`
    case 'HandshakeSucceeded':
      return `HandshakeSucceeded(${String(event.player)})`
    default:
      return event._tag
  }
}

/**
 * Feed one event to one peer's machine and record what the machine said.
 *
 * `transition` answers `undefined` for an illegal event rather than the
 * unchanged state, and DN-8 explains why: a caller that gets the unchanged state
 * cannot tell "nothing to do" from "you asked for something incoherent". This
 * preview therefore keeps the peer in its old state and COUNTS the rejection,
 * which is what an adapter would have to do, and puts the count on screen.
 */
export const fire = (session: Session, name: SideName, event: ConnectionEvent): void => {
  const target = sideOf(session, name)
  const before = target.state
  const next = transition(before, event)
  session.seq += 1

  if (next === undefined) {
    target.rejectedEvents += 1
    session.events = [
      ...session.events,
      {
        event: describeEvent(event),
        from: describeState(before),
        rejected: true,
        seq: session.seq,
        side: name,
        to: 'REJECTED (transition returned undefined)',
      },
    ]
    return
  }

  target.state = next
  if (next._tag === 'Connected') {
    target.identity = `${String(next.player)}@${String(next.world)}`
  }
  session.events = [
    ...session.events,
    {
      event: describeEvent(event),
      from: describeState(before),
      rejected: false,
      seq: session.seq,
      side: name,
      to: describeState(next),
    },
  ]
}

/** The one message tag a build one version newer might reasonably add. */
const FUTURE_TAG = 'EntitySnapshot'

const forgeFutureFrame = (): WireText =>
  JSON.stringify({
    message: { _tag: FUTURE_TAG, entities: [{ id: 'zombie-1', at: { x: 0, y: 64, z: 0 } }] },
    protocolVersion: PROTOCOL_VERSION + 1,
  })

const corrupt = (text: WireText): WireText => {
  // The middle character, so the damage lands inside the payload rather than on
  // The opening brace. A frame that fails on its first byte is a less
  // Interesting frame than one that parses halfway.
  const at = Math.floor(text.length / 2)
  return `${text.slice(0, at)}~${text.slice(at + 1)}`
}

const tagOf = (message: NetworkMessage): string => message._tag

/**
 * Send one message from one peer, applying whatever fault is armed.
 *
 * Note the order: the state machine is NOT consulted. `domain/connection.ts:59`
 * says "Frames may only be sent from `Connected`. Enforced by `TransportPort`",
 * and this function is the place that claim would have to be true. It is left
 * unenforced here deliberately, so that `--stats` can measure whether any
 * implementation in the repository enforces it. The `send-while-connecting`
 * fault is what makes the answer visible.
 */
export const send = (
  session: Session,
  from: SideName,
  message: NetworkMessage,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const sender = sideOf(session, from)
    const receiver = sideOf(session, OTHER[from])
    const fault = session.armed
    session.armed = 'none'
    session.seq += 1

    const record = (row: Omit<WireRow, 'seq'>): void => {
      session.wire = [...session.wire, { seq: session.seq, ...row }]
    }

    if (fault === 'kill-transport') {
      // A socket that died between two writes. `disconnectedTransport` is the
      // Repository's own stand-in for exactly this and fails every send with a
      // Typed `TransportError` (`domain/transport.ts:110-128`).
      sender.transport = yield* disconnectedTransport
    }

    const encoded: Either.Either<WireText, ProtocolError> =
      fault === 'wrong-version'
        ? encodeFrameAsVersion(PROTOCOL_VERSION + 1, message)
        : fault === 'future-message'
          ? Either.right(forgeFutureFrame())
          : encodeFrame(message)

    if (Either.isLeft(encoded)) {
      // DN-5's whole point: an invalid value fails at the SENDER, where the
      // Originating code is still on the stack, instead of arriving at the far
      // End as an undebuggable decode failure.
      record({
        bytes: 0,
        failed: true,
        fault: fault === 'none' ? undefined : fault,
        from,
        tag: tagOf(message),
        text: undefined,
        verdict: `encode refused: ProtocolError(${encoded.left.reason})`,
        version: PROTOCOL_VERSION,
      })
      return
    }

    const text = fault === 'corrupt' ? corrupt(encoded.right) : encoded.right
    const version =
      fault === 'wrong-version' || fault === 'future-message' ? PROTOCOL_VERSION + 1 : PROTOCOL_VERSION
    const tag = fault === 'future-message' ? FUTURE_TAG : tagOf(message)

    if (fault === 'drop') {
      record({
        bytes: text.length,
        failed: false,
        fault,
        from,
        tag,
        text,
        verdict: 'DROPPED in flight — the sender sees success, the receiver sees nothing',
        version,
      })
      return
    }

    const sent = yield* Effect.either(sender.transport.send(text))
    if (Either.isLeft(sent)) {
      const error: TransportError = sent.left
      record({
        bytes: text.length,
        failed: true,
        fault: fault === 'none' ? undefined : fault,
        from,
        tag,
        text,
        verdict: `send refused: TransportError(${error.reason})`,
        version,
      })
      // A refused write is a transport problem, and the machine has an event for
      // It that carries the reason all the way to `Closed` so the UI can be
      // Truthful (`domain/connection.ts:37-41`).
      fire(session, from, { _tag: 'TransportFailed', reason: error.reason })
      return
    }

    record({
      bytes: text.length,
      failed: false,
      fault: fault === 'none' ? undefined : fault,
      from,
      tag,
      text,
      verdict: `in flight -> ${receiver.name}`,
      version,
    })
  })

export type Received = {
  readonly ok: ReadonlyArray<NetworkMessage>
  readonly failures: ReadonlyArray<ProtocolError>
}

/**
 * Drain everything waiting for one peer and decode it.
 *
 * `Queue.takeAll` rather than `receiveMessage`: the shipped helper takes ONE
 * frame and blocks until one arrives, which is right for a fiber and wrong for a
 * keystroke. Draining also makes the "dropped frame" fault legible — the queue
 * is empty, and it is empty because nothing was ever offered.
 */
export const pump = (session: Session, name: SideName): Effect.Effect<Received> =>
  Effect.gen(function* () {
    const target = sideOf(session, name)
    const frames = yield* Queue.takeAll(target.transport.inbound)
    const ok: Array<NetworkMessage> = []
    const failures: Array<ProtocolError> = []

    for (const text of frames) {
      session.seq += 1
      const decoded = decodeFrame(text)
      if (Either.isLeft(decoded)) {
        failures.push(decoded.left)
        session.wire = [
          ...session.wire,
          {
            bytes: text.length,
            failed: true,
            fault: undefined,
            from: OTHER[name],
            seq: session.seq,
            tag: '?',
            text,
            verdict: `${name} rejected: ProtocolError(${decoded.left.reason})`,
            version: 0,
          },
        ]
        continue
      }
      ok.push(decoded.right)
      session.wire = [
        ...session.wire,
        {
          bytes: text.length,
          failed: false,
          fault: undefined,
          from: OTHER[name],
          seq: session.seq,
          tag: decoded.right._tag,
          text,
          verdict: `${name} accepted ${decoded.right._tag}`,
          version: PROTOCOL_VERSION,
        },
      ]
    }

    return { failures, ok }
  })

// ---------------------------------------------------------------------------
// The handshake script
// ---------------------------------------------------------------------------

const ALICE = PlayerId.make('alice')
const ALICE_NAME = PlayerName.make('Alice')
const OVERWORLD = WorldId.make('overworld')

export type ScriptStep = {
  readonly label: string
  /** What a reader should be watching while this step runs. */
  readonly watch: string
  readonly run: (session: Session) => Effect.Effect<void>
}

/**
 * Apply the protocol consequences of the messages a peer just accepted.
 *
 * This is the part the repository deliberately does NOT own. DN-9 is emphatic
 * about it: `ClaimDenied` may be a message, but deciding who to deny may not
 * live in the network layer. So the rules below are the thinnest possible
 * session policy — enough to make a handshake happen — and nothing here decides
 * a game outcome.
 */
const applyServer = (session: Session, received: Received): Effect.Effect<void> =>
  Effect.gen(function* () {
    for (const message of received.ok) {
      switch (message._tag) {
        case 'PlayerJoin': {
          fire(session, 'server', { _tag: 'ConnectRequested' })
          fire(session, 'server', {
            _tag: 'HandshakeSucceeded',
            player: message.player,
            world: OVERWORLD,
          })
          break
        }
        case 'Ping': {
          yield* send(session, 'server', { _tag: 'Pong', nonce: message.nonce })
          break
        }
        case 'PlayerLeave': {
          fire(session, 'server', { _tag: 'PeerClosed' })
          break
        }
        default:
          break
      }
    }
    for (const failure of received.failures) {
      // DN-1's two verdicts, and the only place in this app that acts on the
      // Difference. A malformed frame costs the frame; an unsupported version
      // Costs the PEER.
      if (failure.reason === 'unsupported-protocol-version') {
        fire(session, 'server', { _tag: 'TransportFailed', reason: 'closed' })
      }
    }
  })

// `Effect.sync` rather than `Effect.gen`: nothing the client does on receipt
// Needs to send, so there is nothing to await. The server's twin below is a
// Generator because answering a `Ping` with a `Pong` is a send.
const applyClient = (session: Session, received: Received): Effect.Effect<void> =>
  Effect.sync(() => {
    for (const message of received.ok) {
      switch (message._tag) {
        case 'WorldInfo': {
          fire(session, 'client', {
            _tag: 'HandshakeSucceeded',
            player: ALICE,
            world: message.world,
          })
          break
        }
        case 'Pong': {
          session.client.outstandingPings = session.client.outstandingPings.filter(
            (nonce) => nonce !== message.nonce,
          )
          break
        }
        default:
          break
      }
    }
    for (const failure of received.failures) {
      if (failure.reason === 'unsupported-protocol-version') {
        fire(session, 'client', { _tag: 'TransportFailed', reason: 'closed' })
      }
    }
  })

export const SCRIPT: ReadonlyArray<ScriptStep> = [
  {
    label: 'client: ConnectRequested',
    run: (session) => Effect.sync(() => fire(session, 'client', { _tag: 'ConnectRequested' })),
    watch: 'Disconnected -> Connecting. This is the ONLY state a connect may be requested from.',
  },
  {
    label: 'client -> server: PlayerJoin',
    run: (session) =>
      send(session, 'client', { _tag: 'PlayerJoin', player: ALICE, name: ALICE_NAME, at: { x: 8.5, y: 65, z: 8.5 } }),
    watch: 'the handshake is in flight; the client is NOT Connected yet and must not be sending',
  },
  {
    label: 'server: drain and handle',
    run: (session) => Effect.flatMap(pump(session, 'server'), (received) => applyServer(session, received)),
    watch: 'the server runs its own machine: ConnectRequested then HandshakeSucceeded',
  },
  {
    label: 'server -> client: WorldInfo',
    watch: 'the server answers on the same pair — a loopback PAIR, not an echo',
    // Conditional, and that is the whole value of the step under fault
    // Injection: a server that never accepted a join has nothing to answer. A
    // Script that sent WorldInfo unconditionally would let the client reach
    // `Connected` off a handshake that never happened, which is a preview
    // Lying about a failure it was built to show.
    run: (session) =>
      session.server.state._tag === 'Connected'
        ? send(session, 'server', { _tag: 'WorldInfo', seed: 1_337, world: OVERWORLD })
        : Effect.sync(() => {
            session.note = `server is ${session.server.state._tag}, so there is no handshake to answer`
          }),
  },
  {
    label: 'client: drain and handle',
    run: (session) => Effect.flatMap(pump(session, 'client'), (received) => applyClient(session, received)),
    watch: 'the client reaches Connected and carries the identity out of the handshake',
  },
  {
    label: 'client -> server: PlayerMove',
    run: (session) =>
      send(session, 'client', {
        _tag: 'PlayerMove',
        player: ALICE,
        at: { x: 8.5, y: 65.125, z: -12.25 },
        facing: { yawRadians: 1.5, pitchRadians: -0.25 },
      }),
    watch: 'fractional coordinates survive the JSON round trip exactly (DN-5)',
  },
  {
    label: 'client -> server: Chat',
    run: (session) => send(session, 'client', { _tag: 'Chat', player: ALICE, text: 'hello 世界' }),
    watch: 'non-ASCII text survives; `maxLength(256)` is checked at the SENDER',
  },
  {
    label: 'client -> server: BlockPlace(unobtainium)',
    run: (session) =>
      send(session, 'client', { _tag: 'BlockPlace', player: ALICE, at: { x: 1, y: 64, z: 2 }, block: 'unobtainium' }),
    watch: 'a block name this build does not know DECODES (DN-6) — content skew is not corruption',
  },
  {
    label: 'server: drain and handle',
    run: (session) => Effect.flatMap(pump(session, 'server'), (received) => applyServer(session, received)),
    watch: 'three frames arrive in send order — a reordered pair leaves an avatar behind permanently',
  },
  {
    label: 'client -> server: Ping(nonce)',
    run: (session) =>
      Effect.gen(function* () {
        const nonce = session.nextNonce
        session.nextNonce += 1
        session.client.outstandingPings = [...session.client.outstandingPings, nonce]
        yield* send(session, 'client', { _tag: 'Ping', nonce })
      }),
    watch: 'a NONCE, not a timestamp (DN-3). No clock is read anywhere in this app.',
  },
  {
    label: 'server: drain and answer Pong',
    run: (session) => Effect.flatMap(pump(session, 'server'), (received) => applyServer(session, received)),
    watch: 'the server answers with the same nonce; matching is what the nonce is for',
  },
  {
    label: 'client: drain and match the nonce',
    run: (session) => Effect.flatMap(pump(session, 'client'), (received) => applyClient(session, received)),
    watch: 'outstanding pings returns to 0 without anybody reading a clock',
  },
  {
    label: 'client -> server: PlayerLeave',
    run: (session) => send(session, 'client', { _tag: 'PlayerLeave', player: ALICE }),
    watch: 'an orderly goodbye',
  },
  {
    label: 'server: drain, then PeerClosed',
    run: (session) => Effect.flatMap(pump(session, 'server'), (received) => applyServer(session, received)),
    watch: 'the server goes Connected -> Closed(closed)',
  },
  {
    label: 'client: CloseRequested',
    run: (session) => Effect.sync(() => fire(session, 'client', { _tag: 'CloseRequested' })),
    watch: 'Connected -> Disconnected. The session is over and both machines are settled.',
  },
]

export const advance = (session: Session): Effect.Effect<void> =>
  Effect.gen(function* () {
    const step = SCRIPT[session.step]
    if (step === undefined) {
      session.note = 'the script is finished — press r to reset, or send frames by hand'
      return
    }
    yield* step.run(session)
    session.step += 1
    session.note = `${String(session.step)}/${String(SCRIPT.length)}  ${step.label}`
  })

export const runScript = (session: Session): Effect.Effect<void> =>
  Effect.gen(function* () {
    while (session.step < SCRIPT.length) {
      yield* advance(session)
    }
  })

// ---------------------------------------------------------------------------
// State-machine faults — fired immediately, against whatever state we are in
// ---------------------------------------------------------------------------

export type MachineFault = {
  readonly key: string
  readonly label: string
  readonly why: string
  readonly run: (session: Session) => Effect.Effect<void>
}

export const MACHINE_FAULTS: ReadonlyArray<MachineFault> = [
  {
    key: 'a',
    label: 'client: a second ConnectRequested',
    run: (session) => Effect.sync(() => fire(session, 'client', { _tag: 'ConnectRequested' })),
    why: 'DN-8: absorbing this is how a reconnect storm is written. Legal only from Disconnected.',
  },
  {
    key: 'b',
    label: 'client: ConnectRequested from wherever we are',
    run: (session) => Effect.sync(() => fire(session, 'client', { _tag: 'ConnectRequested' })),
    why: 'DN-8: re-entry into Connecting must be RetryRequested, never a reused ConnectRequested.',
  },
  {
    key: 'c',
    label: 'client: RetryRequested',
    run: (session) => Effect.sync(() => fire(session, 'client', { _tag: 'RetryRequested' })),
    why: 'the one legal way back into Connecting. Watch `attempt`.',
  },
  {
    key: 'd',
    label: 'client: HandshakeFailed',
    run: (session) => Effect.sync(() => fire(session, 'client', { _tag: 'HandshakeFailed' })),
    why: 'the handshake times out or the peer refuses. -> Closed(closed).',
  },
  {
    key: 'e',
    label: 'client: PeerClosed',
    run: (session) => Effect.sync(() => fire(session, 'client', { _tag: 'PeerClosed' })),
    why: 'the socket`s close event. Fire it twice and watch the second one.',
  },
  {
    key: 'w',
    label: 'client: send a Chat right now, whatever the state says',
    run: (session) =>
      send(session, 'client', { _tag: 'Chat', player: ALICE, text: 'sent from the wrong state' }),
    why: 'Raw transport access bypasses the optional connection gate for handshake and compatibility.',
  },
  {
    key: 'z',
    label: 'client: send a Chat of 300 characters',
    run: (session) =>
      send(session, 'client', { _tag: 'Chat', player: ALICE, text: 'x'.repeat(300) }),
    why: 'DN-5: an invalid value must fail at the SENDER, where the originating code still is.',
  },
]

/** Whether this peer would be allowed to send, per the machine. */
export const maySend = (target: Peer): boolean => canSend(target.state)

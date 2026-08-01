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
import { decodeFrame, encodeFrame, encodeFrameAsVersion, type WireText } from '../../src/domain/codec'
import {
  canSend,
  initialConnectionState,
  transition,
  type ConnectionEvent,
  type ConnectionState,
} from '../../src/domain/connection'
import { ProtocolError, TransportError } from '../../src/domain/errors'
import {
  disconnectedTransport,
  makeLoopbackPair,
  type TransportService,
} from '../../src/domain/transport'
import {
  PROTOCOL_VERSION,
  PlayerId,
  PlayerName,
  WorldId,
  type NetworkMessage,
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
  none: 'deliver the next frame intact',
  drop: 'encode the next frame and never deliver it — the sender learns nothing',
  corrupt: 'flip one character of the next frame text -> malformed-frame at the far end',
  'wrong-version': `encode the next frame at protocol ${String(PROTOCOL_VERSION + 1)} -> unsupported-protocol-version`,
  'future-message': 'forge a frame from a newer build carrying a tag this build has never heard of',
  'kill-transport': 'replace the sender`s transport with one that refuses every write',
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
  name,
  transport,
  state: initialConnectionState,
  identity: undefined,
  rejectedEvents: 0,
  outstandingPings: [],
})

export const makeSession: Effect.Effect<Session> = Effect.gen(function* () {
  const [clientTransport, serverTransport] = yield* makeLoopbackPair
  return {
    client: peer('client', clientTransport),
    server: peer('server', serverTransport),
    wire: [],
    events: [],
    seq: 0,
    step: 0,
    armed: 'none',
    nextNonce: 1,
    note: 'press SPACE to advance one step of the handshake, f to arm a fault, ? for help',
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

export const stateLabel = describeState

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
        seq: session.seq,
        side: name,
        event: describeEvent(event),
        from: describeState(before),
        to: 'REJECTED (transition returned undefined)',
        rejected: true,
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
      seq: session.seq,
      side: name,
      event: describeEvent(event),
      from: describeState(before),
      to: describeState(next),
      rejected: false,
    },
  ]
}

/** The one message tag a build one version newer might reasonably add. */
const FUTURE_TAG = 'EntitySnapshot'

const forgeFutureFrame = (): WireText =>
  JSON.stringify({
    protocolVersion: PROTOCOL_VERSION + 1,
    message: { _tag: FUTURE_TAG, entities: [{ id: 'zombie-1', at: { x: 0, y: 64, z: 0 } }] },
  })

const corrupt = (text: WireText): WireText => {
  // The middle character, so the damage lands inside the payload rather than on
  // the opening brace. A frame that fails on its first byte is a less
  // interesting frame than one that parses halfway.
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
      // repository's own stand-in for exactly this and fails every send with a
      // typed `TransportError` (`domain/transport.ts:110-128`).
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
      // originating code is still on the stack, instead of arriving at the far
      // end as an undebuggable decode failure.
      record({
        from,
        tag: tagOf(message),
        version: PROTOCOL_VERSION,
        bytes: 0,
        text: undefined,
        fault: fault === 'none' ? undefined : fault,
        verdict: `encode refused: ProtocolError(${encoded.left.reason})`,
        failed: true,
      })
      return
    }

    const text = fault === 'corrupt' ? corrupt(encoded.right) : encoded.right
    const version =
      fault === 'wrong-version' || fault === 'future-message' ? PROTOCOL_VERSION + 1 : PROTOCOL_VERSION
    const tag = fault === 'future-message' ? FUTURE_TAG : tagOf(message)

    if (fault === 'drop') {
      record({
        from,
        tag,
        version,
        bytes: text.length,
        text,
        fault,
        verdict: 'DROPPED in flight — the sender sees success, the receiver sees nothing',
        failed: false,
      })
      return
    }

    const sent = yield* Effect.either(sender.transport.send(text))
    if (Either.isLeft(sent)) {
      const error: TransportError = sent.left
      record({
        from,
        tag,
        version,
        bytes: text.length,
        text,
        fault: fault === 'none' ? undefined : fault,
        verdict: `send refused: TransportError(${error.reason})`,
        failed: true,
      })
      // A refused write is a transport problem, and the machine has an event for
      // it that carries the reason all the way to `Closed` so the UI can be
      // truthful (`domain/connection.ts:37-41`).
      fire(session, from, { _tag: 'TransportFailed', reason: error.reason })
      return
    }

    record({
      from,
      tag,
      version,
      bytes: text.length,
      text,
      fault: fault === 'none' ? undefined : fault,
      verdict: `in flight -> ${receiver.name}`,
      failed: false,
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
            seq: session.seq,
            from: OTHER[name],
            tag: '?',
            version: 0,
            bytes: text.length,
            text,
            fault: undefined,
            verdict: `${name} rejected: ProtocolError(${decoded.left.reason})`,
            failed: true,
          },
        ]
        continue
      }
      ok.push(decoded.right)
      session.wire = [
        ...session.wire,
        {
          seq: session.seq,
          from: OTHER[name],
          tag: decoded.right._tag,
          version: PROTOCOL_VERSION,
          bytes: text.length,
          text,
          fault: undefined,
          verdict: `${name} accepted ${decoded.right._tag}`,
          failed: false,
        },
      ]
    }

    return { ok, failures }
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
      // difference. A malformed frame costs the frame; an unsupported version
      // costs the PEER.
      if (failure.reason === 'unsupported-protocol-version') {
        fire(session, 'server', { _tag: 'TransportFailed', reason: 'closed' })
      }
    }
  })

// `Effect.sync` rather than `Effect.gen`: nothing the client does on receipt
// needs to send, so there is nothing to await. The server's twin below is a
// generator because answering a `Ping` with a `Pong` is a send.
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
    watch: 'Disconnected -> Connecting. This is the ONLY state a connect may be requested from.',
    run: (session) => Effect.sync(() => fire(session, 'client', { _tag: 'ConnectRequested' })),
  },
  {
    label: 'client -> server: PlayerJoin',
    watch: 'the handshake is in flight; the client is NOT Connected yet and must not be sending',
    run: (session) =>
      send(session, 'client', { _tag: 'PlayerJoin', player: ALICE, name: ALICE_NAME, at: { x: 8.5, y: 65, z: 8.5 } }),
  },
  {
    label: 'server: drain and handle',
    watch: 'the server runs its own machine: ConnectRequested then HandshakeSucceeded',
    run: (session) => Effect.flatMap(pump(session, 'server'), (received) => applyServer(session, received)),
  },
  {
    label: 'server -> client: WorldInfo',
    watch: 'the server answers on the same pair — a loopback PAIR, not an echo',
    // Conditional, and that is the whole value of the step under fault
    // injection: a server that never accepted a join has nothing to answer. A
    // script that sent WorldInfo unconditionally would let the client reach
    // `Connected` off a handshake that never happened, which is a preview
    // lying about a failure it was built to show.
    run: (session) =>
      session.server.state._tag === 'Connected'
        ? send(session, 'server', { _tag: 'WorldInfo', world: OVERWORLD, seed: 1_337 })
        : Effect.sync(() => {
            session.note = `server is ${session.server.state._tag}, so there is no handshake to answer`
          }),
  },
  {
    label: 'client: drain and handle',
    watch: 'the client reaches Connected and carries the identity out of the handshake',
    run: (session) => Effect.flatMap(pump(session, 'client'), (received) => applyClient(session, received)),
  },
  {
    label: 'client -> server: PlayerMove',
    watch: 'fractional coordinates survive the JSON round trip exactly (DN-5)',
    run: (session) =>
      send(session, 'client', {
        _tag: 'PlayerMove',
        player: ALICE,
        at: { x: 8.5, y: 65.125, z: -12.25 },
        facing: { yawRadians: 1.5, pitchRadians: -0.25 },
      }),
  },
  {
    label: 'client -> server: Chat',
    watch: 'non-ASCII text survives; `maxLength(256)` is checked at the SENDER',
    run: (session) => send(session, 'client', { _tag: 'Chat', player: ALICE, text: 'hello 世界' }),
  },
  {
    label: 'client -> server: BlockPlace(unobtainium)',
    watch: 'a block name this build does not know DECODES (DN-6) — content skew is not corruption',
    run: (session) =>
      send(session, 'client', { _tag: 'BlockPlace', player: ALICE, at: { x: 1, y: 64, z: 2 }, block: 'unobtainium' }),
  },
  {
    label: 'server: drain and handle',
    watch: 'three frames arrive in send order — a reordered pair leaves an avatar behind permanently',
    run: (session) => Effect.flatMap(pump(session, 'server'), (received) => applyServer(session, received)),
  },
  {
    label: 'client -> server: Ping(nonce)',
    watch: 'a NONCE, not a timestamp (DN-3). No clock is read anywhere in this app.',
    run: (session) =>
      Effect.gen(function* () {
        const nonce = session.nextNonce
        session.nextNonce += 1
        session.client.outstandingPings = [...session.client.outstandingPings, nonce]
        yield* send(session, 'client', { _tag: 'Ping', nonce })
      }),
  },
  {
    label: 'server: drain and answer Pong',
    watch: 'the server answers with the same nonce; matching is what the nonce is for',
    run: (session) => Effect.flatMap(pump(session, 'server'), (received) => applyServer(session, received)),
  },
  {
    label: 'client: drain and match the nonce',
    watch: 'outstanding pings returns to 0 without anybody reading a clock',
    run: (session) => Effect.flatMap(pump(session, 'client'), (received) => applyClient(session, received)),
  },
  {
    label: 'client -> server: PlayerLeave',
    watch: 'an orderly goodbye',
    run: (session) => send(session, 'client', { _tag: 'PlayerLeave', player: ALICE }),
  },
  {
    label: 'server: drain, then PeerClosed',
    watch: 'the server goes Connected -> Closed(closed)',
    run: (session) => Effect.flatMap(pump(session, 'server'), (received) => applyServer(session, received)),
  },
  {
    label: 'client: CloseRequested',
    watch: 'Connected -> Disconnected. The session is over and both machines are settled.',
    run: (session) => Effect.sync(() => fire(session, 'client', { _tag: 'CloseRequested' })),
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
    why: 'DN-8: absorbing this is how a reconnect storm is written. Legal only from Disconnected.',
    run: (session) => Effect.sync(() => fire(session, 'client', { _tag: 'ConnectRequested' })),
  },
  {
    key: 'b',
    label: 'client: ConnectRequested from wherever we are',
    why: 'DN-8: re-entry into Connecting must be RetryRequested, never a reused ConnectRequested.',
    run: (session) => Effect.sync(() => fire(session, 'client', { _tag: 'ConnectRequested' })),
  },
  {
    key: 'c',
    label: 'client: RetryRequested',
    why: 'the one legal way back into Connecting. Watch `attempt`.',
    run: (session) => Effect.sync(() => fire(session, 'client', { _tag: 'RetryRequested' })),
  },
  {
    key: 'd',
    label: 'client: HandshakeFailed',
    why: 'the handshake times out or the peer refuses. -> Closed(closed).',
    run: (session) => Effect.sync(() => fire(session, 'client', { _tag: 'HandshakeFailed' })),
  },
  {
    key: 'e',
    label: 'client: PeerClosed',
    why: 'the socket`s close event. Fire it twice and watch the second one.',
    run: (session) => Effect.sync(() => fire(session, 'client', { _tag: 'PeerClosed' })),
  },
  {
    key: 'w',
    label: 'client: send a Chat right now, whatever the state says',
    why: 'connection.ts:59 says sending is "Enforced by TransportPort". Is it?',
    run: (session) =>
      send(session, 'client', { _tag: 'Chat', player: ALICE, text: 'sent from the wrong state' }),
  },
  {
    key: 'z',
    label: 'client: send a Chat of 300 characters',
    why: 'DN-5: an invalid value must fail at the SENDER, where the originating code still is.',
    run: (session) =>
      send(session, 'client', { _tag: 'Chat', player: ALICE, text: 'x'.repeat(300) }),
  },
]

/** Whether this peer would be allowed to send, per the machine. */
export const maySend = (target: Peer): boolean => canSend(target.state)

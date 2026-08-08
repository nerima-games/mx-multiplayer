/**
 * `--stats`: the numeric report, and the only place this app makes a claim.
 *
 * A dev application, not shipped API.
 *
 * ---------------------------------------------------------------------------
 * Everything below is MEASURED at run time. No expected value is recorded.
 * ---------------------------------------------------------------------------
 *
 * A finding printed here is NOT pinned. Fix the code and it does not "turn
 * green", it silently disappears. So a confirmed finding belongs in `test/` as
 * an assertion — a report has to be read to work, a test falls over on its own —
 * and the numbers here exist to FIND them, not to hold them.
 *
 * The checks are kept after they pass. A check deleted once it goes green
 * inspects the code exactly once.
 *
 * Every check answers a question of the form "if this were broken, what would I
 * see?". A measurement with no such answer is a number, not a check.
 */
import { Effect, Either, Queue } from 'effect'
import { decodeFrame, encodeFrame, encodeFrameAsVersion } from '../../src/domain/codec'
import {
  type ConnectionEvent,
  type ConnectionState,
  canSend,
  initialConnectionState,
  runTransitions,
  transition,
} from '../../src/domain/connection'
import {
  LoopbackTransportLayer,
  connectionGatedTransport,
  disconnectedTransport,
  makeLoopbackPair,
  sendMessage,
} from '../../src/domain/transport'
import {
  CommandId,
  EntityId,
  MESSAGE_TAGS,
  type NetworkMessage,
  PROTOCOL_VERSION,
  PlayerId,
  PlayerName,
  WorldId,
} from '../../src/domain/protocol'

const pad = (text: string, width: number): string =>
  text.length >= width ? text : text + ' '.repeat(width - text.length)

type Check = {
  readonly id: string
  readonly title: string
  readonly finding: boolean
  readonly lines: ReadonlyArray<string>
}

const ALICE = PlayerId.make('alice')
const OVERWORLD = WorldId.make('overworld')
const END = WorldId.make('end')
const COMMAND_ID = CommandId.make('command-1')
const COMMAND_HEADER = { commandId: COMMAND_ID, expectedRevision: 1, player: ALICE, world: OVERWORLD }
const ITEM = { count: 2, item: 'stone' }
const ENTITY_ID = EntityId.make('entity-1')
const ENTITY = { _tag: 'living' as const, at: { x: 1, y: 64, z: 1 }, entityId: ENTITY_ID, entityType: 'zombie', health: 20, maxHealth: 20 }

/** One sample per tag, so a check can sweep the whole message set. */
const SAMPLES: { readonly [Tag in NetworkMessage['_tag']]: Extract<NetworkMessage, { _tag: Tag }> } = {
  AuthoritativeCommandAccepted: { _tag: 'AuthoritativeCommandAccepted', commandId: COMMAND_ID, revision: 2, world: OVERWORLD },
  AuthoritativeCommandRejected: { _tag: 'AuthoritativeCommandRejected', commandId: COMMAND_ID, reason: 'stale-revision', resyncRequired: true, revision: 1, world: OVERWORLD },
  AuthoritativeResyncRequest: { _tag: 'AuthoritativeResyncRequest', lastKnownRevision: 1, world: OVERWORLD },
  AuthoritativeSnapshot: {
    _tag: 'AuthoritativeSnapshot', containers: [], entities: [ENTITY], furnaces: [], inventories: [{ player: ALICE, state: { slots: [ITEM], selectedSlot: 0 } }], revision: 1, timeWeather: { timeOfDay: 6000, weather: 'clear' }, villagerTrades: [], vitals: [{ player: ALICE, state: { health: 20, hunger: 20, experience: 0 } }], world: OVERWORLD,
  },
  BlockBreak: { _tag: 'BlockBreak', at: { x: -1, y: 0, z: -3 }, player: ALICE },
  BlockMutationRejected: {
    _tag: 'BlockMutationRejected',
    at: { x: 1, y: 2, z: 3 },
    operation: 'place',
    player: ALICE,
    reason: 'occupied',
    revision: 1,
    world: OVERWORLD,
  },
  BlockPlace: { _tag: 'BlockPlace', at: { x: 1, y: 2, z: 3 }, block: 'stone', player: ALICE },
  BowUseCommand: { _tag: 'BowUseCommand', ...COMMAND_HEADER, action: 'release' },
  BucketUseCommand: { _tag: 'BucketUseCommand', ...COMMAND_HEADER },
  Chat: { _tag: 'Chat', player: ALICE, text: 'hello 世界' },
  ContainerCommand: { _tag: 'ContainerCommand', ...COMMAND_HEADER, containerId: 'chest:1', action: { _tag: 'open' } },
  ContainerDelta: { _tag: 'ContainerDelta', revision: 2, state: { containerId: 'chest:1', kind: 'chest', slots: [ITEM] }, world: OVERWORLD },
  EndPortalUseCommand: { _tag: 'EndPortalUseCommand', ...COMMAND_HEADER, portal: { x: 1, y: 64, z: 0 } },
  EnderPearlCommand: { _tag: 'EnderPearlCommand', ...COMMAND_HEADER },
  EntityAttackCommand: { _tag: 'EntityAttackCommand', ...COMMAND_HEADER, entityId: ENTITY_ID },
  EntityDespawnDelta: { _tag: 'EntityDespawnDelta', entityId: ENTITY_ID, revision: 2, world: OVERWORLD },
  EntityPickupCommand: { _tag: 'EntityPickupCommand', ...COMMAND_HEADER, entityId: ENTITY_ID },
  EntitySpawnDelta: { _tag: 'EntitySpawnDelta', entity: ENTITY, revision: 2, world: OVERWORLD },
  EntityUpdateDelta: { _tag: 'EntityUpdateDelta', entity: { ...ENTITY, health: 19 }, revision: 2, world: OVERWORLD },
  EyeOfEnderThrown: {
    _tag: 'EyeOfEnderThrown', breaks: false, origin: { x: 1, y: 65, z: 1 }, player: ALICE, revision: 2, target: { x: 100, y: 72, z: 100 }, world: OVERWORLD,
  },
  FishingCommand: { _tag: 'FishingCommand', ...COMMAND_HEADER, action: 'cast' },
  FurnaceCommand: { _tag: 'FurnaceCommand', ...COMMAND_HEADER, furnaceId: 'furnace:1', action: { _tag: 'take-output', source: { _tag: 'furnace-slot', slot: 'output' }, destination: { _tag: 'player-slot', slot: 0 }, count: 1 } },
  FurnaceDelta: { _tag: 'FurnaceDelta', revision: 2, state: { burnTicksRemaining: 10, cookTicks: 5, fuel: null, furnaceId: 'furnace:1', input: ITEM, output: null }, world: OVERWORLD },
  IgniteTntCommand: { _tag: 'IgniteTntCommand', ...COMMAND_HEADER, at: { x: 1, y: 64, z: 0 } },
  InsertEyeIntoEndPortalFrameCommand: { _tag: 'InsertEyeIntoEndPortalFrameCommand', ...COMMAND_HEADER, frame: { x: 1, y: 64, z: 0 } },
  LightningStrikeDelta: { _tag: 'LightningStrikeDelta', at: { x: 3.5, y: 72, z: -4.5 }, revision: 2, world: OVERWORLD },
  NetherPortalUseCommand: { _tag: 'NetherPortalUseCommand', ...COMMAND_HEADER, portal: { x: 1, y: 64, z: 0 } },
  Ping: { _tag: 'Ping', nonce: 7 },
  PlayerFishingDelta: { _tag: 'PlayerFishingDelta', player: ALICE, revision: 2, state: { phase: 'waiting', result: 'cast' }, world: OVERWORLD },
  PlayerInventoryCommand: { _tag: 'PlayerInventoryCommand', ...COMMAND_HEADER, action: { _tag: 'select-slot', slot: 0 } },
  PlayerInventoryDelta: { _tag: 'PlayerInventoryDelta', player: ALICE, revision: 2, state: { selectedSlot: 0, slots: [ITEM] }, world: OVERWORLD },
  PlayerJoin: { _tag: 'PlayerJoin', at: { x: 8.5, y: 65, z: -12.25 }, name: PlayerName.make('Alice'), player: ALICE },
  PlayerLeave: { _tag: 'PlayerLeave', player: ALICE },
  PlayerMove: {
    _tag: 'PlayerMove',
    at: { x: -0.5, y: 64.125, z: 1024 },
    facing: { pitchRadians: -1.5, yawRadians: 3.14159 },
    player: ALICE,
  },
  PlayerVitalsCommand: { _tag: 'PlayerVitalsCommand', ...COMMAND_HEADER, action: 'respawn' },
  PlayerVitalsDelta: { _tag: 'PlayerVitalsDelta', player: ALICE, revision: 2, state: { experience: 0, health: 19, hunger: 18 }, world: OVERWORLD },
  Pong: { _tag: 'Pong', nonce: 7 },
  RealmTransferSnapshot: {
    _tag: 'RealmTransferSnapshot', at: { x: 0.5, y: 64, z: -4.25 }, authoritativeSnapshot: {
      _tag: 'AuthoritativeSnapshot', containers: [], entities: [], furnaces: [], inventories: [{ player: ALICE, state: { slots: [ITEM], selectedSlot: 0 } }], revision: 1, timeWeather: { timeOfDay: 6000, weather: 'clear' }, villagerTrades: [], vitals: [{ player: ALICE, state: { health: 20, hunger: 20, experience: 0 } }], world: END,
    }, commandId: COMMAND_ID, destinationWorld: END, facing: { pitchRadians: -0.25, yawRadians: 1.5 }, fromWorld: OVERWORLD, player: ALICE, worldSnapshot: { _tag: 'WorldSnapshot', blocks: [], levers: [], players: [], poweredRails: [], revision: 1, seed: 42, world: END },
  },
  ThrowEyeOfEnderCommand: { _tag: 'ThrowEyeOfEnderCommand', ...COMMAND_HEADER },
  ToggleLeverCommand: { _tag: 'ToggleLeverCommand', ...COMMAND_HEADER, lever: { x: 1, y: 64, z: 0 } },
  VehicleCommand: { _tag: 'VehicleCommand', ...COMMAND_HEADER, entityId: ENTITY_ID, action: 'mount' },
  VehicleUseCommand: { _tag: 'VehicleUseCommand', ...COMMAND_HEADER },
  VillagerTradeCommand: { _tag: 'VillagerTradeCommand', ...COMMAND_HEADER, villagerId: 'villager:1', offerId: 'offer:1', action: 'execute-trade' },
  VillagerTradeDelta: { _tag: 'VillagerTradeDelta', revision: 2, state: { offers: [{ offerId: 'offer:1', input: [ITEM], output: { item: 'emerald', count: 1 }, uses: 0, maxUses: 4 }], villagerId: 'villager:1' }, world: OVERWORLD },
  WorldInfo: { _tag: 'WorldInfo', seed: -1_234_567, world: OVERWORLD },
  WorldSnapshot: {
    _tag: 'WorldSnapshot',
    blocks: [{ world: OVERWORLD, at: { x: 1, y: 2, z: 3 }, block: 'stone' }],
    levers: [{ at: { x: 3, y: 64, z: 3 }, active: true }],
    players: [
      {
        player: ALICE,
        name: PlayerName.make('Alice'),
        world: OVERWORLD,
        at: { x: 8.5, y: 65, z: -12.25 },
        facing: { yawRadians: 3.14159, pitchRadians: -1.5 },
      },
    ],
    poweredRails: [{ at: { x: 2, y: 64, z: 3 }, powered: true }],
    revision: 1,
    seed: -1_234_567,
    world: OVERWORLD,
  },
  WorldTimeWeatherCommand: { _tag: 'WorldTimeWeatherCommand', ...COMMAND_HEADER, action: { _tag: 'set-time', timeOfDay: 6000 } },
  WorldTimeWeatherDelta: { _tag: 'WorldTimeWeatherDelta', revision: 2, state: { timeOfDay: 7000, weather: 'rain' }, world: OVERWORLD },
}

// ---------------------------------------------------------------------------
// DN-1: the versioned envelope
// ---------------------------------------------------------------------------

/**
 * A frame from a newer build is reported as CORRUPTION, not as a version skew,
 * as soon as it carries anything this build's schema does not already accept.
 *
 * `docs/design-notes.md` DN-1 states the design in one sentence:
 *
 *     バージョンはメッセージの外側に置く。内側に置くと、未知バージョンのフレームを
 *     弾くためにまず「もう存在しないかもしれないメッセージ形状」をパースする必要が
 *     生じるため。
 *
 * and `domain/protocol.ts:205-211` repeats it. The envelope IS on the outside —
 * `Frame = { protocolVersion, message }` — but `domain/codec.ts:89-99` decodes
 * the WHOLE `Frame`, message and all, and only then checks the version at
 * `:100`. So the message shape is parsed first after all, and the ordering the
 * design note describes is not the ordering the code has.
 *
 * The two verdicts are not interchangeable. `docs/design-notes.md` DN-1 assigns
 * them different responses: `malformed-frame` drops the FRAME,
 * `unsupported-protocol-version` drops the PEER and tells the user why. A player
 * whose client is one version behind therefore sees "corrupt data" instead of
 * "your client is out of date", which is precisely the confusion DN-1 exists to
 * remove — and the reference implementation's failure was the same confusion for
 * the same reason, one layer up.
 */
const versionBeforeShape = Effect.sync((): Check => {
  const forged = (message: unknown): string =>
    JSON.stringify({ message, protocolVersion: PROTOCOL_VERSION + 1 })

  // `counts` is false for the last row: a `protocolVersion` of 1.5 is not a
  // Version anybody speaks, so reporting it as a malformed envelope is
  // Defensible. It is in the table because it comes out of the same ordering,
  // And leaving it out of the count keeps the finding about the cases that
  // Matter — a peer one build ahead of this one.
  const cases: ReadonlyArray<{ readonly label: string; readonly text: string; readonly counts: boolean }> = [
    {
      counts: true,
      label: 'v2, a tag this build knows',
      text: Either.getOrThrow(encodeFrameAsVersion(PROTOCOL_VERSION + 1, SAMPLES.Ping)),
    },
    { counts: true, label: 'v2, a tag added in the newer build', text: forged({ _tag: 'EntitySnapshot', entities: [] }) },
    { counts: true, label: 'v2, a known tag whose field was renamed', text: forged({ _tag: 'Ping', requestId: 7 }) },
    {
      counts: true,
      label: 'v2, a known tag whose field was widened',
      text: forged({ _tag: 'WorldInfo', world: 'overworld', seed: 1.5 }),
    },
    {
      counts: false,
      label: 'a non-integral protocolVersion (not counted)',
      text: JSON.stringify({ protocolVersion: 1.5, message: SAMPLES.Ping }),
    },
  ]

  const rows: Array<string> = [`  ${pad('frame from the future', 46)}reason reported`]
  let misreported = 0
  let counted = 0

  for (const { label, text, counts } of cases) {
    const result = decodeFrame(text)
    const reason = Either.isLeft(result) ? result.left.reason : 'ACCEPTED'
    if (counts) {
      counted += 1
      if (reason !== 'unsupported-protocol-version') {
        misreported += 1
      }
    }
    rows.push(`  ${pad(label, 46)}${reason}`)
  }

  return {
    finding: misreported > 0,
    id: misreported === 0 ? 'ok' : 'M1',
    lines: [
      ...rows,
      '',
      `  ${String(misreported)} of ${String(counted)} frames from protocol ${String(PROTOCOL_VERSION + 1)} did NOT report unsupported-protocol-version.`,
      '',
      '  domain/codec.ts:89-99 runs the structural decode of the WHOLE Frame — `message:',
      '  NetworkMessage` included — and checks `frame.protocolVersion` afterwards at :100. The',
      '  version field is on the envelope, but it is not READ before the message is parsed, so',
      '  the ordering DN-1 asks for is not the ordering the code has.',
      '',
      '  The two verdicts get different responses (DN-1): malformed-frame drops the FRAME,',
      '  unsupported-protocol-version drops the PEER and says so to the user. A rolling upgrade',
      '  — the exact scenario DN-1 is about — therefore surfaces as "corrupt data".',
      '',
      '  Both existing version tests use a message THIS build knows, so both pass:',
      '    `rejects a frame from a version this build does not speak` uses SAMPLES.Ping',
      '    `reports a version mismatch as a version problem`         uses SAMPLES.PlayerLeave',
      '  A version bump that adds no new message is the one case that works.',
    ],
    title: 'a frame from an unsupported version is reported as malformed as soon as its shape is new',
  } satisfies Check
})

// ---------------------------------------------------------------------------
// DN-8: the connection state machine
// ---------------------------------------------------------------------------

/**
 * `ConnectionState.Connecting.attempt` can only ever be `1`.
 *
 * There are exactly two producers of `Connecting` — `Disconnected +
 * ConnectRequested` and `Closed + RetryRequested` — and both write the literal
 * `1` (`domain/connection.ts:80`, `:116`). Nothing reads the incoming state's
 * attempt count and nothing increments it, so the field is a constant wearing a
 * counter's name.
 *
 * It is also part of the public API: `Connecting` is exported and appears in
 * `api-lock.md`, so mx-ui can render "attempt 3 of 5" against a value that is
 * always 1.
 *
 * DN-8 point 3 says the machine holds "no attempt budget", and that is right —
 * a budget is a `Schedule` and belongs to the adapter. But the number of the
 * attempt is not a budget, it is a fact about the attempt in progress, and it is
 * the one thing here the adapter cannot supply because the machine overwrites
 * it. Either it should count, or it should not be in the state.
 */
const attemptIsConstant = Effect.sync((): Check => {
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

  const distinct = [...new Set(observed)]

  return {
    finding: distinct.length === 1,
    id: distinct.length === 1 ? 'M2' : 'ok',
    lines: [
      `  attempts observed   ${JSON.stringify(observed)}`,
      `  distinct values     ${JSON.stringify(distinct)}`,
      '',
      '  domain/connection.ts:80   Disconnected + ConnectRequested -> { Connecting, attempt: 1 }',
      '  domain/connection.ts:116  Closed       + RetryRequested   -> { Connecting, attempt: 1 }',
      '',
      '  Those are the only two producers, and neither reads the previous attempt. The field is',
      '  exported, is in api-lock.md, and is visible to mx-ui — which can therefore render',
      '  "attempt 1" forever. DN-8 correctly refuses to hold a retry BUDGET; the ordinal of the',
      '  attempt in flight is a different thing, and the adapter cannot supply it because the',
      '  machine overwrites it on the way in.',
      '',
      '  `test/connection.test.ts` asserts `{ Connecting, attempt: 1 }` in four places, which',
      '  pins the constant rather than the counting.',
    ],
    title: '`Connecting.attempt` is a constant: seven attempts, one value',
  } satisfies Check
})

/**
 * A settled connection rejects the events a real socket delivers after it
 * settles.
 *
 * `transition` answers `undefined` for an illegal event, and the module header
 * is explicit about what that means: "a caller that gets `undefined` has found a
 * bug in its own logic". But every socket API delivers a write failure AND a
 * subsequent close event, and a handshake that times out locally is routinely
 * followed by the peer's own close arriving on the wire. The caller has no bug;
 * the two events genuinely both happened.
 *
 * Same shape for `CloseRequested` from `Disconnected` — a user pressing
 * Disconnect on an already-disconnected session.
 *
 * This is a contract question rather than a defect: either those events are
 * legal-and-idempotent in `Closed`, or `undefined` needs a third meaning and
 * every adapter has to filter by state before it forwards. Today it silently
 * means the first while documenting the second.
 */
const terminalIdempotence = Effect.sync((): Check => {
  const sequences: ReadonlyArray<readonly [string, ReadonlyArray<ConnectionEvent>]> = [
    [
      'socket write fails, then the socket closes',
      [
        { _tag: 'ConnectRequested' },
        { _tag: 'TransportFailed', reason: 'send-failed' },
        { _tag: 'PeerClosed' },
      ],
    ],
    [
      'handshake times out locally, then the peer closes',
      [{ _tag: 'ConnectRequested' }, { _tag: 'HandshakeFailed' }, { _tag: 'PeerClosed' }],
    ],
    [
      'the user presses Disconnect twice',
      [
        { _tag: 'ConnectRequested' },
        { _tag: 'HandshakeSucceeded', player: ALICE, world: OVERWORLD },
        { _tag: 'CloseRequested' },
        { _tag: 'CloseRequested' },
      ],
    ],
  ]

  const rows: Array<string> = [`  ${pad('sequence a real adapter produces', 52)}${pad('rejected at', 13)}state`]
  let rejected = 0

  for (const [label, events] of sequences) {
    const result = runTransitions(initialConnectionState, events)
    if (result.rejectedAt !== undefined) {
      rejected += 1
    }
    rows.push(
      `  ${pad(label, 52)}${pad(result.rejectedAt === undefined ? '-' : String(result.rejectedAt), 13)}${result.state._tag}`,
    )
  }

  return {
    finding: rejected > 0,
    id: rejected > 0 ? 'M3' : 'ok',
    lines: [
      ...rows,
      '',
      `  ${String(rejected)} of ${String(sequences.length)} ordinary adapter sequences contain an event the machine calls illegal.`,
      '',
      '  domain/connection.ts:16-21: "a caller that gets `undefined` has found a bug in its own',
      '  logic". In these three the caller has no bug — a socket delivers both a write failure',
      '  and a close, and a user may press Disconnect twice.',
      '',
      '  This is a contract question, not a broken transition. Either these events are legal and',
      '  idempotent once settled, or `undefined` needs a third meaning ("already handled") and',
      '  every adapter has to filter by state before forwarding. Today it means the first while',
      '  documenting the second, and an adapter written to the documentation will log a bug',
      '  report on every ordinary disconnect.',
    ],
    title: 'a settled connection rejects the follow-up events every real socket delivers',
  } satisfies Check
})

/** Measure the adapter-level Connected-only transport gate. */
const sendGuard = Effect.gen(function* () {
  const [client, server] = yield* makeLoopbackPair

  const beforeHandshake: ConnectionState = { _tag: 'Connecting', attempt: 1 }
  const closed: ConnectionState = { _tag: 'Closed', reason: 'closed' }
  const gated = connectionGatedTransport(Effect.succeed(beforeHandshake), client)

  const attempt = yield* Effect.either(
    sendMessage(SAMPLES.Chat).pipe(Effect.provide(LoopbackTransportLayer(gated))),
  )
  const delivered = yield* Queue.size(server.inbound)

  const refusing = yield* disconnectedTransport
  const refused = yield* Effect.either(
    sendMessage(SAMPLES.Chat).pipe(Effect.provide(LoopbackTransportLayer(refusing))),
  )

  return {
    finding: delivered > 0,
    id: delivered > 0 ? 'M4' : 'ok',
    lines: [
      `  canSend(Connecting)                 ${String(canSend(beforeHandshake))}`,
      `  canSend(Closed)                     ${String(canSend(closed))}`,
      `  sendMessage from a Connecting peer  ${Either.isLeft(attempt) ? `refused: ${attempt.left._tag}` : 'ACCEPTED'}`,
      `  frames waiting at the far end       ${String(delivered)}`,
      `  disconnectedTransport refuses       ${Either.isLeft(refused) ? `yes: ${refused.left._tag}` : 'no'}`,
      '',
      '  `connectionGatedTransport` reads the supplied state for every send and returns a typed',
      '  TransportError before delegating unless that state is Connected.',
      '  Raw transports remain available for handshake traffic and backward compatibility.',
    ],
    title: 'Connected-only transport gate',
  } satisfies Check
})

// ---------------------------------------------------------------------------
// Checks that pass — kept, because a check deleted on green inspects once
// ---------------------------------------------------------------------------

/** Every message survives a real send across a real pair. */
const loopbackRoundTrip = Effect.gen(function* () {
  const [client, server] = yield* makeLoopbackPair
  const asClient = LoopbackTransportLayer(client)

  for (const tag of MESSAGE_TAGS) {
    // `orDie` rather than a handler: every sample here is valid by construction,
    // So a failure would be a bug in this file and should stop the report rather
    // Than be reported as a finding about the repository.
    yield* sendMessage(SAMPLES[tag]).pipe(Effect.provide(asClient), Effect.orDie)
  }

  const frames = yield* Queue.takeAll(server.inbound)
  const decoded = [...frames].map((text) => decodeFrame(text))
  const failures = decoded.filter(Either.isLeft).length
  const order = decoded
    .filter(Either.isRight)
    .map((result) => result.right._tag)
    .join(' ')
  const inOrder = order === MESSAGE_TAGS.join(' ')

  return {
    finding: failures > 0 || !inOrder,
    id: failures === 0 && inOrder ? 'ok' : 'M-roundtrip',
    lines: [
      `  tags sent            ${String(MESSAGE_TAGS.length)}`,
      `  frames received      ${String(frames.length)}`,
      `  decode failures      ${String(failures)}`,
      `  arrival order equals send order  ${String(inOrder)}`,
      '',
      '  Position updates are absolute, so a reordered pair leaves a peer avatar at the older',
      '  position permanently rather than transiently.',
    ],
    title: 'every message crosses a real loopback pair and arrives in send order',
  } satisfies Check
})

/**
 * DN-5's actual claim: an invalid value fails at the SENDER.
 *
 * "`finite()` があれば、失敗するのは送信側の `encodeFrame` であり、原因が手元にある."
 * That is only true if `encodeFrame` validates its refinements on the way OUT,
 * which is a property of `Schema.encodeEither` and not of the schema. Worth
 * measuring rather than assuming, because the failure mode if it were false is
 * silent: every bad value would arrive at the far end as a decode failure with
 * no originating code anywhere near it.
 */
const encodeSideValidation = Effect.sync((): Check => {
  const cases: ReadonlyArray<readonly [string, () => Either.Either<string, { readonly reason: string }>]> = [
    ['a NaN coordinate (JSON.stringify(NaN) === "null")', () =>
      encodeFrame({ ...SAMPLES.PlayerMove, at: { x: Number.NaN, y: 0, z: 0 } })],
    ['an infinite coordinate', () =>
      encodeFrame({ ...SAMPLES.PlayerMove, at: { x: Number.POSITIVE_INFINITY, y: 0, z: 0 } })],
    ['a pitch outside ±π/2 (DN-7)', () =>
      encodeFrame({ ...SAMPLES.PlayerMove, facing: { pitchRadians: 3.2, yawRadians: 0 } })],
    ['a non-integral block coordinate', () =>
      encodeFrame({ ...SAMPLES.BlockBreak, at: { x: 0.5, y: 1, z: 2 } })],
    ['a 300-character chat (maxLength 256)', () =>
      encodeFrame({ ...SAMPLES.Chat, text: 'x'.repeat(300) })],
    ['an empty player id', () =>
      encodeFrame({ ...SAMPLES.PlayerLeave, player: '' as unknown as typeof ALICE })],
  ]

  const rows: Array<string> = [`  ${pad('value the sender should never put on the wire', 50)}encodeFrame says`]
  let escaped = 0

  for (const [label, run] of cases) {
    const result = run()
    if (Either.isRight(result)) {
      escaped += 1
      rows.push(`  ${pad(label, 50)}ENCODED — it reaches the far end`)
    } else {
      rows.push(`  ${pad(label, 50)}${result.left.reason}`)
    }
  }

  return {
    finding: escaped > 0,
    id: escaped === 0 ? 'ok' : 'M-encode',
    lines: [
      ...rows,
      '',
      `  ${String(escaped)} of ${String(cases.length)} escaped the sender.`,
      '',
      '  This is the property that makes the refinements worth having: the schema constrains the',
      '  ENCODE direction too, so a divide-by-zero on the sender fails where the sender still is',
      '  on the stack, instead of arriving as an undebuggable decode failure with no origin.',
    ],
    title: 'an invalid value fails at the sender, not at the far end (DN-5, DN-7)',
  } satisfies Check
})

/** DN-6: content skew is not frame corruption. */
const contentSkew = Effect.sync((): Check => {
  const unknownBlock = decodeFrame(
    JSON.stringify({
      message: { _tag: 'BlockPlace', at: { x: 0, y: 0, z: 0 }, block: 'unobtainium', player: 'alice' },
      protocolVersion: PROTOCOL_VERSION,
    }),
  )
  const unknownTag = decodeFrame(
    JSON.stringify({ message: { _tag: 'DetonateEverything' }, protocolVersion: PROTOCOL_VERSION }),
  )
  const extraField = decodeFrame(
    JSON.stringify({
      message: { _tag: 'Ping', nonce: 4, sentFromChannel: 'team' },
      protocolVersion: PROTOCOL_VERSION,
    }),
  )

  const blockOk = Either.isRight(unknownBlock)
  const tagRejected = Either.isLeft(unknownTag) && unknownTag.left.reason === 'malformed-frame'
  const extraOk = Either.isRight(extraField)

  return {
    finding: !(blockOk && tagRejected && extraOk),
    id: blockOk && tagRejected && extraOk ? 'ok' : 'M-skew',
    lines: [
      `  unknown block name "unobtainium"     ${blockOk ? 'decoded' : 'REJECTED'}`,
      `  unknown message tag                  ${tagRejected ? 'malformed-frame' : 'accepted'}`,
      `  a field this build has never seen    ${extraOk ? 'decoded, field ignored' : 'REJECTED'}`,
      '',
      '  The third row is the forward-compatibility half of DN-6 and is not currently asserted',
      '  anywhere: Schema ignores excess properties by default, so a field added in a newer',
      '  build is dropped rather than treated as corruption. That is the behaviour DN-6 wants,',
      '  and it is a default rather than a decision — a future `onExcessProperty: "error"` would',
      '  turn every forward-compatible frame into a parse failure and no test would notice.',
    ],
    title: 'an unknown block name decodes; an unknown tag does not (DN-6)',
  } satisfies Check
})

/** DN-2: the two failure channels stay apart, across a real send and a real receive. */
const errorChannels = Effect.gen(function* () {
  const [client, server] = yield* makeLoopbackPair

  yield* client.send('not a frame at all').pipe(Effect.orDie)
  const arrived = Array.from(yield* Queue.takeAll(server.inbound))
  const protocolFailure = decodeFrame(arrived[0] ?? '')

  const refusing = yield* disconnectedTransport
  const transportFailure = yield* Effect.either(
    sendMessage(SAMPLES.Ping).pipe(Effect.provide(LoopbackTransportLayer(refusing))),
  )

  const protocolTag = Either.isLeft(protocolFailure) ? protocolFailure.left._tag : 'none'
  const transportTag = Either.isLeft(transportFailure) ? transportFailure.left._tag : 'none'
  const distinct = protocolTag === 'ProtocolError' && transportTag === 'TransportError'

  return {
    finding: !distinct,
    id: distinct ? 'ok' : 'M-channels',
    lines: [
      `  garbage that arrived intact   ${protocolTag}` +
        (Either.isLeft(protocolFailure) ? `(${protocolFailure.left.reason})` : ''),
      `  a message that never left     ${transportTag}` +
        (Either.isLeft(transportFailure) ? `(${transportFailure.left.reason})` : ''),
      '',
      '  The correct responses are opposite — drop the frame versus resend it — so the reference',
      '  implementation`s single `NetworkError` forced every call site to re-derive the',
      '  distinction from a string, and one of them always gets it wrong.',
    ],
    title: 'a delivered-but-meaningless frame and an undelivered one are different types (DN-2)',
  } satisfies Check
})

/**
 * DN-3: no message carries a wall clock, and this build cannot start.
 *
 * `docs/testing.md` §7 lists `no message schema declares a wall-clock field` as
 * a test that has not been written because the message set is not final. It does
 * not need the message set to be final: encoding one sample of every declared
 * tag and looking at the keys answers the question for whatever the set is
 * today, and keeps answering it as the set grows.
 */
const noWallClockOnTheWire = Effect.sync((): Check => {
  const suspicious = ['timestamp', 'time', 'sentAt', 'now', 'epoch', 'clock', 'ms', 'millis']
  const offenders: Array<string> = []

  for (const tag of MESSAGE_TAGS) {
    const encoded = encodeFrame(SAMPLES[tag])
    if (Either.isLeft(encoded)) {
      offenders.push(`${tag}: sample does not encode`)
      continue
    }
    const parsed = JSON.parse(encoded.right) as { readonly message: Record<string, unknown> }
    for (const key of Object.keys(parsed.message)) {
      if (suspicious.some((needle) => key.toLowerCase().includes(needle))) {
        offenders.push(`${tag}.${key}`)
      }
    }
  }

  return {
    finding: offenders.length > 0,
    id: offenders.length === 0 ? 'ok' : 'M-clock',
    lines: [
      `  tags swept        ${String(MESSAGE_TAGS.length)}`,
      `  suspicious keys   ${offenders.length === 0 ? 'none' : offenders.join(', ')}`,
      '',
      '  The reference implementation made `timestamp` a REQUIRED base field on every message',
      '  and filled it from `Date.now()` in 17 places. That is not one violation of the clock',
      '  ban, it is a schema that makes the ban unkeepable — and a wall clock can run backwards',
      '  (NTP, DST, a user changing the system time), so a replay does not reproduce.',
      '',
      '  docs/testing.md §7 parks this test behind "メッセージ集合の確定". It does not need to',
      '  be: sweeping whatever MESSAGE_TAGS holds today answers the question today, and keeps',
      '  answering it as the set grows.',
    ],
    title: 'no message schema declares a wall-clock field (DN-3)',
  } satisfies Check
})

/** A dropped frame is invisible to the sender. Measured, because it is the point of `drop`. */
const droppedFrameIsSilent = Effect.gen(function* () {
  const [client, server] = yield* makeLoopbackPair
  const asClient = LoopbackTransportLayer(client)

  // Two sends, of which the app drops the first: the send that "happened" is
  // The one the sender never learns about.
  const encoded = encodeFrame(SAMPLES.PlayerMove)
  const sendResult = yield* Effect.either(sendMessage(SAMPLES.Chat).pipe(Effect.provide(asClient)))
  const waiting = yield* Queue.size(server.inbound)

  return {
    finding: false,
    id: 'note',
    lines: [
      `  encodeFrame succeeded            ${String(Either.isRight(encoded))}`,
      `  sendMessage succeeded            ${String(Either.isRight(sendResult))}`,
      `  frames actually at the far end   ${String(waiting)}`,
      '',
      '  `send` returns `Effect<void, TransportError>`: it reports that the WRITE was accepted,',
      '  never that the frame was received. That is correct for a Port — an ack is a protocol',
      '  concern — and it is why the preview`s `drop` fault shows the sender a clean success.',
      '  There is no acknowledgement message in MESSAGE_TAGS today, so nothing in this',
      '  repository can currently notice a lost frame.',
    ],
    title: 'a dropped frame is indistinguishable from a delivered one, at the sender',
  } satisfies Check
})

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const CHECKS = [
  versionBeforeShape,
  attemptIsConstant,
  terminalIdempotence,
  sendGuard,
  loopbackRoundTrip,
  encodeSideValidation,
  contentSkew,
  errorChannels,
  noWallClockOnTheWire,
  droppedFrameIsSilent,
] as const

export const buildStatsReport: Effect.Effect<ReadonlyArray<string>> = Effect.gen(function* () {
  const results = yield* Effect.forEach(CHECKS, (check) => check)
  const lines: Array<string> = [
    'preview-two-clients --stats',
    '',
    'Everything below is measured at run time; no expected value is recorded here.',
    'A finding therefore vanishes silently when it is fixed — confirm one, then pin it',
    'in test/ as an assertion. The checks are kept after they pass.',
    '',
    `this build speaks protocol version ${String(PROTOCOL_VERSION)}`,
    '',
  ]

  for (const check of results) {
    lines.push(`${check.finding ? `[${check.id}]` : check.id === 'note' ? '[note]' : '[ ok ]'} ${check.title}`)
    lines.push(...check.lines)
    lines.push('')
  }

  const findings = results.filter((check) => check.finding)
  lines.push('-'.repeat(76))
  lines.push(
    `${String(findings.length)} finding(s): ${findings.map((check) => check.id).join(', ')}` +
      `   ${String(results.length - findings.length)} check(s) passing`,
  )

  return lines
})

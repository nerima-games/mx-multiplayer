import {
  CONNECTION_RATE_LIMITS,
  type ConnectionRateLimitFailure,
  RateLimitExceeded,
  createConnectionRateLimiter,
} from '../src/domain/rate-limit.js'
import { CommandId, PlayerId, WorldId } from '../src/domain/protocol.js'
import {
  type ConnectionState,
  canSend,
  initialConnectionState,
  runTransitions,
  transition,
} from '../src/domain/connection.js'
import { Effect, Result } from 'effect'
import {
  type ReconnectAuth,
  type ReconnectAuthCrypto,
  type ReconnectAuthStore,
  ReconnectToken,
  ReconnectTokenInput,
  createReconnectAuth,
} from '../src/application/server/reconnect-auth.js'
import type {
  ScenarioAction,
  ScenarioClientId,
  ScenarioDefinition,
  ScenarioEvaluationInput,
  ScenarioStepContext,
  ScenarioVerdict,
} from './types.js'
import { inspectInboundFrame } from '../src/application/server/frame-inspection.js'

const WORLD = WorldId.make('overworld')
const ZERO = 0
const ONE = 1
const TWO = 2
const SCENARIO_PREFIX = 's2-transport'
const TOKEN_LENGTH = 43
const TOKEN_HASH_MULTIPLIER = 33
const TOKEN_HASH_MODULUS = 0x1_0000_0000
const TOKEN_HASH_WORD_LENGTH = 8
const TOKEN_HASH_WORD_COUNT = 8
const TOKEN_HASH_RADIX = 16
const MAX_FRAME_CODE_UNITS = 1_048_576
const BYTE_RATE_CONFIG = {
  burstFrames: TWO,
  bytesPerSecond: 1_000,
  framesPerSecond: 25,
  maxDeltaBytes: 80,
}
const BYTE_RATE_FIRST_FRAME_BYTES = 60
const BYTE_RATE_REJECTED_FRAME_BYTES = 21
const BYTE_RATE_REMAINING_FRAME_BYTES = 20
const TOKEN_VALUES = [
  'A'.repeat(TOKEN_LENGTH),
  'B'.repeat(TOKEN_LENGTH),
  'C'.repeat(TOKEN_LENGTH),
  'D'.repeat(TOKEN_LENGTH),
] as const

const commandAction = (
  client: { readonly id: ScenarioClientId; readonly player: string },
  seed: number,
  frame: number,
): ScenarioAction => ({
  clientId: client.id,
  kind: 'message',
  message: {
    _tag: 'BowUseCommand',
    action: 'start',
    commandId: CommandId.make(`${SCENARIO_PREFIX}-${String(seed)}-${String(frame)}-${client.id}`),
    expectedRevision: ZERO,
    player: PlayerId.make(client.player),
    world: WORLD,
  },
})

const twoClientActions = ({ clients, frame, seed }: ScenarioStepContext) =>
  clients.map((client) => commandAction(client, seed, frame))

const bothClientsAccepted = ({ clients, authority, frame }: ScenarioEvaluationInput): boolean =>
  clients.length === TWO
  && clients.every((client) => client.connected && client.accepted === frame && client.rejected === ZERO)
  && authority.acceptedCommands === frame * TWO
  && authority.rejectedCommands === ZERO

const makeVerdict = (
  passed: boolean,
  successSummary: string,
  pendingSummary: string,
): ScenarioVerdict => {
  let status: ScenarioVerdict['status'] = 'incomplete'
  let summary = pendingSummary
  if (passed) {
    status = 'pass'
    summary = successSummary
  }
  return { status, summary }
}

const connectionTransitionsPass = (): boolean => {
  const connected: ConnectionState = {
    _tag: 'Connected',
    player: PlayerId.make('scenario-player-a'),
    world: WORLD,
  }
  const legal = runTransitions(initialConnectionState, [
    { _tag: 'ConnectRequested' },
    { _tag: 'HandshakeSucceeded', player: connected.player, world: connected.world },
    { _tag: 'PeerClosed' },
    { _tag: 'RetryRequested' },
    { _tag: 'HandshakeSucceeded', player: connected.player, world: connected.world },
    { _tag: 'CloseRequested' },
  ])
  const illegal = runTransitions(initialConnectionState, [
    { _tag: 'ConnectRequested' },
    { _tag: 'ConnectRequested' },
  ])
  return legal.rejectedAt === undefined
    && legal.state._tag === 'Disconnected'
    && illegal.rejectedAt === ONE
    && illegal.state._tag === 'Connecting'
    && transition(initialConnectionState, { _tag: 'RetryRequested' }) === undefined
    && !canSend(initialConnectionState)
    && canSend(connected)
}

const tokenHash = (token: string): string => {
  let hash = ZERO
  for (const character of token) {
    hash = (Math.imul(hash, TOKEN_HASH_MULTIPLIER) + character.charCodeAt(ZERO)) % TOKEN_HASH_MODULUS
  }
  return hash.toString(TOKEN_HASH_RADIX).padStart(TOKEN_HASH_WORD_LENGTH, '0').repeat(TOKEN_HASH_WORD_COUNT)
}

const createTokenStore = (): ReconnectAuthStore => {
  let contents: string | undefined = undefined
  return {
    load: () => Effect.sync(() => contents),
    save: (next) => Effect.sync(() => { contents = next }),
  }
}

const createReconnectAuthFixture = (): ReconnectAuth => {
  let tokenIndex = ZERO
  const crypto: ReconnectAuthCrypto = {
    hashHex: tokenHash,
    randomToken: () => {
      const token = TOKEN_VALUES[tokenIndex]
      if (token === undefined) {
        throw new RangeError('S2 token fixture exhausted')
      }
      tokenIndex += ONE
      return ReconnectToken.make(token)
    },
    timingSafeEqualHex: (left, right) => left === right,
  }
  return Effect.runSync(createReconnectAuth(crypto, createTokenStore()))
}

const validReconnectPasses = (auth: ReconnectAuth, aliceToken: string): boolean => {
  const resumed = Effect.runSync(auth.resume(ReconnectTokenInput.make(aliceToken)))
  return resumed !== undefined
    && resumed.player === PlayerId.make('alice')
    && resumed.token !== aliceToken
}

const forgedTokensRejected = (auth: ReconnectAuth, aliceToken: string): boolean => {
  let replacement = 'A'
  if (aliceToken.endsWith('A')) {
    replacement = 'B'
  }
  const tampered = `${aliceToken.slice(ZERO, -ONE)}${replacement}`
  const tamperedResume = Effect.runSync(auth.resume(ReconnectTokenInput.make(tampered)))
  const unknownResume = Effect.runSync(auth.resume(ReconnectTokenInput.make('Z'.repeat(TOKEN_LENGTH))))
  return tamperedResume === undefined && unknownResume === undefined
}

const mismatchedIdentityRejected = (auth: ReconnectAuth, aliceToken: string): boolean => {
  const bobToken = Effect.runSync(auth.issue('bob'))
  if (bobToken === undefined) {
    return false
  }
  return Effect.runSync(auth.rotate('bob', aliceToken)) === undefined
}

const rotateToken = (auth: ReconnectAuth, token: string): string | undefined =>
  Effect.runSync(auth.rotate('alice', token))

const rotateTwice = (auth: ReconnectAuth, token: string): string | undefined => {
  const firstRotation = rotateToken(auth, token)
  if (firstRotation === undefined) {
    return undefined
  }
  return rotateToken(auth, firstRotation)
}

const tokenRevokedAfterTwoRotations = (): boolean => {
  const auth = createReconnectAuthFixture()
  const originalToken = Effect.runSync(auth.issue('alice'))
  if (originalToken === undefined) {
    return false
  }
  return rotateTwice(auth, originalToken) !== undefined && rotateToken(auth, originalToken) === undefined
}

const reconnectAuthPasses = (): boolean => {
  const auth = createReconnectAuthFixture()
  const aliceToken = Effect.runSync(auth.issue('alice'))
  if (aliceToken === undefined) {
    return false
  }
  return validReconnectPasses(auth, aliceToken)
    && forgedTokensRejected(auth, aliceToken)
    && mismatchedIdentityRejected(auth, aliceToken)
    && tokenRevokedAfterTwoRotations()
}

const isRateLimitRejection = (
  result: Result.Result<void, ConnectionRateLimitFailure>,
  expectedReason: RateLimitExceeded['reason'],
): boolean => {
  if (Result.isSuccess(result)) {
    return false
  }
  return result.failure instanceof RateLimitExceeded && result.failure.reason === expectedReason
}

const frameRateRejectionPasses = (): boolean => {
  const limiterResult = createConnectionRateLimiter(CONNECTION_RATE_LIMITS)
  if (Result.isFailure(limiterResult)) {
    return false
  }
  const limiter = limiterResult.success
  let admittedBurst = true
  for (let frame = ZERO; frame < CONNECTION_RATE_LIMITS.burstFrames; frame += ONE) {
    if (Result.isFailure(limiter.consume(ONE, ZERO))) {
      admittedBurst = false
    }
  }
  const frameRateRejected = isRateLimitRejection(limiter.consume(ONE, ZERO), 'frame-rate')
  return admittedBurst && frameRateRejected
}

const byteRateRejectionPasses = (): boolean => {
  const limiterResult = createConnectionRateLimiter(BYTE_RATE_CONFIG)
  if (Result.isFailure(limiterResult)) {
    return false
  }
  const limiter = limiterResult.success
  const admittedFirstFrame = Result.isSuccess(limiter.consume(BYTE_RATE_FIRST_FRAME_BYTES, ZERO))
  const byteRateRejected = isRateLimitRejection(limiter.consume(BYTE_RATE_REJECTED_FRAME_BYTES, ZERO), 'byte-rate')
  const admittedAfterRejection = Result.isSuccess(limiter.consume(BYTE_RATE_REMAINING_FRAME_BYTES, ZERO))
  return admittedFirstFrame && byteRateRejected && admittedAfterRejection
}

const deltaAndInboundFrameRejectionsPass = (): boolean => {
  const limiterResult = createConnectionRateLimiter(CONNECTION_RATE_LIMITS)
  if (Result.isFailure(limiterResult)) {
    return false
  }
  const limiter = limiterResult.success
  const admittedDeltaLimit = Result.isSuccess(
    limiter.consume(CONNECTION_RATE_LIMITS.maxDeltaBytes, ZERO),
  )
  const deltaTooLargeRejected = isRateLimitRejection(
    limiter.consume(CONNECTION_RATE_LIMITS.maxDeltaBytes + ONE, ZERO),
    'delta-too-large',
  )
  const oversized = inspectInboundFrame(' '.repeat(MAX_FRAME_CODE_UNITS + ONE))
  const oversizedFrameRejected = oversized._tag === 'Rejected'
    && oversized.reason === 'frame-too-large'
    && oversized.stage === 'predecode-limit'
  return admittedDeltaLimit && deltaTooLargeRejected && oversizedFrameRejected
}

const receiveRejectionsPass = (): boolean =>
  frameRateRejectionPasses() && byteRateRejectionPasses() && deltaAndInboundFrameRejectionsPass()

export const connectionScenario: ScenarioDefinition = {
  actions: twoClientActions,
  angle: 'A5',
  description: 'Runs state transitions and sends both clients through the deterministic codec, transport, and authority path.',
  evaluate: (input) => {
    const passed = connectionTransitionsPass() && bothClientsAccepted(input)
    return makeVerdict(
      passed,
      'legal and illegal connection transitions were confirmed before both clients delivered',
      'waiting for the connection state trace and both accepted client commands',
    )
  },
  group: 'transport',
  id: 'transport.connection.two-clients',
  title: 'Two clients send after connecting',
}

export const dropScenario: ScenarioDefinition = {
  actions: twoClientActions,
  angle: 'A4',
  description: 'Drops client A at the transport boundary while client B continues to deliver.',
  evaluate: ({ clients, wireLog }) => {
    const dropped = wireLog.some((entry) => entry.from === 'client-a' && entry.outcome === 'dropped')
    const peerAccepted = clients.find((client) => client.id === 'client-b')?.accepted === ONE
    const passed = dropped && peerAccepted
    return makeVerdict(
      passed,
      'client A was dropped and client B was accepted',
      'waiting for the selected drop and peer acceptance',
    )
  },
  group: 'transport',
  id: 'transport.fault.drop',
  title: 'A dropped frame stays out of authority',
}

export const duplicateScenario: ScenarioDefinition = {
  actions: ({ clients, frame, seed }) => {
    const clientA = clients.find((client) => client.id === 'client-a')
    const clientB = clients.find((client) => client.id === 'client-b')
    if (clientA === undefined || clientB === undefined) {
      return []
    }
    const duplicate = commandAction(clientA, seed, frame)
    return [duplicate, duplicate, commandAction(clientB, seed, frame)]
  },
  angle: 'A4',
  description: 'Sends the same command frame twice and checks that authority accepts its intent only once.',
  evaluate: ({ clients, authority, frame, wireLog }) => {
    const clientA = clients.find((client) => client.id === 'client-a')
    const duplicateAcknowledged = wireLog.some((entry) =>
      entry.from === 'client-a' && entry.result === 'authority acknowledged accepted intent replay')
    const passed = clientA?.submitted === frame * TWO
      && clientA.accepted === frame
      && duplicateAcknowledged
      && authority.acceptedCommands === frame * TWO
    return makeVerdict(
      passed,
      'the duplicate was acknowledged without another authority acceptance',
      'waiting for duplicate acknowledgement',
    )
  },
  group: 'transport',
  id: 'transport.fault.duplicate',
  title: 'A duplicate command is replayed once',
}

export const reorderScenario: ScenarioDefinition = {
  actions: twoClientActions,
  angle: 'A4',
  description: 'Reverses delivery sequence for both clients while preserving their logical frame.',
  evaluate: ({ frame, wireLog }) => {
    const currentFrame = wireLog.filter((entry) => entry.frame === frame)
    const passed = currentFrame.length === TWO
      && currentFrame[ZERO]?.deliverySequence === TWO
      && currentFrame[ONE]?.deliverySequence === ONE
    return makeVerdict(
      passed,
      'delivery order is the reverse of submission order',
      'waiting for reverse delivery order',
    )
  },
  group: 'transport',
  id: 'transport.fault.reorder',
  title: 'Ready frames may arrive in reverse order',
}

export const delayScenario: ScenarioDefinition = {
  actions: ({ clients, frame, seed }) => {
    if (frame !== ONE) {
      return []
    }
    return clients.map((client) => commandAction(client, seed, frame))
  },
  angle: 'A4',
  description: 'Delays client A by one logical frame while client B is delivered immediately.',
  evaluate: ({ clients, wireLog }) => {
    const delayedOrLate = wireLog.some((entry) => entry.from === 'client-a'
      && (entry.outcome === 'delayed' || entry.deliveredFrame === TWO))
    const peerAccepted = clients.find((client) => client.id === 'client-b')?.accepted === ONE
    const passed = delayedOrLate && peerAccepted
    return makeVerdict(
      passed,
      'client A was delayed and client B was delivered on time',
      'waiting for the delayed frame and peer delivery',
    )
  },
  group: 'transport',
  id: 'transport.fault.delay',
  title: 'A delayed frame keeps its original sequence',
}

export const disconnectScenario: ScenarioDefinition = {
  actions: twoClientActions,
  angle: 'A5',
  description: 'Disconnects client A before delivery and confirms that client B remains connected.',
  evaluate: ({ clients, wireLog }) => {
    const clientA = clients.find((client) => client.id === 'client-a')
    const clientB = clients.find((client) => client.id === 'client-b')
    const disconnected = wireLog.some((entry) => entry.from === 'client-a' && entry.outcome === 'disconnected')
    const passed = disconnected && clientA?.connected === false && clientB?.connected === true
    return makeVerdict(
      passed,
      'client A is disconnected while client B remains connected',
      'waiting for transport disconnect',
    )
  },
  group: 'transport',
  id: 'transport.fault.disconnect',
  title: 'A disconnected client cannot deliver',
}

export const reconnectScenario: ScenarioDefinition = {
  actions: twoClientActions,
  angle: 'A5',
  description: 'Resumes the issued token as its stored player and verifies that rotation returns a new token.',
  evaluate: (input) => {
    const passed = reconnectAuthPasses() && bothClientsAccepted(input)
    return makeVerdict(
      passed,
      'the current reconnect token resumed Alice and rotated to a new token',
      'waiting for valid reconnect authentication and both accepted client commands',
    )
  },
  group: 'transport',
  id: 'transport.reconnect.valid-token',
  title: 'A current token resumes its stored player',
}

export const authRejectionScenario: ScenarioDefinition = {
  actions: twoClientActions,
  angle: 'A7',
  description: 'Rejects tampered, unknown, stale, and mismatched-player tokens through reconnect authentication.',
  evaluate: (input) => {
    const passed = reconnectAuthPasses() && bothClientsAccepted(input)
    return makeVerdict(
      passed,
      'tampered, unknown, rotated-out, and mismatched-player tokens were rejected',
      'waiting for reconnect token rejection checks and both accepted client commands',
    )
  },
  group: 'transport',
  id: 'transport.auth.reject-forged-and-mismatched',
  title: 'Invalid reconnect identities are rejected',
}

export const receiveRejectionScenario: ScenarioDefinition = {
  actions: twoClientActions,
  angle: 'A7',
  description: 'Rejects frame-rate, byte-rate, oversized-delta, and oversized inbound frame inputs.',
  evaluate: (input) => {
    const passed = receiveRejectionsPass() && bothClientsAccepted(input)
    return makeVerdict(
      passed,
      'frame-rate, byte-rate, delta-size, and inbound frame-size limits rejected their excess inputs',
      'waiting for receive rejection checks and both accepted client commands',
    )
  },
  group: 'transport',
  id: 'transport.receive.rate-and-size-rejection',
  title: 'Excess receive traffic is rejected',
}

export const transportScenarios: ReadonlyArray<ScenarioDefinition> = [
  connectionScenario,
  dropScenario,
  duplicateScenario,
  reorderScenario,
  delayScenario,
  disconnectScenario,
  reconnectScenario,
  authRejectionScenario,
  receiveRejectionScenario,
]

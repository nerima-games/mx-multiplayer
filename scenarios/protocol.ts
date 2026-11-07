import { type NetworkMessage, PROTOCOL_VERSION } from '../src/domain/protocol.js'
import type { ScenarioDefinition, ScenarioEvaluationInput, ScenarioVerdict } from './types.js'

const ONE = 1
const TWO = 2
const FIRST_FRAME = ONE
const SECOND_FRAME = TWO
const PING: NetworkMessage = { _tag: 'Ping', nonce: ONE }
const FRAME_SIZE_LIMIT_CODE_UNITS = 1_048_576
const VALID_PING_FRAME = JSON.stringify({ message: PING, protocolVersion: PROTOCOL_VERSION })
const MALFORMED_PING_FRAME = JSON.stringify({
  message: { _tag: 'Ping', nonce: 'invalid' },
  protocolVersion: PROTOCOL_VERSION,
})
const UNKNOWN_VERSION_FRAME = JSON.stringify({
  message: PING,
  protocolVersion: PROTOCOL_VERSION + ONE,
})
const UNKNOWN_TAG_FRAME = JSON.stringify({
  message: { _tag: 'FutureProtocolMessage' },
  protocolVersion: PROTOCOL_VERSION,
})
const PING_FRAME_AT_LIMIT = `${VALID_PING_FRAME}${' '.repeat(FRAME_SIZE_LIMIT_CODE_UNITS - VALID_PING_FRAME.length)}`
const PING_FRAME_OVER_LIMIT = `${PING_FRAME_AT_LIMIT} `

const verdict = (passed: boolean, summary: string): ScenarioVerdict => {
  if (passed) {
    return { status: 'pass', summary }
  }
  return { status: 'fail', summary }
}

const hasRejectedFrame = (
  input: ScenarioEvaluationInput,
  text: string,
  reason: string,
): boolean => {
  const [entry] = input.wireLog
  return input.wireLog.length === ONE
    && entry !== undefined
    && entry.frame === FIRST_FRAME
    && entry.tag === '?'
    && entry.text === text
    && entry.outcome === 'rejected'
    && entry.result === `decode rejected: ${reason}`
}

export const pingRoundTripScenario: ScenarioDefinition = {
  actions: () => [{ clientId: 'client-a', kind: 'message', message: PING }],
  angle: 'A1',
  description: 'This A1 scenario checks the Ping tag through encoded wire delivery and decoding.',
  evaluate: (input) => {
    const [entry] = input.wireLog
    const passed = input.wireLog.length === ONE
      && entry !== undefined
      && entry.frame === FIRST_FRAME
      && entry.tag === 'Ping'
      && entry.text === VALID_PING_FRAME
      && entry.outcome === 'delivered'
      && entry.result === 'decoded Ping'
    return verdict(passed, 'Ping frame content and decoded wire result match the expected round trip')
  },
  group: 'protocol',
  id: 'mx-multiplayer.s1.protocol.ping-round-trip',
  title: 'Ping round trip (A1)',
}

export const malformedPingPayloadScenario: ScenarioDefinition = {
  actions: () => [{ clientId: 'client-a', kind: 'raw', text: MALFORMED_PING_FRAME }],
  angle: 'A1',
  description: 'This A1 scenario checks that the codec rejects a Ping frame with a string nonce.',
  evaluate: (input) => verdict(
    hasRejectedFrame(input, MALFORMED_PING_FRAME, 'malformed-frame'),
    'Malformed Ping payload was rejected by the frame decoder',
  ),
  group: 'protocol',
  id: 'mx-multiplayer.s1.protocol.malformed-ping-payload',
  title: 'Malformed Ping payload (A1)',
}

export const unknownProtocolVersionScenario: ScenarioDefinition = {
  actions: () => [{ clientId: 'client-a', kind: 'raw', text: UNKNOWN_VERSION_FRAME }],
  angle: 'A1',
  description: 'This A1 scenario checks that the codec rejects a frame using an unsupported protocol version.',
  evaluate: (input) => verdict(
    hasRejectedFrame(input, UNKNOWN_VERSION_FRAME, 'unsupported-protocol-version'),
    'Frame with an unknown protocol version was rejected',
  ),
  group: 'protocol',
  id: 'mx-multiplayer.s1.protocol.unknown-version',
  title: 'Unknown protocol version (A1)',
}

export const unknownMessageTagScenario: ScenarioDefinition = {
  actions: () => [{ clientId: 'client-a', kind: 'raw', text: UNKNOWN_TAG_FRAME }],
  angle: 'A1',
  description: 'This A1 scenario checks codec rejection of an unregistered message tag.',
  evaluate: (input) => verdict(
    hasRejectedFrame(input, UNKNOWN_TAG_FRAME, 'malformed-frame'),
    'Frame with an unknown message tag was rejected',
  ),
  group: 'protocol',
  id: 'mx-multiplayer.s1.protocol.unknown-tag',
  title: 'Unknown message tag (A1)',
}

export const frameSizeBoundaryScenario: ScenarioDefinition = {
  actions: ({ frame }) => {
    if (frame === FIRST_FRAME) {
      return [{ clientId: 'client-a', kind: 'raw', text: PING_FRAME_AT_LIMIT }]
    }
    if (frame === SECOND_FRAME) {
      return [{ clientId: 'client-a', kind: 'raw', text: PING_FRAME_OVER_LIMIT }]
    }
    return []
  },
  angle: 'A1',
  description: 'This A1 scenario checks the codec at the 1,048,576-code-unit limit and one code unit above it.',
  evaluate: (input) => {
    const [atLimit, overLimit] = input.wireLog
    const passed = input.wireLog.length === TWO
      && atLimit !== undefined
      && atLimit.frame === FIRST_FRAME
      && atLimit.tag === 'Ping'
      && atLimit.text === PING_FRAME_AT_LIMIT
      && atLimit.text.length === FRAME_SIZE_LIMIT_CODE_UNITS
      && atLimit.outcome === 'delivered'
      && atLimit.result === 'decoded Ping'
      && overLimit !== undefined
      && overLimit.frame === SECOND_FRAME
      && overLimit.tag === '?'
      && overLimit.text === PING_FRAME_OVER_LIMIT
      && overLimit.text.length === FRAME_SIZE_LIMIT_CODE_UNITS + ONE
      && overLimit.outcome === 'rejected'
      && overLimit.result === 'decode rejected: frame-too-large'
    return verdict(passed, 'Frame at the code-unit limit was delivered and the next code unit was rejected')
  },
  group: 'protocol',
  id: 'mx-multiplayer.s1.protocol.frame-size-boundary',
  title: 'Frame size boundary (A1)',
}

export const protocolScenarios: ReadonlyArray<ScenarioDefinition> = [
  pingRoundTripScenario,
  malformedPingPayloadScenario,
  unknownProtocolVersionScenario,
  unknownMessageTagScenario,
  frameSizeBoundaryScenario,
]

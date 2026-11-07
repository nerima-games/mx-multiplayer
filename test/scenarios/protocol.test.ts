import { describe, expect, it } from '@effect/vitest'
import { PROTOCOL_VERSION } from '../../src/domain/protocol.js'
import { createScenarioRuntime } from '../../scenarios/runtime.js'
import type { ScenarioDefinition } from '../../scenarios/types.js'
import {
  frameSizeBoundaryScenario,
  malformedPingPayloadScenario,
  pingRoundTripScenario,
  unknownMessageTagScenario,
  unknownProtocolVersionScenario,
} from '../../scenarios/protocol.js'

const PING = { _tag: 'Ping', nonce: 1 }
const FRAME_SIZE_LIMIT_CODE_UNITS = 1_048_576
const PING_FRAME = JSON.stringify({ message: PING, protocolVersion: PROTOCOL_VERSION })
const MALFORMED_PING_FRAME = JSON.stringify({
  message: { _tag: 'Ping', nonce: 'invalid' },
  protocolVersion: PROTOCOL_VERSION,
})
const UNKNOWN_VERSION_FRAME = JSON.stringify({
  message: PING,
  protocolVersion: PROTOCOL_VERSION + 1,
})
const UNKNOWN_TAG_FRAME = JSON.stringify({
  message: { _tag: 'FutureProtocolMessage' },
  protocolVersion: PROTOCOL_VERSION,
})
const PING_FRAME_AT_LIMIT = `${PING_FRAME}${' '.repeat(FRAME_SIZE_LIMIT_CODE_UNITS - PING_FRAME.length)}`
const PING_FRAME_OVER_LIMIT = `${PING_FRAME_AT_LIMIT} `

const runScenario = async (scenario: ScenarioDefinition, frames = 1) => {
  const runtime = await createScenarioRuntime(scenario, { seed: 41 })
  return runtime.run(frames)
}

describe('protocol scenarios', () => {
  // This fails if a valid Ping frame is encoded incorrectly or the receiver decodes different wire content.
  it('round-trips an encoded Ping frame', async () => {
    const result = await runScenario(pingRoundTripScenario)

    expect(result.angle).toBe('A1')
    expect(result.wireLog).toHaveLength(1)
    expect(result.wireLog[0]).toMatchObject({
      frame: 1,
      tag: 'Ping',
      text: PING_FRAME,
      outcome: 'delivered',
      result: 'decoded Ping',
    })
    expect(result.verdict.status).toBe('pass')
  })

  // This fails if the decoder accepts a Ping payload whose nonce is not an integer.
  it('rejects a malformed Ping payload from a raw frame', async () => {
    const result = await runScenario(malformedPingPayloadScenario)

    expect(result.angle).toBe('A1')
    expect(result.wireLog).toHaveLength(1)
    expect(result.wireLog[0]).toMatchObject({
      frame: 1,
      tag: '?',
      text: MALFORMED_PING_FRAME,
      outcome: 'rejected',
      result: 'decode rejected: malformed-frame',
    })
    expect(result.verdict.status).toBe('pass')
  })

  // This fails if the decoder accepts a frame with a protocol version it does not support.
  it('rejects an unknown protocol version from a raw frame', async () => {
    const result = await runScenario(unknownProtocolVersionScenario)

    expect(result.angle).toBe('A1')
    expect(result.wireLog).toHaveLength(1)
    expect(result.wireLog[0]).toMatchObject({
      frame: 1,
      tag: '?',
      text: UNKNOWN_VERSION_FRAME,
      outcome: 'rejected',
      result: 'decode rejected: unsupported-protocol-version',
    })
    expect(result.verdict.status).toBe('pass')
  })

  // This fails if a frame with an unregistered message tag reaches the receiver as a decoded message.
  it('rejects an unknown message tag from a raw frame', async () => {
    const result = await runScenario(unknownMessageTagScenario)

    expect(result.angle).toBe('A1')
    expect(result.wireLog).toHaveLength(1)
    expect(result.wireLog[0]).toMatchObject({
      frame: 1,
      tag: '?',
      text: UNKNOWN_TAG_FRAME,
      outcome: 'rejected',
      result: 'decode rejected: malformed-frame',
    })
    expect(result.verdict.status).toBe('pass')
  })

  // This fails if the codec rejects the inclusive frame limit or accepts one additional code unit.
  it('accepts the frame code-unit limit and rejects one code unit over', async () => {
    const result = await runScenario(frameSizeBoundaryScenario, 2)

    expect(result.angle).toBe('A1')
    expect(result.wireLog).toHaveLength(2)
    expect(result.wireLog.map(({ frame, tag, outcome, result: wireResult }) => ({
      frame,
      tag,
      outcome,
      result: wireResult,
    }))).toStrictEqual([
      { frame: 1, tag: 'Ping', outcome: 'delivered', result: 'decoded Ping' },
      { frame: 2, tag: '?', outcome: 'rejected', result: 'decode rejected: frame-too-large' },
    ])
    expect(result.wireLog[0]?.text).toBe(PING_FRAME_AT_LIMIT)
    expect(result.wireLog[1]?.text).toBe(PING_FRAME_OVER_LIMIT)
    expect(result.wireLog[0]?.text.length).toBe(FRAME_SIZE_LIMIT_CODE_UNITS)
    expect(result.wireLog[1]?.text.length).toBe(FRAME_SIZE_LIMIT_CODE_UNITS + 1)
    expect(result.verdict.status).toBe('pass')
  })
})

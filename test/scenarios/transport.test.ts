import { describe, expect, it } from '@effect/vitest'
import { createScenarioRuntime } from '../../apps/debug-ui/entrypoints/scenarios/scenario-runtime.js'
import {
  authRejectionScenario,
  connectionScenario,
  delayScenario,
  disconnectScenario,
  dropScenario,
  duplicateScenario,
  receiveRejectionScenario,
  reconnectScenario,
  reorderScenario,
} from '../../scenarios/transport.js'
import type { ScenarioDefinition, ScenarioFault, ScenarioResult } from '../../scenarios/types.js'

const ZERO = 0
const ONE = 1
const TWO = 2
const FIXED_SEED = 41

const runScenario = async (
  definition: ScenarioDefinition,
  fault?: ScenarioFault,
  frames = ONE,
): Promise<ScenarioResult> => {
  const runtime = await createScenarioRuntime(definition, {
    ...(fault === undefined ? {} : { fault }),
    seed: FIXED_SEED,
  })
  return runtime.run(frames)
}

describe('transport scenarios', () => {
  // Fails if legal connection transitions, illegal transition rejection, or the client wire path regresses.
  it('reports connection state checks with the accepted two-client wire path', async () => {
    const result = await runScenario(connectionScenario)

    expect(result.id).toBe('transport.connection.two-clients')
    expect(result.angle).toBe('A5')
    expect(result.seed).toBe(FIXED_SEED)
    expect(result.wireLog.map((entry) => [entry.sequence, entry.tag, entry.outcome])).toStrictEqual([
      [ONE, 'BowUseCommand', 'accepted'],
      [TWO, 'BowUseCommand', 'accepted'],
    ])
    expect(result.clients.map((client) => ({
      connected: client.connected,
      submitted: client.submitted,
      received: client.received,
      accepted: client.accepted,
      rejected: client.rejected,
    }))).toStrictEqual([
      { connected: true, submitted: ONE, received: ONE, accepted: ONE, rejected: ZERO },
      { connected: true, submitted: ONE, received: ONE, accepted: ONE, rejected: ZERO },
    ])
    expect(result.verdict).toStrictEqual({
      status: 'pass',
      summary: 'legal and illegal connection transitions were confirmed before both clients delivered',
    })
  })

  // Fails if a dropped frame reaches authority or also drops the unaffected client.
  it('records a dropped frame without disconnecting the sender or losing the peer frame', async () => {
    const result = await runScenario(dropScenario, { kind: 'drop', atFrame: ONE, clientId: 'client-a' })

    expect(result.angle).toBe('A4')
    expect(result.wireLog.map((entry) => [entry.from, entry.outcome])).toStrictEqual([
      ['client-a', 'dropped'],
      ['client-b', 'accepted'],
    ])
    expect(result.clients.map((client) => [client.connected, client.submitted, client.received, client.accepted])).toStrictEqual([
      [true, ONE, ZERO, ZERO],
      [true, ONE, ONE, ONE],
    ])
    expect(result.verdict).toMatchObject({ status: 'pass' })
  })

  // Fails if duplicate command IDs are applied to authority more than once.
  it('delivers a duplicated frame but applies its command only once', async () => {
    const result = await runScenario(duplicateScenario)

    expect(result.angle).toBe('A4')
    expect(result.wireLog.map((entry) => [entry.from, entry.outcome])).toStrictEqual([
      ['client-a', 'accepted'],
      ['client-a', 'delivered'],
      ['client-b', 'accepted'],
    ])
    expect(result.wireLog[TWO - ONE]?.result).toBe('authority acknowledged accepted intent replay')
    expect(result.clients.map((client) => [client.submitted, client.received, client.accepted])).toStrictEqual([
      [TWO, TWO, ONE],
      [ONE, ONE, ONE],
    ])
    expect(result.authority.acceptedCommands).toBe(TWO)
    expect(result.verdict).toMatchObject({ status: 'pass' })
  })

  // Fails if the reorder fault changes submission order without changing delivery order.
  it('records the reversed delivery sequence for reordered frames', async () => {
    const result = await runScenario(reorderScenario, { kind: 'reorder', atFrame: ONE })

    expect(result.angle).toBe('A4')
    expect(result.wireLog.map((entry) => [entry.sequence, entry.deliverySequence, entry.outcome])).toStrictEqual([
      [ONE, TWO, 'accepted'],
      [TWO, ONE, 'accepted'],
    ])
    expect(result.clients.map((client) => client.accepted)).toStrictEqual([ONE, ONE])
    expect(result.verdict).toMatchObject({ status: 'pass' })
  })

  // Fails if a delayed frame is discarded or delivered before its logical due frame.
  it('holds a delayed frame for one logical frame and later delivers it', async () => {
    const runtime = await createScenarioRuntime(delayScenario, {
      fault: { kind: 'delay', frames: ONE, atFrame: ONE, clientId: 'client-a' },
      seed: FIXED_SEED,
    })
    const delayed = await runtime.run(ONE)
    const delivered = await runtime.run(ONE)

    expect(delayed.angle).toBe('A4')
    expect(delayed.wireLog.map((entry) => [entry.from, entry.outcome])).toStrictEqual([
      ['client-a', 'delayed'],
      ['client-b', 'accepted'],
    ])
    expect(delayed.clients.map((client) => client.accepted)).toStrictEqual([ZERO, ONE])
    expect(delayed.verdict).toMatchObject({ status: 'pass' })
    expect(delivered.wireLog[ZERO]).toMatchObject({ frame: ONE, deliveredFrame: TWO, outcome: 'accepted' })
    expect(delivered.clients.map((client) => client.accepted)).toStrictEqual([ONE, ONE])
    expect(delivered.verdict).toMatchObject({ status: 'pass' })
  })

  // Fails if a disconnect leaves the client sendable or affects the other connection.
  it('marks only the disconnected client offline before delivery', async () => {
    const result = await runScenario(disconnectScenario, { kind: 'disconnect', atFrame: ONE, clientId: 'client-a' })

    expect(result.angle).toBe('A5')
    expect(result.wireLog.map((entry) => [entry.from, entry.outcome])).toStrictEqual([
      ['client-a', 'disconnected'],
      ['client-b', 'accepted'],
    ])
    expect(result.clients.map((client) => [client.connected, client.accepted])).toStrictEqual([
      [false, ZERO],
      [true, ONE],
    ])
    expect(result.verdict).toMatchObject({ status: 'pass' })
  })
})

describe('reconnect authentication scenarios', () => {
  // Fails if a valid current token does not resume its stored player or rotate.
  it('reports a valid reconnect through the real auth service', async () => {
    const result = await runScenario(reconnectScenario)

    expect(result.id).toBe('transport.reconnect.valid-token')
    expect(result.angle).toBe('A5')
    expect(result.wireLog.map((entry) => entry.outcome)).toStrictEqual(['accepted', 'accepted'])
    expect(result.clients.map((client) => [client.connected, client.submitted, client.received, client.accepted, client.rejected])).toStrictEqual([
      [true, ONE, ONE, ONE, ZERO],
      [true, ONE, ONE, ONE, ZERO],
    ])
    expect(result.verdict).toStrictEqual({
      status: 'pass',
      summary: 'the current reconnect token resumed Alice and rotated to a new token',
    })
  })

  // Fails if forged, unknown, stale, or mismatched-player tokens are accepted.
  it('reports auth rejection checks through the real auth service', async () => {
    const result = await runScenario(authRejectionScenario)

    expect(result.id).toBe('transport.auth.reject-forged-and-mismatched')
    expect(result.angle).toBe('A7')
    expect(result.wireLog.map((entry) => entry.outcome)).toStrictEqual(['accepted', 'accepted'])
    expect(result.clients.map((client) => [client.connected, client.submitted, client.received, client.accepted, client.rejected])).toStrictEqual([
      [true, ONE, ONE, ONE, ZERO],
      [true, ONE, ONE, ONE, ZERO],
    ])
    expect(result.verdict).toStrictEqual({
      status: 'pass',
      summary: 'tampered, unknown, rotated-out, and mismatched-player tokens were rejected',
    })
  })
})

describe('receive rejection scenarios', () => {
  // Fails if rate-limited or oversized receive inputs bypass their source guards.
  it('reports rate and frame-size rejection checks through the real guards', async () => {
    const result = await runScenario(receiveRejectionScenario)

    expect(result.id).toBe('transport.receive.rate-and-size-rejection')
    expect(result.angle).toBe('A7')
    expect(result.wireLog.map((entry) => entry.outcome)).toStrictEqual(['accepted', 'accepted'])
    expect(result.clients.map((client) => [client.connected, client.submitted, client.received, client.accepted, client.rejected])).toStrictEqual([
      [true, ONE, ONE, ONE, ZERO],
      [true, ONE, ONE, ONE, ZERO],
    ])
    expect(result.verdict).toStrictEqual({
      status: 'pass',
      summary: 'frame-rate, byte-rate, delta-size, and inbound frame-size limits rejected their excess inputs',
    })
  })
})

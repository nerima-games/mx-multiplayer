import { readFileSync } from 'node:fs'
import { describe, expect, it } from '@effect/vitest'
import {
  AUTHORITY_ACCEPT_REPLAY_SCENARIO,
  AUTHORITY_SNAPSHOT_CONVERGENCE_SCENARIO,
} from '../../scenarios/authority.js'
import { createScenarioRuntime } from '../../apps/debug-ui/entrypoints/scenarios/scenario-runtime.js'
import type { ScenarioClock, ScenarioDefinition } from '../../scenarios/types.js'

const SCENARIO_SEED = 83
const FRAME_COUNT_ONE = 1
const FRAME_COUNT_THREE = 3
const JOINING_CLIENT = 'client-c'

describe('scenario runtime extensions', () => {
  // Fails if a joining client skips connection and the encoded snapshot application path.
  it('joins mid-run and receives the server snapshot into its own client projection', async () => {
    const runtime = await createScenarioRuntime(AUTHORITY_SNAPSHOT_CONVERGENCE_SCENARIO, { seed: SCENARIO_SEED })
    const beforeJoin = await runtime.run(FRAME_COUNT_ONE)
    const result = await runtime.join(JOINING_CLIENT)
    const joiningProjection = result.clientProjections.find(({ id }) => id === JOINING_CLIENT)
    const joiningWorld = joiningProjection?.worlds[0]

    expect(beforeJoin.frame).toBe(FRAME_COUNT_ONE)
    expect(result.clients.map(({ id }) => id)).toStrictEqual(['client-a', 'client-b'])
    expect(result.runtimeClients.map(({ id }) => id)).toStrictEqual(['client-a', 'client-b', JOINING_CLIENT])
    expect(joiningWorld?.revision).toBe(0)
    expect(joiningWorld?.blocks.map(({ block }) => block.reading._tag)).toStrictEqual(['Block'])
    expect(result.revisionHistory.some(({ clientId, frame }) => clientId === JOINING_CLIENT && frame === FRAME_COUNT_ONE)).toBe(true)
    expect(Object.isFrozen(joiningProjection?.worlds)).toBe(true)
  })

  // Fails if corrupt injection changes a log label without corrupting a frame decoded by the codec.
  it('sends a malformed encoded frame for the corrupt fault', async () => {
    const runtime = await createScenarioRuntime(AUTHORITY_ACCEPT_REPLAY_SCENARIO, {
      fault: { atFrame: FRAME_COUNT_ONE, clientId: 'client-a', kind: 'corrupt' },
      seed: SCENARIO_SEED,
    })
    const result = await runtime.run(FRAME_COUNT_ONE)

    expect(result.wireLog.map(({ result: wireResult, outcome }) => ({ outcome, wireResult }))).toStrictEqual([
      { outcome: 'rejected', wireResult: 'decode rejected: malformed-frame' },
    ])
    expect(result.clients[0]?.rejected).toBe(1)
  })

  // Fails if version injection bypasses the codec's unsupported-protocol-version rejection.
  it('sends a valid frame at the wrong protocol version', async () => {
    const runtime = await createScenarioRuntime(AUTHORITY_ACCEPT_REPLAY_SCENARIO, {
      fault: { atFrame: FRAME_COUNT_ONE, clientId: 'client-a', kind: 'version' },
      seed: SCENARIO_SEED,
    })
    const result = await runtime.run(FRAME_COUNT_ONE)

    expect(result.wireLog.map(({ result: wireResult }) => wireResult)).toStrictEqual([
      'decode rejected: unsupported-protocol-version',
    ])
    expect(result.clients[0]?.rejected).toBe(1)
  })

  // Fails if a future fault does not turn an accepted command into an authority stale-revision rejection.
  it('compares a future-revision fault with no fault and records the authority rejection', async () => {
    const controlRuntime = await createScenarioRuntime(AUTHORITY_ACCEPT_REPLAY_SCENARIO, { seed: SCENARIO_SEED })
    const control = await controlRuntime.run(FRAME_COUNT_ONE)
    const runtime = await createScenarioRuntime(AUTHORITY_ACCEPT_REPLAY_SCENARIO, {
      fault: { atFrame: FRAME_COUNT_ONE, clientId: 'client-a', kind: 'future' },
      seed: SCENARIO_SEED,
    })
    const result = await runtime.run(FRAME_COUNT_ONE)

    expect(result.wireLog.map(({ result: wireResult, outcome }) => ({ outcome, wireResult }))).toStrictEqual([
      { outcome: 'rejected', wireResult: 'authority rejected command: stale-revision' },
    ])
    expect(control.runtimeFault).toStrictEqual({ kind: 'none' })
    expect(control.wireLog[0]?.result).toBe('authority accepted canonical intent; world state was not applied')
    expect(result.authority.rejectedCommands).toBe(1)
    expect(result.fault).toStrictEqual({ kind: 'none' })
    expect(result.runtimeFault).toStrictEqual({
      atFrame: FRAME_COUNT_ONE,
      clientId: 'client-a',
      kind: 'future',
    })
  })

  // Fails if a future fault on a valid but unsupported frame is silently ignored.
  it('records that a future fault does not apply to a valid Ping', async () => {
    const pingScenario: ScenarioDefinition = {
      actions: () => [{ clientId: 'client-a', kind: 'message', message: { _tag: 'Ping', nonce: SCENARIO_SEED } }],
      angle: 'A1',
      description: 'A valid Ping does not carry a revision that a future fault can change.',
      evaluate: () => ({ status: 'pass', summary: 'Ping was delivered.' }),
      group: 'protocol',
      id: 'negative-control.future-on-ping',
      title: 'Future fault applicability control',
    }
    const runtime = await createScenarioRuntime(pingScenario, {
      fault: { atFrame: FRAME_COUNT_ONE, clientId: 'client-a', kind: 'future' },
      seed: SCENARIO_SEED,
    })
    const result = await runtime.run(FRAME_COUNT_ONE)

    expect(result.wireLog[0]?.tag).toBe('Ping')
    expect(result.wireLog[0]?.faultNotApplied).toBe("fault 'future' not applicable to Ping")
    expect(result.wireLog[0]?.result).toBe('decoded Ping')
  })

  // Fails if an undecodable raw frame hides why version injection was not applied.
  it('records a skipped version fault and the raw decoder rejection', async () => {
    const malformedScenario: ScenarioDefinition = {
      actions: () => [{ clientId: 'client-a', kind: 'raw', text: '{broken' }],
      angle: 'A1',
      description: 'Malformed raw input must be rejected by the codec before a version can be changed.',
      evaluate: () => ({ status: 'pass', summary: 'Raw frame was observed.' }),
      group: 'protocol',
      id: 'negative-control.version-on-malformed-frame',
      title: 'Version fault applicability control',
    }
    const runtime = await createScenarioRuntime(malformedScenario, {
      fault: { atFrame: FRAME_COUNT_ONE, clientId: 'client-a', kind: 'version' },
      seed: SCENARIO_SEED,
    })
    const result = await runtime.run(FRAME_COUNT_ONE)

    expect(result.wireLog[0]?.faultNotApplied).toBe("fault 'version' not applicable to ?")
    expect(result.wireLog[0]?.result).toBe('decode rejected: malformed-frame')
  })

  // Fails if duplicate delivery applies the same accepted intent more than once.
  it('delivers the same encoded frame twice and records the authority replay', async () => {
    const runtime = await createScenarioRuntime(AUTHORITY_ACCEPT_REPLAY_SCENARIO, {
      fault: { atFrame: FRAME_COUNT_ONE, clientId: 'client-a', kind: 'duplicate' },
      seed: SCENARIO_SEED,
    })
    const result = await runtime.run(FRAME_COUNT_ONE)

    expect(result.wireLog.map(({ result: wireResult }) => wireResult)).toStrictEqual([
      'authority accepted canonical intent; world state was not applied',
      'authority acknowledged accepted intent replay',
    ])
    expect(result.authority.acceptedCommands).toBe(1)
    expect(result.wireLog[0]?.text).toBe(result.wireLog[1]?.text)
  })

  // Fails if frame history omits per-entity revisions or records a decreasing revision.
  it('records immutable per-entity revisions after each observed frame', async () => {
    const runtime = await createScenarioRuntime(AUTHORITY_SNAPSHOT_CONVERGENCE_SCENARIO, { seed: SCENARIO_SEED })
    const result = await runtime.run(FRAME_COUNT_THREE)
    const history = result.revisionHistory.filter(({ clientId }) => clientId === 'client-a')
    const revisions = history.map(({ revision }) => revision)
    const monotonic = revisions.slice(1).every((revision, index) => {
      const previous = revisions[index]
      return previous !== undefined && revision >= previous
    })

    expect(history.map(({ frame }) => frame)).toStrictEqual([0, 1, 2, 3])
    expect(history.every(({ entityId }) => entityId.startsWith('block:'))).toBe(true)
    expect(monotonic).toBe(true)
    expect(Object.isFrozen(result.revisionHistory)).toBe(true)
  })

  // Fails if runtime time ignores the injected deterministic clock.
  it('uses and exposes the injected clock in runtime observations', async () => {
    let now = 500
    const clock: ScenarioClock = Object.freeze({ now: () => now })
    const runtime = await createScenarioRuntime(AUTHORITY_SNAPSHOT_CONVERGENCE_SCENARIO, {
      clock,
      seed: SCENARIO_SEED,
    })

    expect(runtime.clock).toBe(clock)
    expect(runtime.snapshot().clockNow).toBe(500)
    now = 700
    expect((await runtime.step()).clockNow).toBe(700)
  })

  // Fails if any runtime path reads wall-clock time instead of the injected clock.
  it('does not read Date.now or performance.now in the scenario runtime', () => {
    const runtimeSource = readFileSync(new URL('../../apps/debug-ui/entrypoints/scenarios/scenario-runtime.ts', import.meta.url), 'utf8')

    expect(runtimeSource).not.toMatch(/Date\.now\s*\(/)
    expect(runtimeSource).not.toMatch(/performance\.now\s*\(/)
  })
})

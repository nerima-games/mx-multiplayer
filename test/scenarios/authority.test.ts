import { describe, expect, it } from '@effect/vitest'
import {
  AUTHORITY_ACCEPT_REPLAY_SCENARIO,
  AUTHORITY_REVISION_GAP_SCENARIO,
  AUTHORITY_SNAPSHOT_CONVERGENCE_SCENARIO,
  AUTHORITY_STALE_REVISION_SCENARIO,
  AUTHORITY_UNSUPPORTED_REASON_SCENARIO,
  AUTHORITY_UNAUTHORIZED_PLAYER_SCENARIO,
  S3_UNSUPPORTED_COMMAND_EXPECTATIONS,
  S3_UNSUPPORTED_COMMAND_TAGS,
  runAuthoritySyncProbe,
} from '../../scenarios/authority.js'
import { createScenarioRuntime } from '../../scenarios/runtime.js'

const FIXED_SEED = 41
const FRAME_COUNT_TWO = 2
const FRAME_COUNT_ONE = 1
const EXPECTED_UNIQUE_UNSUPPORTED_TAG_COUNT = 16
const EXPECTED_SINGLE_REJECTION_COUNT = 1
const EXPECTED_BASELINE_REVISION = 4
const EXPECTED_CONVERGED_REVISION = 5

describe('authority and world sync scenarios', () => {
  // Fails if an identical command replay is accepted as a second intent or changes the accepted count.
  it('records an accepted canonical command and its replay', async () => {
    const runtime = await createScenarioRuntime(AUTHORITY_ACCEPT_REPLAY_SCENARIO, { seed: FIXED_SEED })
    const result = await runtime.run(FRAME_COUNT_TWO)

    expect(result.angle).toBe('A2')
    expect(result.verdict.status).toBe('pass')
    expect(result.wireLog.map((entry) => entry.result)).toStrictEqual([
      'authority accepted canonical intent; world state was not applied',
      'authority acknowledged accepted intent replay',
    ])
    expect(result.authority).toMatchObject({ acceptedCommands: 1, rejectedCommands: 0, revision: 0 })
    expect(result.clients.find((client) => client.id === 'client-a')).toMatchObject({ accepted: 1, rejected: 0 })
  })

  // Fails if authority accepts a command whose expected revision is stale.
  it('rejects a stale revision as an authority-application decision', async () => {
    const runtime = await createScenarioRuntime(AUTHORITY_STALE_REVISION_SCENARIO, { seed: FIXED_SEED })
    const result = await runtime.run(FRAME_COUNT_ONE)

    expect(result.angle).toBe('A2')
    expect(result.verdict.status).toBe('pass')
    expect(result.wireLog.map((entry) => entry.result)).toStrictEqual([
      'authority rejected command: stale-revision',
    ])
    expect(result.authority).toMatchObject({ acceptedCommands: 0, rejectedCommands: EXPECTED_SINGLE_REJECTION_COUNT })
    expect(result.clients.map((client) => client.rejected)).toStrictEqual([0, 1])
  })

  // Fails if authority accepts a command that claims another player's identity.
  it('rejects a player identity spoof as a malicious-client decision', async () => {
    const runtime = await createScenarioRuntime(AUTHORITY_UNAUTHORIZED_PLAYER_SCENARIO, { seed: FIXED_SEED })
    const result = await runtime.run(FRAME_COUNT_ONE)

    expect(result.angle).toBe('A7')
    expect(result.verdict.status).toBe('pass')
    expect(result.wireLog.map((entry) => entry.result)).toStrictEqual([
      'authority rejected command: unauthorized-player',
    ])
    expect(result.authority).toMatchObject({ acceptedCommands: 0, rejectedCommands: EXPECTED_SINGLE_REJECTION_COUNT })
    expect(result.clients.map((client) => client.rejected)).toStrictEqual([1, 0])
  })

  // Fails if any I1-unsupported tag becomes accepted or its observed rejection reason drifts.
  it('keeps the 16 I1-unsupported tags rejected with their current reasons', async () => {
    const runtime = await createScenarioRuntime(AUTHORITY_UNSUPPORTED_REASON_SCENARIO, { seed: FIXED_SEED })
    const result = await runtime.run(FRAME_COUNT_ONE)
    const entries = result.wireLog.map((entry) => ({
      outcome: entry.outcome,
      result: entry.result,
      tag: entry.tag,
    }))
    const expected = S3_UNSUPPORTED_COMMAND_EXPECTATIONS.map(({ tag, reason }) => ({
      outcome: 'rejected',
      result: `authority marked command unsupported: ${reason}`,
      tag,
    }))

    expect(result.angle).toBe('A2')
    expect(result.verdict.status).toBe('pass')
    expect(entries).toStrictEqual(expected)
    expect(new Set(entries.map((entry) => entry.tag)).size).toBe(EXPECTED_UNIQUE_UNSUPPORTED_TAG_COUNT)
    expect(S3_UNSUPPORTED_COMMAND_TAGS).toHaveLength(15)
    expect(result.authority.rejectedCommands).toBe(expected.length)
  })

  // Fails if a revision gap advances the projection or omits the client's resync request.
  it('rejects a revision gap and preserves the prior client projection', async () => {
    const runtime = await createScenarioRuntime(AUTHORITY_REVISION_GAP_SCENARIO, { seed: FIXED_SEED })
    const result = await runtime.run(FRAME_COUNT_ONE)
    const probe = runAuthoritySyncProbe()

    expect(result.angle).toBe('A4')
    expect(result.verdict.status).toBe('pass')
    expect(probe.gapTransition).toMatchObject({
      accepted: false,
      reason: 'revision-gap',
      request: { lastKnownRevision: EXPECTED_BASELINE_REVISION },
    })
    expect(probe.gapAfter).toBe(probe.gapBefore)
    expect(probe.gapAfter?.revision).toBe(EXPECTED_BASELINE_REVISION)
  })

  // Fails if transferred snapshot chunks are lost or the two clients' actual owner/block/revision maps diverge.
  it('transfers a snapshot and compares both clients after applying the same delta', async () => {
    const runtime = await createScenarioRuntime(AUTHORITY_SNAPSHOT_CONVERGENCE_SCENARIO, { seed: FIXED_SEED })
    const result = await runtime.run(FRAME_COUNT_ONE)
    const probe = runAuthoritySyncProbe()

    expect(result.angle).toBe('A3')
    expect(result.verdict.status).toBe('pass')
    expect(probe.transferBegin).toMatchObject({ accepted: true })
    expect(probe.transferAppend).toMatchObject({ accepted: true })
    expect(probe.transferCompletion.accepted).toBe(true)
    expect(probe.transferTransition?.accepted).toBe(true)
    expect(probe.directDeltaTransition.accepted).toBe(true)
    expect(probe.transferDeltaTransition.accepted).toBe(true)
    expect(probe.directWorld?.revision).toBe(EXPECTED_CONVERGED_REVISION)
    expect(probe.directWorld).toStrictEqual(probe.transferWorld)
    expect(probe.clientsConverged).toBe(true)
  })
})

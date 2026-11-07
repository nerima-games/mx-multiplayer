import { describe, expect, it } from '@effect/vitest'
import { DimensionRevisionSchema, SimulationTickSchema } from '@nerima-games/mc-kernel'
import { Schema } from 'effect'
import { PlayerId } from '../../src/domain/protocol.js'
import { createHungerAuthority, type HungerCommand } from '../../src/domain/hunger-authority.js'
import { SurvivalAuthority, type SurvivalCommand } from '../../src/domain/survival-authority.js'
import { createScenarioRuntime } from '../../scenarios/runtime.js'
import {
  SURVIVAL_SCENARIO_FRAME_COUNT,
  SURVIVAL_UNAUTHORIZED_SCENARIO_FRAME_COUNT,
  survivalRejectionCoverage,
  survivalScenario,
  survivalUnauthorizedScenario,
} from '../../scenarios/survival.js'

const ZERO = 0
const ONE = 1
const NEGATIVE_ONE = -ONE
const SEED = 17
const ACCEPT_EAT_FRAME = 4
const PLAYER = PlayerId.make('s6-player')
const EXPECTED_REVISION = ZERO
const EXPECTED_DIMENSION_REVISION = Schema.decodeUnknownSync(DimensionRevisionSchema)(EXPECTED_REVISION)
const TARGET_TICK = Schema.decodeUnknownSync(SimulationTickSchema)(ONE)
const EXPECTED_REASON_UNION_NAMES = ['commandUnsupported', 'command', 'playerDamage', 'survivalAuthority', 'hungerAuthority'] as const
type ExpectedReasonUnionName = (typeof EXPECTED_REASON_UNION_NAMES)[number]

type ReasonCoverageEntry = {
  readonly status: 'scenario' | 'unreachable'
  readonly details: string
  readonly evidence: ReadonlyArray<string>
}

const reasonsForStatus = (
  coverage: Readonly<Record<string, ReasonCoverageEntry>>,
  status: ReasonCoverageEntry['status'],
): ReadonlyArray<string> => Object.entries(coverage)
  .filter(([, entry]) => entry.status === status)
  .map(([reason]) => reason)
  .sort()

const EXPECTED_REASON_UNIONS = {
  commandUnsupported: [
    'no-matching-c2-intent-payload',
    'intent-payload-does-not-preserve-command',
  ],
  command: [
    'unauthorized-player',
    'invalid-command',
    'stale-revision',
    'snapshot-required',
    'resource-not-found',
    'insufficient-items',
    'offer-exhausted',
    'out-of-range',
    'entity-dead',
    'not-mounted',
    'vehicle-occupied',
  ],
  playerDamage: [
    'stale-revision',
    'unauthorized-player',
    'wrong-world',
    'invalid-command',
  ],
  survivalAuthority: [
    'duplicate-request',
    'stale-revision',
    'unauthorized-actor',
    'session-mismatch',
    'invalid-command',
    'invalid-game-mode',
    'out-of-reach',
    'insufficient-items',
    'cooldown-active',
    'occupied',
    'missing-block',
    'target-not-found',
    'target-dead',
    'actor-dead',
    'target-alive',
    'invalid-bed',
    'not-sleep-time',
    'sleep-unsafe',
    'already-sleeping',
    'not-sleeping',
    'authority-boundary-unsupported',
  ],
  hungerAuthority: [
    'duplicate-command',
    'stale-revision',
    'unauthorized-player',
    'session-mismatch',
    'invalid-command',
    'insufficient-items',
    'cannot-eat',
    'invalid-elapsed-time',
    'authority-boundary-unsupported',
  ],
} as const satisfies Record<ExpectedReasonUnionName, ReadonlyArray<string>>

const stripReasonPrefix = (result: string, prefix: string): string => result.slice(prefix.length)

describe('survival and hunger rejection scenarios', () => {
  // This fails if A2 PlayerVitalsCommand acceptance or rejection differs from the scenario contract.
  it('observes PlayerVitalsCommand authority outcomes under A2', async () => {
    const runtime = await createScenarioRuntime(survivalScenario, { seed: SEED })
    const result = await runtime.run(SURVIVAL_SCENARIO_FRAME_COUNT)
    const unsupportedPrefix = 'authority marked command unsupported: '
    const rejectedPrefix = 'authority rejected command: '
    const unsupportedReasons = result.wireLog
      .filter((entry) => entry.result.startsWith(unsupportedPrefix))
      .map((entry) => stripReasonPrefix(entry.result, unsupportedPrefix))
      .sort()
    const commandReasons = result.wireLog
      .filter((entry) => entry.result.startsWith(rejectedPrefix))
      .map((entry) => stripReasonPrefix(entry.result, rejectedPrefix))
      .sort()

    expect(result.verdict.status).toBe('pass')
    expect(result.angle).toBe('A2')
    expect(unsupportedReasons).toStrictEqual(reasonsForStatus(survivalRejectionCoverage.commandUnsupported, 'scenario'))
    expect(commandReasons).toStrictEqual(reasonsForStatus(survivalRejectionCoverage.command, 'scenario')
      .filter((reason) => reason !== 'unauthorized-player'))
    expect(result.wireLog.find((entry) => entry.frame === ACCEPT_EAT_FRAME)).toMatchObject({
      outcome: 'accepted',
      result: 'authority accepted canonical intent; world state was not applied',
      tag: 'PlayerVitalsCommand',
    })
  })

  // This fails if the server accepts a PlayerVitalsCommand that names another client's player.
  it("rejects another player's command under A7", async () => {
    const runtime = await createScenarioRuntime(survivalUnauthorizedScenario, { seed: SEED })
    const result = await runtime.run(SURVIVAL_UNAUTHORIZED_SCENARIO_FRAME_COUNT)
    const rejectedPrefix = 'authority rejected command: '
    const commandReasons = result.wireLog
      .filter((entry) => entry.result.startsWith(rejectedPrefix))
      .map((entry) => stripReasonPrefix(entry.result, rejectedPrefix))

    expect(result.verdict.status).toBe('pass')
    expect(result.angle).toBe('A7')
    expect(commandReasons).toStrictEqual(['unauthorized-player'])
    expect(commandReasons).toStrictEqual(reasonsForStatus(survivalRejectionCoverage.command, 'scenario')
      .filter((reason) => reason === 'unauthorized-player'))
  })

  // This fails if the direct survival or hunger APIs stop returning a covered rejection reason.
  it('exercises every reachable direct survival and hunger rejection reason', () => {
    const survivalHeader = (requestId: string) => ({
      actor: PLAYER,
      expectedDimensionRevision: EXPECTED_DIMENSION_REVISION,
      expectedRevision: EXPECTED_REVISION,
      requestId,
      session: 's6-session',
    })
    const malformedSurvivalCommand: SurvivalCommand = { ...survivalHeader(''), _tag: 'Respawn' }
    const unsupportedSurvivalCommand: SurvivalCommand = { ...survivalHeader('s6-respawn'), _tag: 'Respawn' }
    const survivalResults = [
      new SurvivalAuthority().execute(malformedSurvivalCommand, TARGET_TICK),
      new SurvivalAuthority().execute(unsupportedSurvivalCommand, TARGET_TICK),
    ]
    const survivalReasons = survivalResults.flatMap((result) => result.accepted ? [] : [result.reason]).sort()

    const hungerHeader = (commandId: string) => ({
      commandId,
      expectedDimensionRevision: EXPECTED_DIMENSION_REVISION,
      expectedRevision: EXPECTED_REVISION,
      player: PLAYER,
      session: 's6-session',
    })
    const malformedActivity: HungerCommand = {
      ...hungerHeader('s6-invalid-activity'),
      _tag: 'Activity',
      activity: 'walk',
      amount: ZERO,
    }
    const unsupportedActivity: HungerCommand = {
      ...hungerHeader('s6-unsupported-activity'),
      _tag: 'Activity',
      activity: 'walk',
      amount: ONE,
    }
    const hungerAuthority = createHungerAuthority()
    const hungerResults = [
      hungerAuthority.execute(malformedActivity, TARGET_TICK),
      hungerAuthority.tick(NEGATIVE_ONE),
      hungerAuthority.execute(unsupportedActivity, TARGET_TICK),
    ]
    const hungerReasons = hungerResults.flatMap((result) => result.accepted ? [] : [result.reason]).sort()

    expect(survivalReasons).toStrictEqual(reasonsForStatus(survivalRejectionCoverage.survivalAuthority, 'scenario'))
    expect(hungerReasons).toStrictEqual(reasonsForStatus(survivalRejectionCoverage.hungerAuthority, 'scenario'))
    expect(malformedSurvivalCommand.requestId).toBe('')
    expect(malformedActivity.amount).toBe(ZERO)
  })

  // This fails if a rejection-union member lacks a scenario entry or code evidence for an unreachable entry.
  it('enumerates all five rejection unions and requires source evidence for every member', () => {
    const coverageUnions = {
      commandUnsupported: survivalRejectionCoverage.commandUnsupported,
      command: survivalRejectionCoverage.command,
      playerDamage: survivalRejectionCoverage.playerDamage,
      survivalAuthority: survivalRejectionCoverage.survivalAuthority,
      hungerAuthority: survivalRejectionCoverage.hungerAuthority,
    }
    const allEntries = Object.values(coverageUnions).flatMap((coverage) => Object.values(coverage))

    for (const unionName of EXPECTED_REASON_UNION_NAMES) {
      expect(Object.keys(coverageUnions[unionName]).sort()).toStrictEqual([...EXPECTED_REASON_UNIONS[unionName]].sort())
    }
    expect(reasonsForStatus(survivalRejectionCoverage.playerDamage, 'scenario')).toStrictEqual([])
    expect(reasonsForStatus(survivalRejectionCoverage.playerDamage, 'unreachable'))
      .toStrictEqual([...EXPECTED_REASON_UNIONS.playerDamage].sort())
    expect(allEntries).toHaveLength(Object.values(EXPECTED_REASON_UNIONS).reduce((count, reasons) => count + reasons.length, ZERO))
    for (const entry of allEntries) {
      expect(entry.details.length).toBeGreaterThan(ZERO)
      expect(entry.evidence.length).toBeGreaterThan(ZERO)
      expect(entry.evidence.every((reference) => /^[a-z][\w./-]*:\d+/u.test(reference))).toBe(true)
    }
  })
})

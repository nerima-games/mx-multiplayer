import { describe, expect, it } from '@effect/vitest'
import { createScenarioRuntime } from '../../apps/debug-ui/entrypoints/scenarios/scenario-runtime.js'
import {
  DIMENSIONS_BOSSES_SCENARIO_FRAME_COUNT,
  dimensionsBossesAuthorityScenario,
  dimensionsBossesUnauthorizedScenario,
} from '../../scenarios/dimensions-bosses.js'

const SEED = 67
const EXPECTED_COMMAND_COUNT = 5
const NO_MATCHING_INTENT = 'authority marked command unsupported: no-matching-c2-intent-payload'
const UNAUTHORIZED_PLAYER = 'authority rejected command: unauthorized-player'
const ACCEPTED_CONTROL = 'authority accepted canonical intent; world state was not applied'
const G6_COMMAND_TAGS = [
  'EndPortalUseCommand',
  'ThrowEyeOfEnderCommand',
  'InsertEyeIntoEndPortalFrameCommand',
  'NetherPortalUseCommand',
  'ToggleLeverCommand',
] as const

describe('dimensions and bosses scenarios', () => {
  // Fails if a dimensions or bosses command stops returning its explicit unsupported result on the authority path.
  it('records authority decisions for portal, eye, and lever commands under A2', async () => {
    const runtime = await createScenarioRuntime(dimensionsBossesAuthorityScenario, { seed: SEED })
    const result = await runtime.run(DIMENSIONS_BOSSES_SCENARIO_FRAME_COUNT)

    expect(result.angle).toBe('A2')
    expect(result.verdict.status).toBe('pass')
    expect(result.wireLog).toHaveLength(EXPECTED_COMMAND_COUNT + 1)
    expect(result.wireLog.slice(0, EXPECTED_COMMAND_COUNT).map((entry) => ({
      outcome: entry.outcome,
      result: entry.result,
      tag: entry.tag,
    }))).toStrictEqual(G6_COMMAND_TAGS.map((tag) => ({
      outcome: 'rejected',
      result: NO_MATCHING_INTENT,
      tag,
    })))
    expect(result.wireLog[EXPECTED_COMMAND_COUNT]).toMatchObject({
      outcome: 'accepted',
      result: ACCEPTED_CONTROL,
      tag: 'BowUseCommand',
    })
    expect(result.authority).toMatchObject({ acceptedCommands: 1, rejectedCommands: EXPECTED_COMMAND_COUNT })
  })

  // Fails if any G6 command trusts the submitted player ID before checking the connected identity.
  it('rejects forged player IDs before the authorized unsupported-action control under A7', async () => {
    const runtime = await createScenarioRuntime(dimensionsBossesUnauthorizedScenario, { seed: SEED })
    const result = await runtime.run(DIMENSIONS_BOSSES_SCENARIO_FRAME_COUNT)

    expect(result.angle).toBe('A7')
    expect(result.verdict.status).toBe('pass')
    expect(result.wireLog).toHaveLength(EXPECTED_COMMAND_COUNT + 1)
    expect(result.wireLog.slice(0, EXPECTED_COMMAND_COUNT).map((entry) => ({
      from: entry.from,
      outcome: entry.outcome,
      result: entry.result,
      tag: entry.tag,
    }))).toStrictEqual(G6_COMMAND_TAGS.map((tag) => ({
      from: 'client-b',
      outcome: 'rejected',
      result: UNAUTHORIZED_PLAYER,
      tag,
    })))
    expect(result.wireLog[EXPECTED_COMMAND_COUNT]).toMatchObject({
      from: 'client-a',
      outcome: 'rejected',
      result: NO_MATCHING_INTENT,
      tag: 'ToggleLeverCommand',
    })
    expect(result.authority.rejectedCommands).toBe(EXPECTED_COMMAND_COUNT + 1)
  })
})

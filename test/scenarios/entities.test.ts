import { describe, expect, it } from '@effect/vitest'
import { createScenarioRuntime } from '../../apps/debug-ui/entrypoints/scenarios/scenario-runtime.js'
import {
  ENTITIES_COMMAND_TAGS,
  ENTITIES_MESSAGE_TAGS,
  entitiesAuthorityScenario,
  entitiesUnauthorizedScenario,
  entitiesWireScenario,
} from '../../scenarios/entities.js'

const FIXED_SEED = 59
const ONE_FRAME = 1
const VALID_TAG_COUNT = 16
const MALFORMED_COUNT = 1
const ACCEPTED_COMMAND_COUNT = 4
const UNSUPPORTED_COMMAND_COUNT = 6
const SPOOFED_COMMAND_COUNT = 10

describe('entities and combat scenarios', () => {
  // Fails if an entity-group tag stops decoding or malformed fishing state is accepted.
  it('decodes every entities tag and rejects malformed fishing state', async () => {
    const runtime = await createScenarioRuntime(entitiesWireScenario, { seed: FIXED_SEED })
    const result = await runtime.run(ONE_FRAME)

    expect(ENTITIES_MESSAGE_TAGS).toHaveLength(VALID_TAG_COUNT)
    expect(result.angle).toBe('A1')
    expect(result.verdict.status).toBe('pass')
    expect(result.wireLog.slice(0, VALID_TAG_COUNT).map(({ tag }) => tag)).toStrictEqual([...ENTITIES_MESSAGE_TAGS])
    expect(result.wireLog.slice(0, VALID_TAG_COUNT).every(({ text }) => text.length > 0)).toBe(true)
    expect(result.wireLog.at(-1)).toMatchObject({
      outcome: 'rejected',
      result: 'decode rejected: malformed-frame',
      tag: '?',
    })
    expect(result.clients.reduce((received, client) => received + client.received, 0)).toBe(VALID_TAG_COUNT)
    expect(result.wireLog.filter(({ tag, outcome, result: decision }) =>
      tag === '?' && outcome === 'rejected' && decision === 'decode rejected: malformed-frame',
    )).toHaveLength(MALFORMED_COUNT)
  })

  // Fails if an accepted C2 intent is rejected or an unsupported command loses its typed reason.
  it('records supported and unsupported entities command authority outcomes', async () => {
    const runtime = await createScenarioRuntime(entitiesAuthorityScenario, { seed: FIXED_SEED })
    const result = await runtime.run(ONE_FRAME)

    expect(result.angle).toBe('A2')
    expect(result.verdict.status).toBe('pass')
    expect(result.wireLog.map(({ tag, outcome, result: decision }) => [tag, outcome, decision])).toStrictEqual([
      ['WorldTimeWeatherCommand', 'rejected', 'authority marked command unsupported: no-matching-c2-intent-payload'],
      ['EntityAttackCommand', 'accepted', 'authority accepted canonical intent; world state was not applied'],
      ['EntityPickupCommand', 'rejected', 'authority marked command unsupported: no-matching-c2-intent-payload'],
      ['BowUseCommand', 'accepted', 'authority accepted canonical intent; world state was not applied'],
      ['IgniteTntCommand', 'rejected', 'authority marked command unsupported: no-matching-c2-intent-payload'],
      ['EnderPearlCommand', 'rejected', 'authority marked command unsupported: intent-payload-does-not-preserve-command'],
      ['BucketUseCommand', 'rejected', 'authority marked command unsupported: no-matching-c2-intent-payload'],
      ['VehicleUseCommand', 'rejected', 'authority marked command unsupported: no-matching-c2-intent-payload'],
      ['FishingCommand', 'accepted', 'authority accepted canonical intent; world state was not applied'],
      ['VehicleCommand', 'accepted', 'authority accepted canonical intent; world state was not applied'],
    ])
    expect(result.authority).toMatchObject({ acceptedCommands: ACCEPTED_COMMAND_COUNT, rejectedCommands: UNSUPPORTED_COMMAND_COUNT })
  })

  // Fails if a command can claim another player's identity while a valid player's command remains usable.
  it('rejects entity command identity spoofing and accepts a valid control', async () => {
    const runtime = await createScenarioRuntime(entitiesUnauthorizedScenario, { seed: FIXED_SEED })
    const result = await runtime.run(ONE_FRAME)

    expect(result.angle).toBe('A7')
    expect(result.verdict.status).toBe('pass')
    expect(result.wireLog[0]).toMatchObject({
      tag: 'BowUseCommand',
      outcome: 'accepted',
      result: 'authority accepted canonical intent; world state was not applied',
    })
    expect(result.wireLog.slice(1).map(({ tag, outcome, result: decision }) => [tag, outcome, decision])).toStrictEqual([
      ...ENTITIES_COMMAND_TAGS.map((tag) => [tag, 'rejected', 'authority rejected command: unauthorized-player']),
    ])
    expect(result.authority).toMatchObject({ acceptedCommands: 1, rejectedCommands: SPOOFED_COMMAND_COUNT })
  })
})

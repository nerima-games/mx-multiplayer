import { describe, expect, it } from '@effect/vitest'
import { createScenarioRuntime } from '../../scenarios/runtime.js'
import { WORKBENCH_TAGS, workbenchWireScenario } from '../../scenarios/workbenches.js'

const FIXED_SEED = 47
const ONE_FRAME = 1
const INVALID_ENTRY_COUNT = 1
const LAST_ENTRY_OFFSET = -1

describe('workbench wire scenario', () => {
  // Fails if any workbench tag stops decoding at the wire boundary or malformed anvil input is accepted.
  it('decodes every workbench tag and rejects an invalid anvil slot', async () => {
    const runtime = await createScenarioRuntime(workbenchWireScenario, { seed: FIXED_SEED })
    const result = await runtime.run(ONE_FRAME)

    expect(result.angle).toBe('A1')
    expect(result.verdict.status).toBe('pass')
    expect(result.wireLog.map((entry) => entry.tag)).toStrictEqual([...WORKBENCH_TAGS, '?'])
    expect(result.wireLog.map((entry) => entry.outcome)).toStrictEqual([
      ...WORKBENCH_TAGS.map(() => 'delivered'),
      'rejected',
    ])
    expect(result.wireLog.slice(0, WORKBENCH_TAGS.length).map((entry) => entry.result))
      .toStrictEqual(WORKBENCH_TAGS.map((tag) => `decoded ${tag}`))
    expect(result.wireLog.at(LAST_ENTRY_OFFSET)).toMatchObject({
      outcome: 'rejected',
      result: 'decode rejected: malformed-frame',
    })
    expect(result.wireLog.at(LAST_ENTRY_OFFSET)?.text).toContain('"slot":36')
    expect(result.clients.reduce((received, client) => received + client.received, 0)).toBe(WORKBENCH_TAGS.length)
    expect(result.clients.reduce((rejected, client) => rejected + client.rejected, 0)).toBe(INVALID_ENTRY_COUNT)
    expect(result.authority).toMatchObject({ acceptedCommands: 0, rejectedCommands: 0 })
  })
})

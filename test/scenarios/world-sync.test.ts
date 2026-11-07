import { describe, expect, it } from '@effect/vitest'
import { createScenarioRuntime } from '../../scenarios/runtime.js'
import {
  runWorldSyncReconnectSnapshotProbe,
  worldSyncReconnectSnapshotScenario,
} from '../../scenarios/world-sync.js'

const FIXED_SEED = 41
const ONE_FRAME = 1
const INITIAL_REVISION = 3
const RECONNECT_REVISION = 5

const runScenario = async (scenario: typeof worldSyncReconnectSnapshotScenario) => {
  const runtime = await createScenarioRuntime(scenario, { seed: FIXED_SEED })
  return runtime.run(ONE_FRAME)
}

describe('world-sync lifecycle scenarios', () => {
  // Fails if a reconnect accepts an incremental revision before its new full-world baseline.
  it('requires a decoded WorldSnapshot before applying updates after disconnect', async () => {
    const probe = runWorldSyncReconnectSnapshotProbe()
    const result = await runScenario(worldSyncReconnectSnapshotScenario)

    expect(probe.updateBeforeSnapshot).toMatchObject({ accepted: false, reason: 'snapshot-required' })
    expect(probe.initial).toStrictEqual({ accepted: true, revision: INITIAL_REVISION })
    expect(probe.updateAfterDisconnect).toMatchObject({ accepted: false, reason: 'snapshot-required' })
    expect(probe.reconnect).toStrictEqual({ accepted: true, revision: RECONNECT_REVISION })
    expect(probe.updateAfterReconnect).toStrictEqual({ accepted: true, revision: RECONNECT_REVISION + 1 })
    expect(result).toMatchObject({
      angle: 'A5',
      id: 'world-sync.reconnect.snapshot-required',
      verdict: { status: 'pass' },
    })
  })

})

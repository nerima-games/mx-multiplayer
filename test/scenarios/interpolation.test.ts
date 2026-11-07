import { describe, expect, it } from '@effect/vitest'
import { Result } from 'effect'
import { PlayerId } from '../../src/domain/protocol.js'
import { SnapshotInterpolator, type PlayerTransformSnapshot } from '../../src/domain/snapshot-interpolation.js'
import { createScenarioRuntime } from '../../apps/debug-ui/entrypoints/scenarios/scenario-runtime.js'
import { interpolationScenario } from '../../scenarios/interpolation.js'

const PLAYER = PlayerId.make('s5-interpolation-test')
const RENDER_TICKS = [0, 2, 4, 6, 10, 15, 20]

const makeInterpolator = (): SnapshotInterpolator => {
  const result = SnapshotInterpolator.make({ historyLimit: 8, teleportDistance: 100 })
  if (Result.isFailure(result)) {
    throw new Error('valid interpolation test configuration was rejected')
  }
  return result.success
}

const snapshot = (
  sequence: number,
  tick: number,
  x: number,
  y = 0,
  z = 0,
  yawRadians = 0,
  pitchRadians = 0,
): PlayerTransformSnapshot => ({
  at: { x, y, z },
  facing: { pitchRadians, yawRadians },
  sequence,
  tick,
})

describe('snapshot interpolation scenario', () => {
  // This fails if movement messages stop traversing the scenario runtime or the interpolator violates its contract.
  it('runs the deterministic two-client movement scenario', async () => {
    const runtime = await createScenarioRuntime(interpolationScenario, { seed: 17 })
    const result = await runtime.run(2)

    expect(result.verdict.status).toBe('pass')
    expect(result.wireLog).toHaveLength(4)
    expect(result.wireLog.every((entry) => entry.tag === 'PlayerMove' && entry.outcome === 'delivered')).toBe(true)
  })

  // This fails if endpoints are extrapolated, clamped incorrectly, or the midpoint is not linear.
  it('samples both endpoints, clamps out-of-range render ticks, and interpolates the midpoint', () => {
    const interpolator = makeInterpolator()
    const first = snapshot(1, 0, 2, 4, 6, -0.5, -0.2)
    const last = snapshot(2, 1, 10, 8, 2, 0.5, 0.2)

    expect(interpolator.ingest(PLAYER, first).accepted).toBe(true)
    expect(interpolator.ingest(PLAYER, last).accepted).toBe(true)
    expect(interpolator.sample(PLAYER, 0)).toStrictEqual(first)
    expect(interpolator.sample(PLAYER, 1)).toStrictEqual(last)
    expect(interpolator.sample(PLAYER, -2)).toStrictEqual(first)
    expect(interpolator.sample(PLAYER, 3)).toStrictEqual(last)
    expect(interpolator.sample(PLAYER, 0.5)).toStrictEqual({
      at: { x: 6, y: 6, z: 4 },
      facing: { pitchRadians: 0, yawRadians: 0 },
      sequence: 2,
      tick: 0.5,
    })
  })

  // This fails if increasing render time makes the interpolated x position move backwards.
  it('keeps sampled position monotonic across an ordered history', () => {
    const interpolator = makeInterpolator()
    const history = [snapshot(1, 0, 0), snapshot(2, 6, 12), snapshot(3, 20, 40)]

    for (const sample of history) {
      expect(interpolator.ingest(PLAYER, sample).accepted).toBe(true)
    }

    const positions = RENDER_TICKS.map((tick) => {
      const sampled = interpolator.sample(PLAYER, tick)
      if (sampled === undefined) {
        throw new Error(`expected a sample at render tick ${String(tick)}`)
      }
      return sampled.at.x
    })
    let previous = Number.NEGATIVE_INFINITY
    for (const position of positions) {
      expect(position).toBeGreaterThanOrEqual(previous)
      previous = position
    }
  })

  // This fails if delayed or reordered snapshots are accepted and alter the existing interpolation history.
  it('ignores delayed and reordered snapshots without changing the sampled result', () => {
    const interpolator = makeInterpolator()

    expect(interpolator.ingest(PLAYER, snapshot(1, 0, 0)).accepted).toBe(true)
    expect(interpolator.ingest(PLAYER, snapshot(3, 20, 40)).accepted).toBe(true)
    expect(interpolator.ingest(PLAYER, snapshot(4, 15, 100))).toStrictEqual({
      accepted: false,
      reason: 'duplicate-or-stale',
    })
    expect(interpolator.ingest(PLAYER, snapshot(2, 10, 10))).toStrictEqual({
      accepted: false,
      reason: 'duplicate-or-stale',
    })
    expect(interpolator.historySize(PLAYER)).toBe(2)
    expect(interpolator.sample(PLAYER, 10)?.at.x).toBe(20)
  })

  // This fails if duplicate sequence or tick values create a second history entry or change interpolation.
  it('ignores duplicate snapshots and preserves the previous history', () => {
    const interpolator = makeInterpolator()
    const first = snapshot(1, 0, 0)
    const last = snapshot(2, 10, 10)

    expect(interpolator.ingest(PLAYER, first).accepted).toBe(true)
    expect(interpolator.ingest(PLAYER, last).accepted).toBe(true)
    expect(interpolator.ingest(PLAYER, last)).toStrictEqual({ accepted: false, reason: 'duplicate-or-stale' })
    expect(interpolator.ingest(PLAYER, snapshot(2, 20, 20))).toStrictEqual({
      accepted: false,
      reason: 'duplicate-or-stale',
    })
    expect(interpolator.ingest(PLAYER, snapshot(3, 10, 30))).toStrictEqual({
      accepted: false,
      reason: 'duplicate-or-stale',
    })
    expect(interpolator.historySize(PLAYER)).toBe(2)
    expect(interpolator.sample(PLAYER, 5)?.at.x).toBe(5)
  })
})

import { describe, expect, it } from '@effect/vitest'
import { Effect, Result } from 'effect'
import * as fc from 'fast-check'
import {
  EntityId,
  PlayerId,
  type EntityTransformSnapshot,
  type PlayerTransformSnapshot,
  createServerCorrectionPlan,
  SnapshotInterpolator,
} from '../src/index'

const alice = PlayerId.make('alice')
const bob = PlayerId.make('bob')
const zombie = EntityId.make('zombie-1')
const skeleton = EntityId.make('skeleton-1')
const snapshot = (
  sequence: number,
  tick: number,
  x: number,
  yawRadians = 0,
): PlayerTransformSnapshot => ({
  at: { x, y: 64, z: 0 },
  facing: { pitchRadians: 0, yawRadians },
  sequence,
  tick,
})

const entitySnapshot = (sequence: number, tick: number, x: number): EntityTransformSnapshot => ({
  at: { x, y: 64, z: 0 },
  sequence,
  tick,
})

const makeSubject = (historyLimit = 4, teleportDistance = 16) =>
  Result.getOrThrow(SnapshotInterpolator.make({ historyLimit, teleportDistance }))

describe('snapshot admission and history', () => {
  it.effect('rejects duplicate, delayed, reversed-tick and invalid snapshots', () =>
    Effect.sync(() => {
      const subject = makeSubject()
      expect(subject.ingest(alice, snapshot(4, 10, 0))).toEqual({ accepted: true, historySize: 1 })
      expect(subject.ingest(alice, snapshot(4, 11, 1))).toEqual({ accepted: false, reason: 'duplicate-or-stale' })
      expect(subject.ingest(alice, snapshot(3, 12, 1))).toEqual({ accepted: false, reason: 'duplicate-or-stale' })
      expect(subject.ingest(alice, snapshot(5, 9, 1))).toEqual({ accepted: false, reason: 'duplicate-or-stale' })
      expect(subject.ingest(alice, snapshot(5.5, 12, 1))).toEqual({ accepted: false, reason: 'invalid' })
      expect(subject.historySize(alice)).toBe(1)
    }),
  )

  it.effect('property-checks player admission as a typed result for arbitrary JSON inputs', () =>
    Effect.sync(() => {
      fc.assert(
        fc.property(fc.jsonValue(), (input) => {
          const result = makeSubject().ingest(alice, input)
          expect(typeof result.accepted).toBe('boolean')
          if (result.accepted) {
            expect(Number.isSafeInteger(result.historySize)).toBe(true)
          } else {
            expect(['invalid', 'duplicate-or-stale']).toContain(result.reason)
          }
        }),
        { numRuns: 100, seed: 38_400 },
      )
    }),
  )

  it.effect('rejects non-record positions and facings, and clears every entity history on disconnect', () =>
    Effect.sync(() => {
      const subject = makeSubject()
      expect(subject.ingest(alice, { ...snapshot(1, 10, 0), at: null })).toEqual({
        accepted: false,
        reason: 'invalid',
      })
      expect(subject.ingest(alice, { ...snapshot(1, 10, 0), facing: null })).toEqual({
        accepted: false,
        reason: 'invalid',
      })

      subject.ingestEntity(zombie, entitySnapshot(1, 10, 0))
      subject.ingestEntity(skeleton, entitySnapshot(1, 10, 1))
      subject.disconnectEntity()

      expect(subject.entityHistorySize(zombie)).toBe(0)
      expect(subject.entityHistorySize(skeleton)).toBe(0)
    }),
  )

  it.effect('bounds history independently for every player', () =>
    Effect.sync(() => {
      const subject = makeSubject(2)
      for (let value = 0; value < 5; value += 1) {
        subject.ingest(alice, snapshot(value, value, value))
      }
      subject.ingest(bob, snapshot(0, 0, 50))
      expect(subject.historySize(alice)).toBe(2)
      expect(subject.historySize(bob)).toBe(1)
      expect(subject.sample(alice, -1)?.at.x).toBe(3)
    }),
  )
})

describe('deterministic interpolation', () => {
  it.effect('interpolates position, pitch and yaw over the shortest angular path', () =>
    Effect.sync(() => {
      const subject = makeSubject()
      subject.ingest(alice, snapshot(1, 10, 0, Math.PI * 0.9))
      subject.ingest(alice, {
        ...snapshot(2, 20, 10, -Math.PI * 0.9),
        facing: { pitchRadians: 1, yawRadians: -Math.PI * 0.9 },
      })

      const first = subject.sample(alice, 15)
      const replay = subject.sample(alice, 15)
      expect(first).toStrictEqual(replay)
      expect(first?.at).toStrictEqual({ x: 5, y: 64, z: 0 })
      expect(first?.facing.pitchRadians).toBe(0.5)
      expect(first?.facing.yawRadians).toBeCloseTo(Math.PI)
      expect(first?.sequence).toBe(2)
      expect(first?.tick).toBe(15)
    }),
  )

  it.effect('clamps outside history and snaps teleports only at their authoritative tick', () =>
    Effect.sync(() => {
      const subject = makeSubject(4, 8)
      const before = snapshot(1, 10, 0)
      const after = snapshot(2, 20, 100)
      subject.ingest(alice, before)
      subject.ingest(alice, after)

      expect(subject.sample(alice, 5)).toBe(before)
      expect(subject.sample(alice, 19.999)).toBe(before)
      expect(subject.sample(alice, 20)).toBe(after)
      expect(subject.sample(alice, 999)).toBe(after)
    }),
  )

  it.effect('teleports only when movement exceeds teleportDistance', () =>
    Effect.sync(() => {
      const subject = makeSubject(4, 8)
      const before = snapshot(1, 0, 0)
      const exactlyAtThreshold = snapshot(2, 10, 8)
      subject.ingest(alice, before)
      subject.ingest(alice, exactlyAtThreshold)
      expect(subject.sample(alice, 5)?.at.x).toBe(4)

      const justBelowThreshold = makeSubject(4, 8)
      const near = snapshot(2, 10, 7.999)
      justBelowThreshold.ingest(alice, before)
      justBelowThreshold.ingest(alice, near)
      expect(justBelowThreshold.sample(alice, 5)?.at.x).toBeCloseTo(3.9995)

      const justAboveThreshold = makeSubject(4, 8)
      const far = snapshot(2, 10, 8.001)
      justAboveThreshold.ingest(alice, before)
      justAboveThreshold.ingest(alice, far)
      expect(justAboveThreshold.sample(alice, 5)?.at.x).toBe(0)
      expect(justAboveThreshold.sample(alice, 10)?.at.x).toBe(8.001)
    }),
  )

  it.effect('interpolates orientation when position is unchanged instead of treating zero distance as a teleport', () =>
    Effect.sync(() => {
      const subject = makeSubject(4, 8)
      subject.ingest(alice, {
        ...snapshot(1, 10, 7),
        facing: { pitchRadians: 0, yawRadians: 0 },
      })
      subject.ingest(alice, {
        ...snapshot(2, 20, 7),
        facing: { pitchRadians: 1, yawRadians: 1 },
      })

      const sample = subject.sample(alice, 15)
      expect(sample?.at).toStrictEqual({ x: 7, y: 64, z: 0 })
      expect(sample?.facing).toStrictEqual({ pitchRadians: 0.5, yawRadians: 0.5 })
      expect(sample?.tick).toBe(15)
    }),
  )

  it.effect('walks past a non-matching pair to interpolate within a later one in a 3-snapshot history', () =>
    Effect.sync(() => {
      const subject = makeSubject(4, 16)
      subject.ingest(alice, snapshot(1, 10, 0))
      subject.ingest(alice, snapshot(2, 20, 10))
      subject.ingest(alice, snapshot(3, 30, 20))

      // renderTick (25) is past the first neighbouring pair's right edge (tick
      // 20), so `#interpolate`'s loop must skip it and match the second pair
      // (tick 20, tick 30) instead — the only way to exercise the loop's
      // "not this pair" branch rather than always matching on the first.
      const sample = subject.sample(alice, 25)
      expect(sample?.at).toStrictEqual({ x: 15, y: 64, z: 0 })
    }),
  )

  it.effect('snaps a mid-history teleport to the later side when renderTick lands exactly on its tick', () =>
    Effect.sync(() => {
      const subject = makeSubject(4, 8)
      const before = snapshot(1, 10, 0)
      const teleported = snapshot(2, 20, 100)
      const after = snapshot(3, 30, 101)
      subject.ingest(alice, before)
      subject.ingest(alice, teleported)
      subject.ingest(alice, after)

      // renderTick sits strictly between the buffer's endpoints (10 and 30), so
      // the boundary check does not intercept it; it lands exactly on the
      // teleporting pair's later tick, which is the case boundary checks alone
      // cannot cover.
      expect(subject.sample(alice, 20)).toBe(teleported)
    }),
  )
})

describe('entity interpolation', () => {
  it.effect('samples independent entity histories at server ticks', () =>
    Effect.sync(() => {
      const subject = makeSubject(4, 16)
      subject.ingestEntity(zombie, entitySnapshot(1, 10, 2))
      subject.ingestEntity(zombie, entitySnapshot(2, 20, 10))
      subject.ingestEntity(skeleton, entitySnapshot(1, 10, 40))

      expect(subject.sampleEntity(zombie, 15)).toStrictEqual({
        at: { x: 6, y: 64, z: 0 },
        sequence: 2,
        tick: 15,
      })
      expect(subject.sampleEntity(skeleton, 15)?.at.x).toBe(40)
      expect(subject.entityHistorySize(zombie)).toBe(2)
      expect(subject.historySize(alice)).toBe(0)
    }),
  )

  it.effect('rejects invalid and stale entity snapshots without growing their history', () =>
    Effect.sync(() => {
      const subject = makeSubject()
      expect(subject.ingestEntity(zombie, entitySnapshot(1, 10, 0))).toEqual({ accepted: true, historySize: 1 })
      expect(subject.ingestEntity(zombie, entitySnapshot(2, 9, 1))).toEqual({ accepted: false, reason: 'duplicate-or-stale' })
      expect(subject.ingestEntity(zombie, entitySnapshot(2, 11, Number.NaN))).toEqual({ accepted: false, reason: 'invalid' })
      expect(subject.entityHistorySize(zombie)).toBe(1)
    }),
  )

  it.effect('property-checks entity admission as a typed result for arbitrary JSON inputs', () =>
    Effect.sync(() => {
      const subject = makeSubject()
      fc.assert(
        fc.property(fc.jsonValue(), (input) => {
          const result = subject.ingestEntity(zombie, input)
          expect(typeof result.accepted).toBe('boolean')
          if (result.accepted) {
            expect(Number.isSafeInteger(result.historySize)).toBe(true)
          } else {
            expect(['invalid', 'duplicate-or-stale']).toContain(result.reason)
          }
        }),
        { numRuns: 100, seed: 38_404 },
      )
    }),
  )

  it.effect('property-checks tick interpolation for positions below the teleport threshold', () =>
    Effect.sync(() => {
      fc.assert(
        fc.property(
          fc.integer({ min: 0, max: 1_000_000 }),
          fc.integer({ min: 1, max: 100 }),
          fc.integer({ min: 0, max: 1_000 }),
          fc.integer({ min: 0, max: 15 }),
          (startTick, tickSpan, startX, distance) => {
            const subject = makeSubject(4, 16)
            subject.ingestEntity(zombie, entitySnapshot(1, startTick, startX))
            subject.ingestEntity(zombie, entitySnapshot(2, startTick + tickSpan, startX + distance))

            const renderTick = startTick + tickSpan / 2
            expect(subject.sampleEntity(zombie, renderTick)?.at.x).toBe(startX + distance / 2)
            expect(subject.sampleEntity(zombie, renderTick)?.tick).toBe(renderTick)
          },
        ),
        { numRuns: 100, seed: 38_401 },
      )
    }),
  )

  it.effect('teleports entity positions only above the threshold', () =>
    Effect.sync(() => {
      const exact = makeSubject(4, 8)
      exact.ingestEntity(zombie, entitySnapshot(1, 0, 0))
      exact.ingestEntity(zombie, entitySnapshot(2, 10, 8))
      expect(exact.sampleEntity(zombie, 5)?.at.x).toBe(4)

      const below = makeSubject(4, 8)
      below.ingestEntity(zombie, entitySnapshot(1, 0, 0))
      below.ingestEntity(zombie, entitySnapshot(2, 10, 7.999))
      expect(below.sampleEntity(zombie, 5)?.at.x).toBeCloseTo(3.9995)

      const above = makeSubject(4, 8)
      above.ingestEntity(zombie, entitySnapshot(1, 0, 0))
      above.ingestEntity(zombie, entitySnapshot(2, 10, 8.001))
      expect(above.sampleEntity(zombie, 5)?.at.x).toBe(0)
      expect(above.sampleEntity(zombie, 10)?.at.x).toBe(8.001)
    }),
  )

  it.effect('clears entity history with its entity and on transport close', () =>
    Effect.sync(() => {
      const subject = makeSubject()
      subject.ingestEntity(zombie, entitySnapshot(1, 1, 1))
      subject.ingestEntity(skeleton, entitySnapshot(1, 1, 2))

      subject.disconnectEntity(zombie)
      expect(subject.sampleEntity(zombie, 1)).toBeUndefined()
      expect(subject.sampleEntity(skeleton, 1)?.at.x).toBe(2)

      subject.disconnect()
      expect(subject.entityHistorySize(skeleton)).toBe(0)
    }),
  )
})

describe('server correction interpolation', () => {
  const from = { x: 0, y: 2, z: 4 }
  const to = { x: 8, y: 6, z: 12 }

  it.effect('moves a normal correction over its configured simulation ticks', () =>
    Effect.sync(() => {
      const plan = Result.getOrThrow(createServerCorrectionPlan({
        correctionDurationTicks: 4,
        from,
        startTick: 20,
        teleportDistance: 16,
        to,
      }))

      expect(Result.getOrThrow(plan.sample(19))).toEqual(from)
      expect(Result.getOrThrow(plan.sample(20))).toEqual(from)
      expect(Result.getOrThrow(plan.sample(22))).toEqual({ x: 4, y: 4, z: 8 })
      expect(Result.getOrThrow(plan.sample(24))).toEqual(to)
      expect(Result.getOrThrow(plan.sample(100))).toEqual(to)
      expect(plan.sample(Number.NaN)).toMatchObject({ _tag: 'Failure', failure: { reason: 'invalid-sample-tick' } })
    }),
  )

  it.effect('applies a correction immediately only when it exceeds the teleport threshold', () =>
    Effect.sync(() => {
      const exact = Result.getOrThrow(createServerCorrectionPlan({
        correctionDurationTicks: 4,
        from,
        startTick: 20,
        teleportDistance: 8,
        to: { x: 8, y: 2, z: 4 },
      }))
      expect(Result.getOrThrow(exact.sample(20))).toEqual(from)
      expect(Result.getOrThrow(exact.sample(22))).toEqual({ x: 4, y: 2, z: 4 })

      const gradual = Result.getOrThrow(createServerCorrectionPlan({
        correctionDurationTicks: 4,
        from,
        startTick: 20,
        teleportDistance: 8,
        to: { x: 7.999, y: 2, z: 4 },
      }))
      expect(Result.getOrThrow(gradual.sample(20))).toEqual(from)
      expect(Result.getOrThrow(gradual.sample(22))).toEqual({ x: 3.9995, y: 2, z: 4 })
      expect(Result.getOrThrow(gradual.sample(24))).toEqual({ x: 7.999, y: 2, z: 4 })

      const teleport = Result.getOrThrow(createServerCorrectionPlan({
        correctionDurationTicks: 4,
        from,
        startTick: 20,
        teleportDistance: 8,
        to: { x: 8.001, y: 2, z: 4 },
      }))
      expect(Result.getOrThrow(teleport.sample(19))).toEqual(from)
      expect(Result.getOrThrow(teleport.sample(20))).toEqual({ x: 8.001, y: 2, z: 4 })
    }),
  )

  it.effect('property-checks correction samples from absolute tick inputs', () =>
    Effect.sync(() => {
      fc.assert(
        fc.property(
          fc.integer({ min: 0, max: 1_000_000 }),
          fc.integer({ min: 1, max: 100 }),
          fc.integer({ min: -1_000, max: 1_000 }),
          fc.integer({ min: -1_000, max: 1_000 }),
          (startTick, durationTicks, startX, targetX) => {
            const plan = Result.getOrThrow(createServerCorrectionPlan({
              correctionDurationTicks: durationTicks,
              from: { x: startX, y: 0, z: 0 },
              startTick,
              teleportDistance: 10_000,
              to: { x: targetX, y: 0, z: 0 },
            }))
            const halfwayTick = startTick + durationTicks / 2
            const expectedMidpoint = (startX + targetX) / 2

            expect(Result.getOrThrow(plan.sample(startTick))).toEqual({ x: startX, y: 0, z: 0 })
            expect(Result.getOrThrow(plan.sample(halfwayTick))).toEqual({ x: expectedMidpoint, y: 0, z: 0 })
            expect(Result.getOrThrow(plan.sample(startTick + durationTicks))).toEqual({ x: targetX, y: 0, z: 0 })
          },
        ),
        { numRuns: 100, seed: 38_402 },
      )
    }),
  )

  it.effect('returns typed failures for invalid plans and ticks', () =>
    Effect.sync(() => {
      expect(createServerCorrectionPlan(null)).toMatchObject({
        _tag: 'Failure',
        failure: { _tag: 'ServerCorrectionError', reason: 'invalid-plan-input' },
      })
      expect(createServerCorrectionPlan({
        correctionDurationTicks: 0,
        from,
        startTick: 20,
        teleportDistance: 8,
        to,
      })).toMatchObject({
        _tag: 'Failure',
        failure: { _tag: 'ServerCorrectionError', reason: 'invalid-plan-input' },
      })

      fc.assert(
        fc.property(fc.jsonValue(), (input) => {
          const result = createServerCorrectionPlan(input)
          if (Result.isFailure(result)) {
            expect(result.failure).toMatchObject({ _tag: 'ServerCorrectionError', reason: 'invalid-plan-input' })
          } else {
            expect(Result.isSuccess(result.success.sample(0))).toBe(true)
          }
        }),
        { numRuns: 100, seed: 38_403 },
      )
    }),
  )
})

describe('disconnect cleanup', () => {
  it.effect('clears one departed peer without touching others, then clears all on transport close', () =>
    Effect.sync(() => {
      const subject = makeSubject()
      subject.ingest(alice, snapshot(1, 1, 1))
      subject.ingest(bob, snapshot(1, 1, 2))

      subject.disconnect(alice)
      expect(subject.sample(alice, 1)).toBeUndefined()
      expect(subject.sample(bob, 1)?.at.x).toBe(2)

      subject.disconnect()
      expect(subject.historySize(bob)).toBe(0)
    }),
  )

  it.effect('refuses to sample a non-finite renderTick rather than propagating NaN into the result', () =>
    Effect.sync(() => {
      const subject = makeSubject()
      subject.ingest(alice, snapshot(1, 10, 0))
      expect(subject.sample(alice, Number.NaN)).toBeUndefined()
      expect(subject.sample(alice, Number.POSITIVE_INFINITY)).toBeUndefined()
    }),
  )

  it.effect('returns typed failures for invalid configuration', () =>
    Effect.sync(() => {
      expect(SnapshotInterpolator.make({ historyLimit: 1, teleportDistance: 1 })).toMatchObject({
        _tag: 'Failure',
        failure: { reason: 'invalid-history-limit' },
      })
      expect(SnapshotInterpolator.make({ historyLimit: 2, teleportDistance: 0 })).toMatchObject({
        _tag: 'Failure',
        failure: { reason: 'invalid-teleport-distance' },
      })
    }),
  )

  it.effect('keeps opposite extreme coordinates finite when distance calculation overflows', () =>
    Effect.sync(() => {
      const subject = makeSubject(4, Number.MAX_VALUE)
      const maximum = Number.MAX_VALUE
      subject.ingest(alice, {
        at: { x: -maximum, y: maximum, z: 0 },
        facing: { pitchRadians: 1, yawRadians: maximum },
        sequence: 1,
        tick: 10,
      })
      subject.ingest(alice, {
        at: { x: maximum, y: -maximum, z: 0 },
        facing: { pitchRadians: -1, yawRadians: -maximum },
        sequence: 2,
        tick: 20,
      })

      const sample = subject.sample(alice, 15)
      expect(sample).toBeDefined()
      expect(Number.isFinite(sample?.at.x)).toBe(true)
      expect(Number.isFinite(sample?.at.y)).toBe(true)
      expect(Number.isFinite(sample?.at.z)).toBe(true)
      expect(Number.isFinite(sample?.facing.pitchRadians)).toBe(true)
      expect(Number.isFinite(sample?.facing.yawRadians)).toBe(true)
    }),
  )

  it.effect('interpolates nearby positions with finite extreme headings', () =>
    Effect.sync(() => {
      const subject = makeSubject(4, Number.MAX_VALUE)
      const maximum = Number.MAX_VALUE
      subject.ingest(alice, {
        at: { x: 0, y: 1, z: 2 },
        facing: { pitchRadians: 1, yawRadians: maximum },
        sequence: 1,
        tick: 10,
      })
      subject.ingest(alice, {
        at: { x: 1, y: 2, z: 3 },
        facing: { pitchRadians: -1, yawRadians: -maximum },
        sequence: 2,
        tick: 20,
      })

      const sample = subject.sample(alice, 15)
      expect(sample?.at).toStrictEqual({ x: 0.5, y: 1.5, z: 2.5 })
      expect(Number.isFinite(sample?.facing.pitchRadians)).toBe(true)
      expect(Number.isFinite(sample?.facing.yawRadians)).toBe(true)
    }),
  )
})

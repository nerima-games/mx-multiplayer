import { describe, expect, it } from '@effect/vitest'
import { Effect } from 'effect'
import {
  PlayerId,
  type PlayerTransformSnapshot,
  SnapshotInterpolator,
} from '../src/index'

const alice = PlayerId.make('alice')
const bob = PlayerId.make('bob')
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

const makeSubject = (historyLimit = 4, teleportDistance = 16) =>
  new SnapshotInterpolator({ historyLimit, teleportDistance })

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

  it.effect('rejects invalid configuration eagerly', () =>
    Effect.sync(() => {
      expect(() => new SnapshotInterpolator({ historyLimit: 1, teleportDistance: 1 })).toThrow(RangeError)
      expect(() => new SnapshotInterpolator({ historyLimit: 2, teleportDistance: 0 })).toThrow(RangeError)
    }),
  )
})

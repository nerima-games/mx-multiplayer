import { describe, expect, it } from '@effect/vitest'
import { Effect } from 'effect'
import {
  PlayerId,
  SnapshotInterpolator,
  type PlayerTransformSnapshot,
} from '../src/index'

const alice = PlayerId.make('alice')
const bob = PlayerId.make('bob')
const snapshot = (
  sequence: number,
  tick: number,
  x: number,
  yawRadians = 0,
): PlayerTransformSnapshot => ({
  sequence,
  tick,
  at: { x, y: 64, z: 0 },
  facing: { yawRadians, pitchRadians: 0 },
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
        facing: { yawRadians: -Math.PI * 0.9, pitchRadians: 1 },
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

  it.effect('rejects invalid configuration eagerly', () =>
    Effect.sync(() => {
      expect(() => new SnapshotInterpolator({ historyLimit: 1, teleportDistance: 1 })).toThrow(RangeError)
      expect(() => new SnapshotInterpolator({ historyLimit: 2, teleportDistance: 0 })).toThrow(RangeError)
    }),
  )
})

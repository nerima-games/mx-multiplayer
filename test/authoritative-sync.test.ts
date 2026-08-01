/* eslint-disable no-magic-numbers, id-length, sort-imports -- Protocol fixtures favor literal values and conventional import grouping. */
import { describe, expect, it } from '@effect/vitest'
import { Effect } from 'effect'
import {
  AuthoritativeRevisionTracker,
  PlayerId,
  PlayerName,
  WorldId,
  type WorldSnapshot,
} from '../src/index'

const overworld = WorldId.make('overworld')
const nether = WorldId.make('nether')

const snapshot = (world: WorldId, revision: number): WorldSnapshot => ({
  _tag: 'WorldSnapshot',
  blocks: [],
  players: [
    {
      at: { x: 0, y: 64, z: 0 },
      facing: { pitchRadians: 0, yawRadians: 0 },
      name: PlayerName.make('Alice'),
      player: PlayerId.make('alice'),
      world,
    },
  ],
  revision,
  seed: 42,
  world,
})

describe('authoritative world revision admission', () => {
  it.effect('requires a snapshot before applying incremental updates', () =>
    Effect.sync(() => {
      const subject = new AuthoritativeRevisionTracker()

      expect(subject.ingestRevision(overworld, 8)).toStrictEqual({
        accepted: false,
        reason: 'snapshot-required',
        receivedRevision: 8,
      })
      expect(subject.revision(overworld)).toBeUndefined()
      expect(subject.ingestSnapshot(snapshot(overworld, 7))).toStrictEqual({
        accepted: true,
        revision: 7,
      })
      expect(subject.ingestRevision(overworld, 8)).toStrictEqual({ accepted: true, revision: 8 })
    }),
  )

  it.effect('detects missing revisions without advancing past the gap', () =>
    Effect.sync(() => {
      const subject = new AuthoritativeRevisionTracker()
      subject.ingestSnapshot(snapshot(overworld, 10))

      expect(subject.ingestRevision(overworld, 12)).toStrictEqual({
        accepted: false,
        expectedRevision: 11,
        reason: 'revision-gap',
        receivedRevision: 12,
      })
      expect(subject.revision(overworld)).toBe(10)
      expect(subject.ingestSnapshot(snapshot(overworld, 12))).toStrictEqual({
        accepted: true,
        revision: 12,
      })
    }),
  )

  it.effect('rejects delayed snapshots and duplicate live updates', () =>
    Effect.sync(() => {
      const subject = new AuthoritativeRevisionTracker()
      subject.ingestSnapshot(snapshot(overworld, 3))
      subject.ingestRevision(overworld, 4)

      expect(subject.ingestSnapshot(snapshot(overworld, 4))).toStrictEqual({
        accepted: false,
        reason: 'duplicate-or-stale',
        receivedRevision: 4,
      })
      expect(subject.ingestSnapshot(snapshot(overworld, 2))).toStrictEqual({
        accepted: false,
        reason: 'duplicate-or-stale',
        receivedRevision: 2,
      })
      expect(subject.ingestRevision(overworld, 4)).toStrictEqual({
        accepted: false,
        reason: 'duplicate-or-stale',
        receivedRevision: 4,
      })
      expect(subject.revision(overworld)).toBe(4)
    }),
  )

  it.effect('tracks worlds independently and invalidates baselines on disconnect', () =>
    Effect.sync(() => {
      const subject = new AuthoritativeRevisionTracker()
      subject.ingestSnapshot(snapshot(overworld, 5))
      subject.ingestSnapshot(snapshot(nether, 20))

      subject.disconnect(overworld)
      expect(subject.revision(overworld)).toBeUndefined()
      expect(subject.revision(nether)).toBe(20)

      subject.disconnect()
      expect(subject.ingestRevision(nether, 21)).toStrictEqual({
        accepted: false,
        reason: 'snapshot-required',
        receivedRevision: 21,
      })
    }),
  )
})

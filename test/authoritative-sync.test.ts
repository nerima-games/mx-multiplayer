/* eslint-disable no-magic-numbers, id-length, sort-imports -- Protocol fixtures favor literal values and conventional import grouping. */
import { describe, expect, it } from '@effect/vitest'
import * as fc from 'fast-check'
import { Effect, Result, Schema } from 'effect'
import { BlockIdSchema, BlockPositionSchema, WorldRevisionSchema } from '@nerima-games/mc-kernel'
import type { BlockPosition, WorldRevision } from '@nerima-games/mc-kernel'
import { ReplicatedOwnerIdSchema } from '@nerima-games/mc-sim'
import type {
  ReplicatedBlockChange,
  ReplicatedOwnerChange,
  ReplicatedOwnerId,
  WorldBlockRead,
} from '@nerima-games/mc-sim'
import {
  AuthoritativeClientState,
  SnapshotTransferReceiver,
  applyReplicatedWorldDelta,
  decodeUtf8Frame,
  sha256Hex,
  type CompletedSnapshotTransfer,
  type SnapshotTransferLimits,
} from '../src/domain/authoritative-sync'
import {
  createReplicatedOwnerRegistry,
  encodeFrame,
  encodeTransferredSnapshotFrame,
  type ReplicatedOwnerRegistryLimits,
} from '../src/domain/codec'
import {
  AuthoritativeRevisionTracker,
  PlayerId,
  PlayerName,
  type ReplicatedWorldDeltaMessage,
  type ReplicatedWorldSnapshot,
  type ReplicatedWorldSnapshotChunk,
  type ReplicatedWorldSnapshotEnd,
  type ReplicatedWorldSnapshotStart,
  type Base64,
  Base64Schema,
  LowercaseHexSha256Schema,
  TransferIdSchema,
  WorldId,
  type WorldSnapshot,
} from '../src/index'

const overworld = WorldId.make('overworld')
const nether = WorldId.make('nether')

const snapshot = (world: WorldId, revision: number): WorldSnapshot => ({
  _tag: 'WorldSnapshot',
  blocks: [],
  levers: [],
  players: [
    {
      at: { x: 0, y: 64, z: 0 },
      facing: { pitchRadians: 0, yawRadians: 0 },
      name: PlayerName.make('Alice'),
      player: PlayerId.make('alice'),
      world,
    },
  ],
  poweredRails: [],
  revision,
  seed: 42,
  world,
})

const replicatedRevision = (value: number): WorldRevision => Schema.decodeUnknownSync(WorldRevisionSchema)(value)

const ownerId = (value: string): ReplicatedOwnerId => Schema.decodeUnknownSync(ReplicatedOwnerIdSchema)(value)

const ownerChange = (owner: string, state: unknown): ReplicatedOwnerChange => ({ owner: ownerId(owner), state })

const blockPosition = (x: number, y = 64, z = 0): BlockPosition => Schema.decodeUnknownSync(BlockPositionSchema)({ x, y, z })

const blockRead = (x: number, block: number, y = 64, z = 0): WorldBlockRead => ({
  dimension: 'overworld',
  position: blockPosition(x, y, z),
  reading: { _tag: 'Block', block: Schema.decodeUnknownSync(BlockIdSchema)(block) },
})

const blockChange = (x: number, after: number): ReplicatedBlockChange => ({
  before: Schema.decodeUnknownSync(BlockIdSchema)(0),
  dimension: 'overworld',
  position: blockPosition(x),
  after: Schema.decodeUnknownSync(BlockIdSchema)(after),
})

const replicatedSnapshot = (
  revision: number,
  owners: ReadonlyArray<ReplicatedOwnerChange> = [],
  blocks: ReadonlyArray<WorldBlockRead> = [],
): ReplicatedWorldSnapshot => ({
  _tag: 'ReplicatedWorldSnapshot',
  blocks,
  owners,
  revision: replicatedRevision(revision),
  world: overworld,
})

const replicatedDelta = (
  revision: number,
  changes: ReadonlyArray<ReplicatedOwnerChange> = [],
  blockChanges: ReadonlyArray<ReplicatedBlockChange> = [],
): ReplicatedWorldDeltaMessage => ({
  _tag: 'ReplicatedWorldDelta',
  blockChanges,
  changes,
  revision: replicatedRevision(revision),
  world: overworld,
})

const asciiBytes = (text: string): Uint8Array => Uint8Array.from(text, (character) => character.charCodeAt(0))

const MAXIMUM_FRAME_JSON_DEPTH = 13
const MAXIMUM_FRAME_COLLECTION_ITEMS = 31_149
const MAXIMUM_AOI_PROFILE_OWNER_COUNT = 3
const MAXIMUM_AOI_PROFILE_DELTA_BLOCK_CHANGES = 256
const MAXIMUM_AOI_PROFILE_SNAPSHOT_BLOCK_READS = 15_000
const MAXIMUM_AOI_OWNER_IDS = [
  ownerId('owner:maximum-1'),
  ownerId('owner:maximum-2'),
  ownerId('owner:maximum-3'),
  ownerId('owner:maximum-4'),
]
const MAXIMUM_AOI_OWNER_STATE_SCHEMA = Schema.Struct({ labels: Schema.Array(Schema.String) })
const MAXIMUM_AOI_OWNER_STATE_SAMPLE = { labels: ['x'.repeat(34), 'y'.repeat(34)] }
const MAXIMUM_AOI_OWNER_STATE_BYTES = new TextEncoder().encode(JSON.stringify(MAXIMUM_AOI_OWNER_STATE_SAMPLE)).length
const MAXIMUM_AOI_OWNER_STATE_LIMIT_BYTES = Math.ceil(MAXIMUM_AOI_OWNER_STATE_BYTES * 1.25)
const MAXIMUM_AOI_OWNER_STATE_EMPTY_COLLECTION = { labels: ['', '', ''] }
const MAXIMUM_AOI_OWNER_STATE = {
  labels: [
    'x'.repeat(MAXIMUM_AOI_OWNER_STATE_LIMIT_BYTES - new TextEncoder().encode(JSON.stringify(MAXIMUM_AOI_OWNER_STATE_EMPTY_COLLECTION)).length),
    '',
    '',
  ],
}
const MAXIMUM_AOI_BLOCK_BEFORE = 65_535
const MAXIMUM_AOI_BLOCK_AFTER = 65_534
const MAXIMUM_AOI_BLOCK_READ = 65_535
const MAXIMUM_AOI_BLOCK_AXIS = Number.MIN_SAFE_INTEGER
const maximumAoiBlockPosition = (index: number): BlockPosition => blockPosition(
  MAXIMUM_AOI_BLOCK_AXIS + index,
  MAXIMUM_AOI_BLOCK_AXIS,
  MAXIMUM_AOI_BLOCK_AXIS,
)
const maximumAoiBlockRead = (index: number): WorldBlockRead => blockRead(
  MAXIMUM_AOI_BLOCK_AXIS + index,
  MAXIMUM_AOI_BLOCK_READ,
  MAXIMUM_AOI_BLOCK_AXIS,
  MAXIMUM_AOI_BLOCK_AXIS,
)
const maximumAoiBlockChange = (index: number): ReplicatedBlockChange => ({
  before: Schema.decodeUnknownSync(BlockIdSchema)(MAXIMUM_AOI_BLOCK_BEFORE),
  dimension: 'overworld',
  position: maximumAoiBlockPosition(index),
  after: Schema.decodeUnknownSync(BlockIdSchema)(MAXIMUM_AOI_BLOCK_AFTER),
})
const MAXIMUM_AOI_OWNER_CHANGES = MAXIMUM_AOI_OWNER_IDS.map((owner) => ({ owner, state: MAXIMUM_AOI_OWNER_STATE }))
const MAXIMUM_AOI_OWNER_REGISTRATIONS = MAXIMUM_AOI_OWNER_IDS.map((registeredOwnerId) => ({
  ownerId: registeredOwnerId,
  schema: MAXIMUM_AOI_OWNER_STATE_SCHEMA,
  initialState: MAXIMUM_AOI_OWNER_STATE_SAMPLE,
}))
const MAXIMUM_AOI_OWNER_STATE_BOUNDS: ReplicatedOwnerRegistryLimits['ownerStates'] = MAXIMUM_AOI_OWNER_IDS.map((registeredOwnerId) => ({
  ownerId: registeredOwnerId,
  maxStateBytes: MAXIMUM_AOI_OWNER_STATE_LIMIT_BYTES,
  maxStateDepth: 4,
  maxCollectionItems: 3,
}))

const EMPTY_OWNER_REGISTRY_LIMITS = {
  maxRegisteredOwners: 0,
  maxDeltaBlockChanges: 256,
  maxSnapshotBlockReads: MAXIMUM_FRAME_COLLECTION_ITEMS,
  maxDepth: MAXIMUM_FRAME_JSON_DEPTH,
  maxCollectionItems: MAXIMUM_FRAME_COLLECTION_ITEMS,
  maxDeltaFrameBytes: 1_048_576,
  maxSnapshotFrameBytes: 8_388_608,
  ownerStates: [],
} satisfies ReplicatedOwnerRegistryLimits

const makeEmptyOwnerRegistry = () => {
  const result = createReplicatedOwnerRegistry([], EMPTY_OWNER_REGISTRY_LIMITS)
  if (Result.isFailure(result)) {
    throw result.failure
  }
  return result.success
}

const base64Alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

const encodeBase64 = (bytes: Uint8Array): Base64 => {
  let encoded = ''
  for (let offset = 0; offset < bytes.length; offset += 3) {
    const first = bytes[offset] ?? 0
    const second = bytes[offset + 1]
    const third = bytes[offset + 2]
    const firstIndex = Math.floor(first / 4)
    const secondIndex = (first % 4) * 16 + Math.floor((second ?? 0) / 16)
    encoded += base64Alphabet.charAt(firstIndex)
    encoded += base64Alphabet.charAt(secondIndex)
    if (second === undefined) {
      encoded += '=='
    } else {
      const thirdIndex = (second % 16) * 4 + Math.floor((third ?? 0) / 64)
      encoded += base64Alphabet.charAt(thirdIndex)
      if (third === undefined) {
        encoded += '='
      } else {
        encoded += base64Alphabet.charAt(third % 64)
      }
    }
  }
  return Schema.decodeUnknownSync(Base64Schema)(encoded)
}

const snapshotFrameBytes = (revision: number): Uint8Array => {
  const frame = encodeFrame(replicatedSnapshot(revision), makeEmptyOwnerRegistry())
  if (Result.isFailure(frame)) {
    throw frame.failure
  }
  return asciiBytes(frame.success)
}

const transferStart = (
  bytes: Uint8Array,
  transfer: string,
  revision: number,
  chunkBytes: number,
  digest = sha256Hex(bytes),
): ReplicatedWorldSnapshotStart => ({
  _tag: 'ReplicatedWorldSnapshotStart',
  chunkCount: Math.ceil(bytes.length / chunkBytes),
  revision: replicatedRevision(revision),
  sha256: Schema.decodeUnknownSync(LowercaseHexSha256Schema)(digest),
  totalBytes: bytes.length,
  transferId: Schema.decodeUnknownSync(TransferIdSchema)(transfer),
  world: overworld,
})

const transferChunks = (
  bytes: Uint8Array,
  transfer: string,
  chunkBytes: number,
): Array<ReplicatedWorldSnapshotChunk> => {
  const chunks: Array<ReplicatedWorldSnapshotChunk> = []
  for (let offset = 0; offset < bytes.length; offset += chunkBytes) {
    chunks.push({
      _tag: 'ReplicatedWorldSnapshotChunk',
      data: encodeBase64(bytes.subarray(offset, Math.min(offset + chunkBytes, bytes.length))),
      index: chunks.length,
      transferId: Schema.decodeUnknownSync(TransferIdSchema)(transfer),
    })
  }
  return chunks
}

const transferEnd = (transfer: string): ReplicatedWorldSnapshotEnd => ({
  _tag: 'ReplicatedWorldSnapshotEnd',
  transferId: Schema.decodeUnknownSync(TransferIdSchema)(transfer),
})

const transferLimits = (
  bytes: Uint8Array,
  chunkBytes: number,
  overrides: Partial<SnapshotTransferLimits> = {},
): SnapshotTransferLimits => ({
  maxChunkBytes: chunkBytes,
  maxChunkCount: Math.ceil(bytes.length / chunkBytes),
  maxQueuedDeltaBytes: 1024,
  maxQueuedDeltaCount: 4,
  maxTotalBytes: bytes.length,
  ...overrides,
})

const makeTransferReceiver = (limits: SnapshotTransferLimits): SnapshotTransferReceiver => {
  const result = SnapshotTransferReceiver.make(limits)
  if (Result.isFailure(result)) {
    throw result.failure
  }
  return result.success
}
const measureJsonShape = (root: unknown): Readonly<{ maxDepth: number; maxCollectionItems: number }> => {
  const pending: Array<Readonly<{ depth: number; value: unknown }>> = [{ depth: 1, value: root }]
  let maxDepth = 1
  let maxCollectionItems = 0

  while (pending.length > 0) {
    const current = pending.pop()
    if (current === undefined || typeof current.value !== 'object' || current.value === null) {
      continue
    }
    const entries = Array.isArray(current.value) ? current.value : Object.values(current.value)
    maxCollectionItems = Math.max(maxCollectionItems, entries.length)
    for (const value of entries) {
      const depth = current.depth + 1
      maxDepth = Math.max(maxDepth, depth)
      pending.push({ depth, value })
    }
  }

  return { maxDepth, maxCollectionItems }
}

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

      subject.disconnect(undefined)
      subject.disconnect()
      expect(subject.ingestRevision(nether, 21)).toStrictEqual({
        accepted: false,
        reason: 'snapshot-required',
        receivedRevision: 21,
      })
    }),
  )
})

describe('C4 authoritative client sync', () => {
  it.effect('requests a snapshot before applying a delta without a world baseline', () =>
    Effect.sync(() => {
      const before = new Map()
      const transition = applyReplicatedWorldDelta(before, replicatedDelta(1))

      expect(transition).toMatchObject({
        accepted: false,
        reason: 'snapshot-required',
        request: { world: overworld },
      })
      expect(transition.state).toBe(before)
    }),
  )

  it.effect('rejects duplicate members in snapshots without replacing the current projection', () =>
    Effect.sync(() => {
      const subject = new AuthoritativeClientState()
      subject.applySnapshot(replicatedSnapshot(10, [ownerChange('owner:prior', { value: 'retained' })], [blockRead(0, 1)]))
      const before = subject.snapshot
      const beforeWorld = subject.world(overworld)
      if (beforeWorld === undefined) {
        throw new Error('baseline fixture did not establish a world state')
      }

      expect(subject.applySnapshot(replicatedSnapshot(11, [
        ownerChange('owner:duplicate', { value: 'first' }),
        ownerChange('owner:duplicate', { value: 'second' }),
      ]))).toMatchObject({ accepted: false, reason: 'duplicate-owner' })
      expect(subject.snapshot).toBe(before)
      expect(subject.world(overworld)).toBe(beforeWorld)

      expect(subject.applySnapshot(replicatedSnapshot(11, [], [blockRead(1, 2), blockRead(1, 3)])))
        .toMatchObject({ accepted: false, reason: 'duplicate-block' })
      expect(subject.snapshot).toBe(before)
      expect(subject.world(overworld)).toBe(beforeWorld)
      expect(beforeWorld.revision).toBe(replicatedRevision(10))
      expect(beforeWorld.owners.get(ownerId('owner:prior'))).toStrictEqual({ value: 'retained' })
      expect([...beforeWorld.blocks.values()]).toStrictEqual([blockRead(0, 1)])
    }),
  )

  it.effect('rejects stale snapshots and a duplicate revision at the safe integer ceiling', () =>
    Effect.sync(() => {
      const subject = new AuthoritativeClientState()
      subject.applySnapshot(replicatedSnapshot(10))
      const before = subject.snapshot
      const beforeWorld = subject.world(overworld)

      expect(subject.applySnapshot(replicatedSnapshot(9))).toMatchObject({
        accepted: false,
        reason: 'duplicate-or-stale',
        request: { lastKnownRevision: replicatedRevision(10), world: overworld },
      })
      expect(subject.snapshot).toBe(before)
      expect(subject.world(overworld)).toBe(beforeWorld)

      const maximumRevision = Number.MAX_SAFE_INTEGER
      const maxedState = new AuthoritativeClientState()
      maxedState.applySnapshot(replicatedSnapshot(maximumRevision))
      const maxedBefore = maxedState.snapshot
      expect(maxedState.applyDelta(replicatedDelta(maximumRevision))).toMatchObject({
        accepted: false,
        reason: 'duplicate-or-stale',
        request: { lastKnownRevision: replicatedRevision(maximumRevision), world: overworld },
      })
      expect(maxedState.snapshot).toBe(maxedBefore)
    }),
  )

  it.effect('disconnects one projected world or clears the complete client projection', () =>
    Effect.sync(() => {
      const subject = new AuthoritativeClientState()
      subject.applySnapshot(replicatedSnapshot(10))
      subject.applySnapshot({ ...replicatedSnapshot(20), world: nether })
      const beforeDisconnect = subject.snapshot

      subject.disconnect(nether)
      expect(subject.snapshot).not.toBe(beforeDisconnect)
      expect(subject.world(nether)).toBeUndefined()
      expect(subject.world(overworld)?.revision).toBe(replicatedRevision(10))

      const afterWorldRemoval = subject.snapshot
      subject.disconnect(WorldId.make('end'))
      expect(subject.snapshot).toBe(afterWorldRemoval)

      subject.disconnect()
      expect(subject.snapshot.size).toBe(0)
      expect(subject.world(overworld)).toBeUndefined()
    }),
  )

  it.effect('rejects a duplicate owner member without publishing any part of the group', () =>
    Effect.sync(() => {
      const subject = new AuthoritativeClientState()
      const existingOwner = ownerId('owner:existing')
      expect(subject.applySnapshot(replicatedSnapshot(10, [ownerChange(existingOwner, { value: 'before' })], [blockRead(0, 1)])))
        .toMatchObject({ accepted: true, revision: replicatedRevision(10) })

      const before = subject.snapshot
      const beforeWorld = subject.world(overworld)
      if (beforeWorld === undefined) {
        throw new Error('snapshot fixture did not establish a world state')
      }

      const transition = subject.applyDelta(replicatedDelta(
        11,
        [
          ownerChange('owner:new', { value: 'must-not-appear' }),
          ownerChange(existingOwner, { value: 'first' }),
          ownerChange(existingOwner, { value: 'duplicate' }),
        ],
        [blockChange(1, 2)],
      ))

      expect(transition).toMatchObject({
        accepted: false,
        reason: 'duplicate-owner',
        request: {
          _tag: 'AuthoritativeResyncRequest',
          lastKnownRevision: replicatedRevision(10),
          world: overworld,
        },
      })
      expect(subject.snapshot).toBe(before)
      expect(subject.world(overworld)).toBe(beforeWorld)
      expect(beforeWorld.owners.get(existingOwner)).toStrictEqual({ value: 'before' })
      expect(beforeWorld.owners.has(ownerId('owner:new'))).toBe(false)
      expect([...beforeWorld.blocks.values()]).toStrictEqual([blockRead(0, 1)])
    }),
  )

  it.effect('rejects a duplicate block address atomically with valid owner changes', () =>
    Effect.sync(() => {
      const subject = new AuthoritativeClientState()
      const existingOwner = ownerId('owner:existing')
      subject.applySnapshot(replicatedSnapshot(10, [ownerChange(existingOwner, { value: 'before' })], [blockRead(0, 1)]))
      const before = subject.snapshot
      const beforeWorld = subject.world(overworld)
      if (beforeWorld === undefined) {
        throw new Error('snapshot fixture did not establish a world state')
      }

      const transition = subject.applyDelta(replicatedDelta(
        11,
        [ownerChange(existingOwner, { value: 'must-not-appear' })],
        [blockChange(0, 2), blockChange(0, 3)],
      ))

      expect(transition).toMatchObject({ accepted: false, reason: 'duplicate-block' })
      expect(transition).toMatchObject({
        request: {
          _tag: 'AuthoritativeResyncRequest',
          lastKnownRevision: replicatedRevision(10),
          world: overworld,
        },
      })
      expect(subject.snapshot).toBe(before)
      expect(subject.world(overworld)).toBe(beforeWorld)
      expect(beforeWorld.owners.get(existingOwner)).toStrictEqual({ value: 'before' })
      expect([...beforeWorld.blocks.values()]).toStrictEqual([blockRead(0, 1)])
    }),
  )

  it.effect('rejects a revision gap without advancing or applying group members', () =>
    Effect.sync(() => {
      const subject = new AuthoritativeClientState()
      const existingOwner = ownerId('owner:existing')
      subject.applySnapshot(replicatedSnapshot(10, [ownerChange(existingOwner, { value: 'before' })]))
      const before = subject.snapshot
      const beforeWorld = subject.world(overworld)
      if (beforeWorld === undefined) {
        throw new Error('snapshot fixture did not establish a world state')
      }

      const transition = subject.applyDelta(replicatedDelta(12, [ownerChange(existingOwner, { value: 'gap' })]))

      expect(transition).toMatchObject({
        accepted: false,
        reason: 'revision-gap',
        request: {
          _tag: 'AuthoritativeResyncRequest',
          lastKnownRevision: replicatedRevision(10),
          world: overworld,
        },
      })
      expect(subject.snapshot).toBe(before)
      expect(subject.world(overworld)).toBe(beforeWorld)
      expect(beforeWorld.revision).toBe(replicatedRevision(10))
      expect(beforeWorld.owners.get(existingOwner)).toStrictEqual({ value: 'before' })
    }),
  )

  it.effect('advances exactly one revision for an empty projected group', () =>
    Effect.sync(() => {
      const subject = new AuthoritativeClientState()
      subject.applySnapshot(replicatedSnapshot(10, [ownerChange('owner:existing', { value: 'retained' })], [blockRead(0, 1)]))
      const beforeWorld = subject.world(overworld)
      if (beforeWorld === undefined) {
        throw new Error('snapshot fixture did not establish a world state')
      }

      const transition = subject.applyDelta(replicatedDelta(11))

      expect(transition).toMatchObject({ accepted: true, revision: replicatedRevision(11) })
      const afterWorld = subject.world(overworld)
      expect(afterWorld?.revision).toBe(replicatedRevision(11))
      expect(afterWorld?.owners).toStrictEqual(beforeWorld.owners)
      expect(afterWorld?.blocks).toStrictEqual(beforeWorld.blocks)
    }),
  )

  it.effect('replaces the current projection with a same-revision resync snapshot', () =>
    Effect.sync(() => {
      const subject = new AuthoritativeClientState()
      const priorOwner = ownerId('owner:prior')
      const replacementOwner = ownerId('owner:resynced')
      const baseline = replicatedSnapshot(10, [ownerChange(priorOwner, { value: 'before' })], [blockRead(0, 1)])
      const resyncSnapshot = replicatedSnapshot(
        10,
        [ownerChange(replacementOwner, { value: 'resynced' })],
        [blockRead(1, 2)],
      )

      expect(subject.applySnapshot(baseline)).toMatchObject({ accepted: true, revision: replicatedRevision(10) })
      const before = subject.snapshot
      const beforeWorld = subject.world(overworld)
      if (beforeWorld === undefined) {
        throw new Error('baseline fixture did not establish a world state')
      }

      expect(subject.applySnapshot(resyncSnapshot)).toMatchObject({
        accepted: true,
        revision: replicatedRevision(10),
      })

      const resyncedWorld = subject.world(overworld)
      expect(subject.snapshot).not.toBe(before)
      expect(resyncedWorld).not.toBe(beforeWorld)
      expect(resyncedWorld?.revision).toBe(replicatedRevision(10))
      expect([...resyncedWorld?.owners.entries() ?? []]).toStrictEqual([
        [replacementOwner, { value: 'resynced' }],
      ])
      expect([...resyncedWorld?.blocks.values() ?? []]).toStrictEqual([blockRead(1, 2)])
    }),
  )

  it.effect('keeps every accepted delta sequence at a canonical prefix or returns resync at that prefix', () =>
    Effect.sync(() => {
      const owner = 'owner:prefix'
      const deltas = [1, 2, 3].map((revision) =>
        replicatedDelta(revision, [ownerChange(owner, { revision })]),
      )
      fc.assert(fc.property(
        fc.array(fc.integer({ min: 1, max: 3 }), { minLength: 0, maxLength: 24 }),
        (receivedRevisions) => {
          const subject = new AuthoritativeClientState()
          subject.applySnapshot(replicatedSnapshot(0, [ownerChange(owner, { revision: 0 })]))
          let prefixRevision = 0

          for (const [eventIndex, receivedRevision] of receivedRevisions.entries()) {
            const delta = deltas[receivedRevision - 1]
            if (delta === undefined) {
              throw new Error(`property event ${eventIndex} referred to an absent delta`)
            }
            const before = subject.snapshot
            const transition = subject.applyDelta(delta)
            if (transition.accepted) {
              expect(receivedRevision, `event ${eventIndex}`).toBe(prefixRevision + 1)
              expect(transition.revision, `event ${eventIndex}`).toBe(replicatedRevision(prefixRevision + 1))
              prefixRevision = transition.revision
            } else {
              expect(['duplicate-or-stale', 'revision-gap'], `event ${eventIndex}`).toContain(transition.reason)
              expect(subject.snapshot, `event ${eventIndex}`).toBe(before)
              expect(transition.request, `event ${eventIndex}`).toStrictEqual({
                _tag: 'AuthoritativeResyncRequest',
                lastKnownRevision: replicatedRevision(prefixRevision),
                world: overworld,
              })
            }

            const worldState = subject.world(overworld)
            if (worldState === undefined) {
              throw new Error(`event ${eventIndex} lost its baseline world`)
            }
            expect(worldState.revision, `event ${eventIndex}`).toBe(replicatedRevision(prefixRevision))
            expect(worldState.owners.get(ownerId(owner)), `event ${eventIndex}`).toStrictEqual({
              revision: prefixRevision,
            })
          }
        },
      ), { numRuns: 200, seed: 0xc40a })
    }),
  )
})

describe('C4 snapshot transfer receiver', () => {
  it.effect('rejects invalid limits and frames outside an active transfer', () =>
    Effect.sync(() => {
      const bytes = snapshotFrameBytes(20)
      const limits = transferLimits(bytes, bytes.length)
      const invalidLimits: Array<SnapshotTransferLimits> = [
        { ...limits, maxTotalBytes: 0 },
        { ...limits, maxChunkCount: Number.NaN },
        { ...limits, maxChunkBytes: Number.POSITIVE_INFINITY },
        { ...limits, maxQueuedDeltaCount: -1 },
        { ...limits, maxQueuedDeltaBytes: 0.5 },
      ]
      for (const candidate of invalidLimits) {
        expect(Result.isFailure(SnapshotTransferReceiver.make(candidate))).toBe(true)
      }

      const receiver = makeTransferReceiver(limits)
      expect(receiver.append(transferChunks(bytes, 'idle-append', bytes.length)[0] ?? {
        _tag: 'ReplicatedWorldSnapshotChunk',
        data: encodeBase64(Uint8Array.of(1)),
        index: 0,
        transferId: Schema.decodeUnknownSync(TransferIdSchema)('idle-append'),
      })).toMatchObject({ accepted: false, reason: 'unexpected-transfer-frame' })
      expect(receiver.finish(transferEnd('idle-finish'))).toMatchObject({
        accepted: false,
        reason: 'unexpected-transfer-frame',
      })
      expect(receiver.queueDelta(replicatedDelta(21), 1)).toStrictEqual({ accepted: true, queued: false })

      const invalidDeclaration = { ...transferStart(bytes, 'invalid-declaration', 20, bytes.length), chunkCount: 0 }
      expect(receiver.begin(invalidDeclaration, replicatedRevision(19))).toMatchObject({
        accepted: false,
        reason: 'invalid-declaration',
        request: { lastKnownRevision: replicatedRevision(19), world: overworld },
      })

      const alreadyActive = makeTransferReceiver(limits)
      expect(alreadyActive.begin(transferStart(bytes, 'first-active', 20, bytes.length), replicatedRevision(19)))
        .toStrictEqual({ accepted: true })
      expect(alreadyActive.begin(transferStart(bytes, 'second-active', 21, bytes.length), replicatedRevision(20)))
        .toMatchObject({
          accepted: false,
          reason: 'transfer-already-active',
          request: { lastKnownRevision: replicatedRevision(19), world: overworld },
        })
      expect(alreadyActive.isReceiving).toBe(false)

      const wrongChunkReceiver = makeTransferReceiver(limits)
      expect(wrongChunkReceiver.begin(transferStart(bytes, 'expected-id', 20, bytes.length), replicatedRevision(19)))
        .toStrictEqual({ accepted: true })
      const foreignChunk = transferChunks(bytes, 'foreign-id', bytes.length)[0]
      if (foreignChunk === undefined) {
        throw new Error('foreign transfer fixture was empty')
      }
      expect(wrongChunkReceiver.append(foreignChunk)).toMatchObject({
        accepted: false,
        reason: 'wrong-transfer-id',
        request: { lastKnownRevision: replicatedRevision(19), world: overworld },
      })
      expect(wrongChunkReceiver.isReceiving).toBe(false)

      for (const data of ['', '!!!!'] as const) {
        const malformedReceiver = makeTransferReceiver(limits)
        expect(malformedReceiver.begin(
          transferStart(bytes, `malformed-${data.length}`, 20, bytes.length),
          replicatedRevision(19),
        )).toStrictEqual({ accepted: true })
        const validChunk = transferChunks(bytes, `malformed-${data.length}`, bytes.length)[0]
        if (validChunk === undefined) {
          throw new Error('malformed chunk fixture did not contain its chunk')
        }
        const malformedChunk = { ...validChunk }
        expect(Reflect.set(malformedChunk, 'data', data)).toBe(true)
        expect(malformedReceiver.append(malformedChunk)).toMatchObject({
          accepted: false,
          reason: 'chunk-too-large',
        })
        expect(malformedReceiver.isReceiving).toBe(false)
      }

      const wrongEndReceiver = makeTransferReceiver(limits)
      expect(wrongEndReceiver.begin(transferStart(bytes, 'expected-end', 20, bytes.length), replicatedRevision(19)))
        .toStrictEqual({ accepted: true })
      expect(wrongEndReceiver.finish(transferEnd('foreign-end'))).toMatchObject({
        accepted: false,
        reason: 'wrong-transfer-id',
        request: { lastKnownRevision: replicatedRevision(19), world: overworld },
      })

      const incompleteReceiver = makeTransferReceiver(transferLimits(bytes, Math.floor(bytes.length / 2)))
      expect(incompleteReceiver.begin(
        transferStart(bytes, 'incomplete-end', 20, Math.floor(bytes.length / 2)),
        replicatedRevision(19),
      )).toStrictEqual({ accepted: true })
      expect(incompleteReceiver.finish(transferEnd('incomplete-end'))).toMatchObject({
        accepted: false,
        reason: 'incomplete-transfer',
      })
      incompleteReceiver.discard()
      expect(incompleteReceiver.isReceiving).toBe(false)
    }),
  )

  it.effect('decodes all base64 padding forms and rejects non-canonical unused bits', () =>
    Effect.sync(() => {
      const fragments = [
        { bytes: asciiBytes('A'), transfer: 'one-byte-fragment' },
        { bytes: asciiBytes('AB'), transfer: 'two-byte-fragment' },
        { bytes: asciiBytes('ABC'), transfer: 'three-byte-fragment' },
      ]
      for (const { bytes, transfer } of fragments) {
        const receiver = makeTransferReceiver(transferLimits(bytes, bytes.length))
        expect(receiver.begin(transferStart(bytes, transfer, 20, bytes.length))).toStrictEqual({ accepted: true })
        const chunk = transferChunks(bytes, transfer, bytes.length)[0]
        if (chunk === undefined) {
          throw new Error('base64 fragment fixture was empty')
        }
        expect(receiver.append(chunk)).toStrictEqual({ accepted: true })
        const completion = receiver.finish(transferEnd(transfer))
        if (!completion.accepted) {
          throw new Error('base64 fragment transfer did not complete')
        }
        expect(completion.completion.frameBytes).toStrictEqual(bytes)
      }

      const paddedCases = [
        { data: 'QR==', byteCount: 1, transfer: 'invalid-two-padding-bits' },
        { data: 'AAB=', byteCount: 2, transfer: 'invalid-one-padding-bits' },
      ]
      for (const { data, byteCount, transfer } of paddedCases) {
        const bytes = Uint8Array.from({ length: byteCount }, () => 0)
        const receiver = makeTransferReceiver(transferLimits(bytes, byteCount))
        expect(receiver.begin(transferStart(bytes, transfer, 20, byteCount))).toStrictEqual({ accepted: true })
        expect(receiver.append({
          _tag: 'ReplicatedWorldSnapshotChunk',
          data: Schema.decodeUnknownSync(Base64Schema)(data),
          index: 0,
          transferId: Schema.decodeUnknownSync(TransferIdSchema)(transfer),
        })).toMatchObject({ accepted: false, reason: 'chunk-too-large' })
      }
    }),
  )

  it.effect('decodes valid UTF-8 and rejects truncated, overlong, surrogate, and out-of-range sequences', () =>
    Effect.sync(() => {
      expect(decodeUtf8Frame(Uint8Array.of(0x41, 0xc2, 0xa2, 0xe2, 0x82, 0xac, 0xf0, 0x9f, 0x8c, 0x8d)))
        .toBe('A¢€🌍')

      const malformedSequences = [
        Uint8Array.of(0x80),
        Uint8Array.of(0xc0, 0x80),
        Uint8Array.of(0xc2),
        Uint8Array.of(0xc2, 0x41),
        Uint8Array.of(0xe0, 0x9f, 0xbf),
        Uint8Array.of(0xe2, 0x82),
        Uint8Array.of(0xed, 0xa0, 0x80),
        Uint8Array.of(0xf0, 0x8f, 0xbf, 0xbf),
        Uint8Array.of(0xf0, 0x9f, 0x8c),
        Uint8Array.of(0xf4, 0x90, 0x80, 0x80),
        Uint8Array.of(0xf5, 0x80, 0x80, 0x80),
      ]
      for (const bytes of malformedSequences) {
        expect(decodeUtf8Frame(bytes)).toBeUndefined()
      }
    }),
  )

  it.effect('keeps the client projection when transferred frame bytes or metadata are invalid', () =>
    Effect.sync(() => {
      const validFrameBytes = snapshotFrameBytes(20)
      const malformedCases: Array<Readonly<{ readonly bytes: Uint8Array; readonly maxBytes: number; readonly revision: number }>> = [
        { bytes: validFrameBytes, maxBytes: validFrameBytes.length - 1, revision: 20 },
        { bytes: Uint8Array.of(0xc2), maxBytes: 1, revision: 20 },
        { bytes: asciiBytes('{'), maxBytes: 1, revision: 20 },
        { bytes: validFrameBytes, maxBytes: validFrameBytes.length, revision: 21 },
      ]

      for (const { bytes, maxBytes, revision } of malformedCases) {
        const subject = new AuthoritativeClientState()
        subject.applySnapshot(replicatedSnapshot(19, [ownerChange('owner:retained', { value: true })]))
        const before = subject.snapshot
        const beforeWorld = subject.world(overworld)
        const completion: CompletedSnapshotTransfer = {
          frameBytes: bytes,
          lastKnownRevision: replicatedRevision(19),
          maxTotalBytes: maxBytes,
          queuedDeltas: [],
          revision: replicatedRevision(revision),
          world: overworld,
        }

        expect(subject.applyTransfer(completion, makeEmptyOwnerRegistry())).toMatchObject({
          accepted: false,
          reason: 'invalid-snapshot',
          request: { lastKnownRevision: replicatedRevision(19), world: overworld },
        })
        expect(subject.snapshot).toBe(before)
        expect(subject.world(overworld)).toBe(beforeWorld)
        expect(beforeWorld?.owners.get(ownerId('owner:retained'))).toStrictEqual({ value: true })
      }
    }),
  )

  it.effect('rejects a queued delta from another world without publishing the transferred snapshot', () =>
    Effect.sync(() => {
      const owners = makeEmptyOwnerRegistry()
      const netherSnapshot = { ...replicatedSnapshot(20), world: nether }
      const encodedFrame = encodeTransferredSnapshotFrame(netherSnapshot, owners, 1024)
      if (Result.isFailure(encodedFrame)) {
        throw encodedFrame.failure
      }
      const frameBytes = asciiBytes(encodedFrame.success)
      const completion: CompletedSnapshotTransfer = {
        frameBytes,
        lastKnownRevision: undefined,
        maxTotalBytes: frameBytes.length,
        queuedDeltas: [{ delta: replicatedDelta(21), frameBytes: 1 }],
        revision: replicatedRevision(20),
        world: nether,
      }
      const subject = new AuthoritativeClientState()
      subject.applySnapshot(replicatedSnapshot(10))
      const before = subject.snapshot

      expect(subject.applyTransfer(completion, owners)).toMatchObject({
        accepted: false,
        reason: 'invalid-snapshot',
        request: { _tag: 'AuthoritativeResyncRequest', world: nether },
      })
      expect(subject.snapshot).toBe(before)
      expect(subject.world(overworld)?.revision).toBe(replicatedRevision(10))
      expect(subject.world(nether)).toBeUndefined()
    }),
  )

  it.effect('verifies a complete SHA-256 transfer and rejects a mismatched digest', () =>
    Effect.sync(() => {
      const bytes = snapshotFrameBytes(20)
      const validTransfer = 'snapshot-valid'
      const validChunks = transferChunks(bytes, validTransfer, bytes.length)
      const receiver = makeTransferReceiver(transferLimits(bytes, bytes.length))

      expect(sha256Hex(asciiBytes('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
      expect(receiver.begin(transferStart(bytes, validTransfer, 20, bytes.length), replicatedRevision(19)))
        .toStrictEqual({ accepted: true })
      expect(validChunks).toHaveLength(1)
      const onlyChunk = validChunks[0]
      if (onlyChunk === undefined) {
        throw new Error('single-chunk transfer fixture was empty')
      }
      expect(receiver.append(onlyChunk)).toStrictEqual({ accepted: true })
      const completion = receiver.finish(transferEnd(validTransfer))
      expect(completion).toMatchObject({ accepted: true })
      if (!completion.accepted) {
        throw new Error('valid snapshot transfer did not complete')
      }
      expect(completion.completion.frameBytes).toStrictEqual(bytes)
      expect(completion.completion.revision).toBe(replicatedRevision(20))

      const digest = sha256Hex(bytes)
      const wrongDigest = `${digest.startsWith('0') ? '1' : '0'}${digest.slice(1)}`
      const invalidTransfer = 'snapshot-bad-digest'
      const invalidReceiver = makeTransferReceiver(transferLimits(bytes, bytes.length))
      expect(invalidReceiver.begin(
        transferStart(bytes, invalidTransfer, 20, bytes.length, wrongDigest),
        replicatedRevision(19),
      )).toStrictEqual({ accepted: true })
      const invalidChunk = transferChunks(bytes, invalidTransfer, bytes.length)[0]
      if (invalidChunk === undefined) {
        throw new Error('single-chunk digest fixture was empty')
      }
      expect(invalidReceiver.append(invalidChunk)).toStrictEqual({ accepted: true })
      expect(invalidReceiver.finish(transferEnd(invalidTransfer))).toMatchObject({
        accepted: false,
        reason: 'digest-mismatch',
        request: {
          _tag: 'AuthoritativeResyncRequest',
          lastKnownRevision: replicatedRevision(19),
          world: overworld,
        },
      })
      expect(invalidReceiver.isReceiving).toBe(false)
    }),
  )

  it.effect('rejects chunks that arrive out of order', () =>
    Effect.sync(() => {
      const bytes = snapshotFrameBytes(20)
      const transfer = 'snapshot-order'
      const chunkBytes = Math.floor(bytes.length / 2)
      const chunks = transferChunks(bytes, transfer, chunkBytes)
      const receiver = makeTransferReceiver(transferLimits(bytes, chunkBytes))

      expect(chunks.length).toBeGreaterThan(1)
      expect(receiver.begin(transferStart(bytes, transfer, 20, chunkBytes), replicatedRevision(19)))
        .toStrictEqual({ accepted: true })
      const secondChunk = chunks[1]
      if (secondChunk === undefined) {
        throw new Error('out-of-order fixture did not contain a second chunk')
      }
      expect(receiver.append(secondChunk)).toMatchObject({
        accepted: false,
        reason: 'chunk-out-of-order',
        request: {
          _tag: 'AuthoritativeResyncRequest',
          lastKnownRevision: replicatedRevision(19),
          world: overworld,
        },
      })
      expect(receiver.isReceiving).toBe(false)
    }),
  )

  it.effect('enforces total byte, chunk count, fragment, observed byte, and queued delta bounds', () =>
    Effect.sync(() => {
      const bytes = snapshotFrameBytes(20)
      const limits = transferLimits(bytes, bytes.length)
      const transfer = 'snapshot-bounds'
      const chunkBytes = Math.floor(bytes.length / 2)
      const chunks = transferChunks(bytes, transfer, chunkBytes)

      const totalBound = makeTransferReceiver(transferLimits(bytes, chunkBytes, { maxTotalBytes: bytes.length - 1 }))
      expect(totalBound.begin(transferStart(bytes, transfer, 20, chunkBytes), replicatedRevision(19)))
        .toMatchObject({ accepted: false, reason: 'invalid-declaration' })

      const countBound = makeTransferReceiver(transferLimits(bytes, chunkBytes, {
        maxChunkCount: chunks.length - 1,
      }))
      expect(countBound.begin(transferStart(bytes, transfer, 20, chunkBytes), replicatedRevision(19)))
        .toMatchObject({ accepted: false, reason: 'invalid-declaration' })

      const fragmentTransfer = 'snapshot-fragment-bound'
      const fragmentBound = makeTransferReceiver(transferLimits(bytes, bytes.length, {
        maxChunkBytes: bytes.length - 1,
      }))
      expect(fragmentBound.begin(transferStart(bytes, fragmentTransfer, 20, bytes.length), replicatedRevision(19)))
        .toStrictEqual({ accepted: true })
      const oversizedFragment = transferChunks(bytes, fragmentTransfer, bytes.length)[0]
      if (oversizedFragment === undefined) {
        throw new Error('single-chunk fragment fixture was empty')
      }
      expect(fragmentBound.append(oversizedFragment)).toMatchObject({ accepted: false, reason: 'chunk-too-large' })

      const overflowTransfer = 'snapshot-byte-overflow'
      const overflowLimits: SnapshotTransferLimits = {
        maxChunkBytes: 2,
        maxChunkCount: 1,
        maxQueuedDeltaBytes: 0,
        maxQueuedDeltaCount: 0,
        maxTotalBytes: bytes.length,
      }
      const overflowBound = makeTransferReceiver(overflowLimits)
      const shortDeclaration: ReplicatedWorldSnapshotStart = {
        ...transferStart(bytes, overflowTransfer, 20, bytes.length),
        chunkCount: 1,
        totalBytes: 1,
      }
      expect(overflowBound.begin(shortDeclaration, replicatedRevision(19))).toStrictEqual({ accepted: true })
      expect(overflowBound.append({
        _tag: 'ReplicatedWorldSnapshotChunk',
        data: encodeBase64(Uint8Array.of(1, 2)),
        index: 0,
        transferId: Schema.decodeUnknownSync(TransferIdSchema)(overflowTransfer),
      })).toMatchObject({ accepted: false, reason: 'transfer-byte-overflow' })

      const countQueueTransfer = 'snapshot-queue-count'
      const countQueue = makeTransferReceiver(transferLimits(bytes, bytes.length, {
        maxQueuedDeltaBytes: 8,
        maxQueuedDeltaCount: 1,
      }))
      expect(countQueue.begin(transferStart(bytes, countQueueTransfer, 20, bytes.length))).toStrictEqual({ accepted: true })
      expect(countQueue.queueDelta(replicatedDelta(21), 4)).toStrictEqual({ accepted: true, queued: true })
      expect(countQueue.queueDelta(replicatedDelta(22), 4)).toMatchObject({
        accepted: false,
        reason: 'delta-queue-overflow',
      })

      const bytesQueueTransfer = 'snapshot-queue-bytes'
      const bytesQueue = makeTransferReceiver(transferLimits(bytes, bytes.length, {
        maxQueuedDeltaBytes: 7,
        maxQueuedDeltaCount: 2,
      }))
      expect(bytesQueue.begin(transferStart(bytes, bytesQueueTransfer, 20, bytes.length))).toStrictEqual({ accepted: true })
      expect(bytesQueue.queueDelta(replicatedDelta(21), 4)).toStrictEqual({ accepted: true, queued: true })
      expect(bytesQueue.queueDelta(replicatedDelta(22), 4)).toMatchObject({
        accepted: false,
        reason: 'delta-queue-overflow',
      })

      const worldQueue = makeTransferReceiver(limits)
      expect(worldQueue.begin(transferStart(bytes, 'snapshot-queue-world', 20, bytes.length))).toStrictEqual({ accepted: true })
      expect(worldQueue.queueDelta({ ...replicatedDelta(21), world: nether }, 4)).toMatchObject({
        accepted: false,
        reason: 'world-mismatch',
      })

      const invalidBytesQueue = makeTransferReceiver(limits)
      expect(invalidBytesQueue.begin(transferStart(bytes, 'snapshot-queue-invalid-bytes', 20, bytes.length)))
        .toStrictEqual({ accepted: true })
      expect(invalidBytesQueue.queueDelta(replicatedDelta(21), 0)).toMatchObject({
        accepted: false,
        reason: 'delta-queue-overflow',
      })
    }),
  )

  it.effect('applies queued deltas continuously after replacing state from a transferred snapshot', () =>
    Effect.sync(() => {
      const bytes = snapshotFrameBytes(20)
      const transfer = 'snapshot-with-deltas'
      const chunks = transferChunks(bytes, transfer, bytes.length)
      const receiver = makeTransferReceiver(transferLimits(bytes, bytes.length, {
        maxQueuedDeltaBytes: 20,
        maxQueuedDeltaCount: 2,
      }))

      expect(receiver.begin(transferStart(bytes, transfer, 20, bytes.length), replicatedRevision(19)))
        .toStrictEqual({ accepted: true })
      const onlyChunk = chunks[0]
      if (onlyChunk === undefined) {
        throw new Error('single-chunk continuity fixture was empty')
      }
      expect(receiver.append(onlyChunk)).toStrictEqual({ accepted: true })
      expect(receiver.queueDelta(replicatedDelta(21, [], [blockChange(0, 2)]), 10))
        .toStrictEqual({ accepted: true, queued: true })
      expect(receiver.queueDelta(replicatedDelta(22, [], [blockChange(0, 3)]), 10))
        .toStrictEqual({ accepted: true, queued: true })

      const completion = receiver.finish(transferEnd(transfer))
      if (!completion.accepted) {
        throw new Error('queued snapshot transfer did not complete')
      }
      const subject = new AuthoritativeClientState()
      const transition = subject.applyTransfer(completion.completion, makeEmptyOwnerRegistry())

      expect(transition).toMatchObject({ accepted: true, revision: replicatedRevision(22) })
      expect(subject.world(overworld)?.revision).toBe(replicatedRevision(22))
      expect([...subject.world(overworld)?.blocks.values() ?? []]).toStrictEqual([blockRead(0, 3)])
    }),
  )

  it.effect('keeps the prior projection when a queued delta invalidates a snapshot transfer', () =>
    Effect.sync(() => {
      const bytes = snapshotFrameBytes(20)
      const transfer = 'snapshot-gap-is-atomic'
      const receiver = makeTransferReceiver(transferLimits(bytes, bytes.length))
      const subject = new AuthoritativeClientState()
      subject.applySnapshot(replicatedSnapshot(19, [ownerChange('owner:prior', { value: 'retained' })], [blockRead(0, 1)]))
      const before = subject.snapshot
      const beforeWorld = subject.world(overworld)
      if (beforeWorld === undefined) {
        throw new Error('baseline fixture did not establish a world state')
      }

      expect(receiver.begin(transferStart(bytes, transfer, 20, bytes.length), replicatedRevision(19)))
        .toStrictEqual({ accepted: true })
      const onlyChunk = transferChunks(bytes, transfer, bytes.length)[0]
      if (onlyChunk === undefined) {
        throw new Error('single-chunk transfer fixture was empty')
      }
      expect(receiver.append(onlyChunk)).toStrictEqual({ accepted: true })
      expect(receiver.queueDelta(replicatedDelta(22), 10)).toStrictEqual({ accepted: true, queued: true })

      const completion = receiver.finish(transferEnd(transfer))
      if (!completion.accepted) {
        throw new Error('gap transfer fixture did not complete')
      }
      const transition = subject.applyTransfer(completion.completion, makeEmptyOwnerRegistry())

      expect(transition).toMatchObject({
        accepted: false,
        reason: 'revision-gap',
        request: {
          _tag: 'AuthoritativeResyncRequest',
          lastKnownRevision: replicatedRevision(19),
          world: overworld,
        },
      })
      expect(subject.snapshot).toBe(before)
      expect(subject.world(overworld)).toBe(beforeWorld)
      expect(beforeWorld.revision).toBe(replicatedRevision(19))
      expect(beforeWorld.owners.get(ownerId('owner:prior'))).toStrictEqual({ value: 'retained' })
    }),
  )

  it.effect('accepts fixture-derived maximum AOI snapshot chunks and queued deltas within configured bounds', () =>
    Effect.sync(() => {
      const snapshotBlockLimit = Math.ceil(MAXIMUM_AOI_PROFILE_SNAPSHOT_BLOCK_READS * 1.25)
      const deltaBlockLimit = Math.ceil(MAXIMUM_AOI_PROFILE_DELTA_BLOCK_CHANGES * 1.25)
      const ownerCountLimit = Math.ceil(MAXIMUM_AOI_PROFILE_OWNER_COUNT * 1.25)
      const queuedDeltaCount = 64
      const fixtureChunkBytes = 512 * 1024
      const maxChunkBytes = Math.ceil(fixtureChunkBytes * 1.25)
      const blocks = Array.from({ length: snapshotBlockLimit }, (_, index) => maximumAoiBlockRead(index))
      const maximumSnapshot = replicatedSnapshot(20, MAXIMUM_AOI_OWNER_CHANGES, blocks)
      const queuedDeltas = Array.from({ length: queuedDeltaCount }, (_, deltaIndex) =>
        replicatedDelta(
          21 + deltaIndex,
          MAXIMUM_AOI_OWNER_CHANGES,
          Array.from(
            { length: deltaBlockLimit },
            (_arrayValue, blockIndex) => maximumAoiBlockChange(snapshotBlockLimit + deltaIndex * deltaBlockLimit + blockIndex),
          ),
        ),
      )
      const maximumDelta = queuedDeltas[queuedDeltas.length - 1]
      if (maximumDelta === undefined) {
        throw new Error('maximum delta fixture was empty')
      }
      const snapshotShape = measureJsonShape({ message: maximumSnapshot, protocolVersion: 10 })
      const deltaShape = measureJsonShape({ message: maximumDelta, protocolVersion: 10 })
      const sizingLimits: ReplicatedOwnerRegistryLimits = {
        maxRegisteredOwners: ownerCountLimit,
        maxDeltaBlockChanges: deltaBlockLimit,
        maxSnapshotBlockReads: snapshotBlockLimit,
        maxDepth: 13,
        maxCollectionItems: snapshotBlockLimit,
        maxDeltaFrameBytes: 1_048_576,
        maxSnapshotFrameBytes: 8 * 1024 * 1024,
        ownerStates: MAXIMUM_AOI_OWNER_STATE_BOUNDS,
      }
      const sizingOwners = Result.getOrThrow(createReplicatedOwnerRegistry(MAXIMUM_AOI_OWNER_REGISTRATIONS, sizingLimits))
      const sizedSnapshotFrame = Result.getOrThrow(
        encodeTransferredSnapshotFrame(maximumSnapshot, sizingOwners, sizingLimits.maxSnapshotFrameBytes),
      )
      const sizedSnapshotBytes = new TextEncoder().encode(sizedSnapshotFrame)
      const sizedDeltaByteCounts = queuedDeltas.map((delta) =>
        new TextEncoder().encode(Result.getOrThrow(encodeFrame(delta, sizingOwners))).length,
      )
      const snapshotLimit = Math.ceil(sizedSnapshotBytes.length * 1.25)
      const deltaLimit = Math.ceil(Math.max(...sizedDeltaByteCounts) * 1.25)
      const fixtureShapeDepth = Math.max(snapshotShape.maxDepth, deltaShape.maxDepth)
      const fixtureShapeItems = Math.max(snapshotShape.maxCollectionItems, deltaShape.maxCollectionItems)
      const ownerLimits: ReplicatedOwnerRegistryLimits = {
        ...sizingLimits,
        maxCollectionItems: Math.ceil(fixtureShapeItems * 1.25),
        maxDepth: Math.ceil(fixtureShapeDepth * 1.25),
        maxDeltaFrameBytes: deltaLimit,
        maxSnapshotFrameBytes: snapshotLimit,
      }
      Result.getOrThrow(createReplicatedOwnerRegistry(MAXIMUM_AOI_OWNER_REGISTRATIONS, ownerLimits))
      const snapshotBytes = sizedSnapshotBytes
      const deltaFrameBytes = sizedDeltaByteCounts
      const queueBurstBytes = deltaFrameBytes.reduce((sum, frameBytes) => sum + frameBytes, 0)

      expect(snapshotBytes.length).toBeGreaterThan(1_048_576)
      expect(deltaFrameBytes).toHaveLength(queuedDeltaCount)

      const transfer = 'snapshot-maximum-aoi'
      const chunks = transferChunks(snapshotBytes, transfer, fixtureChunkBytes)
      const maximumTransferLimits: SnapshotTransferLimits = {
        maxTotalBytes: snapshotLimit,
        maxChunkCount: Math.ceil(chunks.length * 1.25),
        maxChunkBytes,
        maxQueuedDeltaCount: Math.ceil(queuedDeltaCount * 1.25),
        maxQueuedDeltaBytes: Math.ceil(queueBurstBytes * 1.25),
      }
      expect({
        blockLimit: snapshotBlockLimit,
        ownerCountLimit: sizingLimits.maxRegisteredOwners,
        maxDeltaBlockChanges: sizingLimits.maxDeltaBlockChanges,
        maxSnapshotBlockReads: sizingLimits.maxSnapshotBlockReads,
        measuredChunkBytes: fixtureChunkBytes,
        chunkBytes: maximumTransferLimits.maxChunkBytes,
        measuredChunkCount: chunks.length,
        chunkCountLimit: maximumTransferLimits.maxChunkCount,
        collectionLimit: ownerLimits.maxCollectionItems,
        measuredCollectionItems: fixtureShapeItems,
        measuredDepth: fixtureShapeDepth,
        depthLimit: ownerLimits.maxDepth,
        deltaByteLimit: ownerLimits.maxDeltaFrameBytes,
        measuredDeltaBytes: Math.max(...deltaFrameBytes),
        maxQueueBytes: maximumTransferLimits.maxQueuedDeltaBytes,
        maxQueueCount: maximumTransferLimits.maxQueuedDeltaCount,
        measuredQueueBurstBytes: queueBurstBytes,
        maxSnapshotBytes: ownerLimits.maxSnapshotFrameBytes,
        measuredSnapshotBytes: snapshotBytes.length,
      }).toMatchInlineSnapshot(`
        {
          "blockLimit": 18750,
          "chunkBytes": 655360,
          "chunkCountLimit": 8,
          "collectionLimit": 23438,
          "deltaByteLimit": 54484,
          "depthLimit": 9,
          "maxDeltaBlockChanges": 320,
          "maxQueueBytes": 3486960,
          "maxQueueCount": 80,
          "maxSnapshotBlockReads": 18750,
          "maxSnapshotBytes": 3422754,
          "measuredChunkBytes": 524288,
          "measuredChunkCount": 6,
          "measuredCollectionItems": 18750,
          "measuredDeltaBytes": 43587,
          "measuredDepth": 7,
          "measuredQueueBurstBytes": 2789568,
          "measuredSnapshotBytes": 2738203,
          "ownerCountLimit": 4,
        }
      `)
      const receiver = makeTransferReceiver(maximumTransferLimits)
      expect(receiver.begin(transferStart(snapshotBytes, transfer, 20, fixtureChunkBytes, '0'.repeat(64)), replicatedRevision(19)))
        .toStrictEqual({ accepted: true })
      const firstChunk = chunks[0]
      if (firstChunk === undefined) {
        throw new Error('maximum snapshot fixture produced no chunks')
      }
      const firstChunkFrame = Result.getOrThrow(encodeFrame(firstChunk))
      expect(new TextEncoder().encode(firstChunkFrame).length).toBeLessThanOrEqual(1_048_576)
      for (const chunk of chunks) {
        expect(receiver.append(chunk)).toStrictEqual({ accepted: true })
      }
      for (let index = 0; index < queuedDeltas.length; index += 1) {
        const delta = queuedDeltas[index]
        const frameBytes = deltaFrameBytes[index]
        if (delta === undefined || frameBytes === undefined) {
          throw new Error('maximum queue burst fixture lost a delta')
        }
        expect(receiver.queueDelta(delta, frameBytes)).toStrictEqual({ accepted: true, queued: true })
      }

      expect(maximumTransferLimits.maxQueuedDeltaCount).toBe(Math.ceil(queuedDeltaCount * 1.25))
      expect(maximumTransferLimits.maxQueuedDeltaBytes).toBe(Math.ceil(queueBurstBytes * 1.25))
      expect(maximumTransferLimits.maxTotalBytes).toBe(Math.ceil(snapshotBytes.length * 1.25))
    }),
  )
})

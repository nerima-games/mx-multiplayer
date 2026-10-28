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
  sha256Hex,
  type SnapshotTransferLimits,
} from '../src/domain/authoritative-sync'
import { createReplicatedOwnerRegistry, encodeFrame } from '../src/domain/codec'
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

const blockPosition = (x: number): BlockPosition => Schema.decodeUnknownSync(BlockPositionSchema)({ x, y: 64, z: 0 })

const blockRead = (x: number, block: number): WorldBlockRead => ({
  dimension: 'overworld',
  position: blockPosition(x),
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

const makeEmptyOwnerRegistry = () => {
  const result = createReplicatedOwnerRegistry([])
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
    encoded += base64Alphabet.charAt(first >> 2)
    encoded += base64Alphabet.charAt(((first & 0x03) << 4) | ((second ?? 0) >> 4))
    encoded += second === undefined
      ? '=='
      : `${base64Alphabet.charAt(((second & 0x0f) << 2) | ((third ?? 0) >> 6))}${third === undefined ? '=' : base64Alphabet.charAt(third & 0x3f)}`
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
})

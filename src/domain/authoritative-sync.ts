import { Result } from 'effect'
import { ProtocolError, SnapshotTransferConfigError } from './errors.js'
import { decodeFrame, type ReplicatedOwnerRegistry } from './codec.js'
import type { WorldId, WorldSnapshot } from './protocol.js'
import type { WorldRevision } from '@nerima-games/mc-kernel'
import type { ReplicatedBlockChange, ReplicatedOwnerChange, WorldBlockRead } from '@nerima-games/mc-sim'
import type {
  AuthoritativeResyncRequest,
  Base64,
  ReplicatedWorldDeltaMessage,
  ReplicatedWorldSnapshotChunk,
  ReplicatedWorldSnapshotEnd,
  ReplicatedWorldSnapshotStart,
  ReplicatedWorldSnapshot,
} from './protocol.js'

/* eslint-disable no-magic-numbers -- These are the SHA-256 constants and bit offsets from FIPS 180-4. */
const SHA256_INITIAL_STATE = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
  0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]
const SHA256_ROUND_CONSTANTS = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]
const SHA256_BLOCK_BYTES = 64
const SHA256_SCHEDULE_WORDS = 64
const SHA256_FINAL_LENGTH_BYTES = 8
const UINT32_MODULUS = 0x1_0000_0000
const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const MAX_UTF8_CODE_POINT = 0x10ffff
/* eslint-enable no-magic-numbers */

const rotateRight = (word: number, count: number): number =>
  ((word >>> count) | (word << (32 - count))) >>> 0

const bufferByte = (bytes: Uint8Array, index: number): number => bytes[index] ?? 0
const arrayWord = (words: ReadonlyArray<number> | Uint32Array, index: number): number => words[index] ?? 0

/** SHA-256 without a platform dependency or a second full-size padded copy. */
export const sha256Hex = (bytes: Uint8Array): string => {
  const state = [...SHA256_INITIAL_STATE]
  const schedule = new Uint32Array(SHA256_SCHEDULE_WORDS)
  const block = new Uint8Array(SHA256_BLOCK_BYTES)
  const paddedLength = Math.ceil((bytes.length + SHA256_FINAL_LENGTH_BYTES + 1) / SHA256_BLOCK_BYTES) * SHA256_BLOCK_BYTES
  const bitLength = bytes.length * 8
  const highLength = Math.floor(bitLength / UINT32_MODULUS)
  const lowLength = bitLength >>> 0

  for (let blockStart = 0; blockStart < paddedLength; blockStart += SHA256_BLOCK_BYTES) {
    block.fill(0)
    const remainingBytes = Math.max(0, Math.min(SHA256_BLOCK_BYTES, bytes.length - blockStart))
    for (let byteIndex = 0; byteIndex < remainingBytes; byteIndex += 1) {
      block[byteIndex] = bufferByte(bytes, blockStart + byteIndex)
    }
    if (blockStart <= bytes.length && bytes.length < blockStart + SHA256_BLOCK_BYTES) {
      block[bytes.length - blockStart] = 0x80
    }
    if (blockStart + SHA256_BLOCK_BYTES === paddedLength) {
      block[SHA256_BLOCK_BYTES - SHA256_FINAL_LENGTH_BYTES] = (highLength >>> 24) & 0xff
      block[SHA256_BLOCK_BYTES - 7] = (highLength >>> 16) & 0xff
      block[SHA256_BLOCK_BYTES - 6] = (highLength >>> 8) & 0xff
      block[SHA256_BLOCK_BYTES - 5] = highLength & 0xff
      block[SHA256_BLOCK_BYTES - 4] = (lowLength >>> 24) & 0xff
      block[SHA256_BLOCK_BYTES - 3] = (lowLength >>> 16) & 0xff
      block[SHA256_BLOCK_BYTES - 2] = (lowLength >>> 8) & 0xff
      block[SHA256_BLOCK_BYTES - 1] = lowLength & 0xff
    }

    for (let wordIndex = 0; wordIndex < 16; wordIndex += 1) {
      const byteOffset = wordIndex * 4
      schedule[wordIndex] = (
        (bufferByte(block, byteOffset) << 24) |
        (bufferByte(block, byteOffset + 1) << 16) |
        (bufferByte(block, byteOffset + 2) << 8) |
        bufferByte(block, byteOffset + 3)
      ) >>> 0
    }
    for (let wordIndex = 16; wordIndex < SHA256_SCHEDULE_WORDS; wordIndex += 1) {
      const previous15 = arrayWord(schedule, wordIndex - 15)
      const previous2 = arrayWord(schedule, wordIndex - 2)
      const smallSigma0 = rotateRight(previous15, 7) ^ rotateRight(previous15, 18) ^ (previous15 >>> 3)
      const smallSigma1 = rotateRight(previous2, 17) ^ rotateRight(previous2, 19) ^ (previous2 >>> 10)
      schedule[wordIndex] = (
        arrayWord(schedule, wordIndex - 16) + smallSigma0 +
        arrayWord(schedule, wordIndex - 7) + smallSigma1
      ) >>> 0
    }

    let stateA = arrayWord(state, 0)
    let stateB = arrayWord(state, 1)
    let stateC = arrayWord(state, 2)
    let stateD = arrayWord(state, 3)
    let stateE = arrayWord(state, 4)
    let stateF = arrayWord(state, 5)
    let stateG = arrayWord(state, 6)
    let stateH = arrayWord(state, 7)

    for (let round = 0; round < SHA256_SCHEDULE_WORDS; round += 1) {
      const sum1 = rotateRight(stateE, 6) ^ rotateRight(stateE, 11) ^ rotateRight(stateE, 25)
      const choose = (stateE & stateF) ^ (~stateE & stateG)
      const constant = SHA256_ROUND_CONSTANTS[round] ?? 0
      const temp1 = (stateH + sum1 + choose + constant + arrayWord(schedule, round)) >>> 0
      const sum0 = rotateRight(stateA, 2) ^ rotateRight(stateA, 13) ^ rotateRight(stateA, 22)
      const majority = (stateA & stateB) ^ (stateA & stateC) ^ (stateB & stateC)
      const temp2 = (sum0 + majority) >>> 0

      stateH = stateG
      stateG = stateF
      stateF = stateE
      stateE = (stateD + temp1) >>> 0
      stateD = stateC
      stateC = stateB
      stateB = stateA
      stateA = (temp1 + temp2) >>> 0
    }

    state[0] = (arrayWord(state, 0) + stateA) >>> 0
    state[1] = (arrayWord(state, 1) + stateB) >>> 0
    state[2] = (arrayWord(state, 2) + stateC) >>> 0
    state[3] = (arrayWord(state, 3) + stateD) >>> 0
    state[4] = (arrayWord(state, 4) + stateE) >>> 0
    state[5] = (arrayWord(state, 5) + stateF) >>> 0
    state[6] = (arrayWord(state, 6) + stateG) >>> 0
    state[7] = (arrayWord(state, 7) + stateH) >>> 0
  }

  return state.map((word) => word.toString(16).padStart(8, '0')).join('')
}

const base64Value = (data: string, index: number): number =>
  BASE64_ALPHABET.indexOf(data.charAt(index))

const decodeBase64Fragment = (data: Base64, maxBytes: number): Uint8Array | undefined => {
  if (data.length === 0 || data.length % 4 !== 0) {
    return undefined
  }
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0
  const decodedLength = (data.length / 4) * 3 - padding
  if (decodedLength <= 0 || decodedLength > maxBytes) {
    return undefined
  }
  const lastQuartet = data.length - 4
  for (let index = 0; index < data.length - padding; index += 1) {
    if (data.charAt(index) === '=') {
      return undefined
    }
  }
  if (padding === 2 && (data.charAt(lastQuartet + 2) !== '=' || data.charAt(lastQuartet + 3) !== '=')) {
    return undefined
  }
  if (padding === 1 && data.charAt(lastQuartet + 3) !== '=') {
    return undefined
  }
  if (padding === 2 && (base64Value(data, lastQuartet + 1) & 0x0f) !== 0) {
    return undefined
  }
  if (padding === 1 && (base64Value(data, lastQuartet + 2) & 0x03) !== 0) {
    return undefined
  }

  const output = new Uint8Array(decodedLength)
  let outputIndex = 0
  for (let offset = 0; offset < data.length; offset += 4) {
    const first = base64Value(data, offset)
    const second = base64Value(data, offset + 1)
    const third = data.charAt(offset + 2) === '=' ? 0 : base64Value(data, offset + 2)
    const fourth = data.charAt(offset + 3) === '=' ? 0 : base64Value(data, offset + 3)
    if (first < 0 || second < 0 || third < 0 || fourth < 0) {
      return undefined
    }
    const packed = (first << 18) | (second << 12) | (third << 6) | fourth
    if (outputIndex < decodedLength) {
      output[outputIndex] = (packed >>> 16) & 0xff
      outputIndex += 1
    }
    if (outputIndex < decodedLength) {
      output[outputIndex] = (packed >>> 8) & 0xff
      outputIndex += 1
    }
    if (outputIndex < decodedLength) {
      output[outputIndex] = packed & 0xff
      outputIndex += 1
    }
  }
  return outputIndex === decodedLength ? output : undefined
}

const isContinuationByte = (value: number): boolean => value >= 0x80 && value <= 0xbf

/** Decode UTF-8 without replacement characters, so malformed bytes cannot become a different JSON frame. */
export const decodeUtf8Frame = (bytes: Uint8Array): string | undefined => {
  const characters: Array<string> = []
  for (let offset = 0; offset < bytes.length;) {
    const first = bufferByte(bytes, offset)
    let codePoint = first
    let width = 1
    if (first >= 0xc2 && first <= 0xdf) {
      const second = bufferByte(bytes, offset + 1)
      if (!isContinuationByte(second)) {
        return undefined
      }
      codePoint = ((first & 0x1f) << 6) | (second & 0x3f)
      width = 2
    } else if (first >= 0xe0 && first <= 0xef) {
      const second = bufferByte(bytes, offset + 1)
      const third = bufferByte(bytes, offset + 2)
      const validSecond = isContinuationByte(second) &&
        (first !== 0xe0 || second >= 0xa0) &&
        (first !== 0xed || second <= 0x9f)
      if (!validSecond || !isContinuationByte(third)) {
        return undefined
      }
      codePoint = ((first & 0x0f) << 12) | ((second & 0x3f) << 6) | (third & 0x3f)
      width = 3
    } else if (first >= 0xf0 && first <= 0xf4) {
      const second = bufferByte(bytes, offset + 1)
      const third = bufferByte(bytes, offset + 2)
      const fourth = bufferByte(bytes, offset + 3)
      const validSecond = isContinuationByte(second) &&
        (first !== 0xf0 || second >= 0x90) &&
        (first !== 0xf4 || second <= 0x8f)
      if (!validSecond || !isContinuationByte(third) || !isContinuationByte(fourth)) {
        return undefined
      }
      codePoint = ((first & 0x07) << 18) | ((second & 0x3f) << 12) | ((third & 0x3f) << 6) | (fourth & 0x3f)
      width = 4
    } else if (first >= 0x80) {
      return undefined
    }
    if (codePoint > MAX_UTF8_CODE_POINT) {
      return undefined
    }
    characters.push(String.fromCodePoint(codePoint))
    offset += width
  }
  return characters.join('')
}

export type SnapshotTransferLimits = Readonly<{
  readonly maxTotalBytes: number
  readonly maxChunkCount: number
  readonly maxChunkBytes: number
  readonly maxQueuedDeltaCount: number
  readonly maxQueuedDeltaBytes: number
}>

export type SnapshotTransferFailureReason =
  | 'transfer-already-active'
  | 'invalid-declaration'
  | 'unexpected-transfer-frame'
  | 'wrong-transfer-id'
  | 'world-mismatch'
  | 'chunk-out-of-order'
  | 'chunk-too-large'
  | 'transfer-byte-overflow'
  | 'delta-queue-overflow'
  | 'incomplete-transfer'
  | 'digest-mismatch'

export type SnapshotTransferFailure = Readonly<{
  readonly accepted: false
  readonly reason: SnapshotTransferFailureReason
  readonly request?: AuthoritativeResyncRequest
}>

export type SnapshotTransferReceipt = Readonly<{ readonly accepted: true }> | SnapshotTransferFailure

export type QueuedReplicatedDelta = Readonly<{
  readonly delta: ReplicatedWorldDeltaMessage
  readonly frameBytes: number
}>

export type CompletedSnapshotTransfer = Readonly<{
  readonly world: WorldId
  readonly revision: WorldRevision
  readonly lastKnownRevision: WorldRevision | undefined
  readonly frameBytes: Uint8Array
  readonly queuedDeltas: ReadonlyArray<QueuedReplicatedDelta>
}>

export type SnapshotTransferCompletion =
  | Readonly<{ readonly accepted: true; readonly completion: CompletedSnapshotTransfer }>
  | SnapshotTransferFailure

type ActiveSnapshotTransfer = {
  readonly start: ReplicatedWorldSnapshotStart
  readonly buffer: Uint8Array
  readonly lastKnownRevision: WorldRevision | undefined
  readonly queuedDeltas: Array<QueuedReplicatedDelta>
  queuedDeltaBytes: number
  receivedBytes: number
  nextIndex: number
}

const isPositiveSafeInteger = (value: number): boolean => Number.isSafeInteger(value) && value > 0
const isNonNegativeSafeInteger = (value: number): boolean => Number.isSafeInteger(value) && value >= 0

const hasValidTransferLimits = (limits: SnapshotTransferLimits): boolean =>
  isPositiveSafeInteger(limits.maxTotalBytes) &&
  isPositiveSafeInteger(limits.maxChunkCount) &&
  isPositiveSafeInteger(limits.maxChunkBytes) &&
  isNonNegativeSafeInteger(limits.maxQueuedDeltaCount) &&
  isNonNegativeSafeInteger(limits.maxQueuedDeltaBytes)

/**
 * Bounded receiver for one logical snapshot frame. Limits are supplied by the
 * host from maximum-valid-snapshot and traffic-burst fixtures.
 */
export class SnapshotTransferReceiver {
  readonly #limits: SnapshotTransferLimits
  #active: ActiveSnapshotTransfer | undefined

  static make(limits: SnapshotTransferLimits): Result.Result<SnapshotTransferReceiver, SnapshotTransferConfigError> {
    if (!hasValidTransferLimits(limits)) {
      return Result.fail(
        new SnapshotTransferConfigError({
          detail: 'transfer byte and chunk limits must be positive safe integers; queue limits must be non-negative safe integers',
        }),
      )
    }
    return Result.succeed(new SnapshotTransferReceiver(limits))
  }

  private constructor(limits: SnapshotTransferLimits) {
    this.#limits = { ...limits }
  }

  get isReceiving(): boolean {
    return this.#active !== undefined
  }

  begin(start: ReplicatedWorldSnapshotStart, lastKnownRevision?: WorldRevision): SnapshotTransferReceipt {
    if (this.#active !== undefined) {
      return this.#rejectActive('transfer-already-active')
    }
    const validDeclaration =
      isPositiveSafeInteger(start.totalBytes) &&
      isPositiveSafeInteger(start.chunkCount) &&
      start.totalBytes <= this.#limits.maxTotalBytes &&
      start.chunkCount <= this.#limits.maxChunkCount &&
      start.chunkCount <= start.totalBytes
    if (!validDeclaration) {
      return this.#reject('invalid-declaration', start.world, lastKnownRevision)
    }

    this.#active = {
      buffer: new Uint8Array(start.totalBytes),
      lastKnownRevision,
      nextIndex: 0,
      queuedDeltaBytes: 0,
      queuedDeltas: [],
      receivedBytes: 0,
      start,
    }
    return { accepted: true }
  }

  append(chunk: ReplicatedWorldSnapshotChunk): SnapshotTransferReceipt {
    const active = this.#active
    if (active === undefined) {
      return this.#reject('unexpected-transfer-frame')
    }
    if (chunk.transferId !== active.start.transferId) {
      return this.#rejectActive('wrong-transfer-id')
    }
    if (chunk.index !== active.nextIndex || active.nextIndex >= active.start.chunkCount) {
      return this.#rejectActive('chunk-out-of-order')
    }

    const fragment = decodeBase64Fragment(chunk.data, this.#limits.maxChunkBytes)
    if (fragment === undefined) {
      return this.#rejectActive('chunk-too-large')
    }
    if (fragment.length > active.start.totalBytes - active.receivedBytes) {
      return this.#rejectActive('transfer-byte-overflow')
    }

    active.buffer.set(fragment, active.receivedBytes)
    active.receivedBytes += fragment.length
    active.nextIndex += 1
    return { accepted: true }
  }

  queueDelta(delta: ReplicatedWorldDeltaMessage, frameBytes: number): SnapshotTransferReceipt & Readonly<{ queued?: boolean }> {
    const active = this.#active
    if (active === undefined) {
      return { accepted: true, queued: false }
    }
    if (delta.world !== active.start.world) {
      return this.#rejectActive('world-mismatch')
    }
    if (!isPositiveSafeInteger(frameBytes)) {
      return this.#rejectActive('delta-queue-overflow')
    }
    if (
      active.queuedDeltas.length >= this.#limits.maxQueuedDeltaCount ||
      frameBytes > this.#limits.maxQueuedDeltaBytes - active.queuedDeltaBytes
    ) {
      return this.#rejectActive('delta-queue-overflow')
    }

    active.queuedDeltas.push({ delta, frameBytes })
    active.queuedDeltaBytes += frameBytes
    return { accepted: true, queued: true }
  }

  finish(end: ReplicatedWorldSnapshotEnd): SnapshotTransferCompletion {
    const active = this.#active
    if (active === undefined) {
      return this.#reject('unexpected-transfer-frame')
    }
    if (end.transferId !== active.start.transferId) {
      return this.#rejectActive('wrong-transfer-id')
    }
    if (
      active.nextIndex !== active.start.chunkCount ||
      active.receivedBytes !== active.start.totalBytes
    ) {
      return this.#rejectActive('incomplete-transfer')
    }
    if (sha256Hex(active.buffer) !== active.start.sha256) {
      return this.#rejectActive('digest-mismatch')
    }

    this.#active = undefined
    return {
      accepted: true,
      completion: {
        frameBytes: active.buffer,
        lastKnownRevision: active.lastKnownRevision,
        queuedDeltas: [...active.queuedDeltas],
        revision: active.start.revision,
        world: active.start.world,
      },
    }
  }

  discard(): void {
    this.#active = undefined
  }

  #reject(
    reason: SnapshotTransferFailureReason,
    world?: WorldId,
    lastKnownRevision?: WorldRevision,
  ): SnapshotTransferFailure {
    if (world === undefined) {
      return { accepted: false, reason }
    }
    return {
      accepted: false,
      reason,
      request: makeResyncRequest(world, lastKnownRevision),
    }
  }

  #rejectActive(reason: SnapshotTransferFailureReason): SnapshotTransferFailure {
    const active = this.#active
    this.#active = undefined
    return active === undefined
      ? this.#reject(reason)
      : this.#reject(reason, active.start.world, active.lastKnownRevision)
  }
}

export type RevisionAdmission =
  | { readonly accepted: true; readonly revision: number }
  | {
      readonly accepted: false
      readonly reason: 'snapshot-required' | 'duplicate-or-stale' | 'revision-gap'
      readonly expectedRevision?: number
      readonly receivedRevision: number
    }

/**
 * Guards application of authoritative world updates without owning game state.
 *
 * A reconnect clears the baseline, so incremental updates cannot be applied
 * until a complete snapshot establishes which revision the client has.
 */
export class AuthoritativeRevisionTracker {
  readonly #revisions = new Map<WorldId, number>()

  ingestSnapshot(snapshot: WorldSnapshot): RevisionAdmission {
    const current = this.#revisions.get(snapshot.world)
    if (current !== undefined) {
      if (snapshot.revision <= current) {
        return {
          accepted: false,
          reason: 'duplicate-or-stale',
          receivedRevision: snapshot.revision,
        }
      }
    }

    this.#revisions.set(snapshot.world, snapshot.revision)
    return { accepted: true, revision: snapshot.revision }
  }

  // eslint-disable-next-line max-statements -- Each admission branch preserves a distinct recovery reason.
  ingestRevision(world: WorldId, revision: number): RevisionAdmission {
    const current = this.#revisions.get(world)
    if (current === undefined) {
      return {
        accepted: false,
        reason: 'snapshot-required',
        receivedRevision: revision,
      }
    }

    if (revision <= current) {
      return { accepted: false, reason: 'duplicate-or-stale', receivedRevision: revision }
    }

    const nextRevisionOffset = 1
    const expectedRevision = current + nextRevisionOffset
    if (revision !== expectedRevision) {
      return {
        accepted: false,
        expectedRevision,
        reason: 'revision-gap',
        receivedRevision: revision,
      }
    }

    this.#revisions.set(world, revision)
    return { accepted: true, revision }
  }

  revision(world: WorldId): number | undefined {
    return this.#revisions.get(world)
  }

  /** Remove one world baseline, or every baseline after transport loss. */
  disconnect(world?: WorldId): void {
    const noArguments = 0
    if (arguments.length === noArguments) {
      this.#revisions.clear()
    } else {
      if (world !== undefined) {
        this.#revisions.delete(world)
      }
    }
  }
}

export type AuthoritativeWorldState = Readonly<{
  readonly world: WorldId
  readonly revision: WorldRevision
  readonly owners: ReadonlyMap<ReplicatedOwnerChange['owner'], ReplicatedOwnerChange['state']>
  readonly blocks: ReadonlyMap<string, WorldBlockRead>
}>

export type AuthoritativeClientSnapshot = ReadonlyMap<WorldId, AuthoritativeWorldState>

export type ClientSyncRejectionReason =
  | 'snapshot-required'
  | 'duplicate-or-stale'
  | 'revision-gap'
  | 'duplicate-owner'
  | 'duplicate-block'
  | 'invalid-snapshot'

export type ClientSyncTransition =
  | {
      readonly accepted: true
      readonly appliedMessages: ReadonlyArray<ReplicatedWorldSnapshot | ReplicatedWorldDeltaMessage>
      readonly state: AuthoritativeClientSnapshot
      readonly revision: WorldRevision
    }
  | {
      readonly accepted: false
      readonly state: AuthoritativeClientSnapshot
      readonly reason: ClientSyncRejectionReason
      readonly request: AuthoritativeResyncRequest
    }

const blockAddress = (block: Pick<WorldBlockRead, 'dimension' | 'position'>): string =>
  JSON.stringify([block.dimension, block.position.x, block.position.y, block.position.z])

const makeResyncRequest = (
  world: WorldId,
  lastKnownRevision: WorldRevision | undefined,
): AuthoritativeResyncRequest =>
  lastKnownRevision === undefined
    ? { _tag: 'AuthoritativeResyncRequest', world }
    : { _tag: 'AuthoritativeResyncRequest', lastKnownRevision, world }

const reject = (
  state: AuthoritativeClientSnapshot,
  world: WorldId,
  lastKnownRevision: WorldRevision | undefined,
  reason: ClientSyncRejectionReason,
): ClientSyncTransition => ({
  accepted: false,
  reason,
  request: makeResyncRequest(world, lastKnownRevision),
  state,
})

const addOwnerChanges = (
  target: Map<ReplicatedOwnerChange['owner'], ReplicatedOwnerChange['state']>,
  changes: ReadonlyArray<ReplicatedOwnerChange>,
): boolean => {
  const seen = new Set<ReplicatedOwnerChange['owner']>()
  for (const change of changes) {
    if (seen.has(change.owner)) {
      return false
    }
    seen.add(change.owner)
    target.set(change.owner, change.state)
  }
  return true
}

const addBlockReads = (
  target: Map<string, WorldBlockRead>,
  blocks: ReadonlyArray<WorldBlockRead>,
): boolean => {
  const seen = new Set<string>()
  for (const block of blocks) {
    const address = blockAddress(block)
    if (seen.has(address)) {
      return false
    }
    seen.add(address)
    target.set(address, block)
  }
  return true
}

const addBlockChanges = (
  target: Map<string, WorldBlockRead>,
  changes: ReadonlyArray<ReplicatedBlockChange>,
): boolean => {
  const seen = new Set<string>()
  for (const change of changes) {
    const address = blockAddress(change)
    if (seen.has(address)) {
      return false
    }
    seen.add(address)
    target.set(address, {
      dimension: change.dimension,
      position: change.position,
      reading: { _tag: 'Block', block: change.after },
    })
  }
  return true
}

const commitWorld = (
  state: AuthoritativeClientSnapshot,
  worldState: AuthoritativeWorldState,
): AuthoritativeClientSnapshot => {
  const next = new Map(state)
  next.set(worldState.world, worldState)
  return next
}

/** Build a complete replacement before exposing it to the caller. */
export const applyReplicatedWorldSnapshot = (
  state: AuthoritativeClientSnapshot,
  snapshot: ReplicatedWorldSnapshot,
): ClientSyncTransition => {
  const current = state.get(snapshot.world)
  if (current !== undefined && snapshot.revision < current.revision) {
    return reject(state, snapshot.world, current.revision, 'duplicate-or-stale')
  }

  const owners = new Map<ReplicatedOwnerChange['owner'], ReplicatedOwnerChange['state']>()
  if (!addOwnerChanges(owners, snapshot.owners)) {
    return reject(state, snapshot.world, current?.revision, 'duplicate-owner')
  }
  const blocks = new Map<string, WorldBlockRead>()
  if (!addBlockReads(blocks, snapshot.blocks)) {
    return reject(state, snapshot.world, current?.revision, 'duplicate-block')
  }

  const nextWorld: AuthoritativeWorldState = {
    blocks,
    owners,
    revision: snapshot.revision,
    world: snapshot.world,
  }
  return {
    accepted: true,
    appliedMessages: [snapshot],
    revision: snapshot.revision,
    state: commitWorld(state, nextWorld),
  }
}

/** Validate both arrays and the revision before publishing one replacement state. */
export const applyReplicatedWorldDelta = (
  state: AuthoritativeClientSnapshot,
  delta: ReplicatedWorldDeltaMessage,
): ClientSyncTransition => {
  const current = state.get(delta.world)
  if (current === undefined) {
    return reject(state, delta.world, undefined, 'snapshot-required')
  }
  if (delta.revision <= current.revision) {
    return reject(state, delta.world, current.revision, 'duplicate-or-stale')
  }

  const nextRevision = current.revision + 1
  if (!Number.isSafeInteger(nextRevision) || delta.revision !== nextRevision) {
    return reject(state, delta.world, current.revision, 'revision-gap')
  }

  const owners = new Map(current.owners)
  if (!addOwnerChanges(owners, delta.changes)) {
    return reject(state, delta.world, current.revision, 'duplicate-owner')
  }
  const blocks = new Map(current.blocks)
  if (!addBlockChanges(blocks, delta.blockChanges)) {
    return reject(state, delta.world, current.revision, 'duplicate-block')
  }

  const nextWorld: AuthoritativeWorldState = {
    blocks,
    owners,
    revision: delta.revision,
    world: delta.world,
  }
  return {
    accepted: true,
    appliedMessages: [delta],
    revision: delta.revision,
    state: commitWorld(state, nextWorld),
  }
}

/** A synchronous client cache swaps one immutable world projection per accepted group. */
export class AuthoritativeClientState {
  #state: AuthoritativeClientSnapshot = new Map()

  get snapshot(): AuthoritativeClientSnapshot {
    return this.#state
  }

  world(world: WorldId): AuthoritativeWorldState | undefined {
    return this.#state.get(world)
  }

  applySnapshot(snapshot: ReplicatedWorldSnapshot): ClientSyncTransition {
    const result = applyReplicatedWorldSnapshot(this.#state, snapshot)
    if (result.accepted) {
      this.#state = result.state
    }
    return result
  }

  applyDelta(delta: ReplicatedWorldDeltaMessage): ClientSyncTransition {
    const result = applyReplicatedWorldDelta(this.#state, delta)
    if (result.accepted) {
      this.#state = result.state
    }
    return result
  }

  applyTransfer(completion: CompletedSnapshotTransfer, owners: ReplicatedOwnerRegistry): ClientSyncTransition {
    const previousState = this.#state
    const decoded = decodeTransferredSnapshot(completion, owners)
    return Result.match(decoded, {
      onFailure: () => {
        const currentRevision = previousState.get(completion.world)?.revision ?? completion.lastKnownRevision
        return reject(previousState, completion.world, currentRevision, 'invalid-snapshot')
      },
      onSuccess: (snapshot) => {
        const snapshotResult = applyReplicatedWorldSnapshot(previousState, snapshot)
        if (!snapshotResult.accepted) {
          return snapshotResult
        }

        let candidateState = snapshotResult.state
        let latestRevision = snapshotResult.revision
        const appliedMessages: Array<ReplicatedWorldSnapshot | ReplicatedWorldDeltaMessage> = [snapshot]
        for (const queued of completion.queuedDeltas) {
          if (queued.delta.world !== completion.world) {
            const currentRevision = previousState.get(completion.world)?.revision ?? completion.lastKnownRevision
            return reject(previousState, completion.world, currentRevision, 'invalid-snapshot')
          }
          const applied = applyReplicatedWorldDelta(candidateState, queued.delta)
          if (!applied.accepted) {
            const currentRevision = previousState.get(completion.world)?.revision ?? completion.lastKnownRevision
            return reject(previousState, completion.world, currentRevision, applied.reason)
          }
          candidateState = applied.state
          appliedMessages.push(queued.delta)
          latestRevision = applied.revision
        }
        this.#state = candidateState
        return { accepted: true, appliedMessages, revision: latestRevision, state: candidateState }
      }
    })
  }

  disconnect(world?: WorldId): void {
    if (world === undefined) {
      this.#state = new Map()
      return
    }
    if (this.#state.has(world)) {
      const next = new Map(this.#state)
      next.delete(world)
      this.#state = next
    }
  }
}

export const decodeTransferredSnapshot = (
  completion: CompletedSnapshotTransfer,
  owners: ReplicatedOwnerRegistry,
): Result.Result<ReplicatedWorldSnapshot, ProtocolError> => {
  const frameText = decodeUtf8Frame(completion.frameBytes)
  if (frameText === undefined) {
    return Result.fail(
      new ProtocolError({ detail: 'snapshot transfer contains invalid UTF-8', reason: 'malformed-frame' }),
    )
  }
  return Result.flatMap(decodeFrame(frameText, owners), (message) => {
    if (
      message._tag !== 'ReplicatedWorldSnapshot' ||
      message.world !== completion.world ||
      message.revision !== completion.revision
    ) {
      return Result.fail(
        new ProtocolError({ detail: 'snapshot transfer metadata does not match its frame', reason: 'malformed-frame' }),
      )
    }
    return Result.succeed(message)
  })
}

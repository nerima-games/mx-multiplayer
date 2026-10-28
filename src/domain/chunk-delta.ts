import {
  type AreaOfInterest,
  type ChunkInterestKey,
  areaOfInterestExpanded,
  areaOfInterestIncludesChunkKey,
  areaOfInterestIncludesOwner,
  chunkInterestKeyForBlockChange,
  isAreaOfInterest,
} from './area-of-interest.js'
import {
  AuthoritativeResyncRequest,
  type ReplicatedWorldDeltaMessage as ReplicatedWorldDelta,
  ReplicatedWorldDeltaMessage,
  Revision,
} from './protocol.js'
import { Data, Result, Schema } from 'effect'
import {
  type NonNegativeSafeInteger,
  type ReplicatedOwnerRegistry,
  type WireText,
  encodeFrame,
  wireFrameByteLength,
} from './codec.js'
import { PlayerId, type PlayerId as PlayerIdType } from './protocol/identifiers.js'
import type { ReplicatedBlockChange } from '@nerima-games/mc-sim'

export const MAX_C4_DELTA_FRAME_BYTES = 54_489

export type DeltaProjectionRecipient = Readonly<{
  id: PlayerIdType
  interest: AreaOfInterest
  previousInterest?: AreaOfInterest
  lastKnownRevision?: Revision
}>

export type DeltaProjectionOutcome =
  | Readonly<{
      _tag: 'ProjectedDelta'
      recipientId: PlayerIdType
      message: ReplicatedWorldDelta
      frame: WireText
      frameBytes: NonNegativeSafeInteger
    }>
  | Readonly<{
      _tag: 'ResyncRequired'
      recipientId: PlayerIdType
      reason: 'interest-expanded' | 'delta-frame-too-large'
      request: typeof AuthoritativeResyncRequest.Type
    }>

export type DeltaProjectionErrorReason = 'invalid-delta' | 'invalid-recipient' | 'frame-encoding-failed'

const DeltaProjectionError_base: ReturnType<typeof Data.TaggedError<'DeltaProjectionError'>> =
  Data.TaggedError('DeltaProjectionError')

export class DeltaProjectionError extends DeltaProjectionError_base<{
  readonly reason: DeltaProjectionErrorReason
  readonly detail: string
}> {}

type ValidRecipient = Readonly<{
  id: PlayerIdType
  interest: AreaOfInterest
  previousInterest: AreaOfInterest | undefined
  lastKnownRevision: Revision | undefined
}>

type RecipientFields = Readonly<{
  id: unknown
  interest: unknown
  lastKnownRevision: unknown
  previousInterest: unknown
}>

type ProjectionContext = Readonly<{
  blockGroups: ReadonlyMap<ChunkInterestKey, ReadonlyArray<ReplicatedBlockChange>>
  delta: ReplicatedWorldDelta
  owners: ReplicatedOwnerRegistry
  recipient: ValidRecipient
}>

type EncodedProjectionContext = Readonly<{
  delta: ReplicatedWorldDelta
  owners: ReplicatedOwnerRegistry
  projected: ReplicatedWorldDelta
  recipient: ValidRecipient
}>

type BatchProjectionContext = Readonly<{
  blockGroups: ReadonlyMap<ChunkInterestKey, ReadonlyArray<ReplicatedBlockChange>>
  delta: ReplicatedWorldDelta
  owners: ReplicatedOwnerRegistry
  recipients: ReadonlyArray<ValidRecipient>
}>

type RecipientAccumulator = {
  recipients: Array<ValidRecipient>
  seenIds: Set<PlayerIdType>
}

const strictParseOptions = { onExcessProperty: 'error' as const }
const ZERO = 0
const ONE = 1

const invalidRecipient = (detail: string): Result.Result<never, DeltaProjectionError> =>
  Result.fail(new DeltaProjectionError({ detail, reason: 'invalid-recipient' }))

const invalidDelta = (detail: string): Result.Result<never, DeltaProjectionError> =>
  Result.fail(new DeltaProjectionError({ detail, reason: 'invalid-delta' }))

const validateRecipientKeys = (input: object): Result.Result<void, DeltaProjectionError> => {
  const allowedFields = ['id', 'interest', 'previousInterest', 'lastKnownRevision']
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== 'string' || !allowedFields.includes(key)) {
      return invalidRecipient('recipient contains an unknown field')
    }
  }
  return Result.succeed(undefined)
}

const readRecipientField = (input: object, field: string): Result.Result<unknown, DeltaProjectionError> => {
  const descriptor = Object.getOwnPropertyDescriptor(input, field)
  if (descriptor === undefined) {
    return Result.succeed(undefined)
  }
  if (!('value' in descriptor)) {
    return invalidRecipient(`recipient field ${field} must be a data property`)
  }
  return Result.succeed(descriptor.value)
}

const readRecipientFields = (input: object): Result.Result<RecipientFields, DeltaProjectionError> => {
  const id = readRecipientField(input, 'id')
  const interest = readRecipientField(input, 'interest')
  const previousInterest = readRecipientField(input, 'previousInterest')
  const lastKnownRevision = readRecipientField(input, 'lastKnownRevision')
  if (Result.isFailure(id) || Result.isFailure(interest) || Result.isFailure(previousInterest) || Result.isFailure(lastKnownRevision)) {
    return invalidRecipient('recipient fields could not be read')
  }
  return Result.succeed({
    id: id.success,
    interest: interest.success,
    lastKnownRevision: lastKnownRevision.success,
    previousInterest: previousInterest.success,
  })
}

const decodeLastKnownRevision = (
  input: unknown,
): Result.Result<Revision | undefined, DeltaProjectionError> => {
  if (input === undefined) {
    return Result.succeed(undefined)
  }
  const revision = Schema.decodeUnknownResult(Revision, strictParseOptions)(input)
  if (Result.isFailure(revision)) {
    return invalidRecipient('last known revision is invalid')
  }
  return Result.succeed(revision.success)
}

const decodeRecipientFields = (fields: RecipientFields): Result.Result<ValidRecipient, DeltaProjectionError> => {
  const { id, interest, lastKnownRevision, previousInterest } = fields
  const decodedId = Schema.decodeUnknownResult(PlayerId, strictParseOptions)(id)
  if (Result.isFailure(decodedId) || !isAreaOfInterest(interest)) {
    return invalidRecipient('recipient id and interest are required')
  }
  if (previousInterest !== undefined && !isAreaOfInterest(previousInterest)) {
    return invalidRecipient('previous interest is invalid')
  }
  const revision = decodeLastKnownRevision(lastKnownRevision)
  if (Result.isFailure(revision)) {
    return Result.fail(revision.failure)
  }
  return Result.succeed({
    id: decodedId.success,
    interest,
    lastKnownRevision: revision.success,
    previousInterest,
  })
}

const readRecipient = (input: unknown): Result.Result<ValidRecipient, DeltaProjectionError> => {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return invalidRecipient('recipient must be an object')
  }
  const keys = validateRecipientKeys(input)
  if (Result.isFailure(keys)) {
    return Result.fail(keys.failure)
  }
  const fields = readRecipientFields(input)
  if (Result.isFailure(fields)) {
    return Result.fail(fields.failure)
  }
  return decodeRecipientFields(fields.success)
}

const appendRecipient = (
  input: unknown,
  accumulator: RecipientAccumulator,
): Result.Result<void, DeltaProjectionError> => {
  const recipient = readRecipient(input)
  if (Result.isFailure(recipient)) {
    return Result.fail(recipient.failure)
  }
  if (accumulator.seenIds.has(recipient.success.id)) {
    return invalidRecipient('recipient ids must be unique')
  }
  accumulator.seenIds.add(recipient.success.id)
  accumulator.recipients.push(recipient.success)
  return Result.succeed(undefined)
}

const appendRecipientAtIndex = (
  input: ReadonlyArray<unknown>,
  index: number,
  accumulator: RecipientAccumulator,
): Result.Result<void, DeltaProjectionError> => {
  const descriptor = Object.getOwnPropertyDescriptor(input, String(index))
  if (descriptor === undefined || !('value' in descriptor)) {
    return invalidRecipient(`recipient at index ${index} is missing or accessor-backed`)
  }
  return appendRecipient(descriptor.value, accumulator)
}

const decodeRecipients = (input: unknown): Result.Result<ReadonlyArray<ValidRecipient>, DeltaProjectionError> => {
  if (!Array.isArray(input)) {
    return invalidRecipient('recipients must be an array')
  }
  const accumulator: RecipientAccumulator = { recipients: [], seenIds: new Set<PlayerIdType>() }
  for (let index = ZERO; index < input.length; index += ONE) {
    const appended = appendRecipientAtIndex(input, index, accumulator)
    if (Result.isFailure(appended)) {
      return Result.fail(appended.failure)
    }
  }
  return Result.succeed(accumulator.recipients)
}

const resyncRequest = (
  world: ReplicatedWorldDelta['world'],
  lastKnownRevision: Revision | undefined,
): typeof AuthoritativeResyncRequest.Type => {
  if (lastKnownRevision === undefined) {
    return Schema.decodeUnknownSync(AuthoritativeResyncRequest, strictParseOptions)({
      _tag: 'AuthoritativeResyncRequest',
      world,
    })
  }
  return Schema.decodeUnknownSync(AuthoritativeResyncRequest, strictParseOptions)({
    _tag: 'AuthoritativeResyncRequest',
    lastKnownRevision,
    world,
  })
}

const makeResyncOutcome = (
  recipient: ValidRecipient,
  delta: ReplicatedWorldDelta,
  reason: 'interest-expanded' | 'delta-frame-too-large',
): DeltaProjectionOutcome => ({
  _tag: 'ResyncRequired',
  reason,
  recipientId: recipient.id,
  request: resyncRequest(delta.world, recipient.lastKnownRevision),
})

const visibleBlockChanges = (
  delta: ReplicatedWorldDelta,
  interest: AreaOfInterest,
  blockGroups: ReadonlyMap<ChunkInterestKey, ReadonlyArray<ReplicatedBlockChange>>,
): ReadonlyArray<ReplicatedBlockChange> => {
  const visibleChanges = new Set<ReplicatedBlockChange>()
  for (const [key, group] of blockGroups) {
    if (areaOfInterestIncludesChunkKey(interest, key)) {
      for (const change of group) {
        visibleChanges.add(change)
      }
    }
  }
  return delta.blockChanges.filter((change) => visibleChanges.has(change))
}

const projectedDelta = (
  delta: ReplicatedWorldDelta,
  recipient: ValidRecipient,
  blockGroups: ReadonlyMap<ChunkInterestKey, ReadonlyArray<ReplicatedBlockChange>>,
): ReplicatedWorldDelta => ({
  _tag: 'ReplicatedWorldDelta',
  blockChanges: visibleBlockChanges(delta, recipient.interest, blockGroups),
  changes: delta.changes.filter((change) => areaOfInterestIncludesOwner(recipient.interest, change.owner)),
  revision: delta.revision,
  world: delta.world,
})

const encodeProjection = (
  context: EncodedProjectionContext,
): Result.Result<DeltaProjectionOutcome, DeltaProjectionError> => {
  const { delta, recipient, projected, owners } = context
  const frame = encodeFrame(projected, owners)
  if (Result.isFailure(frame)) {
    if (frame.failure.reason === 'frame-too-large') {
      return Result.succeed(makeResyncOutcome(recipient, delta, 'delta-frame-too-large'))
    }
    return Result.fail(new DeltaProjectionError({
      detail: frame.failure.message,
      reason: 'frame-encoding-failed',
    }))
  }
  const frameBytes = wireFrameByteLength(frame.success)
  if (frameBytes > MAX_C4_DELTA_FRAME_BYTES) {
    return Result.succeed(makeResyncOutcome(recipient, delta, 'delta-frame-too-large'))
  }
  return Result.succeed({
    _tag: 'ProjectedDelta',
    frame: frame.success,
    frameBytes,
    message: projected,
    recipientId: recipient.id,
  })
}

const projectForRecipient = (
  context: ProjectionContext,
): Result.Result<DeltaProjectionOutcome, DeltaProjectionError> => {
  const { delta, recipient, blockGroups, owners } = context
  if (areaOfInterestExpanded(recipient.previousInterest, recipient.interest)) {
    return Result.succeed(makeResyncOutcome(recipient, delta, 'interest-expanded'))
  }
  return encodeProjection({
    delta,
    owners,
    projected: projectedDelta(delta, recipient, blockGroups),
    recipient,
  })
}

const groupBlockChanges = (
  changes: ReadonlyArray<ReplicatedBlockChange>,
): ReadonlyMap<ChunkInterestKey, ReadonlyArray<ReplicatedBlockChange>> => {
  const groupedChanges = new Map<ChunkInterestKey, Array<ReplicatedBlockChange>>()
  for (const change of changes) {
    const key = chunkInterestKeyForBlockChange(change)
    const group = groupedChanges.get(key)
    if (group === undefined) {
      groupedChanges.set(key, [change])
    } else {
      group.push(change)
    }
  }
  return groupedChanges
}

const projectRecipients = (
  context: BatchProjectionContext,
): Result.Result<ReadonlyArray<DeltaProjectionOutcome>, DeltaProjectionError> => {
  const { delta, recipients, blockGroups, owners } = context
  const outcomes: Array<DeltaProjectionOutcome> = []
  for (const recipient of recipients) {
    const projected = projectForRecipient({ blockGroups, delta, owners, recipient })
    if (Result.isFailure(projected)) {
      return Result.fail(projected.failure)
    }
    outcomes.push(projected.success)
  }
  return Result.succeed(Object.freeze(outcomes))
}

export const projectReplicatedWorldDelta = (
  deltaInput: unknown,
  recipientInput: unknown,
  owners: ReplicatedOwnerRegistry,
): Result.Result<ReadonlyArray<DeltaProjectionOutcome>, DeltaProjectionError> => {
  const delta = Schema.decodeUnknownResult(ReplicatedWorldDeltaMessage, strictParseOptions)(deltaInput)
  if (Result.isFailure(delta)) {
    return invalidDelta(delta.failure.message)
  }
  const recipients = decodeRecipients(recipientInput)
  if (Result.isFailure(recipients)) {
    return Result.fail(recipients.failure)
  }

  const blockGroups = groupBlockChanges(delta.success.blockChanges)
  return projectRecipients({
    blockGroups,
    delta: delta.success,
    owners,
    recipients: recipients.success,
  })
}

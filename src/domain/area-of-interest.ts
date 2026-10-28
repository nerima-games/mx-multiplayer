import { Data, Result, Schema } from 'effect'
import { type ReplicatedBlockChange, type ReplicatedOwnerId, ReplicatedOwnerIdSchema } from '@nerima-games/mc-sim'
import { DIMENSIONS } from '@nerima-games/mc-kernel'

export type ChunkInterest = Readonly<{
  dimension: ReplicatedBlockChange['dimension']
  x: number
  z: number
}>

const areaOfInterestBrand: unique symbol = Symbol('AreaOfInterest')
const areaOfInterestBrandValue: true = true

export type AreaOfInterest = Readonly<{
  [areaOfInterestBrand]: true
  chunkCount: number
  ownerCount: number
}>

export type AreaOfInterestInputErrorReason =
  | 'not-object'
  | 'missing-field'
  | 'unknown-field'
  | 'accessor-field'
  | 'invalid-array'
  | 'invalid-owner'
  | 'duplicate-owner'
  | 'invalid-chunk'
  | 'duplicate-chunk'

const AreaOfInterestInputError_base: ReturnType<typeof Data.TaggedError<'AreaOfInterestInputError'>> =
  Data.TaggedError('AreaOfInterestInputError')

export class AreaOfInterestInputError extends AreaOfInterestInputError_base<{
  readonly path: string
  readonly reason: AreaOfInterestInputErrorReason
}> {}

type AreaOfInterestState = Readonly<{
  chunks: ReadonlySet<string>
  owners: ReadonlySet<ReplicatedOwnerId>
}>

type DataRecord = Record<string, unknown>
type DecodeError = AreaOfInterestInputError

const ZERO = 0
const ONE = 1
const CHUNK_SIDE_BLOCKS = 16
const states = new WeakMap<object, AreaOfInterestState>()
const strictParseOptions = { onExcessProperty: 'error' as const }

const fail = (reason: AreaOfInterestInputErrorReason, path: string): Result.Result<never, DecodeError> =>
  Result.fail(new AreaOfInterestInputError({ path, reason }))

const hasOnlyAllowedRecordKeys = (input: object, allowedFields: ReadonlyArray<string>): boolean => {
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== 'string' || !allowedFields.includes(key)) {
      return false
    }
  }
  return true
}

const readRequiredRecordFields = (
  input: object,
  allowedFields: ReadonlyArray<string>,
  path: string,
): Result.Result<DataRecord, DecodeError> => {
  const record: DataRecord = {}
  for (const field of allowedFields) {
    const descriptor = Object.getOwnPropertyDescriptor(input, field)
    if (descriptor === undefined) {
      return fail('missing-field', `${path}.${field}`)
    }
    if (!('value' in descriptor)) {
      return fail('accessor-field', `${path}.${field}`)
    }
    record[field] = descriptor.value
  }
  return Result.succeed(record)
}

const readRecord = (
  input: unknown,
  allowedFields: ReadonlyArray<string>,
  path: string,
): Result.Result<DataRecord, DecodeError> => {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return fail('not-object', path)
  }
  if (!hasOnlyAllowedRecordKeys(input, allowedFields)) {
    return fail('unknown-field', path)
  }
  return readRequiredRecordFields(input, allowedFields, path)
}

const isValidArrayKey = (key: PropertyKey, length: number): boolean => {
  if (key === 'length') {
    return true
  }
  if (typeof key !== 'string' || !/^(?<index>0|[1-9][0-9]*)$/.test(key) || Number(key) >= length) {
    return false
  }
  return true
}

const readArrayValues = (input: ReadonlyArray<unknown>, path: string): Result.Result<ReadonlyArray<unknown>, DecodeError> => {
  const values: Array<unknown> = []
  for (let index = ZERO; index < input.length; index += ONE) {
    const descriptor = Object.getOwnPropertyDescriptor(input, String(index))
    if (descriptor === undefined || !('value' in descriptor)) {
      return fail('invalid-array', `${path}[${index}]`)
    }
    values.push(descriptor.value)
  }
  return Result.succeed(values)
}

const readArray = (input: unknown, path: string): Result.Result<ReadonlyArray<unknown>, DecodeError> => {
  if (!Array.isArray(input)) {
    return fail('invalid-array', path)
  }
  for (const key of Reflect.ownKeys(input)) {
    if (!isValidArrayKey(key, input.length)) {
      return fail('invalid-array', path)
    }
  }
  return readArrayValues(input, path)
}

const isChunkDimension = (value: unknown): value is ReplicatedBlockChange['dimension'] =>
  typeof value === 'string' && DIMENSIONS.some((dimension) => dimension === value)

const chunkKey = (chunk: ChunkInterest): string => JSON.stringify([chunk.dimension, chunk.x, chunk.z])

const areaInterestState = (input: unknown): AreaOfInterestState | undefined => {
  if (typeof input !== 'object' || input === null) {
    return undefined
  }
  return states.get(input)
}

const hasSetExpansion = <Value>(previous: ReadonlySet<Value>, current: ReadonlySet<Value>): boolean => {
  for (const value of current) {
    if (!previous.has(value)) {
      return true
    }
  }
  return false
}

const areaStateExpanded = (previous: AreaOfInterestState | undefined, current: AreaOfInterestState): boolean => {
  if (previous === undefined) {
    return true
  }
  return hasSetExpansion(previous.owners, current.owners) || hasSetExpansion(previous.chunks, current.chunks)
}

export const chunkInterestKeyForBlockChange = (change: ReplicatedBlockChange): string =>
  chunkKey({
    dimension: change.dimension,
    x: Math.floor(change.position.x / CHUNK_SIDE_BLOCKS),
    z: Math.floor(change.position.z / CHUNK_SIDE_BLOCKS),
  })

const readInterestArrays = (
  input: unknown,
): Result.Result<Readonly<{ chunks: ReadonlyArray<unknown>; ownerIds: ReadonlyArray<unknown> }>, DecodeError> => {
  const record = readRecord(input, ['chunks', 'ownerIds'], 'interest')
  if (Result.isFailure(record)) {
    return Result.fail(record.failure)
  }
  const ownerIds = readArray(record.success['ownerIds'], 'interest.ownerIds')
  if (Result.isFailure(ownerIds)) {
    return Result.fail(ownerIds.failure)
  }
  const chunks = readArray(record.success['chunks'], 'interest.chunks')
  if (Result.isFailure(chunks)) {
    return Result.fail(chunks.failure)
  }
  return Result.succeed({ chunks: chunks.success, ownerIds: ownerIds.success })
}

const decodeOwners = (input: ReadonlyArray<unknown>): Result.Result<ReadonlySet<ReplicatedOwnerId>, DecodeError> => {
  const owners = new Set<ReplicatedOwnerId>()
  for (let index = ZERO; index < input.length; index += ONE) {
    const decoded = Schema.decodeUnknownResult(ReplicatedOwnerIdSchema, strictParseOptions)(input[index])
    if (Result.isFailure(decoded)) {
      return fail('invalid-owner', `interest.ownerIds[${index}]`)
    }
    if (owners.has(decoded.success)) {
      return fail('duplicate-owner', `interest.ownerIds[${index}]`)
    }
    owners.add(decoded.success)
  }
  return Result.succeed(owners)
}

const decodeChunk = (input: unknown, path: string): Result.Result<string, DecodeError> => {
  const decoded = readRecord(input, ['dimension', 'x', 'z'], path)
  if (Result.isFailure(decoded)) {
    return Result.fail(decoded.failure)
  }
  const { dimension, x, z } = decoded.success
  if (!isChunkDimension(dimension) || typeof x !== 'number' || !Number.isSafeInteger(x) || typeof z !== 'number' || !Number.isSafeInteger(z)) {
    return fail('invalid-chunk', path)
  }
  return Result.succeed(chunkKey({ dimension, x, z }))
}

const decodeChunks = (input: ReadonlyArray<unknown>): Result.Result<ReadonlySet<string>, DecodeError> => {
  const chunks = new Set<string>()
  for (let index = ZERO; index < input.length; index += ONE) {
    const path = `interest.chunks[${index}]`
    const decoded = decodeChunk(input[index], path)
    if (Result.isFailure(decoded)) {
      return Result.fail(decoded.failure)
    }
    if (chunks.has(decoded.success)) {
      return fail('duplicate-chunk', path)
    }
    chunks.add(decoded.success)
  }
  return Result.succeed(chunks)
}

const decodeAreaOfInterestInput = (
  input: unknown,
): Result.Result<AreaOfInterestState, AreaOfInterestInputError> => {
  const arrays = readInterestArrays(input)
  if (Result.isFailure(arrays)) {
    return Result.fail(arrays.failure)
  }
  const owners = decodeOwners(arrays.success.ownerIds)
  if (Result.isFailure(owners)) {
    return Result.fail(owners.failure)
  }
  const chunks = decodeChunks(arrays.success.chunks)
  if (Result.isFailure(chunks)) {
    return Result.fail(chunks.failure)
  }
  return Result.succeed({ chunks: chunks.success, owners: owners.success })
}

export const createAreaOfInterest = (input: unknown): Result.Result<AreaOfInterest, AreaOfInterestInputError> => {
  const decoded = decodeAreaOfInterestInput(input)
  if (Result.isFailure(decoded)) {
    return Result.fail(decoded.failure)
  }
  const interest: AreaOfInterest = Object.freeze({
    [areaOfInterestBrand]: areaOfInterestBrandValue,
    chunkCount: decoded.success.chunks.size,
    ownerCount: decoded.success.owners.size,
  })
  states.set(interest, decoded.success)
  return Result.succeed(interest)
}

export const isAreaOfInterest = (input: unknown): input is AreaOfInterest =>
  areaInterestState(input) !== undefined

export const areaOfInterestIncludesOwner = (interest: unknown, owner: ReplicatedOwnerId): boolean =>
  areaInterestState(interest)?.owners.has(owner) ?? false

export const areaOfInterestIncludesChunkKey = (interest: unknown, key: string): boolean =>
  areaInterestState(interest)?.chunks.has(key) ?? false

export const areaOfInterestIncludesBlockChange = (
  interest: unknown,
  change: ReplicatedBlockChange,
): boolean => areaInterestState(interest)?.chunks.has(chunkInterestKeyForBlockChange(change)) ?? false

export const areaOfInterestExpanded = (previous: unknown, current: unknown): boolean => {
  const currentState = areaInterestState(current)
  if (currentState === undefined) {
    return false
  }
  return areaStateExpanded(areaInterestState(previous), currentState)
}

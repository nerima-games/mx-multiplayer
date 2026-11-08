import { describe, expect, it } from '@effect/vitest'
import * as fc from 'fast-check'
import {
  BlockIdSchema,
  BlockStateValuesSchema,
  decodeBlockState,
  defaultBlockState,
  EncodedBlockStateSchema,
  encodeBlockState,
} from '@nerima-games/mc-kernel'
import { Arbitrary, Effect, Result, Schema, SchemaAST } from 'effect'
import {
  createReplicatedOwnerRegistry,
  decodeFrame,
  encodeFrame,
  ReplicatedOwnerRegistryLimitsSchema,
} from '../src/domain/codec.js'
import { MESSAGE_TAGS, NetworkMessage, PROTOCOL_VERSION } from '../src/domain/protocol.js'
import { MESSAGE_PROPERTY_EXCLUSIONS } from './protocol-property-exclusions.js'

const PROPERTY_SEED = 0x51c0ffee
const SAMPLE_SEED_MAX = 0x7fffffff
const SAMPLE_SIZE = 4
const NUM_RUNS = 8
const MAX_SKIPS_PER_RUN = 100

const EMPTY_OWNER_REGISTRY_LIMITS = Schema.decodeUnknownSync(ReplicatedOwnerRegistryLimitsSchema)({
  maxRegisteredOwners: 0,
  maxDeltaBlockChanges: 31_149,
  maxSnapshotBlockReads: 31_149,
  maxDepth: 13,
  maxCollectionItems: 31_149,
  maxDeltaFrameBytes: 1_048_576,
  maxSnapshotFrameBytes: 1_048_576,
  ownerStates: [],
})
const EMPTY_OWNER_REGISTRY = Result.getOrThrow(
  createReplicatedOwnerRegistry([], EMPTY_OWNER_REGISTRY_LIMITS),
)
const DOOR_BLOCK_ID = Schema.decodeUnknownSync(BlockIdSchema)(106)
const AIR_BLOCK_ID = Schema.decodeUnknownSync(BlockIdSchema)(0)
const doorStateArbitrary = fc.record({
  facing: fc.constantFrom('north', 'south', 'west', 'east'),
  half: fc.constantFrom('lower', 'upper'),
  hinge: fc.constantFrom('left', 'right'),
  open: fc.boolean(),
  powered: fc.boolean(),
})

const doorFacingIndex = (facing: 'north' | 'south' | 'west' | 'east'): number => {
  switch (facing) {
    case 'north':
      return 0
    case 'south':
      return 1
    case 'west':
      return 2
    case 'east':
      return 3
  }
}

const expectedDoorStateCode = (state: {
  readonly facing: 'north' | 'south' | 'west' | 'east'
  readonly half: 'lower' | 'upper'
  readonly hinge: 'left' | 'right'
  readonly open: boolean
  readonly powered: boolean
}): number =>
  doorFacingIndex(state.facing) +
  (state.half === 'upper' ? 4 : 0) +
  (state.hinge === 'right' ? 8 : 0) +
  (state.open ? 16 : 0) +
  (state.powered ? 32 : 0)

const flattenMessageSchemas = (schema: Schema.Constraint): ReadonlyArray<Schema.Constraint> => {
  if (!SchemaAST.isUnion(schema.ast)) {
    return [schema]
  }
  if (!('members' in schema) || !Array.isArray(schema.members)) {
    throw new Error('NetworkMessage union is missing its member schemas')
  }
  const members = schema.members.filter(Schema.isSchema)
  if (members.length !== schema.members.length) {
    throw new Error('NetworkMessage union contains a non-schema member')
  }
  return members.flatMap(flattenMessageSchemas)
}

const messageSchemaTag = (schema: Schema.Constraint): string => {
  if (!SchemaAST.isObjects(schema.ast)) {
    throw new Error('NetworkMessage member is not a tagged object schema')
  }
  const tagField = schema.ast.propertySignatures.find((field) => field.name === '_tag')
  if (tagField === undefined || !SchemaAST.isLiteral(tagField.type) || typeof tagField.type.literal !== 'string') {
    throw new Error('NetworkMessage member has no string literal _tag schema')
  }
  return tagField.type.literal
}

const NETWORK_MESSAGE_SCHEMAS = flattenMessageSchemas(NetworkMessage)
const NETWORK_MESSAGE_SCHEMA_ENTRIES = NETWORK_MESSAGE_SCHEMAS.map(
  (schema): readonly [string, Schema.Constraint] => [messageSchemaTag(schema), schema],
)
const NETWORK_MESSAGE_SCHEMAS_BY_TAG = new Map(NETWORK_MESSAGE_SCHEMA_ENTRIES)
const NETWORK_MESSAGE_SCHEMA_TAGS = NETWORK_MESSAGE_SCHEMA_ENTRIES.map(([tag]) => tag)

const schemaDerivedArbitrary = <S extends Schema.Constraint>(schema: S): fc.Arbitrary<S['Type']> =>
  fc.nat({ max: SAMPLE_SEED_MAX }).map((seed) => {
    const samples = Effect.runSync(
      Arbitrary.sampleEffect(Arbitrary.schema(schema), {
        count: 1,
        seed,
        size: SAMPLE_SIZE,
      }),
    )
    const sample = samples[0]
    if (sample === undefined) {
      throw new Error('Effect Schema arbitrary produced no message')
    }
    return sample
  })

const messageTag = (message: unknown): string | undefined => {
  if (typeof message !== 'object' || message === null || !('_tag' in message)) {
    return undefined
  }
  return typeof message._tag === 'string' ? message._tag : undefined
}

const messageSchemaForTag = (tag: string): Schema.Constraint => {
  const schema = NETWORK_MESSAGE_SCHEMAS_BY_TAG.get(tag)
  if (schema === undefined) {
    throw new Error(`NetworkMessage has no schema for tag ${tag}`)
  }
  return schema
}

const hasEmptyArray = (message: unknown, field: string): boolean => {
  if (typeof message !== 'object' || message === null || !(field in message)) {
    return false
  }
  const fieldValue: unknown = Reflect.get(message, field)
  return Array.isArray(fieldValue) && fieldValue.length === 0
}

const isEncodableWithEmptyOwnerRegistry = (message: unknown): boolean => {
  switch (messageTag(message)) {
    case 'ReplicatedWorldDelta':
      return hasEmptyArray(message, 'changes')
    case 'ReplicatedWorldSnapshot':
      return hasEmptyArray(message, 'owners')
    default:
      return true
  }
}

const encodeWithCodec = (message: unknown): string => {
  const result = encodeFrame(message, EMPTY_OWNER_REGISTRY)
  if (Result.isFailure(result)) {
    throw new Error(`Message failed to encode: ${result.failure.message}`)
  }
  return result.success
}

const assertRoundTrip = (message: unknown, encode: (message: unknown) => string): void => {
  const result = decodeFrame(encode(message), EMPTY_OWNER_REGISTRY)
  if (Result.isFailure(result)) {
    throw new Error(`Message failed to decode: ${result.failure.message}`)
  }
  expect(result.success).toStrictEqual(message)
}

const tagsToGenerate = NETWORK_MESSAGE_SCHEMA_TAGS.filter(
  (tag) => !Object.hasOwn(MESSAGE_PROPERTY_EXCLUSIONS, tag),
)

describe('mc-kernel block-state codec public API', () => {
  it('encodes and decodes generated door states against an independent bit-layout expectation', () => {
    expect(Result.getOrThrow(defaultBlockState(DOOR_BLOCK_ID))).toStrictEqual({
      facing: 'north',
      half: 'lower',
      hinge: 'left',
      open: false,
      powered: false,
    })

    fc.assert(
      fc.property(doorStateArbitrary, (state) => {
        const values = Schema.decodeUnknownResult(BlockStateValuesSchema)(state)
        expect(Result.isSuccess(values)).toBe(true)
        if (Result.isFailure(values)) {
          return false
        }

        const expected = expectedDoorStateCode(state)
        const expectedEncodedState = Schema.decodeUnknownResult(EncodedBlockStateSchema)(expected)
        expect(Result.isSuccess(expectedEncodedState)).toBe(true)
        if (Result.isFailure(expectedEncodedState)) {
          return false
        }

        const encoded = encodeBlockState(DOOR_BLOCK_ID, state)
        expect(Result.isSuccess(encoded)).toBe(true)
        if (Result.isFailure(encoded)) {
          return false
        }
        expect(encoded.success).toBe(expectedEncodedState.success)

        const decoded = decodeBlockState(DOOR_BLOCK_ID, expected)
        expect(Result.isSuccess(decoded)).toBe(true)
        if (Result.isFailure(decoded)) {
          return false
        }
        expect(decoded.success).toStrictEqual(values.success)
        return true
      }),
      { seed: PROPERTY_SEED, numRuns: NUM_RUNS },
    )
  })

  it('returns typed failures for invalid state shapes, unsupported properties, and reserved codes', () => {
    for (const invalid of [
      { facing: 'north-east' },
      { powered: 1 },
      { unexpected: true },
    ]) {
      expect(Result.isFailure(Schema.decodeUnknownResult(BlockStateValuesSchema)(invalid))).toBe(true)
      expect(Result.isFailure(encodeBlockState(DOOR_BLOCK_ID, invalid))).toBe(true)
    }

    const unsupported = { waterlogged: true }
    expect(Result.isSuccess(Schema.decodeUnknownResult(BlockStateValuesSchema)(unsupported))).toBe(true)
    expect(Result.isFailure(encodeBlockState(DOOR_BLOCK_ID, unsupported))).toBe(true)
    expect(Result.isFailure(decodeBlockState(AIR_BLOCK_ID, 1))).toBe(true)

    for (const invalid of [-1, 1.5, 0x1_0000_0000, Number.NaN]) {
      expect(Result.isFailure(Schema.decodeUnknownResult(EncodedBlockStateSchema)(invalid))).toBe(true)
    }
  })
})

describe('NetworkMessage schema-derived round trips', () => {
  // BUG: a message union tag can drift out of the generated property suite without an explicit exclusion.
  it('accounts for every schema tag in either the property suite or the exclusions', () => {
    const schemaTags = [...NETWORK_MESSAGE_SCHEMA_TAGS].sort()
    const declaredTags = [...MESSAGE_TAGS].sort()
    const accountedTags = [...tagsToGenerate, ...Object.keys(MESSAGE_PROPERTY_EXCLUSIONS)].sort()

    expect(NETWORK_MESSAGE_SCHEMAS_BY_TAG.size).toBe(NETWORK_MESSAGE_SCHEMAS.length)
    expect(declaredTags).toStrictEqual(schemaTags)
    expect(accountedTags).toStrictEqual(schemaTags)

    for (const exclusion of Object.values(MESSAGE_PROPERTY_EXCLUSIONS)) {
      if (exclusion === undefined) {
        continue
      }
      expect(exclusion.schema.length).toBeGreaterThan(0)
      expect(exclusion.reason.length).toBeGreaterThan(0)
      expect(exclusion.source).toMatch(/^src\/.+\.ts:\d+$/)
    }
  })

  for (const tag of tagsToGenerate) {
    const schema = messageSchemaForTag(tag)
    const arbitrary = schemaDerivedArbitrary(schema).filter(isEncodableWithEmptyOwnerRegistry)

    // BUG: a valid schema value changes across the wire because a codec drops or alters a field.
    it(`round-trips schema-generated ${tag} messages`, () => {
      fc.assert(
        fc.property(arbitrary, (message) => {
          expect(messageTag(message)).toBe(tag)
          assertRoundTrip(message, encodeWithCodec)
          return true
        }),
        { seed: PROPERTY_SEED, numRuns: NUM_RUNS, maxSkipsPerRun: MAX_SKIPS_PER_RUN },
      )
    })
  }

  for (const tag of NETWORK_MESSAGE_SCHEMA_TAGS) {
    // BUG: the decoder accepts a correctly tagged message after required payload fields have been removed.
    it(`rejects an incomplete ${tag} message`, () => {
      const frame = JSON.stringify({
        message: { _tag: tag },
        protocolVersion: PROTOCOL_VERSION,
      })
      const decoded = decodeFrame(frame, EMPTY_OWNER_REGISTRY)

      expect(Result.isFailure(decoded)).toBe(true)
    })
  }

  // BUG: a lossy encoder that changes Chat.text can pass decode while losing round-trip equality.
  it('fails the round-trip assertion when the encoder changes a Chat field', () => {
    const chatSamples = fc.sample(schemaDerivedArbitrary(messageSchemaForTag('Chat')), {
      numRuns: 1,
      seed: PROPERTY_SEED,
    })
    const chat = chatSamples[0]
    if (chat === undefined) {
      throw new Error('Chat arbitrary produced no message')
    }

    const lossyEncode = (message: unknown): string => {
      if (messageTag(message) !== 'Chat' || typeof message !== 'object' || message === null || !('player' in message) || !('text' in message) || typeof message.text !== 'string') {
        throw new Error('lossy Chat encoder received a different tag')
      }
      return JSON.stringify({
        message: { _tag: 'Chat', player: message.player, text: message.text === 'x' ? 'y' : 'x' },
        protocolVersion: PROTOCOL_VERSION,
      })
    }

    const lossyFrame = lossyEncode(chat)
    const decoded = decodeFrame(lossyFrame, EMPTY_OWNER_REGISTRY)
    expect(Result.isSuccess(decoded)).toBe(true)
    expect(() => assertRoundTrip(chat, lossyEncode)).toThrow()
  })
})

import { describe, expect, it } from '@effect/vitest'
import { makeReplicatedOwnerId, type ReplicatedOwnerRegistration } from '@nerima-games/mc-sim'
import { Result, Schema } from 'effect'
import { frameTag, inspectInboundFrame, unknownRecord } from '../src/application/server/frame-inspection'
import {
  createReplicatedOwnerRegistry,
  decodeFrame,
  ReplicatedOwnerRegistryLimitsSchema,
  wireFrameByteLength,
} from '../src/domain/codec'
import { PROTOCOL_VERSION } from '../src/domain/protocol'

// Mirror the limits enforced by codec until those constants are public exports.
const MAX_FRAME_CODE_UNITS = 1_048_576
const MAX_JSON_COLLECTION_ITEMS = 31_149
const MAX_JSON_DEPTH = 13

describe('unknownRecord', () => {
  it('accepts a plain object', () => {
    expect(unknownRecord({ a: 1 })).toStrictEqual({ a: 1 })
  })

  it('rejects null, a primitive, and an array', () => {
    expect(unknownRecord(null)).toBeUndefined()
    expect(unknownRecord('text')).toBeUndefined()
    expect(unknownRecord([1, 2])).toStrictEqual([1, 2])
  })
})

const wireFrame = (messageJson: string, protocolVersion = PROTOCOL_VERSION): string =>
  `{"protocolVersion":${protocolVersion},"message":${messageJson}}`

const decodeFailureReason = (frame: string): string | undefined => {
  const decoded = decodeFrame(frame)
  return Result.isFailure(decoded) ? decoded.failure.reason : undefined
}

describe('frameTag', () => {
  it('reads the _tag off a well-formed frame', () => {
    expect(frameTag('{"_tag":"Ping","nonce":1}')).toBe('Ping')
  })

  it('returns undefined for text that is not JSON', () => {
    expect(frameTag('not json')).toBeUndefined()
  })

  it('returns undefined for JSON that is not an object', () => {
    expect(frameTag('42')).toBeUndefined()
    expect(frameTag('[1,2,3]')).toBeUndefined()
  })

  it('returns undefined when _tag is missing or not a string', () => {
    expect(frameTag('{"nonce":1}')).toBeUndefined()
    expect(frameTag('{"_tag":7}')).toBeUndefined()
  })
})


describe('bounded frameTag compatibility', () => {
  it('keeps returning arbitrary message tags for bounded message JSON', () => {
    expect(frameTag('{"_tag":"FutureMessage"}')).toBe('FutureMessage')
  })

  it('does not parse message JSON above the shared code-unit cap', () => {
    const oversized = '{"_tag":"Ping"}'.padEnd(MAX_FRAME_CODE_UNITS + 1, ' ')
    expect(frameTag(oversized)).toBeUndefined()
  })
})

describe('inspectInboundFrame', () => {
  it('returns the strict decoded message and codec tag metadata for a valid frame', () => {
    const frame = wireFrame('{"_tag":"Ping","nonce":1}')
    const inspected = inspectInboundFrame(frame)
    const decoded = decodeFrame(frame)

    expect(Result.isSuccess(decoded)).toBe(true)
    expect(inspected).toMatchObject({
      _tag: 'Accepted',
      byteLength: wireFrameByteLength(frame),
      message: { _tag: 'Ping', nonce: 1 },
      replicatedTag: undefined,
      tag: 'Ping',
    })
    if (inspected._tag === 'Accepted' && Result.isSuccess(decoded)) {
      expect(inspected.message).toStrictEqual(decoded.success)
    }
  })

  it('accepts the exact code-unit cap and returns a typed predecode failure one unit above it', async () => {
    const fc = await import('fast-check')
    fc.assert(
      fc.property(
        fc.tuple(fc.constant(MAX_FRAME_CODE_UNITS), fc.constant(MAX_FRAME_CODE_UNITS + 1)),
        ([atLimit, overLimit]) => {
          const base = wireFrame('{"_tag":"Ping","nonce":1}')
          const exact = base.padEnd(atLimit, ' ')
          const oversized = base.padEnd(overLimit, ' ')

          expect(wireFrameByteLength(exact)).toBe(atLimit)
          expect(inspectInboundFrame(exact)._tag).toBe('Accepted')
          expect(decodeFailureReason(exact)).toBeUndefined()
          expect(inspectInboundFrame(oversized)).toMatchObject({
            _tag: 'Rejected',
            byteLength: undefined,
            reason: 'frame-too-large',
            stage: 'predecode-limit',
          })
        },
      ),
      { numRuns: 1 },
    )
  })

  it('rejects an unknown or missing message tag with a typed result', () => {
    const unknownTagFrame = wireFrame('{"_tag":"FutureMessage"}')
    const missingTagFrame = wireFrame('{"nonce":1}')

    expect(decodeFailureReason(unknownTagFrame)).toBe('malformed-frame')
    expect(decodeFailureReason(missingTagFrame)).toBe('malformed-frame')
    expect(inspectInboundFrame(unknownTagFrame)).toMatchObject({
      _tag: 'Rejected',
      reason: 'unknown-message-tag',
      stage: 'tag-predecode',
      tag: 'FutureMessage',
    })
    expect(inspectInboundFrame(missingTagFrame)).toMatchObject({
      _tag: 'Rejected',
      reason: 'missing-message-tag',
      stage: 'tag-predecode',
    })
  })

  it('reports malformed messages, preserves open root fields, and rejects unsupported protocol versions', () => {
    const malformedFrame = wireFrame('{"_tag":"Ping","nonce":null}')
    expect(decodeFailureReason(malformedFrame)).toBe('malformed-frame')
    expect(inspectInboundFrame(malformedFrame)).toMatchObject({
      _tag: 'Rejected',
      reason: 'malformed-frame',
      stage: 'decode',
      tag: 'Ping',
    })

    const forwardCompatibleFrame = wireFrame('{"_tag":"Ping","nonce":1,"extra":true}')
    expect(decodeFailureReason(forwardCompatibleFrame)).toBeUndefined()
    expect(inspectInboundFrame(forwardCompatibleFrame)).toMatchObject({
      _tag: 'Accepted',
      message: { _tag: 'Ping', nonce: 1 },
      tag: 'Ping',
    })

    expect(inspectInboundFrame(wireFrame('{"_tag":"Ping","nonce":1}', PROTOCOL_VERSION - 1))).toMatchObject({
      _tag: 'Rejected',
      reason: 'unsupported-protocol-version',
      stage: 'protocol',
      tag: 'Ping',
    })

    expect(inspectInboundFrame(wireFrame('{"_tag":"ReplicatedWorldDelta"}'))).toMatchObject({
      _tag: 'Rejected',
      reason: 'malformed-frame',
      stage: 'decode',
      tag: 'ReplicatedWorldDelta',
    })
  })

  it('applies the known-tag byte limit before decoding its message schema', () => {
    const oversized = wireFrame(JSON.stringify({ _tag: 'PlayerDamageCommand', damage: 'x'.repeat(4_100) }))

    expect(inspectInboundFrame(oversized)).toMatchObject({
      _tag: 'Rejected',
      reason: 'frame-too-large',
      stage: 'predecode-limit',
    })
  })

  it('rejects JSON depth above the cap before message Schema decode', async () => {
    const fc = await import('fast-check')
    fc.assert(
      fc.property(
        fc.tuple(fc.constant(MAX_JSON_DEPTH), fc.constant(MAX_JSON_DEPTH + 1)),
        ([atLimit, overLimit]) => {
          const withDepth = (depth: number): string => {
            const nestedDepth = depth - 2
            const nested = '['.repeat(nestedDepth) + '0' + ']'.repeat(nestedDepth)
            return wireFrame(`{"_tag":"Ping","nonce":1,"extra":${nested}}`)
          }
          const exact = withDepth(atLimit)
          const over = withDepth(overLimit)

          expect(decodeFailureReason(exact)).toBeUndefined()
          expect(inspectInboundFrame(exact)).toMatchObject({
            _tag: 'Accepted',
            message: { _tag: 'Ping', nonce: 1 },
          })
          expect(decodeFailureReason(over)).toBe('frame-too-large')
          expect(inspectInboundFrame(over)).toMatchObject({
            _tag: 'Rejected',
            reason: 'frame-too-large',
            stage: 'predecode-limit',
          })
        },
      ),
      { numRuns: 1 },
    )
  })

  it('rejects collection counts above the cap before message Schema decode', async () => {
    const fc = await import('fast-check')
    fc.assert(
      fc.property(
        fc.tuple(fc.constant(MAX_JSON_COLLECTION_ITEMS), fc.constant(MAX_JSON_COLLECTION_ITEMS + 1)),
        ([atLimit, overLimit]) => {
          const withCollection = (count: number): string => {
            const values = JSON.stringify(Array.from({ length: count }, () => 0))
            return wireFrame(`{"_tag":"Ping","nonce":1,"extra":${values}}`)
          }
          const exact = withCollection(atLimit)
          const over = withCollection(overLimit)

          expect(decodeFailureReason(exact)).toBeUndefined()
          expect(inspectInboundFrame(exact)).toMatchObject({
            _tag: 'Accepted',
            message: { _tag: 'Ping', nonce: 1 },
          })
          expect(decodeFailureReason(over)).toBe('frame-too-large')
          expect(inspectInboundFrame(over)).toMatchObject({
            _tag: 'Rejected',
            reason: 'frame-too-large',
            stage: 'predecode-limit',
          })
        },
      ),
      { numRuns: 1 },
    )
  })

  it('returns a typed malformed-frame error for invalid JSON', () => {
    expect(inspectInboundFrame('not json')).toMatchObject({
      _tag: 'Rejected',
      reason: 'malformed-frame',
      stage: 'decode',
    })
  })

  it('returns a typed malformed-frame error when the message is not an object', () => {
    expect(inspectInboundFrame(wireFrame('null'))).toMatchObject({
      _tag: 'Rejected',
      reason: 'malformed-frame',
      stage: 'decode',
    })
  })
})

describe('replicated owner registry inspection', () => {
  it('returns a typed error when a registration owner ID fails schema decoding', () => {
    const validOwnerId = makeReplicatedOwnerId('registered-owner')
    const invalidOwnerId = makeReplicatedOwnerId('')
    const stateSchema = Schema.Struct({ count: Schema.Number })
    const registration: ReplicatedOwnerRegistration<typeof stateSchema> = {
      ownerId: invalidOwnerId,
      schema: stateSchema,
      initialState: { count: 0 },
    }
    const limits = Schema.decodeUnknownSync(ReplicatedOwnerRegistryLimitsSchema)({
      maxRegisteredOwners: 1,
      maxDeltaBlockChanges: 0,
      maxSnapshotBlockReads: 0,
      maxDepth: MAX_JSON_DEPTH,
      maxCollectionItems: MAX_JSON_COLLECTION_ITEMS,
      maxDeltaFrameBytes: 1_048_576,
      maxSnapshotFrameBytes: 1_048_576,
      ownerStates: [{
        ownerId: validOwnerId,
        maxStateBytes: 1_024,
        maxStateDepth: 2,
        maxCollectionItems: 1,
      }],
    })

    const registry = createReplicatedOwnerRegistry([registration], limits)

    expect(Result.isFailure(registry)).toBe(true)
    if (Result.isFailure(registry)) {
      expect(registry.failure.reason).toBe('malformed-frame')
    }
  })
})

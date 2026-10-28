/**
 * Inspect a v10 wire frame before passing it on to a transport handler.
 *
 * `decodeFrame` enforces the shared byte and JSON-shape limits before decoding
 * the strict message schema. `frameTag` remains for callers holding a bounded
 * message JSON value rather than a complete wire frame.
 */
import { MESSAGE_TAGS, type NetworkMessage } from '../../domain/protocol.js'
import {
  type NonNegativeSafeInteger,
  type ReplicatedFrameTag,
  type ReplicatedOwnerRegistry,
  type WireText,
  decodeFrame,
  inspectReplicatedFrameTag,
  wireFrameByteLength,
} from '../../domain/codec.js'
import { Result, Schema } from 'effect'
import { ProtocolError } from '../../domain/errors.js'

const MAX_FRAME_CODE_UNITS = 1_048_576

const FrameTagSchema: Schema.brand<typeof Schema.String, 'FrameTag'> = Schema.String.pipe(Schema.brand('FrameTag'))
export type FrameTag = NetworkMessage['_tag'] | typeof FrameTagSchema.Type

export type UnknownRecord = Readonly<Record<string, unknown>>

const isUnknownRecord = (value: unknown): value is UnknownRecord => typeof value === 'object' && value !== null

export const unknownRecord = (value: unknown): UnknownRecord | undefined => {
  if (isUnknownRecord(value)) {
    return value
  }
  return undefined
}

const JSON_PARSE_FAILED: unique symbol = Symbol('frame-inspection/json-parse-failed')

const JSON_UNKNOWN_SCHEMA = Schema.fromJsonString(Schema.Unknown)
const tryParseJson = (text: string): unknown => {
  const parsed = Schema.decodeUnknownResult(JSON_UNKNOWN_SCHEMA)(text)
  if (Result.isFailure(parsed)) {
    return JSON_PARSE_FAILED
  }
  return parsed.success
}

const decodeFrameTag = (input: unknown): FrameTag | undefined => {
  const decoded = Schema.decodeUnknownResult(FrameTagSchema)(input)
  if (Result.isFailure(decoded)) {
    return undefined
  }
  return decoded.success
}

/** The frame's `_tag`, or `undefined` if the frame is not JSON, not an object, or has no string `_tag`. */
export const frameTag = (frame: WireText): FrameTag | undefined => {
  if (frame.length > MAX_FRAME_CODE_UNITS) {
    return undefined
  }
  return decodeFrameTag(unknownRecord(tryParseJson(frame))?.['_tag'])
}


export type InboundFrameInspection =
  | {
      readonly _tag: 'Accepted'
      readonly byteLength: NonNegativeSafeInteger
      readonly message: NetworkMessage
      readonly replicatedTag: ReplicatedFrameTag | undefined
      readonly tag: NetworkMessage['_tag']
    }
  | {
      readonly _tag: 'Rejected'
      readonly byteLength: NonNegativeSafeInteger | undefined
      readonly error: ProtocolError
      readonly reason: ProtocolError['reason'] | 'missing-message-tag' | 'unknown-message-tag'
      readonly stage: 'predecode-limit' | 'protocol' | 'tag-predecode' | 'decode'
      readonly tag: FrameTag | undefined
    }

type ParsedEnvelopeTag =
  | { readonly _tag: 'MissingTag' }
  | { readonly _tag: 'Tag'; readonly tag: FrameTag }

const parseEnvelopeTag = (frame: WireText): ParsedEnvelopeTag | undefined => {
  const envelope = unknownRecord(tryParseJson(frame))
  const message = unknownRecord(envelope?.['message'])
  if (message === undefined) {
    return undefined
  }
  const tag = message['_tag']
  if (typeof tag === 'string') {
    return { _tag: 'Tag', tag: Schema.decodeUnknownSync(FrameTagSchema)(tag) }
  }
  return { _tag: 'MissingTag' }
}

const tagFromParsedEnvelope = (parsedTag: ParsedEnvelopeTag | undefined): FrameTag | undefined => {
  if (parsedTag?._tag !== 'Tag') {
    return undefined
  }
  const { tag } = parsedTag
  return tag
}

const knownMessageTags: ReadonlySet<string> = new Set(MESSAGE_TAGS)

type RejectedFrameInspection = Extract<InboundFrameInspection, { readonly _tag: 'Rejected' }>

type RejectedFrameOptions = Readonly<{
  byteLength: NonNegativeSafeInteger | undefined
  error: ProtocolError
  reason?: RejectedFrameInspection['reason']
  stage: RejectedFrameInspection['stage']
  tag: FrameTag | undefined
}>

const rejectedFrame = ({ byteLength, error, reason = error.reason, stage, tag }: RejectedFrameOptions): RejectedFrameInspection => ({
  _tag: 'Rejected',
  byteLength,
  error,
  reason,
  stage,
  tag,
})

const rejectDecodeFailure = (
  frame: WireText,
  byteLength: NonNegativeSafeInteger,
  error: ProtocolError,
): RejectedFrameInspection => {
  const tag = tagFromParsedEnvelope(parseEnvelopeTag(frame))
  return rejectedFrame({ byteLength, error, stage: 'decode', tag })
}

const rejectOversizedCodeUnitFrame = (frame: WireText): RejectedFrameInspection | undefined => {
  if (frame.length <= MAX_FRAME_CODE_UNITS) {
    return undefined
  }
  return rejectedFrame({
    byteLength: undefined,
    error: new ProtocolError({
      detail: `frame UTF-16 code units ${frame.length} exceed limit ${MAX_FRAME_CODE_UNITS}`,
      reason: 'frame-too-large',
    }),
    stage: 'predecode-limit',
    tag: undefined,
  })
}

type DecodeFailureOptions = Readonly<{
  byteLength: NonNegativeSafeInteger
  error: ProtocolError
  frame: WireText
  replicatedTag: ReplicatedFrameTag | undefined
}>

const rejectDecodedFrameFailure = ({ frame, byteLength, error, replicatedTag }: DecodeFailureOptions): RejectedFrameInspection => {
  if (error.reason === 'frame-too-large') {
    return rejectedFrame({ byteLength, error, stage: 'predecode-limit', tag: undefined })
  }
  if (replicatedTag !== undefined) {
    return rejectedFrame({ byteLength, error, stage: 'decode', tag: replicatedTag })
  }
  return rejectDecodeFailure(frame, byteLength, error)
}

type InspectDecodedFrameOptions = Readonly<{
  byteLength: NonNegativeSafeInteger
  frame: WireText
  owners: ReplicatedOwnerRegistry | undefined
  replicatedTag: ReplicatedFrameTag | undefined
}>

const inspectDecodedFrame = ({ frame, owners, byteLength, replicatedTag }: InspectDecodedFrameOptions): InboundFrameInspection => {
  const decoded = decodeFrame(frame, owners)
  if (Result.isFailure(decoded)) {
    return rejectDecodedFrameFailure({ byteLength, error: decoded.failure, frame, replicatedTag })
  }
  return {
    _tag: 'Accepted',
    byteLength,
    message: decoded.success,
    replicatedTag,
    tag: decoded.success._tag,
  }
}

type PreflightFailureOptions = Readonly<{
  byteLength: NonNegativeSafeInteger
  error: ProtocolError
  frame: WireText
}>

const preflightFailureTag = (frame: WireText, error: ProtocolError): FrameTag | undefined => {
  if (error.reason === 'frame-too-large') {
    return undefined
  }
  return tagFromParsedEnvelope(parseEnvelopeTag(frame))
}

const rejectPreflightFailure = ({ frame, byteLength, error }: PreflightFailureOptions): RejectedFrameInspection => {
  let stage: RejectedFrameInspection['stage'] = 'decode'
  if (error.reason === 'unsupported-protocol-version') {
    stage = 'protocol'
  } else if (error.reason === 'frame-too-large') {
    stage = 'predecode-limit'
  }
  const tag = preflightFailureTag(frame, error)
  return rejectedFrame({
    byteLength,
    error,
    stage,
    tag,
  })
}

const rejectInvalidEnvelopeTag = (
  parsedTag: ParsedEnvelopeTag | undefined,
  byteLength: NonNegativeSafeInteger,
): RejectedFrameInspection | undefined => {
  if (parsedTag?._tag === 'MissingTag') {
    const error = new ProtocolError({ detail: 'message is missing a string _tag', reason: 'malformed-frame' })
    return rejectedFrame({ byteLength, error, reason: 'missing-message-tag', stage: 'tag-predecode', tag: undefined })
  }
  if (parsedTag?._tag === 'Tag' && !knownMessageTags.has(parsedTag.tag)) {
    const error = new ProtocolError({ detail: `unknown message tag: ${parsedTag.tag}`, reason: 'malformed-frame' })
    return rejectedFrame({
      byteLength,
      error,
      reason: 'unknown-message-tag',
      stage: 'tag-predecode',
      tag: parsedTag.tag,
    })
  }
  return undefined
}

const inspectBoundedFrame = (
  frame: WireText,
  owners?: ReplicatedOwnerRegistry,
): InboundFrameInspection => {
  const byteLength = wireFrameByteLength(frame)
  const preflight = inspectReplicatedFrameTag(frame)
  if (Result.isFailure(preflight)) {
    return rejectPreflightFailure({ byteLength, error: preflight.failure, frame })
  }

  const invalidTag = rejectInvalidEnvelopeTag(parseEnvelopeTag(frame), byteLength)
  if (invalidTag !== undefined) {
    return invalidTag
  }
  return inspectDecodedFrame({ byteLength, frame, owners, replicatedTag: preflight.success })
}

export const inspectInboundFrame = (
  frame: WireText,
  owners?: ReplicatedOwnerRegistry,
): InboundFrameInspection => rejectOversizedCodeUnitFrame(frame) ?? inspectBoundedFrame(frame, owners)

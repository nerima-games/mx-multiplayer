/**
 * Inspect a v10 wire frame before passing it on to a transport handler.
 *
 * `decodeFrame` enforces the shared byte and JSON-shape limits before decoding
 * the strict message schema. `frameTag` remains for callers holding a bounded
 * message JSON value rather than a complete wire frame.
 */
import { Result } from 'effect'
import {
  decodeFrame,
  inspectReplicatedFrameTag,
  wireFrameByteLength,
  type ReplicatedFrameTag,
  type ReplicatedOwnerRegistry,
  type WireText,
} from '../../domain/codec.js'
import { ProtocolError } from '../../domain/errors.js'
import { MESSAGE_TAGS, type NetworkMessage } from '../../domain/protocol.js'

const MAX_FRAME_CODE_UNITS = 1_048_576

export type UnknownRecord = Readonly<Record<string, unknown>>

const isUnknownRecord = (value: unknown): value is UnknownRecord => typeof value === 'object' && value !== null

export const unknownRecord = (value: unknown): UnknownRecord | undefined => {
  if (isUnknownRecord(value)) {
    return value
  }
  return undefined
}

const JSON_PARSE_FAILED: unique symbol = Symbol('frame-inspection/json-parse-failed')

const tryParseJson = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return JSON_PARSE_FAILED
  }
}

/** The frame's `_tag`, or `undefined` if the frame is not JSON, not an object, or has no string `_tag`. */
export const frameTag = (frame: WireText): string | undefined => {
  if (frame.length > MAX_FRAME_CODE_UNITS) {
    return undefined
  }
  const tag = unknownRecord(tryParseJson(frame))?.['_tag']
  if (typeof tag === 'string') {
    return tag
  }
  return undefined
}


export type InboundFrameInspection =
  | {
      readonly _tag: 'Accepted'
      readonly byteLength: number
      readonly message: NetworkMessage
      readonly replicatedTag: ReplicatedFrameTag | undefined
      readonly tag: NetworkMessage['_tag']
    }
  | {
      readonly _tag: 'Rejected'
      readonly byteLength: number | undefined
      readonly error: ProtocolError
      readonly reason: ProtocolError['reason'] | 'missing-message-tag' | 'unknown-message-tag'
      readonly stage: 'predecode-limit' | 'protocol' | 'tag-after-decode' | 'decode'
      readonly tag: string | undefined
    }

type ParsedEnvelopeTag =
  | { readonly _tag: 'MissingTag' }
  | { readonly _tag: 'Tag'; readonly tag: string }

const parseEnvelopeTag = (frame: WireText): ParsedEnvelopeTag | undefined => {
  const envelope = unknownRecord(tryParseJson(frame))
  const message = unknownRecord(envelope?.['message'])
  if (message === undefined) {
    return undefined
  }
  const tag = message['_tag']
  if (typeof tag === 'string') {
    return { _tag: 'Tag', tag }
  }
  return { _tag: 'MissingTag' }
}

const knownMessageTags: ReadonlySet<string> = new Set(MESSAGE_TAGS)

type RejectedFrameInspection = Extract<InboundFrameInspection, { readonly _tag: 'Rejected' }>

type RejectedFrameOptions = Readonly<{
  byteLength: number | undefined
  error: ProtocolError
  reason?: RejectedFrameInspection['reason']
  stage: RejectedFrameInspection['stage']
  tag: string | undefined
}>

const rejectedFrame = ({ byteLength, error, reason = error.reason, stage, tag }: RejectedFrameOptions): RejectedFrameInspection => ({
  _tag: 'Rejected',
  byteLength,
  error,
  reason,
  stage,
  tag,
})

const rejectReplicatedTagFailure = (
  frame: WireText,
  byteLength: number,
  error: ProtocolError,
): RejectedFrameInspection => {
  const tag = parseEnvelopeTag(frame)
  const stage = error.reason === 'unsupported-protocol-version' ? 'protocol' : 'decode'
  return rejectedFrame({ byteLength, error, stage, tag: tag?._tag === 'Tag' ? tag.tag : undefined })
}

const rejectDecodeFailure = (
  frame: WireText,
  byteLength: number,
  error: ProtocolError,
): RejectedFrameInspection => {
  const parsedTag = parseEnvelopeTag(frame)
  if (parsedTag?._tag === 'MissingTag') {
    return rejectedFrame({ byteLength, error, reason: 'missing-message-tag', stage: 'tag-after-decode', tag: undefined })
  }
  if (parsedTag?._tag === 'Tag' && !knownMessageTags.has(parsedTag.tag)) {
    return rejectedFrame({ byteLength, error, reason: 'unknown-message-tag', stage: 'tag-after-decode', tag: parsedTag.tag })
  }
  return rejectedFrame({ byteLength, error, stage: 'decode', tag: parsedTag?._tag === 'Tag' ? parsedTag.tag : undefined })
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

const rejectDecodedFrameFailure = (
  frame: WireText,
  byteLength: number,
  error: ProtocolError,
): RejectedFrameInspection => {
  if (error.reason === 'frame-too-large') {
    return rejectedFrame({ byteLength, error, stage: 'predecode-limit', tag: undefined })
  }
  const inspectedTag = inspectReplicatedFrameTag(frame)
  if (Result.isFailure(inspectedTag)) {
    return rejectReplicatedTagFailure(frame, byteLength, inspectedTag.failure)
  }
  return rejectDecodeFailure(frame, byteLength, error)
}

const inspectDecodedFrame = (
  frame: WireText,
  owners: ReplicatedOwnerRegistry | undefined,
  byteLength: number,
): InboundFrameInspection => {
  const decoded = decodeFrame(frame, owners)
  if (Result.isFailure(decoded)) {
    return rejectDecodedFrameFailure(frame, byteLength, decoded.failure)
  }
  const inspectedTag = inspectReplicatedFrameTag(frame)
  if (Result.isFailure(inspectedTag)) {
    return rejectReplicatedTagFailure(frame, byteLength, inspectedTag.failure)
  }
  return {
    _tag: 'Accepted',
    byteLength,
    message: decoded.success,
    replicatedTag: inspectedTag.success,
    tag: decoded.success._tag,
  }
}

export const inspectInboundFrame = (
  frame: WireText,
  owners?: ReplicatedOwnerRegistry,
): InboundFrameInspection => {
  const codeUnitFailure = rejectOversizedCodeUnitFrame(frame)
  if (codeUnitFailure !== undefined) {
    return codeUnitFailure
  }
  const byteLength = wireFrameByteLength(frame)
  return inspectDecodedFrame(frame, owners, byteLength)
}

/**
 * Frame codec: `NetworkMessage` <-> wire text.
 *
 * PRE-AUDIT FIRST CUT (叩き台).
 *
 * ---------------------------------------------------------------------------
 * Why the codec produces TEXT and not bytes
 * ---------------------------------------------------------------------------
 *
 * The reference implementation's codec
 * (`packages/network/application/codec.ts`, 34 LOC) hands back an
 * `ArrayBuffer`, which means it reaches for `TextEncoder`/`TextDecoder` — and
 * those are platform globals, not language ones. That made the codec
 * untestable without a DOM-ish environment and pinned the protocol layer to a
 * runtime.
 *
 * Here the domain codec stops at text. Turning text into whatever the socket
 * wants (UTF-8 bytes, a compressed frame, a length-prefixed record) is the
 * adapter's job, in whichever repository owns the platform. The benefit is
 * concrete: `tsconfig.build.json` compiles this repository with `lib: ["ES2024"]`
 * and `types: []` — no DOM, no Node — so a protocol change cannot quietly
 * acquire a platform dependency.
 *
 * ---------------------------------------------------------------------------
 * Round trip is the contract
 * ---------------------------------------------------------------------------
 *
 * `decodeFrame(encodeFrame(m)) === m` for every representable `m`. That is the
 * property `test/codec.test.ts` exercises message by message, and it is the
 * reason the payload schemas carry `finite()` / `int()` refinements: JSON turns
 * `NaN` and `Infinity` into `null`, so an unconstrained number would break the
 * round trip at the far end, where the frame is no longer available to debug.
 */
import {
  ReplicatedOwnerIdSchema,
  type ReplicatedOwnerChange,
  type ReplicatedOwnerId,
  type ReplicatedOwnerRegistration,
} from '@nerima-games/mc-sim'
import { Result, Schema } from 'effect'
import { ProtocolError } from './errors.js'
import {
  NetworkMessage,
  type NetworkMessage as NetworkMessageType,
  PROTOCOL_VERSION,
} from './protocol.js'

/**
 * One frame, as text. Exactly one message; framing multiple messages into a
 * single socket write is a transport concern, not a protocol one.
 */
export type WireText = string

const MAX_FRAME_CODE_UNITS = 1_048_576
const MAX_FRAME_UTF8_BYTES = 3_145_728
const legacyFrameLimits: ReadonlyMap<string, { readonly codeUnits: number; readonly utf8Bytes: number }> = new Map([
  ['PlayerDamageCommand', { codeUnits: 1_024, utf8Bytes: 3_072 }],
  ['CraftingCommand', { codeUnits: 1_024, utf8Bytes: 3_072 }],
  ['BrewingCommand', { codeUnits: 8_192, utf8Bytes: 24_576 }],
  ['AnvilCommand', { codeUnits: 2_048, utf8Bytes: 6_144 }],
  ['EnchantingCommand', { codeUnits: 32_768, utf8Bytes: 98_304 }],
  ['WitherCommand', { codeUnits: 1_048_576, utf8Bytes: 3_145_728 }],
  ['EnderDragonCommand', { codeUnits: 16_384, utf8Bytes: 49_152 }],
  ['SleepCommand', { codeUnits: 1_048_576, utf8Bytes: 3_145_728 }],
])
const strictParseOptions = { onExcessProperty: 'error' as const }
const WireFrame = Schema.fromJsonString(
  Schema.Struct({
    message: NetworkMessage,
    protocolVersion: Schema.Number.pipe(Schema.check(Schema.isInt())),
  }),
)
const strictRootMessageTags = new Set([
  'EndPortalUseCommand',
  'InsertEyeIntoEndPortalFrameCommand',
  'NetherPortalUseCommand',
  'RealmTransferSnapshot',
  'ThrowEyeOfEnderCommand',
  'ToggleLeverCommand',
  'ReplicatedWorldDelta',
  'ReplicatedWorldSnapshot',
  'ReplicatedWorldSnapshotStart',
  'ReplicatedWorldSnapshotChunk',
  'ReplicatedWorldSnapshotEnd',
])
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const ownerRegistryBrand: unique symbol = Symbol('ReplicatedOwnerRegistry')
export type ReplicatedOwnerRegistry = Readonly<{ [ownerRegistryBrand]: true }>

export type ReplicatedFrameTag =
  | 'ReplicatedWorldDelta'
  | 'ReplicatedWorldSnapshot'
  | 'ReplicatedWorldSnapshotStart'
  | 'ReplicatedWorldSnapshotChunk'
  | 'ReplicatedWorldSnapshotEnd'

type OwnerStateCodec = Schema.Codec<any, any>
const ownerSchemasByRegistry = new WeakMap<
  ReplicatedOwnerRegistry,
  ReadonlyMap<ReplicatedOwnerId, OwnerStateCodec>
>()

const malformedFrame = (detail: string): ProtocolError =>
  new ProtocolError({ detail, reason: 'malformed-frame' })

const frameTooLarge = (detail: string): ProtocolError =>
  new ProtocolError({ detail, reason: 'frame-too-large' })

/** Build the finite owner-to-state-schema table used by C4 frame codecs. */
export const createReplicatedOwnerRegistry = (
  registrations: ReadonlyArray<ReplicatedOwnerRegistration>,
): Result.Result<ReplicatedOwnerRegistry, ProtocolError> => {
  const schemas = new Map<ReplicatedOwnerId, OwnerStateCodec>()

  for (const registration of registrations) {
    const decodedOwnerId = Schema.decodeUnknownResult(ReplicatedOwnerIdSchema, strictParseOptions)(registration.ownerId)
    if (Result.isFailure(decodedOwnerId)) {
      return Result.fail(malformedFrame('owner registration contains an invalid owner ID'))
    }

    const ownerId = decodedOwnerId.success
    if (schemas.has(ownerId)) {
      return Result.fail(malformedFrame(`duplicate replicated owner registration: ${ownerId}`))
    }

    schemas.set(ownerId, registration.schema)
  }

  const registry: ReplicatedOwnerRegistry = { [ownerRegistryBrand]: true }
  Object.freeze(registry)
  ownerSchemasByRegistry.set(registry, schemas)
  return Result.succeed(registry)
}

const utf8ByteLength = (text: string): number => {
  let bytes = 0
  for (let index = 0; index < text.length; index += 1) {
    const codeUnit = text.charCodeAt(index)
    if (codeUnit <= 0x7f) {
      bytes += 1
    } else if (codeUnit <= 0x7ff) {
      bytes += 2
    } else if (codeUnit >= 0xd800 && codeUnit <= 0xdbff && index + 1 < text.length) {
      const next = text.charCodeAt(index + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4
        index += 1
      } else {
        bytes += 3
      }
    } else {
      bytes += 3
    }

  }
  return bytes
}

/** Count UTF-8 bytes, matching the byte accounting used by frame validation. */
export const wireFrameByteLength = (text: WireText): number => utf8ByteLength(text)

type JsonScanContainer = {
  kind: 'object' | 'array'
  state: 'key-or-end' | 'key' | 'colon' | 'value' | 'value-or-end' | 'comma-or-end'
  key: string | undefined
  root: boolean
  rootMessageBody: boolean
}

const isJsonWhitespace = (codeUnit: number): boolean =>
  codeUnit === 0x20 || codeUnit === 0x09 || codeUnit === 0x0a || codeUnit === 0x0d

const skipJsonWhitespace = (text: string, start: number): number => {
  let index = start
  while (index < text.length && isJsonWhitespace(text.charCodeAt(index))) {
    index += 1
  }
  return index
}

const hexDigitValue = (codeUnit: number): number | undefined => {
  if (codeUnit >= 0x30 && codeUnit <= 0x39) return codeUnit - 0x30
  if (codeUnit >= 0x41 && codeUnit <= 0x46) return codeUnit - 0x41 + 10
  if (codeUnit >= 0x61 && codeUnit <= 0x66) return codeUnit - 0x61 + 10
  return undefined
}

const readJsonString = (
  text: string,
  start: number,
  captureValue: boolean,
): { readonly value: string | undefined; readonly end: number } | undefined => {
  if (text.charCodeAt(start) !== 0x22) return undefined

  let value = ''
  let index = start + 1
  while (index < text.length) {
    const codeUnit = text.charCodeAt(index)
    if (codeUnit === 0x22) {
      return { value: captureValue ? value : undefined, end: index + 1 }
    }
    if (codeUnit < 0x20) return undefined

    if (codeUnit !== 0x5c) {
      if (captureValue) value += text[index]
      index += 1
      continue
    }

    index += 1
    const escape = text.charCodeAt(index)
    const escaped = escape === 0x22 || escape === 0x5c || escape === 0x2f
      ? String.fromCharCode(escape)
      : escape === 0x62
        ? '\b'
        : escape === 0x66
          ? '\f'
          : escape === 0x6e
            ? '\n'
            : escape === 0x72
              ? '\r'
              : escape === 0x74
                ? '\t'
                : undefined
    if (escaped !== undefined) {
      if (captureValue) value += escaped
      index += 1
      continue
    }
    if (escape !== 0x75 || index + 4 >= text.length) return undefined

    const first = hexDigitValue(text.charCodeAt(index + 1))
    const second = hexDigitValue(text.charCodeAt(index + 2))
    const third = hexDigitValue(text.charCodeAt(index + 3))
    const fourth = hexDigitValue(text.charCodeAt(index + 4))
    if (first === undefined || second === undefined || third === undefined || fourth === undefined) return undefined
    if (captureValue) value += String.fromCharCode(first * 0x1000 + second * 0x100 + third * 0x10 + fourth)
    index += 5
  }

  return undefined
}

const readJsonNumberEnd = (text: string, start: number): number | undefined => {
  let index = start
  if (text.charCodeAt(index) === 0x2d) index += 1

  const firstDigit = text.charCodeAt(index)
  if (firstDigit === 0x30) {
    index += 1
    const next = text.charCodeAt(index)
    if (next >= 0x30 && next <= 0x39) return undefined
  } else if (firstDigit >= 0x31 && firstDigit <= 0x39) {
    index += 1
    while (text.charCodeAt(index) >= 0x30 && text.charCodeAt(index) <= 0x39) index += 1
  } else {
    return undefined
  }

  if (text.charCodeAt(index) === 0x2e) {
    index += 1
    const fractionStart = index
    while (text.charCodeAt(index) >= 0x30 && text.charCodeAt(index) <= 0x39) index += 1
    if (index === fractionStart) return undefined
  }

  const exponent = text.charCodeAt(index)
  if (exponent === 0x65 || exponent === 0x45) {
    index += 1
    const sign = text.charCodeAt(index)
    if (sign === 0x2b || sign === 0x2d) index += 1
    const exponentStart = index
    while (text.charCodeAt(index) >= 0x30 && text.charCodeAt(index) <= 0x39) index += 1
    if (index === exponentStart) return undefined
  }

  return index
}

// This bounded lexical pass finds the envelope tag without constructing the parsed payload.
const scanRootMessageTag = (text: string): string | undefined => {
  let index = skipJsonWhitespace(text, 0)
  if (text.charCodeAt(index) !== 0x7b) return undefined
  index += 1

  const stack: Array<JsonScanContainer> = [{
    kind: 'object',
    state: 'key-or-end',
    key: undefined,
    root: true,
    rootMessageBody: false,
  }]
  let messageTag: string | undefined

  while (stack.length > 0) {
    index = skipJsonWhitespace(text, index)
    if (index >= text.length) return undefined

    const container = stack[stack.length - 1]
    if (container === undefined) return undefined
    const codeUnit = text.charCodeAt(index)

    if (container.kind === 'object' && (container.state === 'key-or-end' || container.state === 'key')) {
      if (container.state === 'key-or-end' && codeUnit === 0x7d) {
        stack.pop()
        index += 1
        if (stack.length === 0) return skipJsonWhitespace(text, index) === text.length ? messageTag : undefined
        continue
      }
      const key = readJsonString(text, index, true)
      if (key === undefined || key.value === undefined) return undefined
      container.key = key.value
      container.state = 'colon'
      index = key.end
      continue
    }

    if (container.kind === 'object' && container.state === 'colon') {
      if (codeUnit !== 0x3a) return undefined
      container.state = 'value'
      index += 1
      continue
    }

    if (container.kind === 'object' && container.state === 'value') {
      const isRootMessageValue = container.root && container.key === 'message'
      const isMessageTagValue = container.rootMessageBody && container.key === '_tag'
      if (isRootMessageValue || isMessageTagValue) messageTag = undefined
      container.state = 'comma-or-end'
      container.key = undefined

      if (codeUnit === 0x7b) {
        stack.push({
          kind: 'object',
          state: 'key-or-end',
          key: undefined,
          root: false,
          rootMessageBody: isRootMessageValue,
        })
        index += 1
        continue
      }
      if (codeUnit === 0x5b) {
        stack.push({
          kind: 'array',
          state: 'value-or-end',
          key: undefined,
          root: false,
          rootMessageBody: false,
        })
        index += 1
        continue
      }
      if (codeUnit === 0x22) {
        const value = readJsonString(text, index, isMessageTagValue)
        if (value === undefined) return undefined
        if (isMessageTagValue) messageTag = value.value
        index = value.end
        continue
      }
      const literal = text.startsWith('true', index)
        ? 'true'
        : text.startsWith('false', index)
          ? 'false'
          : text.startsWith('null', index)
            ? 'null'
            : undefined
      if (literal !== undefined) {
        index += literal.length
        continue
      }
      const numberEnd = readJsonNumberEnd(text, index)
      if (numberEnd === undefined) return undefined
      index = numberEnd
      continue
    }

    if (container.kind === 'array' && (container.state === 'value-or-end' || container.state === 'value')) {
      if (container.state === 'value-or-end' && codeUnit === 0x5d) {
        stack.pop()
        index += 1
        if (stack.length === 0) return skipJsonWhitespace(text, index) === text.length ? messageTag : undefined
        continue
      }
      container.state = 'comma-or-end'
      if (codeUnit === 0x7b) {
        stack.push({ kind: 'object', state: 'key-or-end', key: undefined, root: false, rootMessageBody: false })
        index += 1
        continue
      }
      if (codeUnit === 0x5b) {
        stack.push({ kind: 'array', state: 'value-or-end', key: undefined, root: false, rootMessageBody: false })
        index += 1
        continue
      }
      if (codeUnit === 0x22) {
        const value = readJsonString(text, index, false)
        if (value === undefined) return undefined
        index = value.end
        continue
      }
      const literal = text.startsWith('true', index)
        ? 'true'
        : text.startsWith('false', index)
          ? 'false'
          : text.startsWith('null', index)
            ? 'null'
            : undefined
      if (literal !== undefined) {
        index += literal.length
        continue
      }
      const numberEnd = readJsonNumberEnd(text, index)
      if (numberEnd === undefined) return undefined
      index = numberEnd
      continue
    }

    if (container.state === 'comma-or-end') {
      if (container.kind === 'object' && codeUnit === 0x7d || container.kind === 'array' && codeUnit === 0x5d) {
        stack.pop()
        index += 1
        if (stack.length === 0) return skipJsonWhitespace(text, index) === text.length ? messageTag : undefined
        continue
      }
      if (codeUnit !== 0x2c) return undefined
      container.state = container.kind === 'object' ? 'key' : 'value'
      index += 1
      continue
    }

    return undefined
  }

  return undefined
}

const globalFrameSizeFailure = (text: string): ProtocolError | undefined => {
  if (text.length > MAX_FRAME_CODE_UNITS) {
    return frameTooLarge(`frame UTF-16 code units ${text.length} exceed limit ${MAX_FRAME_CODE_UNITS}`)
  }
  const bytes = utf8ByteLength(text)
  if (bytes > MAX_FRAME_UTF8_BYTES) {
    return frameTooLarge(`frame UTF-8 bytes ${bytes} exceed limit ${MAX_FRAME_UTF8_BYTES}`)
  }
  return undefined
}

const legacyFrameSizeFailure = (text: string, tag: string | undefined): ProtocolError | undefined => {
  if (tag === undefined) return undefined
  const bytes = utf8ByteLength(text)
  const limits = legacyFrameLimits.get(tag)
  if (limits !== undefined && bytes > limits.utf8Bytes) {
    return frameTooLarge(`${tag} frame UTF-8 bytes ${bytes} exceed limit ${limits.utf8Bytes}`)
  }
  if (limits !== undefined && text.length > limits.codeUnits) {
    return frameTooLarge(`${tag} frame UTF-16 code units ${text.length} exceed limit ${limits.codeUnits}`)
  }
  return undefined
}

const frameSizeFailure = (text: string): ProtocolError | undefined => {
  const globalFailure = globalFrameSizeFailure(text)
  if (globalFailure !== undefined) return globalFailure
  const tag = scanRootMessageTag(text)
  return legacyFrameSizeFailure(text, tag)
}

const validateOwnerChanges = (
  changes: ReadonlyArray<ReplicatedOwnerChange>,
  registry: ReplicatedOwnerRegistry | undefined,
  direction: 'decode' | 'encode',
): Result.Result<ReadonlyArray<ReplicatedOwnerChange>, ProtocolError> => {
  const schemas = registry === undefined ? undefined : ownerSchemasByRegistry.get(registry)
  if (schemas === undefined) {
    return Result.fail(malformedFrame('C4 owner state requires a replicated owner registry'))
  }

  const seen = new Set<ReplicatedOwnerId>()
  const validated: Array<ReplicatedOwnerChange> = []
  for (const change of changes) {
    if (seen.has(change.owner)) {
      return Result.fail(malformedFrame(`duplicate owner change in C4 group: ${change.owner}`))
    }
    seen.add(change.owner)

    const schema = schemas.get(change.owner)
    if (schema === undefined) {
      return Result.fail(malformedFrame(`unknown replicated owner: ${change.owner}`))
    }

    const state = direction === 'decode'
      ? Schema.decodeUnknownResult(schema, strictParseOptions)(change.state)
      : Schema.encodeUnknownResult(schema, strictParseOptions)(change.state)
    if (Result.isFailure(state)) {
      return Result.fail(malformedFrame(`invalid state for replicated owner ${change.owner}: ${state.failure.message}`))
    }

    validated.push({ owner: change.owner, state: state.success })
  }

  return Result.succeed(validated)
}

const validateOwnerStates = (
  message: NetworkMessageType,
  registry: ReplicatedOwnerRegistry | undefined,
  direction: 'decode' | 'encode',
): Result.Result<NetworkMessageType, ProtocolError> => {
  if (message._tag === 'ReplicatedWorldDelta') {
    return Result.map(validateOwnerChanges(message.changes, registry, direction), (changes) => ({ ...message, changes }))
  }
  if (message._tag === 'ReplicatedWorldSnapshot') {
    return Result.map(validateOwnerChanges(message.owners, registry, direction), (owners) => ({ ...message, owners }))
  }
  return Result.succeed(message)
}

/** The stable envelope decoded before inspecting a version-specific message. */
const WireEnvelope = Schema.fromJsonString(
  // eslint-disable-next-line new-cap
  Schema.Struct({
    message: Schema.Unknown,
    protocolVersion: Schema.Number.pipe(Schema.check(Schema.isInt())),
  }),
)

const decodeWireEnvelope = Schema.decodeUnknownResult(WireEnvelope, strictParseOptions)
const decodeNetworkMessageIgnoringUnknownRootFields = Schema.decodeUnknownResult(NetworkMessage)
const decodeNetworkMessageStrict = Schema.decodeUnknownResult(NetworkMessage, strictParseOptions)
const encodeWireFrame = Schema.encodeUnknownResult(WireFrame, strictParseOptions)

const validateStrictMessage = (input: unknown, value: NetworkMessageType) => {
  if (!isRecord(input) || strictRootMessageTags.has(value._tag)) {
    return decodeNetworkMessageStrict(input)
  }

  // Root fields stay open for forward-compatible messages; nested object shapes are versioned.
  const strictInput = Object.fromEntries(Object.entries(input).filter(([key]) => Object.hasOwn(value, key)))
  return decodeNetworkMessageStrict(strictInput)
}

const decodeNetworkMessage = (
  input: unknown,
  owners?: ReplicatedOwnerRegistry,
): Result.Result<NetworkMessageType, ProtocolError> => {
  const decoded = decodeNetworkMessageIgnoringUnknownRootFields(input)
  if (Result.isFailure(decoded)) {
    return Result.fail(malformedFrame(decoded.failure.message))
  }

  const strict = validateStrictMessage(input, decoded.success)
  if (Result.isFailure(strict)) {
    return Result.fail(malformedFrame(strict.failure.message))
  }

  return validateOwnerStates(strict.success, owners, 'decode')
}

const unsupportedProtocolVersion = (protocolVersion: number): ProtocolError =>
  new ProtocolError({
    detail:
      `peer speaks protocol version ${String(protocolVersion)}, ` +
      `this build speaks ${String(PROTOCOL_VERSION)}`,
    reason: 'unsupported-protocol-version',
  })

/** Identify a v10 C4 tag before its body is decoded, for resync classification. */
export const inspectReplicatedFrameTag = (
  text: WireText,
): Result.Result<ReplicatedFrameTag | undefined, ProtocolError> => {
  const globalSizeFailure = globalFrameSizeFailure(text)
  if (globalSizeFailure !== undefined) {
    return Result.fail(globalSizeFailure)
  }

  const rootTag = scanRootMessageTag(text)
  const envelopeResult = decodeWireEnvelope(text)
  if (Result.isFailure(envelopeResult)) {
    return Result.fail(malformedFrame(envelopeResult.failure.message))
  }

  const envelope = envelopeResult.success
  if (envelope.protocolVersion !== PROTOCOL_VERSION) {
    return Result.fail(unsupportedProtocolVersion(envelope.protocolVersion))
  }

  if (!isRecord(envelope.message)) {
    return Result.succeed(undefined)
  }

  switch (envelope.message['_tag']) {
    case 'ReplicatedWorldDelta':
    case 'ReplicatedWorldSnapshot':
    case 'ReplicatedWorldSnapshotStart':
    case 'ReplicatedWorldSnapshotChunk':
    case 'ReplicatedWorldSnapshotEnd':
      return Result.succeed(envelope.message['_tag'])
    default: {
      const sizeFailure = legacyFrameSizeFailure(text, rootTag)
      return sizeFailure === undefined ? Result.succeed(undefined) : Result.fail(sizeFailure)
    }
  }
}

/**
 * Encode a message at an explicit protocol version.
 *
 * Exists so that tests can forge a frame from a version this build does not
 * speak — the only way to prove the version check actually rejects rather than
 * best-effort parses. Production code calls `encodeFrame`.
 */
export const encodeFrameAsVersion = (
  protocolVersion: number,
  message: unknown,
  owners?: ReplicatedOwnerRegistry,
): Result.Result<WireText, ProtocolError> => {
  const decoded = Schema.decodeUnknownResult(NetworkMessage, strictParseOptions)(message)
  if (Result.isFailure(decoded)) {
    return Result.fail(new ProtocolError({ detail: decoded.failure.message, reason: 'unencodable-message' }))
  }

  const ownerEncoded = validateOwnerStates(decoded.success, owners, 'encode')
  if (Result.isFailure(ownerEncoded)) {
    return Result.fail(new ProtocolError({ detail: ownerEncoded.failure.message, reason: 'unencodable-message' }))
  }

  const encoded = encodeWireFrame({ message: ownerEncoded.success, protocolVersion })
  if (Result.isFailure(encoded)) {
    return Result.fail(new ProtocolError({ detail: encoded.failure.message, reason: 'unencodable-message' }))
  }

  const sizeFailure = frameSizeFailure(encoded.success)
  return sizeFailure === undefined ? Result.succeed(encoded.success) : Result.fail(sizeFailure)
}

/** Encode a runtime value into a frame at this build's protocol version. */
export const encodeFrame = (
  message: unknown,
  owners?: ReplicatedOwnerRegistry,
): Result.Result<WireText, ProtocolError> =>
  encodeFrameAsVersion(PROTOCOL_VERSION, message, owners)

/**
 * Decode a frame.
 *
 * Two distinct failures, never merged:
 *
 * - `malformed-frame` — the text is not JSON, or is JSON that is not a frame,
 *   or carries a message tag this build does not know. Drop it.
 * - `unsupported-protocol-version` — it IS a frame, and it is from a peer this
 *   build cannot talk to. Drop the *peer*, and say so to the user.
 *
 * The stable envelope is decoded first, with its message left opaque. This lets
 * an older build reject a future protocol version without trying to understand
 * that version's message schema. Only a supported version reaches the
 * `NetworkMessage` decoder.
 */
export const decodeFrame = (
  text: WireText,
  owners?: ReplicatedOwnerRegistry,
): Result.Result<NetworkMessageType, ProtocolError> => {
  const sizeFailure = frameSizeFailure(text)
  if (sizeFailure !== undefined) {
    return Result.fail(sizeFailure)
  }

  const envelopeResult = decodeWireEnvelope(text)
  if (Result.isFailure(envelopeResult)) {
    return Result.fail(malformedFrame(envelopeResult.failure.message))
  }

  const envelope = envelopeResult.success
  if (envelope.protocolVersion !== PROTOCOL_VERSION) {
    return Result.fail(unsupportedProtocolVersion(envelope.protocolVersion))
  }

  return decodeNetworkMessage(envelope.message, owners)
}

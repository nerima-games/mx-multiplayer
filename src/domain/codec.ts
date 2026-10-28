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
  NetworkMessage,
  type NetworkMessage as NetworkMessageType,
  PROTOCOL_VERSION,
} from './protocol.js'
import {
  type ReplicatedOwnerChange,
  type ReplicatedOwnerId,
  ReplicatedOwnerIdSchema,
  type ReplicatedOwnerRegistration,
} from '@nerima-games/mc-sim'
import { Result, Schema } from 'effect'
import { ProtocolError } from './errors.js'

/**
 * One frame, as text. Exactly one message; framing multiple messages into a
 * single socket write is a transport concern, not a protocol one.
 */
export type WireText = string

const MAX_FRAME_CODE_UNITS = 1_048_576
const MAX_FRAME_UTF8_BYTES = 4_194_304
const MAX_JSON_DEPTH = 13
const MAX_JSON_COLLECTION_ITEMS = 31_149
const ZERO = 0
const ONE = 1
const TWO = 2
const THREE = 3
const FOUR = 4
const FIVE = 5
const SIX = 6
const TEN = 10
const JSON_CHAR = {
  backslash: 0x5c,
  carriageReturn: 0x0d,
  closeBrace: 0x7d,
  closeBracket: 0x5d,
  colon: 0x3a,
  comma: 0x2c,
  decimalPoint: 0x2e,
  digitNine: 0x39,
  digitOne: 0x31,
  digitZero: 0x30,
  escapeBackspace: 0x62,
  escapeFormFeed: 0x66,
  escapeLineFeed: 0x6e,
  escapeReturn: 0x72,
  escapeSlash: 0x2f,
  escapeTab: 0x74,
  escapeUnicode: 0x75,
  exponentLower: 0x65,
  exponentUpper: 0x45,
  lineFeed: 0x0a,
  minus: 0x2d,
  openBrace: 0x7b,
  openBracket: 0x5b,
  plus: 0x2b,
  quote: 0x22,
  space: 0x20,
  tab: 0x09,
} as const
const HEX_CHAR = {
  digitNine: 0x39,
  digitZero: 0x30,
  lowerA: 0x61,
  lowerF: 0x66,
  upperA: 0x41,
  upperF: 0x46,
} as const
const UNICODE_SURROGATE = {
  highEnd: 0xdbff,
  highStart: 0xd800,
  lowEnd: 0xdfff,
  lowStart: 0xdc00,
} as const
const UTF8_CODE_UNIT_LIMITS = {
  ascii: 0x7f,
  twoByte: 0x7ff,
} as const
const UNICODE_HEX_SHIFTS = {
  fourThousandNinetySix: 0x1000,
  one: ONE,
  sixteen: 0x10,
  twoHundredFiftySix: 0x100,
} as const
type LegacyFrameLimit = Readonly<{ codeUnits: number; utf8Bytes: number }>
const legacyFrameLimitEntries: ReadonlyArray<readonly [NetworkMessage['_tag'], LegacyFrameLimit]> = [
  ['PlayerDamageCommand', { codeUnits: 1_024, utf8Bytes: 4_096 }],
  ['CraftingCommand', { codeUnits: 1_024, utf8Bytes: 4_096 }],
  ['BrewingCommand', { codeUnits: 8_192, utf8Bytes: 32_768 }],
  ['AnvilCommand', { codeUnits: 2_048, utf8Bytes: 8_192 }],
  ['EnchantingCommand', { codeUnits: 32_768, utf8Bytes: 131_072 }],
  ['SummonWitherCommand', { codeUnits: 1_048_576, utf8Bytes: 4_194_304 }],
  ['DamageWitherCommand', { codeUnits: 1_048_576, utf8Bytes: 4_194_304 }],
  ['DamageEnderDragonCommand', { codeUnits: 16_384, utf8Bytes: 65_536 }],
]
const legacyFrameLimits: ReadonlyMap<string, LegacyFrameLimit> = new Map(legacyFrameLimitEntries)
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

const isJsonWhitespace = (codeUnit: number): boolean =>
  codeUnit === JSON_CHAR.carriageReturn ||
  codeUnit === JSON_CHAR.lineFeed ||
  codeUnit === JSON_CHAR.space ||
  codeUnit === JSON_CHAR.tab

const ownerRegistryBrand: unique symbol = Symbol('ReplicatedOwnerRegistry')
export type ReplicatedOwnerRegistry = Readonly<{ [ownerRegistryBrand]: true }>

export type ReplicatedOwnerStateBounds = Readonly<{
  ownerId: ReplicatedOwnerId
  maxStateBytes: number
  maxStateDepth: number
  maxCollectionItems: number
}>

export type ReplicatedOwnerRegistryLimits = Readonly<{
  maxRegisteredOwners: number
  maxDeltaBlockChanges: number
  maxSnapshotBlockReads: number
  maxDepth: number
  maxCollectionItems: number
  maxDeltaFrameBytes: number
  maxSnapshotFrameBytes: number
  ownerStates: ReadonlyArray<ReplicatedOwnerStateBounds>
}>

type ReplicatedOwnerRegistryEntry = Readonly<{
  schemas: ReadonlyMap<ReplicatedOwnerId, OwnerStateCodec>
  bounds: ReadonlyMap<ReplicatedOwnerId, ReplicatedOwnerStateBounds>
  limits: ReplicatedOwnerRegistryLimits
}>

export type ReplicatedFrameTag =
  | 'ReplicatedWorldDelta'
  | 'ReplicatedWorldSnapshot'
  | 'ReplicatedWorldSnapshotStart'
  | 'ReplicatedWorldSnapshotChunk'
  | 'ReplicatedWorldSnapshotEnd'

type OwnerStateCodec = Schema.Codec<any, any>
const ownerSchemasByRegistry = new WeakMap<
  ReplicatedOwnerRegistry,
  ReplicatedOwnerRegistryEntry
>()

const malformedFrame = (detail: string): ProtocolError =>
  new ProtocolError({ detail, reason: 'malformed-frame' })

const frameTooLarge = (detail: string): ProtocolError =>
  new ProtocolError({ detail, reason: 'frame-too-large' })

const isPositiveSafeInteger = (value: number): boolean => Number.isSafeInteger(value) && value > ZERO
const isNonNegativeSafeInteger = (value: number): boolean => Number.isSafeInteger(value) && value >= ZERO

const hasValidRegistryLimits = (limits: ReplicatedOwnerRegistryLimits, registrationCount: number): boolean =>
  isNonNegativeSafeInteger(limits.maxRegisteredOwners) &&
  registrationCount <= limits.maxRegisteredOwners &&
  isNonNegativeSafeInteger(limits.maxDeltaBlockChanges) &&
  isNonNegativeSafeInteger(limits.maxSnapshotBlockReads) &&
  isPositiveSafeInteger(limits.maxDepth) &&
  limits.maxDepth <= MAX_JSON_DEPTH &&
  isPositiveSafeInteger(limits.maxCollectionItems) &&
  limits.maxCollectionItems <= MAX_JSON_COLLECTION_ITEMS &&
  isPositiveSafeInteger(limits.maxDeltaFrameBytes) &&
  limits.maxDeltaFrameBytes <= MAX_FRAME_UTF8_BYTES &&
  isPositiveSafeInteger(limits.maxSnapshotFrameBytes)

const buildOwnerBounds = (
  ownerStates: ReplicatedOwnerRegistryLimits['ownerStates'],
): Map<ReplicatedOwnerId, ReplicatedOwnerStateBounds> | undefined => {
  const bounds = new Map<ReplicatedOwnerId, ReplicatedOwnerStateBounds>()
  for (const ownerBounds of ownerStates) {
    const isValid = isPositiveSafeInteger(ownerBounds.maxStateBytes) &&
      isPositiveSafeInteger(ownerBounds.maxStateDepth) &&
      isPositiveSafeInteger(ownerBounds.maxCollectionItems) &&
      !bounds.has(ownerBounds.ownerId)
    if (!isValid) {
      return undefined
    }
    bounds.set(ownerBounds.ownerId, ownerBounds)
  }
  return bounds
}

type OwnerSchemaBuildContext = Readonly<{
  bounds: ReadonlyMap<ReplicatedOwnerId, ReplicatedOwnerStateBounds>
  schemas: Map<ReplicatedOwnerId, OwnerStateCodec>
}>

const addOwnerSchema = (
  registration: ReplicatedOwnerRegistration,
  context: OwnerSchemaBuildContext,
): Result.Result<void, ProtocolError> => {
  const decodedOwnerId = Schema.decodeUnknownResult(ReplicatedOwnerIdSchema, strictParseOptions)(registration.ownerId)
  if (Result.isFailure(decodedOwnerId)) {
    return Result.fail(malformedFrame('owner registration contains an invalid owner ID'))
  }
  const ownerId = decodedOwnerId.success
  if (context.schemas.has(ownerId)) {
    return Result.fail(malformedFrame(`duplicate replicated owner registration: ${ownerId}`))
  }
  if (!context.bounds.has(ownerId)) {
    return Result.fail(malformedFrame(`missing replicated owner state limits: ${ownerId}`))
  }
  context.schemas.set(ownerId, registration.schema)
  return Result.succeed(undefined)
}

const buildOwnerSchemas = (
  registrations: ReadonlyArray<ReplicatedOwnerRegistration>,
  bounds: ReadonlyMap<ReplicatedOwnerId, ReplicatedOwnerStateBounds>,
): Result.Result<Map<ReplicatedOwnerId, OwnerStateCodec>, ProtocolError> => {
  const context: OwnerSchemaBuildContext = { bounds, schemas: new Map() }
  for (const registration of registrations) {
    const result = addOwnerSchema(registration, context)
    if (Result.isFailure(result)) {
      return Result.fail(result.failure)
    }
  }
  return Result.succeed(context.schemas)
}

const createOwnerRegistry = (
  registrations: ReadonlyArray<ReplicatedOwnerRegistration>,
  limits: ReplicatedOwnerRegistryLimits,
  bounds: ReadonlyMap<ReplicatedOwnerId, ReplicatedOwnerStateBounds>,
): Result.Result<ReplicatedOwnerRegistry, ProtocolError> => {
  const schemaResult = buildOwnerSchemas(registrations, bounds)
  if (Result.isFailure(schemaResult)) {
    return Result.fail(schemaResult.failure)
  }
  const schemas = schemaResult.success
  if (bounds.size !== schemas.size) {
    return Result.fail(malformedFrame('replicated owner state limits do not match registrations'))
  }
  const registry: ReplicatedOwnerRegistry = { [ownerRegistryBrand]: true }
  Object.freeze(registry)
  ownerSchemasByRegistry.set(registry, { bounds, limits, schemas })
  return Result.succeed(registry)
}

/** Build the finite owner-to-state-schema table used by C4 frame codecs. */
export const createReplicatedOwnerRegistry = (
  registrations: ReadonlyArray<ReplicatedOwnerRegistration>,
  limits: ReplicatedOwnerRegistryLimits,
): Result.Result<ReplicatedOwnerRegistry, ProtocolError> => {
  if (!hasValidRegistryLimits(limits, registrations.length)) {
    return Result.fail(malformedFrame('replicated owner limits contain an invalid bound'))
  }
  const bounds = buildOwnerBounds(limits.ownerStates)
  if (bounds === undefined) {
    return Result.fail(malformedFrame('replicated owner state limits contain an invalid or duplicate bound'))
  }
  return createOwnerRegistry(registrations, limits, bounds)
}

const utf8ByteLength = (text: string): number => {
  let bytes = ZERO
  for (let index = ZERO; index < text.length; index += ONE) {
    const codeUnit = text.charCodeAt(index)
    if (codeUnit <= UTF8_CODE_UNIT_LIMITS.ascii) {
      bytes += ONE
    } else if (codeUnit <= UTF8_CODE_UNIT_LIMITS.twoByte) {
      bytes += TWO
    } else if (
      codeUnit >= UNICODE_SURROGATE.highStart &&
      codeUnit <= UNICODE_SURROGATE.highEnd &&
      index + ONE < text.length &&
      text.charCodeAt(index + ONE) >= UNICODE_SURROGATE.lowStart &&
      text.charCodeAt(index + ONE) <= UNICODE_SURROGATE.lowEnd
    ) {
      bytes += FOUR
      index += ONE
    } else {
      bytes += THREE
    }
  }
  return bytes
}

/** Count UTF-8 bytes, matching the byte accounting used by frame validation. */
export const wireFrameByteLength = (text: WireText): number => utf8ByteLength(text)

type JsonScanContainerBase = {
  root: boolean
  rootMessageBody: boolean
  entries: number
}
type JsonScanObjectContainer = JsonScanContainerBase & {
  kind: 'object'
  state: 'key-or-end' | 'key' | 'colon' | 'value' | 'comma-or-end'
  key: string | undefined
}
type JsonScanArrayContainer = JsonScanContainerBase & {
  kind: 'array'
  state: 'value-or-end' | 'value' | 'comma-or-end'
}
type JsonScanContainer = JsonScanObjectContainer | JsonScanArrayContainer

type JsonScanMetrics = { maxDepth: number; maxCollectionItems: number; exceeded: boolean }
type JsonScanState = { messageTag: string | undefined }
type JsonScanContext = Readonly<{
  metrics: JsonScanMetrics
  stack: Array<JsonScanContainer>
  state: JsonScanState
  text: string
}>

const skipJsonWhitespace = (text: string, start: number): number => {
  let index = start
  while (index < text.length && isJsonWhitespace(text.charCodeAt(index))) {
    index += ONE
  }
  return index
}

const hexDigitValue = (codeUnit: number): number | undefined => {
  if (codeUnit >= HEX_CHAR.digitZero && codeUnit <= HEX_CHAR.digitNine) {
    return codeUnit - HEX_CHAR.digitZero
  }
  if (codeUnit >= HEX_CHAR.upperA && codeUnit <= HEX_CHAR.upperF) {
    return codeUnit - HEX_CHAR.upperA + TEN
  }
  if (codeUnit >= HEX_CHAR.lowerA && codeUnit <= HEX_CHAR.lowerF) {
    return codeUnit - HEX_CHAR.lowerA + TEN
  }
  return undefined
}

type JsonStringRead = Readonly<{ end: number; value: string | undefined }>
type JsonStringStep = Readonly<{ addition: string | undefined; closed: boolean; end: number }>

const simpleJsonEscape = (codeUnit: number): string | undefined => {
  switch (codeUnit) {
    case JSON_CHAR.quote:
      return '"'
    case JSON_CHAR.backslash:
      return '\\'
    case JSON_CHAR.escapeSlash:
      return '/'
    case JSON_CHAR.escapeBackspace:
      return '\b'
    case JSON_CHAR.escapeFormFeed:
      return '\f'
    case JSON_CHAR.escapeLineFeed:
      return '\n'
    case JSON_CHAR.escapeReturn:
      return '\r'
    case JSON_CHAR.escapeTab:
      return '\t'
    default:
      return undefined
  }
}

const readUnicodeEscape = (text: string, start: number): string | undefined => {
  const first = hexDigitValue(text.charCodeAt(start + TWO))
  const second = hexDigitValue(text.charCodeAt(start + THREE))
  const third = hexDigitValue(text.charCodeAt(start + FOUR))
  const fourth = hexDigitValue(text.charCodeAt(start + FIVE))
  if (first === undefined || second === undefined || third === undefined || fourth === undefined) {
    return undefined
  }
  const codeUnit = first * UNICODE_HEX_SHIFTS.fourThousandNinetySix +
    second * UNICODE_HEX_SHIFTS.twoHundredFiftySix +
    third * UNICODE_HEX_SHIFTS.sixteen +
    fourth * UNICODE_HEX_SHIFTS.one
  return String.fromCharCode(codeUnit)
}

const readJsonEscape = (text: string, start: number): JsonStringStep | undefined => {
  const escape = text.charCodeAt(start + ONE)
  if (escape === JSON_CHAR.escapeUnicode) {
    const addition = readUnicodeEscape(text, start)
    if (addition === undefined) {
      return undefined
    }
    return { addition, closed: false, end: start + SIX }
  }
  const addition = simpleJsonEscape(escape)
  if (addition === undefined) {
    return undefined
  }
  return { addition, closed: false, end: start + TWO }
}

const readJsonStringStep = (text: string, index: number): JsonStringStep | undefined => {
  const codeUnit = text.charCodeAt(index)
  if (codeUnit === JSON_CHAR.quote) {
    return { addition: undefined, closed: true, end: index + ONE }
  }
  if (codeUnit < JSON_CHAR.space) {
    return undefined
  }
  if (codeUnit === JSON_CHAR.backslash) {
    return readJsonEscape(text, index)
  }
  return { addition: text[index], closed: false, end: index + ONE }
}

const finishJsonStringRead = (step: JsonStringStep, value: string, captureValue: boolean): JsonStringRead => {
  if (captureValue) {
    return { end: step.end, value }
  }
  return { end: step.end, value: undefined }
}

const appendJsonStringStep = (value: string, step: JsonStringStep, captureValue: boolean): string => {
  if (captureValue && step.addition !== undefined) {
    return value + step.addition
  }
  return value
}

const readJsonStringBody = (text: string, start: number, captureValue: boolean): JsonStringRead | undefined => {
  const cursor = { index: start, value: '' }
  while (cursor.index < text.length) {
    const step = readJsonStringStep(text, cursor.index)
    if (step === undefined) {
      return undefined
    }
    if (step.closed) {
      return finishJsonStringRead(step, cursor.value, captureValue)
    }
    cursor.value = appendJsonStringStep(cursor.value, step, captureValue)
    cursor.index = step.end
  }
  return undefined
}

const readJsonString = (
  text: string,
  start: number,
  captureValue: boolean,
): JsonStringRead | undefined => {
  if (text.charCodeAt(start) !== JSON_CHAR.quote) {
    return undefined
  }
  return readJsonStringBody(text, start + ONE, captureValue)
}

const isDecimalDigit = (codeUnit: number): boolean =>
  codeUnit >= JSON_CHAR.digitZero && codeUnit <= JSON_CHAR.digitNine

const readDecimalDigitsEnd = (text: string, start: number): number => {
  let index = start
  while (isDecimalDigit(text.charCodeAt(index))) {
    index += ONE
  }
  return index
}

const readJsonIntegerDigitsEnd = (text: string, start: number): number | undefined => {
  const firstDigit = text.charCodeAt(start)
  if (firstDigit === JSON_CHAR.digitZero) {
    const next = text.charCodeAt(start + ONE)
    if (isDecimalDigit(next)) {
      return undefined
    }
    return start + ONE
  } else if (firstDigit >= JSON_CHAR.digitOne && firstDigit <= JSON_CHAR.digitNine) {
    return readDecimalDigitsEnd(text, start)
  }
  return undefined
}

const readJsonIntegerEnd = (text: string, start: number): number | undefined => {
  if (text.charCodeAt(start) === JSON_CHAR.minus) {
    return readJsonIntegerDigitsEnd(text, start + ONE)
  }
  return readJsonIntegerDigitsEnd(text, start)
}

const readJsonFractionEnd = (text: string, start: number): number | undefined => {
  if (text.charCodeAt(start) !== JSON_CHAR.decimalPoint) {
    return start
  }
  const index = start + ONE
  if (!isDecimalDigit(text.charCodeAt(index))) {
    return undefined
  }
  return readDecimalDigitsEnd(text, index)
}

const readJsonExponentEnd = (text: string, start: number): number | undefined => {
  const exponent = text.charCodeAt(start)
  if (exponent !== JSON_CHAR.exponentLower && exponent !== JSON_CHAR.exponentUpper) {
    return start
  }
  let index = start + ONE
  const sign = text.charCodeAt(index)
  if (sign === JSON_CHAR.plus || sign === JSON_CHAR.minus) {
    index += ONE
  }
  if (!isDecimalDigit(text.charCodeAt(index))) {
    return undefined
  }
  return readDecimalDigitsEnd(text, index)
}

const readJsonNumberEnd = (text: string, start: number): number | undefined => {
  const integerEnd = readJsonIntegerEnd(text, start)
  if (integerEnd === undefined) {
    return undefined
  }
  const fractionEnd = readJsonFractionEnd(text, integerEnd)
  if (fractionEnd === undefined) {
    return undefined
  }
  return readJsonExponentEnd(text, fractionEnd)
}

const createJsonContainer = <TContainer extends JsonScanContainer>(container: TContainer): TContainer => container

const recordCollectionEntry = (container: JsonScanContainer, metrics: JsonScanMetrics): boolean => {
  container.entries += ONE
  metrics.maxCollectionItems = Math.max(metrics.maxCollectionItems, container.entries)
  if (container.entries > MAX_JSON_COLLECTION_ITEMS) {
    metrics.exceeded = true
    return false
  }
  return true
}

const pushJsonContainer = (
  context: JsonScanContext,
  kind: JsonScanContainer['kind'],
  rootMessageBody: boolean,
): boolean => {
  const { metrics, stack } = context
  if (kind === 'object') {
    stack.push(createJsonContainer({
      entries: ZERO,
      key: undefined,
      kind,
      root: false,
      rootMessageBody,
      state: 'key-or-end',
    }))
  } else {
    stack.push(createJsonContainer({
      entries: ZERO,
      key: undefined,
      kind,
      root: false,
      rootMessageBody,
      state: 'value-or-end',
    }))
  }
  metrics.maxDepth = Math.max(metrics.maxDepth, stack.length)
  if (stack.length > MAX_JSON_DEPTH) {
    metrics.exceeded = true
    return false
  }
  return true
}

const readObjectKeyText = (context: JsonScanContext, index: number, container: JsonScanObjectContainer): number | undefined => {
  const { metrics, text } = context
  const key = readJsonString(text, index, true)
  if (key === undefined || key.value === undefined || !recordCollectionEntry(container, metrics)) {
    return undefined
  }
  container.key = key.value
  container.state = 'colon'
  return key.end
}

const readObjectKey = (context: JsonScanContext, index: number, container: JsonScanObjectContainer): number | undefined => {
  const codeUnit = context.text.charCodeAt(index)
  if (container.state === 'key-or-end' && codeUnit === JSON_CHAR.closeBrace) {
    context.stack.pop()
    return index + ONE
  }
  return readObjectKeyText(context, index, container)
}

const readObjectColon = (index: number, codeUnit: number, container: JsonScanObjectContainer): number | undefined => {
  if (codeUnit !== JSON_CHAR.colon) {
    return undefined
  }
  container.state = 'value'
  return index + ONE
}

const readJsonPrimitiveEnd = (text: string, index: number): number | undefined => {
  if (text.charCodeAt(index) === JSON_CHAR.quote) {
    const parsedString = readJsonString(text, index, false)
    if (parsedString === undefined) {
      return undefined
    }
    return parsedString.end
  }
  for (const literal of ['true', 'false', 'null']) {
    if (text.startsWith(literal, index)) {
      return index + literal.length
    }
  }
  return readJsonNumberEnd(text, index)
}

const readNestedContainerEnd = (
  context: JsonScanContext,
  index: number,
  container: JsonScanContainer,
): number | null | undefined => {
  const codeUnit = context.text.charCodeAt(index)
  const rootMessageBody = container.kind === 'object' && container.root && container.key === 'message'
  switch (codeUnit) {
    case JSON_CHAR.openBrace:
      if (!pushJsonContainer(context, 'object', rootMessageBody)) {
        return null
      }
      return index + ONE
    case JSON_CHAR.openBracket:
      if (!pushJsonContainer(context, 'array', false)) {
        return null
      }
      return index + ONE
    default:
      return undefined
  }
}

const readObjectStringValue = (context: JsonScanContext, index: number, isMessageTagValue: boolean): number | undefined => {
  const value = readJsonString(context.text, index, isMessageTagValue)
  if (value === undefined) {
    return undefined
  }
  if (isMessageTagValue) {
    context.state.messageTag = value.value
  }
  return value.end
}

const readJsonValueContent = (context: JsonScanContext, index: number, isMessageTagValue: boolean): number | undefined => {
  if (context.text.charCodeAt(index) === JSON_CHAR.quote) {
    return readObjectStringValue(context, index, isMessageTagValue)
  }
  return readJsonPrimitiveEnd(context.text, index)
}

const readObjectValueContent = (
  context: JsonScanContext,
  index: number,
  container: JsonScanObjectContainer,
): number | undefined => {
  const isRootMessageValue = container.root && container.key === 'message'
  const isMessageTagValue = container.rootMessageBody && container.key === '_tag'
  if (isRootMessageValue || isMessageTagValue) {
    context.state.messageTag = undefined
  }
  const nestedEnd = readNestedContainerEnd(context, index, container)
  if (nestedEnd === null) {
    return undefined
  }
  if (nestedEnd !== undefined) {
    return nestedEnd
  }
  return readJsonValueContent(context, index, isMessageTagValue)
}

const readObjectValue = (context: JsonScanContext, index: number, container: JsonScanObjectContainer): number | undefined => {
  container.state = 'comma-or-end'
  const result = readObjectValueContent(context, index, container)
  container.key = undefined
  return result
}

const readArrayValueContent = (
  context: JsonScanContext,
  index: number,
  container: JsonScanArrayContainer,
): number | undefined => {
  const nestedEnd = readNestedContainerEnd(context, index, container)
  if (nestedEnd === null) {
    return undefined
  }
  if (nestedEnd !== undefined) {
    return nestedEnd
  }
  return readJsonPrimitiveEnd(context.text, index)
}

const readArrayValue = (context: JsonScanContext, index: number, container: JsonScanArrayContainer): number | undefined => {
  const { metrics, stack, text } = context
  const codeUnit = text.charCodeAt(index)
  if (container.state === 'value-or-end' && codeUnit === JSON_CHAR.closeBracket) {
    stack.pop()
    return index + ONE
  }
  if (!recordCollectionEntry(container, metrics)) {
    return undefined
  }
  container.state = 'comma-or-end'
  return readArrayValueContent(context, index, container)
}

const isContainerClose = (container: JsonScanContainer, codeUnit: number): boolean => {
  if (container.kind === 'object') {
    return codeUnit === JSON_CHAR.closeBrace
  }
  return codeUnit === JSON_CHAR.closeBracket
}

const setContainerValueAfterComma = (container: JsonScanContainer): void => {
  if (container.kind === 'object') {
    container.state = 'key'
  } else {
    container.state = 'value'
  }
}

const readCommaOrEnd = (context: JsonScanContext, index: number, container: JsonScanContainer): number | undefined => {
  const codeUnit = context.text.charCodeAt(index)
  if (isContainerClose(container, codeUnit)) {
    context.stack.pop()
    return index + ONE
  }
  if (codeUnit !== JSON_CHAR.comma) {
    return undefined
  }
  setContainerValueAfterComma(container)
  return index + ONE
}

type JsonObjectScanStep = (
  context: JsonScanContext,
  index: number,
  container: JsonScanObjectContainer,
) => number | undefined
type JsonArrayScanStep = (
  context: JsonScanContext,
  index: number,
  container: JsonScanArrayContainer,
) => number | undefined

const JSON_OBJECT_SCAN_STEPS: Record<JsonScanObjectContainer['state'], JsonObjectScanStep> = {
  'key-or-end': readObjectKey,
  key: readObjectKey,
  colon: (context, index, container) => readObjectColon(index, context.text.charCodeAt(index), container),
  value: readObjectValue,
  'comma-or-end': readCommaOrEnd,
}
const JSON_ARRAY_SCAN_STEPS: Record<JsonScanArrayContainer['state'], JsonArrayScanStep> = {
  'value-or-end': readArrayValue,
  value: readArrayValue,
  'comma-or-end': readCommaOrEnd,
}

const advanceJsonObject = (context: JsonScanContext, index: number, container: JsonScanObjectContainer): number | undefined =>
  JSON_OBJECT_SCAN_STEPS[container.state](context, index, container)

const advanceJsonArray = (context: JsonScanContext, index: number, container: JsonScanArrayContainer): number | undefined =>
  JSON_ARRAY_SCAN_STEPS[container.state](context, index, container)

const advanceJsonContainer = (context: JsonScanContext, index: number, container: JsonScanContainer): number | undefined => {
  if (container.kind === 'object') {
    return advanceJsonObject(context, index, container)
  }
  return advanceJsonArray(context, index, container)
}

const scanJsonStep = (context: JsonScanContext, index: number, container: JsonScanContainer): number | undefined => {
  const nextIndex = skipJsonWhitespace(context.text, index)
  if (nextIndex >= context.text.length) {
    return undefined
  }
  return advanceJsonContainer(context, nextIndex, container)
}

const scanJsonIteration = (context: JsonScanContext, index: number): number | null | undefined => {
  const container = context.stack.pop()
  if (container === undefined) {
    return null
  }
  context.stack.push(container)
  return scanJsonStep(context, index, container)
}

const scanJsonBody = (context: JsonScanContext, start: number): string | undefined => {
  let index = start
  let nextIndex = scanJsonIteration(context, index)
  while (nextIndex !== null) {
    if (nextIndex === undefined) {
      return undefined
    }
    index = nextIndex
    nextIndex = scanJsonIteration(context, index)
  }
  if (skipJsonWhitespace(context.text, index) === context.text.length) {
    return context.state.messageTag
  }
  return undefined
}

// This bounded lexical pass finds the envelope tag without constructing the parsed payload.
const scanRootMessageTag = (
  text: string,
  metrics: JsonScanMetrics = { exceeded: false, maxCollectionItems: ZERO, maxDepth: ONE },
): string | undefined => {
  let index = skipJsonWhitespace(text, ZERO)
  if (text.charCodeAt(index) !== JSON_CHAR.openBrace) {
    return undefined
  }
  index += ONE
  const stack: Array<JsonScanContainer> = [createJsonContainer({
    entries: ZERO,
    key: undefined,
    kind: 'object',
    root: true,
    rootMessageBody: false,
    state: 'key-or-end',
  })]
  const state: JsonScanState = { messageTag: undefined }
  const context: JsonScanContext = { metrics, stack, state, text }
  return scanJsonBody(context, index)
}

const globalFrameSizeFailure = (text: string, maxCodeUnits = MAX_FRAME_CODE_UNITS, maxUtf8Bytes = MAX_FRAME_UTF8_BYTES): ProtocolError | undefined => {
  if (text.length > maxCodeUnits) {
    return frameTooLarge(`frame UTF-16 code units ${text.length} exceed limit ${maxCodeUnits}`)
  }
  const bytes = utf8ByteLength(text)
  if (bytes > maxUtf8Bytes) {
    return frameTooLarge(`frame UTF-8 bytes ${bytes} exceed limit ${maxUtf8Bytes}`)
  }
  return undefined
}

const legacyFrameSizeFailure = (text: string, tag: string | undefined): ProtocolError | undefined => {
  if (tag === undefined) {
    return undefined
  }
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

type JsonFrameShape = Readonly<{ metrics: JsonScanMetrics; tag: string | undefined }>

const scanJsonFrameShape = (text: string): Result.Result<JsonFrameShape, ProtocolError> => {
  const metrics: JsonScanMetrics = { exceeded: false, maxCollectionItems: ZERO, maxDepth: ONE }
  const tag = scanRootMessageTag(text, metrics)
  const globalShapeExceeded = metrics.exceeded ||
    metrics.maxDepth > MAX_JSON_DEPTH ||
    metrics.maxCollectionItems > MAX_JSON_COLLECTION_ITEMS
  if (globalShapeExceeded) {
    return Result.fail(frameTooLarge('frame exceeds JSON depth or collection count limit'))
  }
  return Result.succeed({ metrics, tag })
}

type FrameSizeRequest = Readonly<{
  limits: ReplicatedOwnerRegistryLimits | undefined
  maxFrameBytes: number
  maxCodeUnits: number
  text: string
}>

type FrameSizeContext = FrameSizeRequest & Readonly<{
  metrics: JsonScanMetrics
  tag: string | undefined
}>

type ConfiguredFrameLimit = Readonly<{ byteLimit: number; tag: string }>

const configuredReplicatedFrameSizeFailure = (
  context: FrameSizeContext,
  configured: ConfiguredFrameLimit,
): ProtocolError | undefined => {
  if (context.tag !== configured.tag || context.limits === undefined) {
    return undefined
  }
  const byteLimit = Math.min(configured.byteLimit, context.maxFrameBytes)
  if (utf8ByteLength(context.text) > byteLimit) {
    return frameTooLarge(`${configured.tag} frame UTF-8 bytes exceed limit ${byteLimit}`)
  }
  if (context.metrics.maxDepth > context.limits.maxDepth || context.metrics.maxCollectionItems > context.limits.maxCollectionItems) {
    return frameTooLarge(`${configured.tag} exceeds configured depth or collection count limit`)
  }
  return undefined
}

const replicatedFrameSizeFailure = (context: FrameSizeContext): ProtocolError | undefined => {
  if (context.limits === undefined) {
    return undefined
  }
  const deltaFailure = configuredReplicatedFrameSizeFailure(context, {
    byteLimit: context.limits.maxDeltaFrameBytes,
    tag: 'ReplicatedWorldDelta',
  })
  if (deltaFailure !== undefined) {
    return deltaFailure
  }
  return configuredReplicatedFrameSizeFailure(context, {
    byteLimit: context.limits.maxSnapshotFrameBytes,
    tag: 'ReplicatedWorldSnapshot',
  })
}

const registryEntryFor = (owners: ReplicatedOwnerRegistry | undefined): ReplicatedOwnerRegistryEntry | undefined => {
  if (owners === undefined) {
    return undefined
  }
  return ownerSchemasByRegistry.get(owners)
}

const frameSizeContext = (request: FrameSizeRequest, shape: JsonFrameShape): FrameSizeContext => ({
  ...request,
  metrics: shape.metrics,
  tag: shape.tag,
})

const checkFrameContentSize = (request: FrameSizeRequest): ProtocolError | undefined => {
  const shape = scanJsonFrameShape(request.text)
  if (Result.isFailure(shape)) {
    return shape.failure
  }
  const context = frameSizeContext(request, shape.success)
  const replicatedFailure = replicatedFrameSizeFailure(context)
  if (replicatedFailure !== undefined) {
    return replicatedFailure
  }
  return legacyFrameSizeFailure(request.text, shape.success.tag)
}

const checkFrameSize = (request: FrameSizeRequest): ProtocolError | undefined => {
  const globalFailure = globalFrameSizeFailure(request.text, request.maxCodeUnits, request.maxFrameBytes)
  if (globalFailure !== undefined) {
    return globalFailure
  }
  return checkFrameContentSize(request)
}

const frameSizeFailure = (
  text: string,
  owners?: ReplicatedOwnerRegistry,
  transferredSnapshotMaxBytes?: number,
): ProtocolError | undefined => {
  const maxFrameBytes = transferredSnapshotMaxBytes ?? MAX_FRAME_UTF8_BYTES
  let maxCodeUnits = MAX_FRAME_CODE_UNITS
  if (transferredSnapshotMaxBytes !== undefined) {
    maxCodeUnits = transferredSnapshotMaxBytes
  }
  return checkFrameSize({
    limits: registryEntryFor(owners)?.limits,
    maxCodeUnits,
    maxFrameBytes,
    text,
  })
}

type PendingShapeValue = Readonly<{ depth: number; value: unknown }>
type PendingNestedShapeValue = Readonly<{ depth: number; value: object }>
type ValueShape = Readonly<{ maxCollectionItems: number; maxDepth: number }>

const shapeValues = (value: object): ReadonlyArray<unknown> => {
  if (Array.isArray(value)) {
    return value
  }
  return Object.values(value)
}

const measureNestedShape = (current: PendingNestedShapeValue, pending: Array<PendingShapeValue>): ValueShape => {
  const entries = shapeValues(current.value)
  let maxDepth = current.depth
  for (const value of entries) {
    const depth = current.depth + ONE
    maxDepth = Math.max(maxDepth, depth)
    pending.push({ depth, value })
  }
  return { maxCollectionItems: entries.length, maxDepth }
}

const measureValueShape = (value: unknown): ValueShape => {
  const pending: Array<PendingShapeValue> = [{ depth: ONE, value }]
  let maxDepth = ONE
  let maxCollectionItems = ZERO
  while (pending.length > ZERO) {
    const current = pending.pop()
    if (current !== undefined && typeof current.value === 'object' && current.value !== null) {
      const shape = measureNestedShape({ depth: current.depth, value: current.value }, pending)
      maxDepth = Math.max(maxDepth, shape.maxDepth)
      maxCollectionItems = Math.max(maxCollectionItems, shape.maxCollectionItems)
    }
  }
  return { maxCollectionItems, maxDepth }
}

type OwnerChangeContext = Readonly<{
  direction: 'decode' | 'encode'
  registryEntry: ReplicatedOwnerRegistryEntry
  seen: Set<ReplicatedOwnerId>
}>

const decodeOrEncodeOwnerState = (
  schema: OwnerStateCodec,
  value: unknown,
  direction: 'decode' | 'encode',
): Result.Result<unknown, Schema.SchemaError> => {
  if (direction === 'decode') {
    return Schema.decodeUnknownResult(schema, strictParseOptions)(value)
  }
  return Schema.encodeUnknownResult(schema, strictParseOptions)(value)
}

const validateOwnerStatePayload = (
  change: ReplicatedOwnerChange,
  state: unknown,
  bounds: ReplicatedOwnerStateBounds,
): Result.Result<ReplicatedOwnerChange, ProtocolError> => {
  const stateText = JSON.stringify(state)
  const stateShape = measureValueShape(state)
  const exceedsBounds = stateText === undefined ||
    utf8ByteLength(stateText) > bounds.maxStateBytes ||
    stateShape.maxDepth > bounds.maxStateDepth ||
    stateShape.maxCollectionItems > bounds.maxCollectionItems
  if (exceedsBounds) {
    return Result.fail(malformedFrame(`state for replicated owner ${change.owner} exceeds configured limits`))
  }
  return Result.succeed({ owner: change.owner, state })
}

const validateRegisteredOwnerChange = (
  change: ReplicatedOwnerChange,
  context: OwnerChangeContext,
): Result.Result<ReplicatedOwnerChange, ProtocolError> => {
  const schema = context.registryEntry.schemas.get(change.owner)
  const bounds = context.registryEntry.bounds.get(change.owner)
  if (schema === undefined || bounds === undefined) {
    return Result.fail(malformedFrame(`unknown replicated owner: ${change.owner}`))
  }
  const state = decodeOrEncodeOwnerState(schema, change.state, context.direction)
  if (Result.isFailure(state)) {
    return Result.fail(malformedFrame(`invalid state for replicated owner ${change.owner}: ${state.failure.message}`))
  }
  return validateOwnerStatePayload(change, state.success, bounds)
}

const validateOwnerChange = (
  change: ReplicatedOwnerChange,
  context: OwnerChangeContext,
): Result.Result<ReplicatedOwnerChange, ProtocolError> => {
  if (context.seen.has(change.owner)) {
    return Result.fail(malformedFrame(`duplicate owner change in C4 group: ${change.owner}`))
  }
  context.seen.add(change.owner)
  return validateRegisteredOwnerChange(change, context)
}

const validateOwnerChangeList = (
  changes: ReadonlyArray<ReplicatedOwnerChange>,
  context: OwnerChangeContext,
): Result.Result<ReadonlyArray<ReplicatedOwnerChange>, ProtocolError> => {
  const validated: Array<ReplicatedOwnerChange> = []
  for (const change of changes) {
    const result = validateOwnerChange(change, context)
    if (Result.isFailure(result)) {
      return Result.fail(result.failure)
    }
    validated.push(result.success)
  }
  return Result.succeed(validated)
}

const validateOwnerChanges = (
  changes: ReadonlyArray<ReplicatedOwnerChange>,
  registryEntry: ReplicatedOwnerRegistryEntry,
  direction: 'decode' | 'encode',
): Result.Result<ReadonlyArray<ReplicatedOwnerChange>, ProtocolError> => {
  if (changes.length > registryEntry.limits.maxRegisteredOwners) {
    return Result.fail(malformedFrame('C4 owner change count exceeds configured limit'))
  }
  const context: OwnerChangeContext = { direction, registryEntry, seen: new Set() }
  return validateOwnerChangeList(changes, context)
}

const validateReplicatedDelta = (
  message: Extract<NetworkMessageType, { _tag: 'ReplicatedWorldDelta' }>,
  registry: ReplicatedOwnerRegistry | undefined,
  direction: 'decode' | 'encode',
): Result.Result<NetworkMessageType, ProtocolError> => {
  const registryEntry = registryEntryFor(registry)
  if (registryEntry === undefined || message.blockChanges.length > registryEntry.limits.maxDeltaBlockChanges) {
    return Result.fail(malformedFrame('C4 block change count exceeds configured limit'))
  }
  return Result.map(validateOwnerChanges(message.changes, registryEntry, direction), (changes) => ({ ...message, changes }))
}

const validateReplicatedSnapshot = (
  message: Extract<NetworkMessageType, { _tag: 'ReplicatedWorldSnapshot' }>,
  registry: ReplicatedOwnerRegistry | undefined,
  direction: 'decode' | 'encode',
): Result.Result<NetworkMessageType, ProtocolError> => {
  const registryEntry = registryEntryFor(registry)
  if (registryEntry === undefined || message.blocks.length > registryEntry.limits.maxSnapshotBlockReads) {
    return Result.fail(malformedFrame('C4 snapshot block count exceeds configured limit'))
  }
  return Result.map(validateOwnerChanges(message.owners, registryEntry, direction), (owners) => ({ ...message, owners }))
}

const validateOwnerStates = (
  message: NetworkMessageType,
  registry: ReplicatedOwnerRegistry | undefined,
  direction: 'decode' | 'encode',
): Result.Result<NetworkMessageType, ProtocolError> => {
  if (message._tag === 'ReplicatedWorldDelta') {
    return validateReplicatedDelta(message, registry, direction)
  }
  if (message._tag === 'ReplicatedWorldSnapshot') {
    return validateReplicatedSnapshot(message, registry, direction)
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
const inspectEnvelopeTag = (
  text: WireText,
  rootTag: string | undefined,
  envelope: { readonly message: unknown; readonly protocolVersion: number },
): Result.Result<ReplicatedFrameTag | undefined, ProtocolError> => {
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
      if (sizeFailure !== undefined) {
        return Result.fail(sizeFailure)
      }
      return Result.succeed(undefined)
    }
  }
}

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
  return inspectEnvelopeTag(text, rootTag, envelopeResult.success)
}

/**
 * Encode a message at an explicit protocol version.
 *
 * Exists so that tests can forge a frame from a version this build does not
 * speak — the only way to prove the version check actually rejects rather than
 * best-effort parses. Production code calls `encodeFrame`.
 */
type VersionedFrameEncodeOptions = Readonly<{
  maxFrameBytes?: number
  message: unknown
  owners?: ReplicatedOwnerRegistry | undefined
  protocolVersion: number
}>

const finishEncodedFrame = (
  encoded: WireText,
  owners: ReplicatedOwnerRegistry | undefined,
  maxFrameBytes: number | undefined,
): Result.Result<WireText, ProtocolError> => {
  const sizeFailure = frameSizeFailure(encoded, owners, maxFrameBytes)
  if (sizeFailure !== undefined) {
    return Result.fail(sizeFailure)
  }
  return Result.succeed(encoded)
}

const encodeFrameAsVersionWithByteLimit = (
  options: VersionedFrameEncodeOptions,
): Result.Result<WireText, ProtocolError> => {
  const decoded = Schema.decodeUnknownResult(NetworkMessage, strictParseOptions)(options.message)
  if (Result.isFailure(decoded)) {
    return Result.fail(new ProtocolError({ detail: decoded.failure.message, reason: 'unencodable-message' }))
  }

  const ownerEncoded = validateOwnerStates(decoded.success, options.owners, 'encode')
  if (Result.isFailure(ownerEncoded)) {
    return Result.fail(new ProtocolError({ detail: ownerEncoded.failure.message, reason: 'unencodable-message' }))
  }

  const encoded = encodeWireFrame({ message: ownerEncoded.success, protocolVersion: options.protocolVersion })
  if (Result.isFailure(encoded)) {
    return Result.fail(new ProtocolError({ detail: encoded.failure.message, reason: 'unencodable-message' }))
  }

  return finishEncodedFrame(encoded.success, options.owners, options.maxFrameBytes)
}

export const encodeFrameAsVersion = (
  protocolVersion: number,
  message: unknown,
  owners?: ReplicatedOwnerRegistry,
): Result.Result<WireText, ProtocolError> => encodeFrameAsVersionWithByteLimit({ message, owners, protocolVersion })

/** Encode a runtime value into a frame at this build's protocol version. */
export const encodeFrame = (
  message: unknown,
  owners?: ReplicatedOwnerRegistry,
): Result.Result<WireText, ProtocolError> =>
  encodeFrameAsVersion(PROTOCOL_VERSION, message, owners)

/** Encode one complete snapshot for bounded chunk transfer, above the ordinary frame cap if configured. */
export const encodeTransferredSnapshotFrame = (
  message: unknown,
  owners: ReplicatedOwnerRegistry,
  maxTotalBytes: number,
): Result.Result<WireText, ProtocolError> => {
  if (!isPositiveSafeInteger(maxTotalBytes)) {
    return Result.fail(new ProtocolError({ detail: 'snapshot transfer byte limit is invalid', reason: 'unencodable-message' }))
  }
  const result = encodeFrameAsVersionWithByteLimit({
    maxFrameBytes: maxTotalBytes,
    message,
    owners,
    protocolVersion: PROTOCOL_VERSION,
  })
  if (Result.isFailure(result)) {
    return result
  }
  const tag = scanRootMessageTag(result.success)
  if (tag !== 'ReplicatedWorldSnapshot') {
    return Result.fail(new ProtocolError({ detail: 'snapshot transfer accepts only ReplicatedWorldSnapshot', reason: 'unencodable-message' }))
  }
  return result
}

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
const decodeFrameWithByteLimit = (
  text: WireText,
  owners?: ReplicatedOwnerRegistry,
  maxFrameBytes?: number,
): Result.Result<NetworkMessageType, ProtocolError> => {
  const sizeFailure = frameSizeFailure(text, owners, maxFrameBytes)
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

export const decodeFrame = (
  text: WireText,
  owners?: ReplicatedOwnerRegistry,
): Result.Result<NetworkMessageType, ProtocolError> => decodeFrameWithByteLimit(text, owners)

/** Decode one fully reassembled snapshot under the transfer's declared total-byte bound. */
export const decodeTransferredSnapshotFrame = (
  text: WireText,
  owners: ReplicatedOwnerRegistry,
  maxTotalBytes: number,
): Result.Result<NetworkMessageType, ProtocolError> => {
  if (!isPositiveSafeInteger(maxTotalBytes)) {
    return Result.fail(malformedFrame('snapshot transfer byte limit is invalid'))
  }
  const result = decodeFrameWithByteLimit(text, owners, maxTotalBytes)
  if (Result.isFailure(result)) {
    return result
  }
  if (result.success._tag !== 'ReplicatedWorldSnapshot') {
    return Result.fail(malformedFrame('snapshot transfer contains a non-snapshot frame'))
  }
  return result
}

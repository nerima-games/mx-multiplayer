import {
  AuthoritativeClientState,
  type AuthoritativeCommand,
  type AuthoritativeWorldState,
  Base64Schema,
  type ClientSyncTransition,
  CommandId,
  type CommandUnsupportedReason,
  EntityId,
  NonNegativeSafeIntegerSchema,
  PlayerId,
  PositiveSafeIntegerSchema,
  type ReplicatedOwnerRegistry,
  ReplicatedOwnerRegistryLimitsSchema,
  type ReplicatedWorldDeltaMessage,
  type ReplicatedWorldSnapshot,
  type ReplicatedWorldSnapshotChunk,
  type ReplicatedWorldSnapshotEnd,
  type ReplicatedWorldSnapshotStart,
  type SnapshotTransferCompletion,
  SnapshotTransferLimitsSchema,
  SnapshotTransferReceiver,
  TransferIdSchema,
  WorldId,
  createReplicatedOwnerRegistry,
  encodeFrame,
  sha256Hex,
} from '../src/index.js'
import { BlockIdSchema, type BlockPosition, BlockPositionSchema, EncodedBlockStateSchema, WorldRevisionSchema } from '@nerima-games/mc-kernel'
import { Result, Schema } from 'effect'
import type { ScenarioAction, ScenarioDefinition, ScenarioEvaluationInput, ScenarioVerdict } from './types.js'

const WORLD_ID = WorldId.make('overworld')
const PLAYER_A = PlayerId.make('scenario-player-a')
const PLAYER_B = PlayerId.make('scenario-player-b')
const ZERO = 0
const ONE = 1
const TWO = 2
const FOUR = 4
const FIVE = 5
const SIX = 6
const THREE = 3
const SIXTEEN = 16
const SIXTY_FOUR = 64
const FIFTY = 50
const SIX_THOUSAND = 6_000
const MAXIMUM_ASCII_CODE = 127
const MAXIMUM_FRAME_BYTES = 1_048_576
const MAXIMUM_FRAME_ITEMS = 1_024
const MAXIMUM_FRAME_DEPTH = 13
const BASE64_THREE_BYTE_GROUP = 3
const BASE64_SIX_BIT_DIVISOR = 64
const FIRST_ARRAY_INDEX = ZERO
const SECOND_ARRAY_INDEX = ONE
const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const BASE64_FIRST_DIVISOR = FOUR
const BASE64_FIRST_MODULUS = FOUR
const BASE64_SECOND_MODULUS = SIXTEEN
const BASE64_FIRST_SECOND_SCALE = SIXTEEN
const NO_MATCHING_INTENT = 'no-matching-c2-intent-payload'
const DOES_NOT_PRESERVE_COMMAND = 'intent-payload-does-not-preserve-command'
const BLOCK_POSITION: BlockPosition = Schema.decodeUnknownSync(BlockPositionSchema)({ x: ZERO, y: SIXTY_FOUR, z: ZERO })
const INITIAL_BLOCK_ID = Schema.decodeUnknownSync(BlockIdSchema)(ONE)
const UPDATED_BLOCK_ID = Schema.decodeUnknownSync(BlockIdSchema)(TWO)
const GAP_BLOCK_ID = Schema.decodeUnknownSync(BlockIdSchema)(THREE)
const ZERO_BLOCK_STATE = Schema.decodeUnknownSync(EncodedBlockStateSchema)(ZERO)

const EMPTY_OWNER_REGISTRY_LIMITS = Schema.decodeUnknownSync(ReplicatedOwnerRegistryLimitsSchema)({
  maxCollectionItems: MAXIMUM_FRAME_ITEMS,
  maxDeltaBlockChanges: MAXIMUM_FRAME_ITEMS,
  maxDeltaFrameBytes: MAXIMUM_FRAME_BYTES,
  maxDepth: MAXIMUM_FRAME_DEPTH,
  maxRegisteredOwners: ZERO,
  maxSnapshotBlockReads: MAXIMUM_FRAME_ITEMS,
  maxSnapshotFrameBytes: MAXIMUM_FRAME_BYTES,
  ownerStates: [],
})

const EMPTY_OWNER_REGISTRY: ReplicatedOwnerRegistry = Result.getOrThrow(createReplicatedOwnerRegistry([], EMPTY_OWNER_REGISTRY_LIMITS))

const UNSUPPORTED_COMMAND_TAGS = [
  'BucketUseCommand',
  'ContainerCommand',
  'EndPortalUseCommand',
  'EnderPearlCommand',
  'EntityAttackCommand',
  'EntityPickupCommand',
  'FurnaceCommand',
  'IgniteTntCommand',
  'InsertEyeIntoEndPortalFrameCommand',
  'NetherPortalUseCommand',
  'PlayerInventoryCommand',
  'ThrowEyeOfEnderCommand',
  'ToggleLeverCommand',
  'VehicleUseCommand',
  'WorldTimeWeatherCommand',
] as const

const UNIQUE_UNSUPPORTED_TAG_COUNT = UNSUPPORTED_COMMAND_TAGS.length + ONE

type UnsupportedCommandTag = (typeof UNSUPPORTED_COMMAND_TAGS)[number]

// The production reason map is module-private; these expectations are checked against its public application results.
export const S3_EXPECTED_UNSUPPORTED_COMMAND_REASONS: Readonly<Record<UnsupportedCommandTag, CommandUnsupportedReason>> = {
  BucketUseCommand: NO_MATCHING_INTENT,
  ContainerCommand: NO_MATCHING_INTENT,
  EndPortalUseCommand: NO_MATCHING_INTENT,
  EnderPearlCommand: DOES_NOT_PRESERVE_COMMAND,
  EntityAttackCommand: DOES_NOT_PRESERVE_COMMAND,
  EntityPickupCommand: NO_MATCHING_INTENT,
  FurnaceCommand: NO_MATCHING_INTENT,
  IgniteTntCommand: NO_MATCHING_INTENT,
  InsertEyeIntoEndPortalFrameCommand: NO_MATCHING_INTENT,
  NetherPortalUseCommand: NO_MATCHING_INTENT,
  PlayerInventoryCommand: NO_MATCHING_INTENT,
  ThrowEyeOfEnderCommand: NO_MATCHING_INTENT,
  ToggleLeverCommand: NO_MATCHING_INTENT,
  VehicleUseCommand: NO_MATCHING_INTENT,
  WorldTimeWeatherCommand: NO_MATCHING_INTENT,
}

export const S3_UNSUPPORTED_COMMAND_TAGS: typeof UNSUPPORTED_COMMAND_TAGS = UNSUPPORTED_COMMAND_TAGS

export const S3_UNSUPPORTED_COMMAND_EXPECTATIONS: ReadonlyArray<Readonly<{ tag: string; reason: CommandUnsupportedReason }>> = [
  ...UNSUPPORTED_COMMAND_TAGS.map((tag) => ({ reason: S3_EXPECTED_UNSUPPORTED_COMMAND_REASONS[tag], tag })),
  { reason: NO_MATCHING_INTENT, tag: 'PlayerVitalsCommand' },
  { reason: DOES_NOT_PRESERVE_COMMAND, tag: 'PlayerVitalsCommand' },
]

const commandHeader = (commandId: string, player = PLAYER_A, expectedRevision = ZERO) => ({
  commandId: CommandId.make(commandId),
  expectedRevision,
  player,
  world: WORLD_ID,
})

const position = (): BlockPosition => Schema.decodeUnknownSync(BlockPositionSchema)({ x: ZERO, y: SIXTY_FOUR, z: ZERO })

const neverUnsupportedTag = (tag: never): never => {
  throw new Error(`unhandled unsupported command tag ${String(tag)}`)
}

const makeUnsupportedCommand = (tag: UnsupportedCommandTag, commandId: string): AuthoritativeCommand => {
  const header = commandHeader(commandId)
  switch (tag) {
    case 'BucketUseCommand':
    case 'VehicleUseCommand':
    case 'ThrowEyeOfEnderCommand':
      return { ...header, _tag: tag }
    case 'ContainerCommand':
      return { ...header, _tag: tag, action: { _tag: 'open' }, containerId: 's3-container' }
    case 'EndPortalUseCommand':
      return { ...header, _tag: tag, portal: position() }
    case 'EnderPearlCommand':
      return { ...header, _tag: tag }
    case 'EntityAttackCommand':
      return { ...header, _tag: tag, entityId: EntityId.make('s3-entity'), heldSlot: ZERO }
    case 'EntityPickupCommand':
      return { ...header, _tag: tag, entityId: EntityId.make('s3-entity') }
    case 'FurnaceCommand':
      return {
        ...header,
        _tag: tag,
        action: {
          _tag: 'take-output',
          count: ONE,
          destination: { _tag: 'player-slot', slot: ZERO },
          source: { _tag: 'furnace-slot', slot: 'output' },
        },
        furnaceId: 's3-furnace',
      }
    case 'IgniteTntCommand':
      return { ...header, _tag: tag, at: position() }
    case 'InsertEyeIntoEndPortalFrameCommand':
      return { ...header, _tag: tag, frame: position() }
    case 'NetherPortalUseCommand':
      return { ...header, _tag: tag, portal: position() }
    case 'PlayerInventoryCommand':
      return { ...header, _tag: tag, action: { _tag: 'select-slot', slot: ONE } }
    case 'ToggleLeverCommand':
      return { ...header, _tag: tag, lever: position() }
    case 'WorldTimeWeatherCommand':
      return { ...header, _tag: tag, action: { _tag: 'set-time', timeOfDay: SIX_THOUSAND } }
    default:
      return neverUnsupportedTag(tag)
  }
}

const unsupportedCommands = (seed: number): ReadonlyArray<Readonly<{ command: AuthoritativeCommand; reason: CommandUnsupportedReason }>> => [
  ...UNSUPPORTED_COMMAND_TAGS.map((tag, index) => ({
    command: makeUnsupportedCommand(tag, `s3-${String(seed)}-unsupported-${String(index)}`),
    reason: S3_EXPECTED_UNSUPPORTED_COMMAND_REASONS[tag],
  })),
  {
    command: { ...commandHeader(`s3-${String(seed)}-vitals-respawn`), _tag: 'PlayerVitalsCommand', action: 'respawn' },
    reason: NO_MATCHING_INTENT,
  },
  {
    command: {
      ...commandHeader(`s3-${String(seed)}-vitals-activity`),
      _tag: 'PlayerVitalsCommand',
      action: { _tag: 'activity', activity: 'attack', amount: FIFTY },
    },
    reason: DOES_NOT_PRESERVE_COMMAND,
  },
]

const makeBlockRead = (block: typeof INITIAL_BLOCK_ID | typeof UPDATED_BLOCK_ID | typeof GAP_BLOCK_ID): ReplicatedWorldSnapshot['blocks'][number] => ({
  dimension: 'overworld',
  position: BLOCK_POSITION,
  reading: { _tag: 'Block', block },
  state: ZERO_BLOCK_STATE,
})

const makeBlockChange = (
  before: typeof INITIAL_BLOCK_ID,
  after: typeof UPDATED_BLOCK_ID | typeof GAP_BLOCK_ID,
): ReplicatedWorldDeltaMessage['blockChanges'][number] => ({
  after,
  afterState: ZERO_BLOCK_STATE,
  before,
  beforeState: ZERO_BLOCK_STATE,
  dimension: 'overworld',
  position: BLOCK_POSITION,
})

const makeSnapshot = (revision: number): ReplicatedWorldSnapshot => ({
  _tag: 'ReplicatedWorldSnapshot',
  blocks: [makeBlockRead(INITIAL_BLOCK_ID)],
  owners: [],
  revision: Schema.decodeUnknownSync(WorldRevisionSchema)(revision),
  world: WORLD_ID,
})

const makeDelta = (revision: number, blockChange: ReplicatedWorldDeltaMessage['blockChanges'][number]): ReplicatedWorldDeltaMessage => ({
  _tag: 'ReplicatedWorldDelta',
  blockChanges: [blockChange],
  changes: [],
  revision: Schema.decodeUnknownSync(WorldRevisionSchema)(revision),
  world: WORLD_ID,
})

const mapsEqual = <Key, Value>(left: ReadonlyMap<Key, Value>, right: ReadonlyMap<Key, Value>): boolean => {
  if (left.size !== right.size) {
    return false
  }
  for (const [key, value] of left) {
    const other = right.get(key)
    if (other === undefined || JSON.stringify(value) !== JSON.stringify(other)) {
      return false
    }
  }
  return true
}

const worldsEqual = (
  left: AuthoritativeWorldState | undefined,
  right: AuthoritativeWorldState | undefined,
): boolean => left !== undefined
  && right !== undefined
  && left.world === right.world
  && left.revision === right.revision
  && mapsEqual(left.owners, right.owners)
  && mapsEqual(left.blocks, right.blocks)

const asciiBytes = (text: string): Uint8Array => {
  const bytes = new Uint8Array(text.length)
  for (let index = ZERO; index < text.length; index += ONE) {
    const byte = text.charCodeAt(index)
    if (byte > MAXIMUM_ASCII_CODE) {
      throw new RangeError('snapshot transfer fixture must encode ASCII JSON')
    }
    bytes[index] = byte
  }
  return bytes
}

const encodeBase64Suffix = (second: number | undefined, third: number | undefined): string => {
  if (second === undefined) {
    return '=='
  }
  const thirdIndex = (second % BASE64_SECOND_MODULUS) * FOUR + Math.floor((third ?? ZERO) / BASE64_SIX_BIT_DIVISOR)
  const thirdCharacter = BASE64_ALPHABET.charAt(thirdIndex)
  if (third === undefined) {
    return `${thirdCharacter}=`
  }
  return `${thirdCharacter}${BASE64_ALPHABET.charAt(third % BASE64_SIX_BIT_DIVISOR)}`
}

const encodeBase64Group = (bytes: Uint8Array, offset: number): string => {
  const first = bytes[offset] ?? ZERO
  const second = bytes[offset + ONE]
  const third = bytes[offset + TWO]
  const firstIndex = Math.floor(first / BASE64_FIRST_DIVISOR)
  const secondIndex = (first % BASE64_FIRST_MODULUS) * BASE64_FIRST_SECOND_SCALE
    + Math.floor((second ?? ZERO) / BASE64_SECOND_MODULUS)
  return `${BASE64_ALPHABET.charAt(firstIndex)}${BASE64_ALPHABET.charAt(secondIndex)}${encodeBase64Suffix(second, third)}`
}

const encodeBase64 = (bytes: Uint8Array): string => {
  let encoded = ''
  for (let offset = ZERO; offset < bytes.length; offset += BASE64_THREE_BYTE_GROUP) {
    encoded += encodeBase64Group(bytes, offset)
  }
  return encoded
}

export type AuthoritySyncProbe = {
  readonly directDeltaTransition: ClientSyncTransition
  readonly directSnapshotTransition: ClientSyncTransition
  readonly directWorld: AuthoritativeWorldState | undefined
  readonly gapAfter: AuthoritativeWorldState | undefined
  readonly gapBefore: AuthoritativeWorldState | undefined
  readonly gapTransition: ClientSyncTransition
  readonly transferAppend: ReturnType<SnapshotTransferReceiver['append']>
  readonly transferBegin: ReturnType<SnapshotTransferReceiver['begin']>
  readonly transferCompletion: SnapshotTransferCompletion
  readonly transferDeltaTransition: ClientSyncTransition
  readonly transferTransition: ClientSyncTransition | undefined
  readonly transferWorld: AuthoritativeWorldState | undefined
  readonly clientsConverged: boolean
}

type RevisionGapProbe = Pick<AuthoritySyncProbe, 'gapAfter' | 'gapBefore' | 'gapTransition'>
type TransferProbe = Pick<AuthoritySyncProbe, 'transferAppend' | 'transferBegin' | 'transferCompletion' | 'transferTransition'>
type DeltaProbe = Pick<AuthoritySyncProbe, 'directDeltaTransition' | 'directWorld' | 'transferDeltaTransition' | 'transferWorld' | 'clientsConverged'>
type ConvergenceProbe = DeltaProbe & Pick<AuthoritySyncProbe, 'directSnapshotTransition'>

const makeRevisionGapProbe = (): RevisionGapProbe => {
  const initialSnapshot = makeSnapshot(FOUR)
  const client = new AuthoritativeClientState()
  client.applySnapshot(initialSnapshot)
  const gapBefore = client.world(WORLD_ID)
  const gapTransition = client.applyDelta(makeDelta(SIX, makeBlockChange(INITIAL_BLOCK_ID, GAP_BLOCK_ID)))
  const gapAfter = client.world(WORLD_ID)
  return { gapAfter, gapBefore, gapTransition }
}

type TransferFrames = {
  readonly chunk: ReplicatedWorldSnapshotChunk
  readonly end: ReplicatedWorldSnapshotEnd
  readonly frameBytes: Uint8Array
  readonly start: ReplicatedWorldSnapshotStart
}

const makeTransferFrames = (snapshot: ReplicatedWorldSnapshot): TransferFrames => {
  const frame = Result.getOrThrow(encodeFrame(snapshot, EMPTY_OWNER_REGISTRY))
  const frameBytes = asciiBytes(frame)
  const transferId = Schema.decodeUnknownSync(TransferIdSchema)('s3-snapshot-transfer')
  return {
    chunk: {
      _tag: 'ReplicatedWorldSnapshotChunk',
      data: Schema.decodeUnknownSync(Base64Schema)(encodeBase64(frameBytes)),
      index: Schema.decodeUnknownSync(NonNegativeSafeIntegerSchema)(ZERO),
      transferId,
    },
    end: { _tag: 'ReplicatedWorldSnapshotEnd', transferId },
    frameBytes,
    start: {
      _tag: 'ReplicatedWorldSnapshotStart',
      chunkCount: Schema.decodeUnknownSync(PositiveSafeIntegerSchema)(ONE),
      revision: snapshot.revision,
      sha256: Result.getOrThrow(sha256Hex(frameBytes)),
      totalBytes: Schema.decodeUnknownSync(PositiveSafeIntegerSchema)(frameBytes.length),
      transferId,
      world: WORLD_ID,
    },
  }
}

const makeTransferReceiver = (frameBytes: Uint8Array): SnapshotTransferReceiver => {
  const limits = Schema.decodeUnknownSync(SnapshotTransferLimitsSchema)({
    maxChunkBytes: frameBytes.length,
    maxChunkCount: ONE,
    maxQueuedDeltaBytes: ZERO,
    maxQueuedDeltaCount: ZERO,
    maxTotalBytes: frameBytes.length,
  })
  return Result.getOrThrow(SnapshotTransferReceiver.make(limits))
}

const applyCompletedSnapshotTransfer = (
  client: AuthoritativeClientState,
  completion: SnapshotTransferCompletion,
): ClientSyncTransition | undefined => {
  if (!completion.accepted) {
    return undefined
  }
  return client.applyTransfer(completion.completion, EMPTY_OWNER_REGISTRY)
}

const applySnapshotTransfer = (client: AuthoritativeClientState, snapshot: ReplicatedWorldSnapshot): TransferProbe => {
  const frames = makeTransferFrames(snapshot)
  const receiver = makeTransferReceiver(frames.frameBytes)
  const transferBegin = receiver.begin(frames.start)
  const transferAppend = receiver.append(frames.chunk)
  const transferCompletion = receiver.finish(frames.end)
  const transferTransition = applyCompletedSnapshotTransfer(client, transferCompletion)
  return { transferAppend, transferBegin, transferCompletion, transferTransition }
}

const applyConvergenceDelta = (directClient: AuthoritativeClientState, transferClient: AuthoritativeClientState): DeltaProbe => {
  const delta = makeDelta(FIVE, makeBlockChange(INITIAL_BLOCK_ID, UPDATED_BLOCK_ID))
  const directDeltaTransition = directClient.applyDelta(delta)
  const transferDeltaTransition = transferClient.applyDelta(delta)
  const directWorld = directClient.world(WORLD_ID)
  const transferWorld = transferClient.world(WORLD_ID)
  return {
    clientsConverged: worldsEqual(directWorld, transferWorld),
    directDeltaTransition,
    directWorld,
    transferDeltaTransition,
    transferWorld,
  }
}

const makeConvergenceProbe = (): ConvergenceProbe & Pick<AuthoritySyncProbe, 'transferAppend' | 'transferBegin' | 'transferCompletion' | 'transferTransition'> => {
  const initialSnapshot = makeSnapshot(FOUR)
  const directClient = new AuthoritativeClientState()
  const transferClient = new AuthoritativeClientState()
  const directSnapshotTransition = directClient.applySnapshot(initialSnapshot)
  const transfer = applySnapshotTransfer(transferClient, initialSnapshot)
  const convergence = applyConvergenceDelta(directClient, transferClient)
  return { ...convergence, ...transfer, directSnapshotTransition }
}

const makeSyncProbe = (): AuthoritySyncProbe => {
  const gap = makeRevisionGapProbe()
  const convergence = makeConvergenceProbe()
  return { ...convergence, ...gap }
}

export const runAuthoritySyncProbe = (): AuthoritySyncProbe => makeSyncProbe()

const hasRevisionGapVerdict = (probe: AuthoritySyncProbe): boolean => !probe.gapTransition.accepted
  && probe.gapTransition.reason === 'revision-gap'
  && probe.gapTransition.request.lastKnownRevision === Schema.decodeUnknownSync(WorldRevisionSchema)(FOUR)
  && probe.gapBefore === probe.gapAfter
  && probe.gapAfter?.revision === Schema.decodeUnknownSync(WorldRevisionSchema)(FOUR)

const hasTransferConvergenceVerdict = (probe: AuthoritySyncProbe): boolean => probe.directSnapshotTransition.accepted
  && probe.transferBegin.accepted
  && probe.transferAppend.accepted
  && probe.transferCompletion.accepted
  && probe.transferTransition?.accepted === true
  && probe.directDeltaTransition.accepted
  && probe.transferDeltaTransition.accepted
  && probe.clientsConverged
  && probe.directWorld?.revision === Schema.decodeUnknownSync(WorldRevisionSchema)(FIVE)
  && probe.transferWorld?.revision === Schema.decodeUnknownSync(WorldRevisionSchema)(FIVE)

const incomplete = (summary: string): ScenarioVerdict => ({ status: 'incomplete', summary })
const pass = (summary: string): ScenarioVerdict => ({ status: 'pass', summary })
const fail = (summary: string): ScenarioVerdict => ({ status: 'fail', summary })

type BowCommandActionOptions = {
  readonly action: 'release' | 'start'
  readonly clientId: 'client-a' | 'client-b'
  readonly commandId: string
  readonly expectedRevision: number
  readonly player: typeof PLAYER_A
}

const bowCommandAction = (options: BowCommandActionOptions): ScenarioAction => ({
  clientId: options.clientId,
  kind: 'message',
  message: {
    ...commandHeader(options.commandId, options.player, options.expectedRevision),
    _tag: 'BowUseCommand',
    action: options.action,
  },
})

const replayActions = (frame: number, seed: number): ReadonlyArray<ScenarioAction> => {
  if (frame !== ONE && frame !== TWO) {
    return []
  }
  return [bowCommandAction({
    action: 'release',
    clientId: 'client-a',
    commandId: `s3-${String(seed)}-replay`,
    expectedRevision: ZERO,
    player: PLAYER_A,
  })]
}

const unauthorizedActions = (frame: number, seed: number): ReadonlyArray<ScenarioAction> => {
  if (frame !== ONE) {
    return []
  }
  return [bowCommandAction({
    action: 'start',
    clientId: 'client-a',
    commandId: `s3-${String(seed)}-unauthorized`,
    expectedRevision: ZERO,
    player: PLAYER_B,
  })]
}

const staleActions = (frame: number, seed: number): ReadonlyArray<ScenarioAction> => {
  if (frame !== ONE) {
    return []
  }
  return [bowCommandAction({
    action: 'start',
    clientId: 'client-b',
    commandId: `s3-${String(seed)}-stale`,
    expectedRevision: ONE,
    player: PLAYER_B,
  })]
}

const unsupportedActions = (frame: number, seed: number): ReadonlyArray<ScenarioAction> => {
  if (frame !== ONE) {
    return []
  }
  return unsupportedCommands(seed).map(({ command }) => ({ clientId: 'client-a', kind: 'message', message: command }))
}

const evaluateReplay = ({ frame, clients, authority, wireLog }: ScenarioEvaluationInput): ScenarioVerdict => {
  if (frame < TWO) {
    return incomplete('waiting for the accepted command and its replay')
  }
  const entries = wireLog.filter((entry) => entry.tag === 'BowUseCommand')
  const client = clients.find((entry) => entry.id === 'client-a')
  const acceptedOnce = entries[FIRST_ARRAY_INDEX]?.outcome === 'accepted'
    && entries[FIRST_ARRAY_INDEX].result === 'authority accepted canonical intent; world state was not applied'
  const replayed = entries[SECOND_ARRAY_INDEX]?.result === 'authority acknowledged accepted intent replay'
  const passed = entries.length === TWO
    && acceptedOnce
    && replayed
    && client?.accepted === ONE
    && client.rejected === ZERO
    && authority.acceptedCommands === ONE
    && authority.rejectedCommands === ZERO
  if (passed) {
    return pass('one canonical intent was accepted and its duplicate was replayed without a second acceptance')
  }
  return fail('accepted intent replay changed the authority decision or command counts')
}

const evaluateUnauthorized = ({ frame, clients, authority, wireLog }: ScenarioEvaluationInput): ScenarioVerdict => {
  if (frame < ONE) {
    return incomplete('waiting for the unauthorized command')
  }
  const unauthorized = wireLog.find((entry) => entry.result === 'authority rejected command: unauthorized-player')
  const clientA = clients.find((client) => client.id === 'client-a')
  const clientB = clients.find((client) => client.id === 'client-b')
  const passed = wireLog.length === ONE
    && unauthorized?.outcome === 'rejected'
    && clientA?.accepted === ZERO
    && clientA.rejected === ONE
    && clientB?.accepted === ZERO
    && clientB.rejected === ZERO
    && authority.acceptedCommands === ZERO
    && authority.rejectedCommands === ONE
  if (passed) {
    return pass('authority rejected the command because its player claim did not match the connection identity')
  }
  return fail('authority accepted or misclassified a player identity spoof')
}

const evaluateStale = ({ frame, clients, authority, wireLog }: ScenarioEvaluationInput): ScenarioVerdict => {
  if (frame < ONE) {
    return incomplete('waiting for the stale command')
  }
  const stale = wireLog.find((entry) => entry.result === 'authority rejected command: stale-revision')
  const clientA = clients.find((client) => client.id === 'client-a')
  const clientB = clients.find((client) => client.id === 'client-b')
  const passed = wireLog.length === ONE
    && stale?.outcome === 'rejected'
    && clientA?.accepted === ZERO
    && clientA.rejected === ZERO
    && clientB?.accepted === ZERO
    && clientB.rejected === ONE
    && authority.acceptedCommands === ZERO
    && authority.rejectedCommands === ONE
  if (passed) {
    return pass('authority rejected a command whose expected revision was stale')
  }
  return fail('authority accepted or misclassified a stale command')
}

const unsupportedResultsMatchExpectations = ({ authority, wireLog }: ScenarioEvaluationInput): boolean => {
  const actual = wireLog.filter((entry) => entry.frame === ONE)
  const matches = actual.length === S3_UNSUPPORTED_COMMAND_EXPECTATIONS.length
    && S3_UNSUPPORTED_COMMAND_EXPECTATIONS.every((item, index) => {
      const entry = actual[index]
      return entry !== undefined
        && entry.tag === item.tag
        && entry.outcome === 'rejected'
        && entry.result === `authority marked command unsupported: ${item.reason}`
    })
  return matches && authority.rejectedCommands === S3_UNSUPPORTED_COMMAND_EXPECTATIONS.length
}

const evaluateUnsupported = (input: ScenarioEvaluationInput): ScenarioVerdict => {
  if (input.frame < ONE) {
    return incomplete('waiting for all unsupported command results')
  }
  if (unsupportedResultsMatchExpectations(input)) {
    return pass(`${String(S3_UNSUPPORTED_COMMAND_EXPECTATIONS.length)} unsupported command variants across ${String(UNIQUE_UNSUPPORTED_TAG_COUNT)} tags were rejected with expected reasons`)
  }
  return fail('unsupported command tags or reasons differ from the S3 expectations')
}

const evaluateRevisionGap = (): ScenarioVerdict => {
  if (hasRevisionGapVerdict(runAuthoritySyncProbe())) {
    return pass('revision gap requested resync and left the client world projection unchanged')
  }
  return fail('revision gap changed client state or failed to request resync')
}

const evaluateSnapshotConvergence = (): ScenarioVerdict => {
  if (hasTransferConvergenceVerdict(runAuthoritySyncProbe())) {
    return pass('snapshot start/chunk/end transferred the snapshot and both client world projections converged')
  }
  return fail('snapshot transfer or two-client world projection convergence failed')
}

const replayScenario: ScenarioDefinition = {
  actions: ({ frame, seed }) => replayActions(frame, seed),
  angle: 'A2',
  description: 'A repeated command ID reuses the accepted canonical intent without applying it twice.',
  evaluate: evaluateReplay,
  group: 'authority',
  id: 'authority.accept-replay',
  title: 'Accepted command replay',
}

const unauthorizedScenario: ScenarioDefinition = {
  actions: ({ frame, seed }) => unauthorizedActions(frame, seed),
  angle: 'A7',
  description: 'A command that claims another player identity is rejected by authority.',
  evaluate: evaluateUnauthorized,
  group: 'authority',
  id: 'authority.unauthorized-player',
  title: 'Unauthorized player command',
}

const staleRevisionScenario: ScenarioDefinition = {
  actions: ({ frame, seed }) => staleActions(frame, seed),
  angle: 'A2',
  description: 'A command with an outdated expected revision is explicitly rejected by authority.',
  evaluate: evaluateStale,
  group: 'authority',
  id: 'authority.stale-revision',
  title: 'Stale revision command',
}

const unsupportedScenario: ScenarioDefinition = {
  actions: ({ frame, seed }) => unsupportedActions(frame, seed),
  angle: 'A2',
  description: 'All I1 unsupported command tags remain rejected with their current application reasons.',
  evaluate: evaluateUnsupported,
  group: 'authority',
  id: 'authority.unsupported-reasons',
  title: 'Unsupported command reasons',
}

const revisionGapScenario: ScenarioDefinition = {
  actions: () => [],
  angle: 'A4',
  description: 'A client rejects a non-contiguous delta, requests resync, and preserves its previous world projection.',
  evaluate: evaluateRevisionGap,
  group: 'authority',
  id: 'world-sync.revision-gap',
  title: 'World delta revision gap',
}

const snapshotConvergenceScenario: ScenarioDefinition = {
  actions: () => [],
  angle: 'A3',
  description: 'A transferred snapshot and a direct snapshot converge after both clients apply the same delta.',
  evaluate: evaluateSnapshotConvergence,
  group: 'authority',
  id: 'world-sync.snapshot-transfer-convergence',
  title: 'Snapshot transfer and client convergence',
}

export const AUTHORITY_SCENARIOS: ReadonlyArray<ScenarioDefinition> = [
  replayScenario,
  staleRevisionScenario,
  unauthorizedScenario,
  unsupportedScenario,
  revisionGapScenario,
  snapshotConvergenceScenario,
]

export const AUTHORITY_ACCEPT_REPLAY_SCENARIO: ScenarioDefinition = replayScenario
export const AUTHORITY_STALE_REVISION_SCENARIO: ScenarioDefinition = staleRevisionScenario
export const AUTHORITY_UNAUTHORIZED_PLAYER_SCENARIO: ScenarioDefinition = unauthorizedScenario
export const AUTHORITY_UNSUPPORTED_REASON_SCENARIO: ScenarioDefinition = unsupportedScenario
export const AUTHORITY_REVISION_GAP_SCENARIO: ScenarioDefinition = revisionGapScenario
export const AUTHORITY_SNAPSHOT_CONVERGENCE_SCENARIO: ScenarioDefinition = snapshotConvergenceScenario

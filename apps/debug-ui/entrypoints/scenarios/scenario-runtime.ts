import {
  AuthoritativeClientState,
  AuthoritativeCommand,
  AuthoritativeSession,
  type AuthoritativeSnapshot,
  type CommandIntentContext,
  LoopbackTransportLayer,
  PROTOCOL_VERSION,
  PlayerId,
  type ReplicatedOwnerRegistry,
  ReplicatedOwnerRegistryLimitsSchema,
  type ReplicatedWorldSnapshot,
  Revision,
  type ServerConnectionIdentity,
  TransportError,
  TransportPort,
  type TransportService,
  WorldId,
  type WorldWriteServices,
  applyAuthoritativeCommand,
  createReplicatedOwnerRegistry,
  decodeFrame,
  encodeFrame,
  encodeFrameAsVersion,
  makeLoopbackPair,
  receiveMessage,
  sendMessage,
} from '../../../../src/index.js'
import { BlockIdSchema, BlockPositionSchema, DimensionRevisionSchema, EncodedBlockStateSchema, SimulationTickSchema, WorldRevisionSchema } from '@nerima-games/mc-kernel'
import { Effect, Queue, Result, Schema } from 'effect'
import type {
  ScenarioAction,
  ScenarioClientId,
  ScenarioClientProjection,
  ScenarioClientState,
  ScenarioClock,
  ScenarioDefinition,
  ScenarioEvaluation,
  ScenarioEntityRevision,
  ScenarioEvaluationInput,
  ScenarioFault,
  ScenarioResult,
  ScenarioRuntime,
  ScenarioRuntimeClientId,
  ScenarioRuntimeClientState,
  ScenarioRuntimeFault,
  ScenarioRuntimeFaultKind,
  ScenarioRuntimeOptions,
  ScenarioSpeed,
  ScenarioStepContext,
  ScenarioWireLogEntry,
} from '../../../../scenarios/types.js'
import type { NetworkMessage } from '../../../../src/domain/protocol.js'
import type { WorldBlockRead } from '@nerima-games/mc-sim'

const CLIENT_IDS: ReadonlyArray<ScenarioClientId> = ['client-a', 'client-b']
const WORLD_ID = WorldId.make('overworld')
const ZERO = 0
const ONE = 1
const SCENARIO_PROJECTION_BLOCK_ID = Schema.decodeUnknownSync(BlockIdSchema)(ONE)
const SCENARIO_PROJECTION_BLOCK_POSITION = Schema.decodeUnknownSync(BlockPositionSchema)({ x: ZERO, y: 64, z: ZERO })
const MINIMUM_FRAME = ZERO
const MINIMUM_SEED = ZERO
const MINIMUM_DELAY_FRAMES = ONE
const DEFAULT_EXPECTED_DIMENSION_REVISION = ONE
const WORLD_REVISION = ZERO
const DEFAULT_FRAME = ZERO
const DEFAULT_SEED = ZERO
const INITIAL_SEQUENCE = ZERO
const DEFAULT_FAULT: ScenarioRuntimeFault = { kind: 'none' }
const DEFAULT_SPEED: ScenarioSpeed = 1
const DEFAULT_PANEL = ZERO
const PROJECTION_DIMENSION = 'overworld'
const MAXIMUM_FRAME_BYTES = 1_048_576
const MAXIMUM_FRAME_DEPTH = 13
const MAXIMUM_FRAME_ITEMS = 1_024
const MAXIMUM_REPLICATED_OWNERS = ZERO

const isScenarioEffect = (
  result: ScenarioEvaluation,
): result is Effect.Effect<ScenarioResult['verdict'], unknown, never> => Effect.isEffect(result)

const EMPTY_OWNER_REGISTRY_LIMITS = Schema.decodeUnknownSync(ReplicatedOwnerRegistryLimitsSchema)({
  maxCollectionItems: MAXIMUM_FRAME_ITEMS,
  maxDeltaBlockChanges: MAXIMUM_FRAME_ITEMS,
  maxDeltaFrameBytes: MAXIMUM_FRAME_BYTES,
  maxDepth: MAXIMUM_FRAME_DEPTH,
  maxRegisteredOwners: MAXIMUM_REPLICATED_OWNERS,
  maxSnapshotBlockReads: MAXIMUM_FRAME_ITEMS,
  maxSnapshotFrameBytes: MAXIMUM_FRAME_BYTES,
  ownerStates: [],
})

const EMPTY_OWNER_REGISTRY = Result.getOrThrow(createReplicatedOwnerRegistry([], EMPTY_OWNER_REGISTRY_LIMITS))

type MutableClientState = {
  id: ScenarioRuntimeClientId
  player: string
  owners: ReplicatedOwnerRegistry | undefined
  connected: boolean
  lastFrame: number
  submitted: number
  received: number
  accepted: number
  rejected: number
  lastDecision: string
}

type MutableAuthorityState = {
  revision: number
  acceptedCommands: number
  rejectedCommands: number
  lastDecision: string
}

type MutableWireLogEntry = {
  sequence: number
  frame: number
  deliveredFrame?: number
  deliverySequence?: number
  from: ScenarioClientId
  to: 'authority'
  tag: string
  text: string
  outcome: ScenarioWireLogEntry['outcome']
  result: string
  faultNotApplied?: string
}

type ScenarioTransportEndpoints = {
  readonly client: TransportService
  readonly authority: TransportService
}

type ScenarioTransportLink = ScenarioTransportEndpoints & {
  readonly scheduledClient: TransportService
}

type ConnectedClient = {
  readonly endpoints: ScenarioTransportEndpoints
  readonly id: ScenarioRuntimeClientId
  readonly identity: ServerConnectionIdentity
  readonly player: string
}

type RuntimeSnapshotMessage = Extract<NetworkMessage, { readonly _tag: 'ReplicatedWorldSnapshot' }>

type ScheduledFrame = {
  readonly sequence: number
  readonly frame: number
  readonly dueFrame: number
  readonly from: ScenarioClientId
  readonly text: string
  readonly owners: ReplicatedOwnerRegistry | undefined
  readonly reorder: boolean
  readonly link: ScenarioTransportEndpoints
  readonly entry: MutableWireLogEntry
}

type QueuedMessage = {
  readonly client: MutableClientState
  readonly frame: number
  readonly from: ScenarioClientId
  readonly link: ScenarioTransportEndpoints
  readonly text: string
  readonly owners: ReplicatedOwnerRegistry | undefined
}

type ScheduledMessage = QueuedMessage & {
  readonly entry: MutableWireLogEntry
  readonly faultApplies: boolean
}

type FaultedFrame = {
  readonly text: string
  readonly faultNotApplied?: string
}

type FutureFrameResult =
  | { readonly text: string }
  | { readonly faultNotApplied: string }

type PreparedResetOptions = {
  readonly clock: ScenarioClock | undefined
  readonly fault: ScenarioRuntimeFault
  readonly frame: number
  readonly panel: ScenarioResult['panel']
  readonly play: boolean
  readonly seed: number
  readonly speed: ScenarioSpeed
}

type CommandApplicationResult = Effect.Success<ReturnType<ReturnType<typeof applyAuthoritativeCommand>>>
type CommandRejectedResult = Exclude<
  CommandApplicationResult,
  { readonly _tag: 'AuthoritativeCommandIntentAccepted' | 'AuthoritativeCommandIntentReplayed' | 'AuthoritativeCommandAccepted' }
>

const worldSnapshot: AuthoritativeSnapshot = {
  _tag: 'AuthoritativeSnapshot',
  containers: [],
  furnaces: [],
  inventories: [],
  revision: WORLD_REVISION,
  timeWeather: { timeOfDay: 0, weather: 'clear' },
  villagerTrades: [],
  vitals: [],
  world: WORLD_ID,
}

const noWorldWrites: WorldWriteServices<never> = {
  entities: {
    despawn: () => Effect.die(new Error('scenario intent validation must not despawn entities')),
    find: () => Effect.die(new Error('scenario intent validation must not read entities')),
  },
  hotbarFor: () => undefined,
  inventoryFor: () => undefined,
  vehiclesFor: () => undefined,
  vitalsFor: () => undefined,
}

const clientPlayer = (clientId: ScenarioRuntimeClientId): string => {
  if (clientId === 'client-a') {
    return 'scenario-player-a'
  }
  if (clientId === 'client-b') {
    return 'scenario-player-b'
  }
  return 'scenario-player-c'
}

const authoritativeRevisionForWorld = (world: WorldId): number | undefined => {
  if (world === WORLD_ID) {
    return WORLD_REVISION
  }
  return undefined
}

const validateFrame = (frame: number): void => {
  if (!Number.isSafeInteger(frame) || frame < MINIMUM_FRAME) {
    throw new RangeError('scenario frame must be a non-negative safe integer')
  }
}

const validateSeed = (seed: number): void => {
  if (!Number.isSafeInteger(seed) || seed < MINIMUM_SEED) {
    throw new RangeError('scenario seed must be a non-negative safe integer')
  }
}

const validateFault = (fault: ScenarioRuntimeFault): void => {
  if (fault.kind === 'delay' && (!Number.isSafeInteger(fault.frames) || fault.frames < MINIMUM_DELAY_FRAMES)) {
    throw new RangeError('delay fault frames must be a positive safe integer')
  }
  if (fault.kind !== 'none' && fault.atFrame !== undefined) {
    validateFrame(fault.atFrame)
  }
}

const legacyScenarioFault = (fault: ScenarioRuntimeFault): ScenarioFault => {
  switch (fault.kind) {
    case 'corrupt':
    case 'version':
    case 'future':
    case 'duplicate':
      return { kind: 'none' }
    default:
      return { ...fault }
  }
}

const scenarioProjectionSnapshot = (revision: number): ReplicatedWorldSnapshot => ({
  _tag: 'ReplicatedWorldSnapshot',
  blocks: [{
    dimension: PROJECTION_DIMENSION,
    position: SCENARIO_PROJECTION_BLOCK_POSITION,
    reading: { _tag: 'Block', block: SCENARIO_PROJECTION_BLOCK_ID },
    state: Schema.decodeUnknownSync(EncodedBlockStateSchema)(ZERO),
  }],
  owners: [],
  revision: Schema.decodeUnknownSync(WorldRevisionSchema)(revision),
  world: WORLD_ID,
})

const copyBlockRead = (block: WorldBlockRead): WorldBlockRead => Object.freeze({
  ...block,
  position: Object.freeze({ ...block.position }),
  reading: Object.freeze({ ...block.reading }),
})

const copySnapshotValue = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return Object.freeze(value.map(copySnapshotValue))
  }
  if (typeof value === 'object' && value !== null) {
    return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, child]) => [key, copySnapshotValue(child)])))
  }
  return value
}

const snapshotClientProjection = (id: ScenarioRuntimeClientId, state: AuthoritativeClientState): ScenarioClientProjection =>
  Object.freeze({
    id,
    worlds: Object.freeze([...state.snapshot.values()].map((world) => Object.freeze({
      blocks: Object.freeze([...world.blocks.entries()].map(([entityId, block]) => Object.freeze({
        block: copyBlockRead(block),
        entityId: String(entityId),
        revision: world.revision,
      }))),
      owners: Object.freeze([...world.owners.entries()].map(([entityId, ownerState]) => Object.freeze({
        entityId,
        revision: world.revision,
        state: copySnapshotValue(ownerState),
      }))),
      revision: world.revision,
      world: String(world.world),
    }))),
  })

const snapshotClient = (client: MutableClientState): ScenarioRuntimeClientState => ({
  accepted: client.accepted,
  connected: client.connected,
  id: client.id,
  lastDecision: client.lastDecision,
  lastFrame: client.lastFrame,
  player: client.player,
  received: client.received,
  rejected: client.rejected,
  submitted: client.submitted,
})

const snapshotScenarioClient = (client: MutableClientState, id: ScenarioClientId): ScenarioClientState => ({
  ...snapshotClient(client),
  id,
})

const sendMessageWithOwners = (message: NetworkMessage, owners: ReplicatedOwnerRegistry) => Effect.gen(function*() {
  const transport = yield* TransportPort
  const frame = yield* Effect.fromResult(encodeFrame(message, owners))
  yield* transport.send(frame)
})

const receiveMessageWithOwners = (owners: ReplicatedOwnerRegistry) => Effect.gen(function*() {
  const transport = yield* TransportPort
  const frame = yield* Queue.take(transport.inbound)
  return yield* Effect.fromResult(decodeFrame(frame, owners))
})

class DeterministicScenarioRuntime implements ScenarioRuntime {
  readonly #definition: ScenarioDefinition
  readonly #identities: Map<ScenarioRuntimeClientId, ServerConnectionIdentity> = new Map()
  readonly #links: Map<ScenarioRuntimeClientId, ScenarioTransportLink> = new Map()
  readonly #clients: Map<ScenarioRuntimeClientId, MutableClientState> = new Map()
  readonly #projections: Map<ScenarioRuntimeClientId, AuthoritativeClientState> = new Map()
  readonly #wireLog: Array<MutableWireLogEntry> = []
  readonly #revisionHistory: Array<ScenarioEntityRevision> = []
  readonly #pending: Array<ScheduledFrame> = []
  #authority = new AuthoritativeSession(() => WORLD_REVISION)
  #authorityState: MutableAuthorityState = {
    acceptedCommands: 0,
    lastDecision: 'no command received',
    rejectedCommands: 0,
    revision: WORLD_REVISION,
  }
  #seed = DEFAULT_SEED
  #fault: ScenarioRuntimeFault = DEFAULT_FAULT
  #speed = DEFAULT_SPEED
  #frame = DEFAULT_FRAME
  #playing = false
  #panel: ScenarioResult['panel'] = DEFAULT_PANEL
  #wireSequence = INITIAL_SEQUENCE
  #deliverySequence = INITIAL_SEQUENCE
  #clock: ScenarioClock

  constructor(definition: ScenarioDefinition, clock?: ScenarioClock) {
    this.#definition = definition
    this.#clock = clock ?? Object.freeze({ now: () => this.#frame })
  }

  get clock(): ScenarioClock {
    return this.#clock
  }

  async initialize(options: ScenarioRuntimeOptions<ScenarioRuntimeFaultKind>): Promise<void> {
    await this.reset(options)
  }

  snapshot(): ScenarioResult {
    const runtimeClients = [...this.#clients.values()].map(snapshotClient)
    const clients = CLIENT_IDS.map((id) => {
      const client = this.#clients.get(id)
      if (client === undefined) {
        throw new Error(`scenario client ${id} has not been initialized`)
      }
      return snapshotScenarioClient(client, id)
    })
    const clientProjections = Object.freeze(
      [...this.#projections.entries()].map(([id, state]) => snapshotClientProjection(id, state)),
    )
    const authority = { ...this.#authorityState }
    const wireLog = this.#wireLog.map((entry) => ({ ...entry }))
    const revisionHistory = Object.freeze(this.#revisionHistory.map((entry) => Object.freeze({ ...entry })))
    const evaluation: ScenarioEvaluationInput = {
      authority,
      clients,
      frame: this.#frame,
      wireLog,
    }
    const evaluationResult = this.#definition.evaluate(evaluation)
    const verdict = isScenarioEffect(evaluationResult)
      ? Effect.runSync(evaluationResult)
      : evaluationResult
    return {
      angle: this.#definition.angle,
      authority,
      clientProjections,
      clients,
      clockNow: this.#clock.now(),
      description: this.#definition.description,
      fault: legacyScenarioFault(this.#fault),
      frame: this.#frame,
      group: this.#definition.group,
      id: this.#definition.id,
      panel: this.#panel,
      playing: this.#playing,
      revisionHistory,
      runtimeClients,
      runtimeFault: { ...this.#fault },
      seed: this.#seed,
      speed: this.#speed,
      title: this.#definition.title,
      verdict,
      wireLog,
    }
  }

  pause(): ScenarioResult {
    this.#playing = false
    return this.snapshot()
  }

  play(): ScenarioResult {
    this.#playing = true
    return this.snapshot()
  }

  async step(): Promise<ScenarioResult> {
    this.#frame += ONE
    await this.#executeFrame()
    return this.snapshot()
  }

  async run(frames: number): Promise<ScenarioResult> {
    validateFrame(frames)
    await Effect.runPromise(this.#runFrames(frames))
    return this.snapshot()
  }

  async join(clientId: ScenarioRuntimeClientId): Promise<ScenarioResult> {
    if (this.#clients.has(clientId)) {
      throw new RangeError(`scenario client ${clientId} is already connected`)
    }
    await this.#connectClient(clientId)
    return this.snapshot()
  }

  #runFrames(frames: number): Effect.Effect<void> {
    let completed = ZERO
    return Effect.whileLoop({
      body: () => Effect.sync(() => { this.#frame += ONE }).pipe(
        Effect.andThen(Effect.promise(() => this.#executeFrame())),
      ),
      step: () => { completed += ONE },
      while: () => completed < frames,
    })
  }

  setSpeed(speed: ScenarioSpeed): ScenarioResult {
    this.#speed = speed
    return this.snapshot()
  }

  async reset(options?: ScenarioRuntimeOptions<ScenarioRuntimeFaultKind>): Promise<ScenarioResult> {
    const targetFrame = this.#prepareReset(options)
    this.#clearTrafficState()
    this.#clearConnections()
    this.#resetAuthority()
    await this.#connectClients()
    await Effect.runPromise(this.#runFrames(targetFrame))
    return this.snapshot()
  }

  #prepareReset(options?: ScenarioRuntimeOptions<ScenarioRuntimeFaultKind>): number {
    const prepared = this.#validateResetOptions(options)
    this.#seed = prepared.seed
    this.#fault = { ...prepared.fault }
    this.#clock = prepared.clock ?? this.#clock
    this.#speed = prepared.speed
    this.#panel = prepared.panel
    this.#playing = prepared.play
    return prepared.frame
  }

  #validateResetOptions(options?: ScenarioRuntimeOptions<ScenarioRuntimeFaultKind>): PreparedResetOptions {
    const frame = options?.frame ?? DEFAULT_FRAME
    validateFrame(frame)
    const seed = options?.seed ?? this.#seed
    validateSeed(seed)
    const fault = options?.fault ?? this.#fault
    validateFault(fault)
    return {
      clock: options?.clock,
      fault,
      frame,
      panel: options?.panel ?? this.#panel,
      play: options?.play ?? false,
      seed,
      speed: options?.speed ?? this.#speed,
    }
  }

  #clearTrafficState(): void {
    this.#frame = DEFAULT_FRAME
    this.#wireSequence = INITIAL_SEQUENCE
    this.#deliverySequence = INITIAL_SEQUENCE
    this.#wireLog.length = ZERO
    this.#revisionHistory.length = ZERO
    this.#pending.length = ZERO
  }

  #clearConnections(): void {
    this.#clients.clear()
    this.#projections.clear()
    this.#links.clear()
    this.#identities.clear()
  }

  #resetAuthority(): void {
    this.#authorityState = {
      acceptedCommands: ZERO,
      lastDecision: 'no command received',
      rejectedCommands: ZERO,
      revision: WORLD_REVISION,
    }
    this.#authority = new AuthoritativeSession(authoritativeRevisionForWorld)
    this.#authority.restore(worldSnapshot)
  }

  async #connectClients(): Promise<void> {
    await Effect.runPromise(Effect.forEach(
      CLIENT_IDS,
      (id) => Effect.promise(() => this.#connectClient(id)),
      { concurrency: 1, discard: true },
    ))
  }

  async #connectClient(id: ScenarioRuntimeClientId): Promise<void> {
    const player = clientPlayer(id)
    const identity = this.#authority.connect(PlayerId.make(player), WORLD_ID)
    const endpoints = await DeterministicScenarioRuntime.#makeEndpoints()
    this.#registerClient({ endpoints, id, identity, player })
    await this.#sendSnapshotToClient(id)
  }

  static async #makeEndpoints(): Promise<ScenarioTransportEndpoints> {
    const [client, authority] = await Effect.runPromise(makeLoopbackPair)
    return { authority, client }
  }

  #registerClient(connection: ConnectedClient): void {
    const { endpoints, id, identity, player } = connection
    const transport: TransportService = {
      inbound: endpoints.client.inbound,
      send: (text) => {
        if (id === 'client-c') {
          return Effect.fail(new TransportError({ detail: 'scenario join client cannot emit catalog actions', reason: 'not-connected' }))
        }
        return this.#schedule(id, endpoints, text)
      },
    }
    this.#links.set(id, { ...endpoints, scheduledClient: transport })
    this.#identities.set(id, identity)
    this.#projections.set(id, new AuthoritativeClientState())
    this.#clients.set(id, {
      accepted: ZERO,
      connected: true,
      id,
      lastDecision: 'connected',
      lastFrame: DEFAULT_FRAME,
      owners: undefined,
      player,
      received: ZERO,
      rejected: ZERO,
      submitted: ZERO,
    })
  }

  async #sendSnapshotToClient(clientId: ScenarioRuntimeClientId): Promise<void> {
    const link = this.#links.get(clientId)
    const projection = this.#projections.get(clientId)
    if (link === undefined || projection === undefined) {
      throw new Error(`scenario client ${clientId} has no snapshot transport`)
    }
    const snapshot = scenarioProjectionSnapshot(this.#authorityState.revision)
    const message = await DeterministicScenarioRuntime.#transferSnapshot(link, snapshot)
    const applied = projection.applySnapshot(message)
    if (!applied.accepted) {
      throw new Error(`scenario client ${clientId} rejected its join snapshot: ${applied.reason}`)
    }
    this.#recordClientRevisionHistory(clientId)
  }

  static async #transferSnapshot(
    link: ScenarioTransportEndpoints,
    snapshot: ReplicatedWorldSnapshot,
  ): Promise<RuntimeSnapshotMessage> {
    const encoded = Result.getOrThrow(encodeFrame(snapshot, EMPTY_OWNER_REGISTRY))
    const sent = await Effect.runPromise(link.authority.send(encoded).pipe(Effect.result))
    if (Result.isFailure(sent)) {
      throw sent.failure
    }
    return DeterministicScenarioRuntime.#receiveSnapshot(link)
  }

  static async #receiveSnapshot(link: ScenarioTransportEndpoints): Promise<RuntimeSnapshotMessage> {
    const received = await Effect.runPromise(receiveMessageWithOwners(EMPTY_OWNER_REGISTRY).pipe(
      Effect.provide(LoopbackTransportLayer(link.client)),
      Effect.result,
    ))
    if (Result.isFailure(received)) {
      throw received.failure
    }
    const message = received.success
    if (message._tag !== 'ReplicatedWorldSnapshot') {
      throw new Error(`scenario snapshot path received ${message._tag}`)
    }
    return message
  }

  #recordClientRevisionHistory(clientId: ScenarioRuntimeClientId): void {
    const projection = this.#projections.get(clientId)
    if (projection === undefined) {
      throw new Error(`scenario client ${clientId} has no client projection`)
    }
    for (const world of projection.snapshot.values()) {
      for (const entityId of world.blocks.keys()) {
        this.#revisionHistory.push({
          clientId,
          entityId: `block:${String(world.world)}:${String(entityId)}`,
          frame: this.#frame,
          revision: world.revision,
        })
      }
      for (const entityId of world.owners.keys()) {
        this.#revisionHistory.push({
          clientId,
          entityId: `owner:${String(world.world)}:${entityId}`,
          frame: this.#frame,
          revision: world.revision,
        })
      }
    }
  }

  #recordRevisionHistory(): void {
    for (const clientId of this.#projections.keys()) {
      this.#recordClientRevisionHistory(clientId)
    }
  }

  #faultMatches(clientId: ScenarioClientId): boolean {
    if (this.#fault.kind === 'none') {
      return false
    }
    if (this.#fault.atFrame !== undefined && this.#fault.atFrame !== this.#frame) {
      return false
    }
    if ('clientId' in this.#fault && this.#fault.clientId !== undefined && this.#fault.clientId !== clientId) {
      return false
    }
    return true
  }

  #schedule(from: ScenarioClientId, link: ScenarioTransportEndpoints, text: string): Effect.Effect<void, TransportError> {
    return Effect.suspend(() => this.#scheduleMessage(from, link, text))
  }

  #scheduleMessage(
    from: ScenarioClientId,
    link: ScenarioTransportEndpoints,
    text: string,
  ): Effect.Effect<void, TransportError> {
    const client = this.#clients.get(from)
    if (client === undefined) {
      return Effect.fail(new TransportError({ detail: `unknown scenario client ${from}`, reason: 'not-connected' }))
    }
    const frame = this.#frame
    const queued: QueuedMessage = { client, frame, from, link, owners: client.owners, text }
    const entry = this.#recordQueuedMessage(queued)
    return this.#applyScheduleFault({ ...queued, entry, faultApplies: this.#faultMatches(from) })
  }

  #recordQueuedMessage(queued: QueuedMessage): MutableWireLogEntry {
    const entry = this.#newQueuedEntry(queued)
    this.#wireSequence = entry.sequence
    this.#wireLog.push(entry)
    queued.client.submitted += ONE
    queued.client.lastFrame = queued.frame
    return entry
  }

  #newQueuedEntry(queued: QueuedMessage): MutableWireLogEntry {
    const decoded = decodeFrame(queued.text, queued.owners)
    let tag = '?'
    if (Result.isSuccess(decoded)) {
      tag = decoded.success._tag
    }
    return {
      frame: queued.frame,
      from: queued.from,
      outcome: 'queued',
      result: 'queued at transport boundary',
      sequence: this.#wireSequence + ONE,
      tag,
      text: queued.text,
      to: 'authority',
    }
  }

  #applyScheduleFault(message: ScheduledMessage): Effect.Effect<void, TransportError> {
    if (!message.client.connected || (message.faultApplies && this.#fault.kind === 'disconnect')) {
      return DeterministicScenarioRuntime.#disconnectBeforeDelivery(message.client, message.entry)
    }
    if (message.faultApplies && this.#fault.kind === 'drop') {
      return DeterministicScenarioRuntime.#dropAtTransport(message.entry)
    }
    if (message.faultApplies && ['corrupt', 'version', 'future'].includes(this.#fault.kind)) {
      return this.#applyEncodedFault(message)
    }
    return this.#queueForDelivery(message)
  }

  #applyEncodedFault(message: ScheduledMessage): Effect.Effect<void, TransportError> {
    const faulted = this.#faultEncodedFrame(message.text, message.owners, message.entry.tag)
    if (faulted.faultNotApplied !== undefined) {
      message.entry.faultNotApplied = faulted.faultNotApplied
    }
    message.entry.text = faulted.text
    return this.#queueForDelivery({ ...message, text: faulted.text })
  }

  #faultEncodedFrame(
    text: string,
    owners: ReplicatedOwnerRegistry | undefined,
    tag: string,
  ): FaultedFrame {
    if (this.#fault.kind === 'corrupt') {
      return { text: text.slice(ZERO, -ONE) }
    }
    const decoded = decodeFrame(text, owners)
    if (Result.isFailure(decoded)) {
      return this.#faultNotApplicable(text, tag)
    }
    return this.#faultDecodedFrame(text, decoded.success, owners)
  }

  #faultNotApplicable(text: string, tag: string): FaultedFrame {
    if (this.#fault.kind === 'version' || this.#fault.kind === 'future') {
      return { faultNotApplied: `fault '${this.#fault.kind}' not applicable to ${tag}`, text }
    }
    return { text }
  }

  #faultDecodedFrame(text: string, message: NetworkMessage, owners: ReplicatedOwnerRegistry | undefined): FaultedFrame {
    if (this.#fault.kind === 'version') {
      return { text: Result.getOrThrow(encodeFrameAsVersion(PROTOCOL_VERSION - ONE, message, owners)) }
    }
    if (this.#fault.kind === 'future') {
      return DeterministicScenarioRuntime.#applyFutureFault(text, message, owners)
    }
    return { text }
  }

  static #applyFutureFault(text: string, message: NetworkMessage, owners: ReplicatedOwnerRegistry | undefined): FaultedFrame {
    const future = DeterministicScenarioRuntime.#futureFrame(message, owners)
    if ('faultNotApplied' in future) {
      return { faultNotApplied: future.faultNotApplied, text }
    }
    return future
  }

  static #futureFrame(
    message: NetworkMessage,
    owners: ReplicatedOwnerRegistry | undefined,
  ): FutureFrameResult {
    if (Schema.is(AuthoritativeCommand)(message)) {
      const futureCommand = {
        ...message,
        expectedRevision: Schema.decodeUnknownSync(Revision)(message.expectedRevision + ONE),
      }
      return { text: Result.getOrThrow(encodeFrame(futureCommand, owners)) }
    }
    if (message._tag === 'ReplicatedWorldDelta' || message._tag === 'ReplicatedWorldSnapshot') {
      const futureMessage = {
        ...message,
        revision: Schema.decodeUnknownSync(WorldRevisionSchema)(message.revision + ONE),
      }
      return { text: Result.getOrThrow(encodeFrame(futureMessage, owners)) }
    }
    return { faultNotApplied: `fault 'future' not applicable to ${message._tag}` }
  }

  static #disconnectBeforeDelivery(
    client: MutableClientState,
    entry: MutableWireLogEntry,
  ): Effect.Effect<void, TransportError> {
    client.connected = false
    client.lastDecision = 'transport disconnected before delivery'
    entry.outcome = 'disconnected'
    entry.result = 'transport refused send: not-connected'
    return Effect.fail(new TransportError({ detail: 'scenario transport is disconnected', reason: 'not-connected' }))
  }

  static #dropAtTransport(entry: MutableWireLogEntry): Effect.Effect<void, TransportError> {
    entry.outcome = 'dropped'
    entry.result = 'dropped at transport boundary'
    return Effect.void
  }

  #queueForDelivery(message: ScheduledMessage): Effect.Effect<void, TransportError> {
    const delay = this.#delayForFault(message.faultApplies)
    const reorder = this.#reorderForFault(message.faultApplies)
    if (delay > ZERO) {
      message.entry.outcome = 'delayed'
      message.entry.result = `delayed by ${String(delay)} logical frame(s)`
    }
    const scheduled: ScheduledFrame = {
      dueFrame: message.frame + delay,
      entry: message.entry,
      frame: message.frame,
      from: message.from,
      link: message.link,
      owners: message.owners,
      reorder,
      sequence: message.entry.sequence,
      text: message.text,
    }
    this.#pending.push(scheduled)
    this.#queueDuplicateIfNeeded(message, scheduled, delay)
    return Effect.void
  }

  #queueDuplicateIfNeeded(message: ScheduledMessage, scheduled: ScheduledFrame, delay: number): void {
    if (!message.faultApplies || this.#fault.kind !== 'duplicate') {
      return
    }
    let outcome: MutableWireLogEntry['outcome'] = 'queued'
    if (delay > ZERO) {
      outcome = 'delayed'
    }
    const duplicateEntry: MutableWireLogEntry = {
      frame: message.frame,
      from: message.from,
      outcome,
      result: 'duplicate frame queued at transport boundary',
      sequence: this.#wireSequence + ONE,
      tag: message.entry.tag,
      text: message.text,
      to: 'authority',
    }
    this.#wireSequence = duplicateEntry.sequence
    message.client.submitted += ONE
    this.#wireLog.push(duplicateEntry)
    this.#pending.push({ ...scheduled, entry: duplicateEntry, sequence: duplicateEntry.sequence })
  }

  #delayForFault(faultApplies: boolean): number {
    if (faultApplies && this.#fault.kind === 'delay') {
      return this.#fault.frames
    }
    return ZERO
  }

  #reorderForFault(faultApplies: boolean): boolean {
    return faultApplies && this.#fault.kind === 'reorder'
  }

  async #executeFrame(): Promise<void> {
    const context: ScenarioStepContext = {
      clients: CLIENT_IDS.map((id) => ({ id, player: clientPlayer(id) })),
      frame: this.#frame,
      seed: this.#seed,
    }
    const actions = this.#definition.actions(context)
    await Effect.runPromise(Effect.forEach(
      actions,
      (action) => Effect.promise(() => this.#sendAction(action)),
      { concurrency: 1, discard: true },
    ))
    await this.#deliverPending()
    this.#recordRevisionHistory()
  }

  async #sendAction(action: ScenarioAction): Promise<void> {
    const { client, link } = this.#transportForAction(action)
    client.owners = DeterministicScenarioRuntime.#ownersForAction(action)
    await this.#sendAndRecordFailure(action, client, link)
  }

  #transportForAction(action: ScenarioAction): { readonly client: MutableClientState; readonly link: ScenarioTransportLink } {
    const link = this.#links.get(action.clientId)
    const client = this.#clients.get(action.clientId)
    if (link === undefined || client === undefined) {
      throw new RangeError(`scenario action references unknown client ${action.clientId}`)
    }
    return { client, link }
  }

  static #ownersForAction(action: ScenarioAction): ReplicatedOwnerRegistry | undefined {
    if (action.kind === 'message') {
      return action.owners
    }
    return undefined
  }

  async #sendAndRecordFailure(action: ScenarioAction, client: MutableClientState, link: ScenarioTransportLink): Promise<void> {
    const oldLogLength = this.#wireLog.length
    const sent = await Effect.runPromise(DeterministicScenarioRuntime.#sendEffect(action, link).pipe(Effect.result))
    if (Result.isFailure(sent)) {
      this.#recordSendFailure({ action, client, oldLogLength, reason: sent.failure.reason })
    }
  }

  static #sendEffect(action: ScenarioAction, link: ScenarioTransportLink) {
    if (action.kind === 'message') {
      return DeterministicScenarioRuntime.#sendMessageEffect(action, link)
    }
    return link.scheduledClient.send(action.text)
  }

  static #sendMessageEffect(action: Extract<ScenarioAction, { readonly kind: 'message' }>, link: ScenarioTransportLink) {
    if (action.owners === undefined) {
      return sendMessage(action.message).pipe(Effect.provide(LoopbackTransportLayer(link.scheduledClient)))
    }
    return sendMessageWithOwners(action.message, action.owners).pipe(Effect.provide(LoopbackTransportLayer(link.scheduledClient)))
  }

  #recordSendFailure(sendFailure: {
    readonly action: ScenarioAction
    readonly client: MutableClientState
    readonly oldLogLength: number
    readonly reason: string
  }): void {
    const { action, client, oldLogLength, reason } = sendFailure
    client.lastDecision = `send refused: ${reason}`
    if (oldLogLength === this.#wireLog.length) {
      this.#recordRejectedSend(action, client, reason)
    }
  }

  #recordRejectedSend(action: ScenarioAction, client: MutableClientState, reason: string): void {
    client.submitted += ONE
    client.rejected += ONE
    this.#wireSequence += ONE
    this.#wireLog.push({
      frame: this.#frame,
      from: action.clientId,
      outcome: 'rejected',
      result: `codec refused frame: ${reason}`,
      sequence: this.#wireSequence,
      tag: DeterministicScenarioRuntime.#actionTag(action),
      text: '',
      to: 'authority',
    })
  }

  static #actionTag(action: ScenarioAction): string {
    if (action.kind === 'message') {
      return action.message._tag
    }
    return '?'
  }

  async #deliverPending(): Promise<void> {
    const ready = this.#pending.filter((frame) => frame.dueFrame <= this.#frame)
    const waiting = this.#pending.filter((frame) => frame.dueFrame > this.#frame)
    this.#pending.length = 0
    this.#pending.push(...waiting)
    const reorder = ready.some((frame) => frame.reorder)
    const deliveries = [...ready].sort((left, right) =>
      DeterministicScenarioRuntime.#compareDeliveryOrder(left, right, reorder))
    const delivered: Array<ScheduledFrame> = []
    await Effect.runPromise(Effect.forEach(
      deliveries,
      (frame) => Effect.promise(() => this.#deliverFrame(frame, delivered)),
      { concurrency: 1, discard: true },
    ))
    await Effect.runPromise(Effect.forEach(
      delivered,
      (frame) => Effect.promise(() => this.#receiveFrame(frame)),
      { concurrency: 1, discard: true },
    ))
  }

  static #compareDeliveryOrder(left: ScheduledFrame, right: ScheduledFrame, reorder: boolean): number {
    if (reorder) {
      return right.sequence - left.sequence
    }
    return left.sequence - right.sequence
  }

  async #deliverFrame(frame: ScheduledFrame, delivered: Array<ScheduledFrame>): Promise<void> {
    const sent = await Effect.runPromise(frame.link.client.send(frame.text).pipe(Effect.result))
    if (Result.isFailure(sent)) {
      this.#recordDeliveryFailure(frame, sent.failure.reason)
      return
    }
    this.#recordDeliverySuccess(frame, delivered)
  }

  #recordDeliveryFailure(frame: ScheduledFrame, reason: string): void {
    const client = this.#clients.get(frame.from)
    if (client !== undefined) {
      client.connected = false
      client.lastDecision = `transport refused delivery: ${reason}`
    }
    frame.entry.outcome = 'disconnected'
    frame.entry.result = `authority transport refused frame: ${reason}`
  }

  #recordDeliverySuccess(frame: ScheduledFrame, delivered: Array<ScheduledFrame>): void {
    frame.entry.deliveredFrame = this.#frame
    this.#deliverySequence += ONE
    frame.entry.deliverySequence = this.#deliverySequence
    frame.entry.outcome = 'delivered'
    frame.entry.result = 'delivered to authority transport'
    delivered.push(frame)
  }

  async #receiveFrame(frame: ScheduledFrame): Promise<void> {
    const client = this.#clientForFrame(frame)
    await this.#processReceivedFrame(frame, client)
  }

  #clientForFrame(frame: ScheduledFrame): MutableClientState {
    const client = this.#clients.get(frame.from)
    if (client === undefined) {
      throw new Error(`scenario client ${frame.from} disappeared during frame delivery`)
    }
    return client
  }

  async #processReceivedFrame(frame: ScheduledFrame, client: MutableClientState): Promise<void> {
    const received = await Effect.runPromise(DeterministicScenarioRuntime.#receiveEffect(frame).pipe(
      Effect.provide(LoopbackTransportLayer(frame.link.authority)),
      Effect.result,
    ))
    client.lastFrame = this.#frame
    if (Result.isFailure(received)) {
      DeterministicScenarioRuntime.#recordProtocolFailure(frame, client, received.failure.reason)
      return
    }
    client.received += ONE
    await this.#applyAuthority(frame, client, received.success)
  }

  static #receiveEffect(frame: ScheduledFrame) {
    if (frame.owners === undefined) {
      return receiveMessage
    }
    return receiveMessageWithOwners(frame.owners)
  }

  static #recordProtocolFailure(frame: ScheduledFrame, client: MutableClientState, reason: string): void {
    client.rejected += ONE
    client.lastDecision = `protocol rejected frame: ${reason}`
    frame.entry.outcome = 'rejected'
    frame.entry.result = `decode rejected: ${reason}`
  }

  async #applyAuthority(
    frame: ScheduledFrame,
    client: MutableClientState,
    message: NetworkMessage,
  ): Promise<void> {
    if (!Schema.is(AuthoritativeCommand)(message)) {
      DeterministicScenarioRuntime.#recordNonCommand(frame, client, message)
      return
    }
    const identity = this.#authorityIdentity(client.id)
    const context = this.#commandContext(identity)
    const result = await Effect.runPromise(
      applyAuthoritativeCommand(this.#authority, noWorldWrites, context)(message),
    )
    this.#recordAuthorityResult(frame, client, result)
  }

  static #recordNonCommand(frame: ScheduledFrame, client: MutableClientState, message: NetworkMessage): void {
    client.lastDecision = `received ${message._tag}`
    frame.entry.result = `decoded ${message._tag}`
  }

  #authorityIdentity(clientId: ScenarioRuntimeClientId): ServerConnectionIdentity {
    const identity = this.#identities.get(clientId)
    if (identity === undefined) {
      throw new Error(`scenario client ${clientId} has no authority identity`)
    }
    return identity
  }

  #commandContext(identity: ServerConnectionIdentity): CommandIntentContext {
    return {
      expectedDimensionRevision: Schema.decodeUnknownSync(DimensionRevisionSchema)(DEFAULT_EXPECTED_DIMENSION_REVISION),
      identity,
      targetTick: Schema.decodeUnknownSync(SimulationTickSchema)(this.#frame),
    }
  }

  #recordAuthorityResult(
    frame: ScheduledFrame,
    client: MutableClientState,
    result: CommandApplicationResult,
  ): void {
    if (result._tag === 'AuthoritativeCommandIntentAccepted') {
      this.#recordIntentAccepted(frame, client)
      return
    }
    if (result._tag === 'AuthoritativeCommandIntentReplayed') {
      this.#recordIntentReplay(frame, client)
      return
    }
    if (result._tag === 'AuthoritativeCommandAccepted') {
      this.#recordCommandAccepted(frame, client)
      return
    }
    this.#recordCommandRejected(frame, client, result)
  }

  #recordIntentAccepted(frame: ScheduledFrame, client: MutableClientState): void {
    client.accepted += ONE
    client.lastDecision = 'authority accepted canonical intent; world state was not applied'
    this.#authorityState.acceptedCommands += ONE
    this.#authorityState.lastDecision = 'canonical C2 intent accepted; world state was not applied'
    frame.entry.outcome = 'accepted'
    frame.entry.result = 'authority accepted canonical intent; world state was not applied'
  }

  #recordIntentReplay(frame: ScheduledFrame, client: MutableClientState): void {
    client.lastDecision = 'authority recognized accepted intent replay'
    this.#authorityState.lastDecision = 'accepted intent replay acknowledged'
    frame.entry.result = 'authority acknowledged accepted intent replay'
  }

  #recordCommandAccepted(frame: ScheduledFrame, client: MutableClientState): void {
    client.accepted += ONE
    client.lastDecision = 'authority accepted command'
    this.#authorityState.acceptedCommands += ONE
    this.#authorityState.lastDecision = 'command accepted'
    frame.entry.outcome = 'accepted'
    frame.entry.result = 'authority accepted command'
  }

  #recordCommandRejected(
    frame: ScheduledFrame,
    client: MutableClientState,
    result: CommandRejectedResult,
  ): void {
    client.rejected += ONE
    if (result._tag === 'CommandUnsupported') {
      client.lastDecision = `authority marked command unsupported: ${result.reason}`
    } else {
      client.lastDecision = `authority rejected command: ${result.reason}`
    }
    this.#authorityState.rejectedCommands += ONE
    this.#authorityState.lastDecision = client.lastDecision
    frame.entry.outcome = 'rejected'
    frame.entry.result = client.lastDecision
  }
}

export const createScenarioRuntime = async (
  definition: ScenarioDefinition,
  options: ScenarioRuntimeOptions<ScenarioRuntimeFaultKind>,
): Promise<ScenarioRuntime> => {
  validateSeed(options.seed)
  validateFault(options.fault ?? DEFAULT_FAULT)
  const runtime = new DeterministicScenarioRuntime(definition)
  await runtime.initialize(options)
  return runtime
}

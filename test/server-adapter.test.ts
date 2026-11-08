/* eslint-disable no-magic-numbers -- The small fixtures identify exact protocol, rate, and AOI boundaries. */
import { describe, expect, it } from '@effect/vitest'
import * as fc from 'fast-check'
import { Effect, Result, Schema } from 'effect'
import {
  BlockIdSchema,
  BlockPositionSchema,
  decodeBlockState,
  DimensionRevisionSchema,
  EncodedBlockStateSchema,
  SimulationTickSchema,
  WorldIdSchema as KernelWorldIdSchema,
  WorldRevisionSchema,
} from '@nerima-games/mc-kernel'
import { makeReplicatedOwnerId } from '@nerima-games/mc-sim'
import type { WorldBlockRead } from '@nerima-games/mc-sim'
import {
  AuthoritativeSession,
  CommandId,
  EntityId,
  PlayerId,
  createReplicatedOwnerRegistry,
  ReplicatedOwnerRegistryLimitsSchema,
  WorldId,
  createServerAdapter,
  encodeFrame,
  type AuthoritativeSnapshot,
  type ReplicatedOwnerRegistryLimits,
  type ServerAdapterConfiguration,
  type ServerOwnerLocationIndex,
  type ServerOwnerLocationResolution,
  type ReplicatedWorldSnapshot,
} from '../src/index.js'
import type { WorldWriteServices } from '../src/application/server/command-application.js'

const WORLD = WorldId.make('adapter-world')
const KERNEL_WORLD = Schema.decodeUnknownSync(KernelWorldIdSchema)('adapter-world')
const PLAYER_A = PlayerId.make('alice')
const PLAYER_B = PlayerId.make('bob')
const OWNER_A = makeReplicatedOwnerId('owner:alice')
const OWNER_B = makeReplicatedOwnerId('owner:bob')
const AIR_BLOCK_ID = Schema.decodeUnknownSync(BlockIdSchema)(0)
const BLOCK_ID = Schema.decodeUnknownSync(BlockIdSchema)(106)
const AIR_BLOCK_INCOMPATIBLE_STATE = Schema.decodeUnknownSync(EncodedBlockStateSchema)(1)
const emptyOwnerRegistryLimits: ReplicatedOwnerRegistryLimits = Schema.decodeUnknownSync(ReplicatedOwnerRegistryLimitsSchema)({
  maxRegisteredOwners: 0,
  maxDeltaBlockChanges: 320,
  maxSnapshotBlockReads: 3_422_759,
  maxDepth: 13,
  maxCollectionItems: 31_149,
  maxDeltaFrameBytes: 54_489,
  maxSnapshotFrameBytes: 3_422_759,
  ownerStates: [],
})

const ownerRegistry = Result.getOrThrow(createReplicatedOwnerRegistry([], emptyOwnerRegistryLimits))
const emptyLocations: ServerOwnerLocationIndex = new Map()
const EMPTY_SERVICES: WorldWriteServices<never> = {
  entities: {
    find: () => Effect.die(new Error('unexpected entity lookup')),
    despawn: () => Effect.die(new Error('unexpected entity despawn')),
  },
  vitalsFor: () => undefined,
  inventoryFor: () => undefined,
  hotbarFor: () => undefined,
  vehiclesFor: () => undefined,
}

const inventory = (item: string) => ({ slots: [{ item, count: 1 }], selectedSlot: 0 })
const vitals = (health: number) => ({ experience: 0, health, hunger: 20 })

const authoritativeSnapshot = (
  inventories: AuthoritativeSnapshot['inventories'] = [
    { player: PLAYER_A, state: inventory('alice_item') },
    { player: PLAYER_B, state: inventory('bob_item') },
  ],
  playerVitals: AuthoritativeSnapshot['vitals'] = [
    { player: PLAYER_A, state: vitals(7) },
    { player: PLAYER_B, state: vitals(19) },
  ],
): AuthoritativeSnapshot => ({
  _tag: 'AuthoritativeSnapshot',
  containers: [],
  entities: [],
  furnaces: [],
  inventories,
  revision: 4,
  timeWeather: { timeOfDay: 6_000, weather: 'clear' },
  villagerTrades: [],
  vitals: playerVitals,
  world: WORLD,
})

const replicatedSnapshot = (
  owners: ReplicatedWorldSnapshot['owners'] = [],
  blocks: ReadonlyArray<WorldBlockRead> = [],
) => ({
  _tag: 'ReplicatedWorldSnapshot' as const,
  blocks,
  owners,
  revision: Schema.decodeUnknownSync(WorldRevisionSchema)(4),
  world: KERNEL_WORLD,
})

const snapshotInputs = (
  replicatedWorld: unknown = replicatedSnapshot(),
  locations: ServerOwnerLocationIndex = emptyLocations,
) => ({ locations, replicatedWorld })

const makeAdapter = (
  interestInputFor: ServerAdapterConfiguration<never>['interestInputFor'] = (_identity, player) => ({
    chunks: [{ dimension: player === PLAYER_A ? 'nether' : 'overworld', x: 0, z: 0 }],
    ownerIds: [],
  }),
  blockStatesForChange: ServerAdapterConfiguration<never>['blockStatesForChange'] = () => Result.succeed({
    afterState: Schema.decodeUnknownSync(EncodedBlockStateSchema)(16),
    beforeState: Schema.decodeUnknownSync(EncodedBlockStateSchema)(0),
  }),
  blockStateForRead: ServerAdapterConfiguration<never>['blockStateForRead'] = () =>
    Result.succeed(Schema.decodeUnknownSync(EncodedBlockStateSchema)(0)),
) => {
  const session = new AuthoritativeSession((world) => world === WORLD ? 4 : undefined)
  session.restore(authoritativeSnapshot())
  const config: ServerAdapterConfiguration<never> = {
    commandContextFor: (identity) => ({
      expectedDimensionRevision: Schema.decodeUnknownSync(DimensionRevisionSchema)(3),
      identity,
      targetTick: Schema.decodeUnknownSync(SimulationTickSchema)(12),
    }),
    commandServices: EMPTY_SERVICES,
    blockStatesForChange,
    blockStateForRead,
    interestInputFor,
    ownerRegistry,
    reconnectAuth: { resume: () => Effect.succeed(undefined) },
    session,
  }
  return createServerAdapter(config)
}

const connected = (adapter: ReturnType<typeof makeAdapter>, player: typeof PLAYER_A) => {
  const result = adapter.connect(player, WORLD)
  if (result._tag !== 'Connected') {
    throw new Error('expected connection to be admitted')
  }
  return result.connection
}

const makeFrame = (message: unknown) => {
  const result = encodeFrame(message, ownerRegistry)
  if (Result.isFailure(result)) {
    throw result.failure
  }
  return result.success
}

const locatedAt = (dimension: Extract<ServerOwnerLocationResolution, { readonly _tag: 'Located' }>['dimension'],
  x: number,
  z: number,
): ServerOwnerLocationResolution => ({
  _tag: 'Located',
  blockPosition: Schema.decodeUnknownSync(BlockPositionSchema)({ x, y: 64, z }),
  dimension,
})

describe('createServerAdapter', () => {
  it('projects private inventory and vitals only to their owner', () => {
    const adapter = makeAdapter()
    const connectionB = connected(adapter, PLAYER_B)

    const projected = Result.getOrThrow(adapter.projectSnapshot(
      connectionB,
      authoritativeSnapshot(),
      snapshotInputs(),
    ))

    expect(projected.connection).toBe(connectionB)
    expect(projected.snapshot.authoritative.inventories).toEqual([
      { player: PLAYER_B, state: inventory('bob_item') },
    ])
    expect(projected.snapshot.authoritative.vitals).toEqual([
      { player: PLAYER_B, state: vitals(19) },
    ])
  })

  it('property-checks recipient snapshots against an independently filtered private-state oracle', () => {
    fc.assert(fc.property(
      fc.array(fc.integer({ min: 0, max: 20 }), { minLength: 1, maxLength: 12 }),
      (healthValues) => {
        const foreignPlayers = healthValues.map((_, index) => PlayerId.make(`foreign-${index}`))
        const inventoryEntries = [
          { player: PLAYER_B, state: inventory('recipient') },
          ...foreignPlayers.map((player, index) => ({ player, state: inventory(`private-${index}`) })),
        ]
        const vitalEntries = [
          { player: PLAYER_B, state: vitals(healthValues[0] ?? 0) },
          ...foreignPlayers.map((player, index) => ({ player, state: vitals(healthValues[index] ?? 0) })),
        ]
        const snapshot = authoritativeSnapshot(inventoryEntries, vitalEntries)
        const expectedInventories = snapshot.inventories.filter((entry) => entry.player === PLAYER_B)
        const expectedVitals = snapshot.vitals.filter((entry) => entry.player === PLAYER_B)
        const adapter = makeAdapter()
        const connectionB = connected(adapter, PLAYER_B)
        const projected = adapter.projectSnapshot(connectionB, snapshot, snapshotInputs())

        expect(Result.isSuccess(projected)).toBe(true)
        if (Result.isSuccess(projected)) {
          expect(projected.success.snapshot.authoritative.inventories).toEqual(expectedInventories)
          expect(projected.success.snapshot.authoritative.vitals).toEqual(expectedVitals)
        }
      },
    ))
  })

  it('filters entity owners by resolved dimension and chunk, omitting only explicit absence', () => {
    const adapter = makeAdapter()
    const connectionB = connected(adapter, PLAYER_B)
    const snapshot = authoritativeSnapshot()
    const entities = [
      { _tag: 'living' as const, at: { x: 0, y: 64, z: 0 }, entityId: EntityId.make('owner:alice'), entityType: 'zombie', health: 20, maxHealth: 20 },
      { _tag: 'living' as const, at: { x: 0, y: 64, z: 0 }, entityId: EntityId.make('owner:bob'), entityType: 'zombie', health: 20, maxHealth: 20 },
    ]
    const authoritativeWithEntities = { ...snapshot, entities }
    const worldWithOwners = replicatedSnapshot([
      { owner: OWNER_A, state: { value: 1 } },
      { owner: OWNER_B, state: { value: 2 } },
    ])
    const locations: ServerOwnerLocationIndex = new Map([
      [OWNER_A, { _tag: 'Absent' }],
      [OWNER_B, locatedAt('overworld', 0, 0)],
    ])

    const projected = Result.getOrThrow(adapter.projectSnapshot(
      connectionB,
      authoritativeWithEntities,
      snapshotInputs(worldWithOwners, locations),
    ))

    expect(projected.snapshot.authoritative.entities?.map((entity) => entity.entityId)).toEqual([EntityId.make('owner:bob')])
    expect(projected.snapshot.replicatedWorld.owners.map((owner) => owner.owner)).toEqual([OWNER_B])
  })

  it('refuses a missing owner location instead of treating it as absent or visible', () => {
    const adapter = makeAdapter()
    const connectionB = connected(adapter, PLAYER_B)
    const worldWithOwner = replicatedSnapshot([{ owner: OWNER_B, state: { value: 2 } }])

    expect(adapter.projectSnapshot(connectionB, authoritativeSnapshot(), snapshotInputs(worldWithOwner))).toMatchObject({
      _tag: 'Failure',
      failure: { _tag: 'ServerProjectionRefused', reason: 'missing-owner-location' },
    })
  })

  it('accepts ID-only snapshot reads and enriches them from server state', () => {
    const blockRead = {
      dimension: 'overworld' as const,
      position: Schema.decodeUnknownSync(BlockPositionSchema)({ x: 0, y: 64, z: 0 }),
      reading: { _tag: 'Block' as const, block: BLOCK_ID },
    }
    const snapshot = replicatedSnapshot([], [blockRead])
    expect(blockRead).not.toHaveProperty('state')
    const adapter = makeAdapter()
    const connectionB = connected(adapter, PLAYER_B)
    const projected = Result.getOrThrow(adapter.projectSnapshot(
      connectionB,
      authoritativeSnapshot(),
      snapshotInputs(snapshot),
    ))

    expect(projected.snapshot.replicatedWorld.blocks).toMatchObject([{ reading: { _tag: 'Block', block: BLOCK_ID }, state: 0 }])

    const missingStateAdapter = makeAdapter(undefined, undefined, () => Result.fail('snapshot state unavailable'))
    const missingStateConnection = connected(missingStateAdapter, PLAYER_B)
    expect(missingStateAdapter.projectSnapshot(
      missingStateConnection,
      authoritativeSnapshot(),
      snapshotInputs(snapshot),
    )).toMatchObject({
      _tag: 'Failure',
      failure: { _tag: 'ServerProjectionRefused', reason: 'invalid-block-state' },
    })
  })

  it('refuses a schema-valid snapshot state that is incompatible with its block ID', () => {
    expect(Result.isFailure(decodeBlockState(AIR_BLOCK_ID, AIR_BLOCK_INCOMPATIBLE_STATE))).toBe(true)
    const blockRead = {
      dimension: 'overworld' as const,
      position: Schema.decodeUnknownSync(BlockPositionSchema)({ x: 0, y: 64, z: 0 }),
      reading: { _tag: 'Block' as const, block: AIR_BLOCK_ID },
    }
    const snapshot = replicatedSnapshot([], [blockRead])
    const invalidStateAdapter = makeAdapter(
      undefined,
      undefined,
      () => Result.succeed(AIR_BLOCK_INCOMPATIBLE_STATE),
    )
    const connectionB = connected(invalidStateAdapter, PLAYER_B)

    expect(invalidStateAdapter.projectSnapshot(
      connectionB,
      authoritativeSnapshot(),
      snapshotInputs(snapshot),
    )).toMatchObject({
      _tag: 'Failure',
      failure: { _tag: 'ServerProjectionRefused', reason: 'invalid-block-state' },
    })
  })

  it('rejects a missing token and never resumes from a supplied player name', async () => {
    const adapter = makeAdapter()

    expect(await Effect.runPromise(adapter.resume(undefined))).toEqual({
      _tag: 'ResumeRejected',
      reason: 'missing-token',
    })
    expect(await Effect.runPromise(adapter.resume({ player: PLAYER_A }))).toEqual({
      _tag: 'ResumeRejected',
      reason: 'invalid-token',
    })
  })

  it('limits chat to three frames per ten seconds and returns the warning policy', async () => {
    const adapter = makeAdapter()
    const connectionA = connected(adapter, PLAYER_A)
    const connectionB = connected(adapter, PLAYER_B)
    const frame = makeFrame({ _tag: 'Chat', player: PLAYER_A, text: 'hello' })

    const acceptedChats = await Promise.all(Array.from(
      { length: 3 },
      () => Effect.runPromise(adapter.receiveFrame(connectionA, frame)),
    ))
    expect(acceptedChats.map(({ _tag }) => _tag)).toEqual(['ChatReceived', 'ChatReceived', 'ChatReceived'])
    expect(await Effect.runPromise(adapter.receiveFrame(connectionA, frame))).toMatchObject({
      _tag: 'RateLimited',
      action: 'warn',
      kind: 'chat',
    })
    expect(await Effect.runPromise(adapter.receiveFrame(
      connectionB,
      makeFrame({ _tag: 'Chat', player: PLAYER_B, text: 'independent' }),
    ))).toMatchObject({ _tag: 'ChatReceived' })
  })

  it('rejects a movement frame that names a different world', async () => {
    const adapter = makeAdapter()
    const connectionA = connected(adapter, PLAYER_A)
    const frame = makeFrame({
      _tag: 'PlayerMove',
      at: { x: 0.5, y: 65, z: 0.5 },
      facing: { pitchRadians: 0, yawRadians: 0 },
      player: PLAYER_A,
      world: WorldId.make('other-adapter-world'),
    })

    expect(await Effect.runPromise(adapter.receiveFrame(connectionA, frame))).toMatchObject({
      _tag: 'ConnectionRefused',
      reason: 'wrong-world',
    })
  })

  it('routes every AuthoritativeCommand through command application', async () => {
    const adapter = makeAdapter()
    const connectionA = connected(adapter, PLAYER_A)
    const frame = makeFrame({
      _tag: 'PlayerInventoryCommand',
      action: { _tag: 'select-slot', slot: 0 },
      commandId: CommandId.make('inventory-command'),
      expectedRevision: 4,
      player: PLAYER_A,
      world: WORLD,
    })

    expect(await Effect.runPromise(adapter.receiveFrame(connectionA, frame))).toMatchObject({
      _tag: 'CommandApplied',
      outcome: { _tag: 'CommandUnsupported', commandTag: 'PlayerInventoryCommand' },
    })
  })

  it('accepts ID-only deltas, enriches state-only changes, and targets the recipient AOI', () => {
    const adapter = makeAdapter()
    const connectionA = connected(adapter, PLAYER_A)
    const connectionB = connected(adapter, PLAYER_B)
    const snapshot = authoritativeSnapshot()
    const worldSnapshot = replicatedSnapshot()
    expect(Result.isSuccess(adapter.projectSnapshot(connectionA, snapshot, snapshotInputs(worldSnapshot)))).toBe(true)
    expect(Result.isSuccess(adapter.projectSnapshot(connectionB, snapshot, snapshotInputs(worldSnapshot)))).toBe(true)

    const stateOnlyDelta = {
      _tag: 'ReplicatedWorldDelta',
      blockChanges: [{
        after: BLOCK_ID,
        before: BLOCK_ID,
        dimension: 'overworld',
        position: Schema.decodeUnknownSync(BlockPositionSchema)({ x: 0, y: 64, z: 0 }),
      }],
      changes: [],
      revision: Schema.decodeUnknownSync(WorldRevisionSchema)(5),
      world: KERNEL_WORLD,
    }
    expect(stateOnlyDelta.blockChanges[0]).not.toHaveProperty('beforeState')
    expect(stateOnlyDelta.blockChanges[0]).not.toHaveProperty('afterState')
    const deliveries = Result.getOrThrow(adapter.projectDelta(stateOnlyDelta))

    expect(deliveries).toHaveLength(1)
    expect(deliveries[0]?.connection).toBe(connectionB)
    const outcome = deliveries[0]?.outcome
    expect(outcome?._tag).toBe('ProjectedDelta')
    if (outcome?._tag === 'ProjectedDelta') {
      expect(outcome.message.blockChanges).toHaveLength(1)
      expect(outcome.message.blockChanges[0]).toMatchObject({
        after: BLOCK_ID,
        afterState: Schema.decodeUnknownSync(EncodedBlockStateSchema)(16),
        before: BLOCK_ID,
        beforeState: Schema.decodeUnknownSync(EncodedBlockStateSchema)(0),
      })
    }
    expect(deliveries.some((delivery) => delivery.connection === connectionA)).toBe(false)
  })

  it('tracks a successful AOI shrink and requests resync after a later expansion', () => {
    let chunks = [
      { dimension: 'overworld' as const, x: 0, z: 0 },
      { dimension: 'nether' as const, x: 0, z: 0 },
    ]
    const adapter = makeAdapter(() => ({ chunks, ownerIds: [] }))
    const connectionB = connected(adapter, PLAYER_B)
    expect(Result.isSuccess(adapter.projectSnapshot(connectionB, authoritativeSnapshot(), snapshotInputs()))).toBe(true)
    const emptyDelta = {
      _tag: 'ReplicatedWorldDelta',
      blockChanges: [],
      changes: [],
      revision: Schema.decodeUnknownSync(WorldRevisionSchema)(5),
      world: KERNEL_WORLD,
    }

    chunks = [{ dimension: 'nether', x: 0, z: 0 }]
    expect(Result.getOrThrow(adapter.projectDelta(emptyDelta))).toHaveLength(0)
    chunks = [
      { dimension: 'overworld', x: 0, z: 0 },
      { dimension: 'nether', x: 0, z: 0 },
    ]
    const expanded = Result.getOrThrow(adapter.projectDelta(emptyDelta))

    expect(expanded).toHaveLength(1)
    expect(expanded[0]?.connection).toBe(connectionB)
    expect(expanded[0]?.outcome).toMatchObject({ _tag: 'ResyncRequired', reason: 'interest-expanded' })
  })

  it('refuses missing or block-incompatible authoritative state instead of defaulting', () => {
    const adapter = makeAdapter(undefined, () => Result.fail('state missing'))
    const stateOnlyDelta = {
      _tag: 'ReplicatedWorldDelta',
      blockChanges: [{
        after: BLOCK_ID,
        before: BLOCK_ID,
        dimension: 'overworld',
        position: Schema.decodeUnknownSync(BlockPositionSchema)({ x: 0, y: 64, z: 0 }),
      }],
      changes: [],
      revision: Schema.decodeUnknownSync(WorldRevisionSchema)(5),
      world: KERNEL_WORLD,
    }

    expect(adapter.projectDelta(stateOnlyDelta)).toMatchObject({
      _tag: 'Failure',
      failure: { _tag: 'ServerProjectionRefused', reason: 'invalid-block-state' },
    })
  })

  it('caps connections at 20, rejects 21, and reuses a slot after disconnect', () => {
    const adapter = makeAdapter()
    const handles = []
    for (let index = 0; index < 20; index += 1) {
      const outcome = adapter.connect(PLAYER_A, WORLD)
      expect(outcome._tag).toBe('Connected')
      if (outcome._tag === 'Connected') {
        handles.push(outcome.connection)
      }
    }
    expect(adapter.connect(PLAYER_B, WORLD)).toMatchObject({
      _tag: 'ConnectionRejected',
      current: 20,
      limit: 20,
      reason: 'connection-limit',
    })
    const first = handles[0]
    expect(first).toBeDefined()
    if (first === undefined) {
      throw new Error('the first admitted connection must exist')
    }
    expect(adapter.disconnect(first)).toBe(true)
    expect(adapter.connect(PLAYER_B, WORLD)._tag).toBe('Connected')
  })
})

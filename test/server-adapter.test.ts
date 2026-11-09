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
  ChunkCoordinateSchema,
  CommandId,
  EntityId,
  PlayerId,
  PlayerName,
  createReplicatedOwnerRegistry,
  ReplicatedOwnerRegistryLimitsSchema,
  WorldId,
  createServerAdapter,
  encodeFrame,
  type ServerAcceptedInboundOutcome,
  type ServerInboundOutcome,
  type ServerProjectionFailure,
  type ServerLoadedInterestInput,
  type TargetedDeltaDelivery,
  type TargetedSnapshotDelivery,
  type AuthoritativeSnapshot,
  type ReplicatedOwnerRegistryLimits,
  type ServerAdapterConfiguration,
  type ServerOwnerLocationIndex,
  type ServerOwnerLocationResolution,
  type ReplicatedWorldSnapshot,
  type ServerSnapshotProjectionInputs,
  type WorldSnapshot,
} from '../src/index.js'
import type { WorldWriteServices } from '../src/application/server/command-application.js'
import { ReconnectToken } from '../src/application/server/reconnect-auth.js'

const WORLD = WorldId.make('adapter-world')
const KERNEL_WORLD = Schema.decodeUnknownSync(KernelWorldIdSchema)('adapter-world')
const PLAYER_A = PlayerId.make('alice')
const PLAYER_B = PlayerId.make('bob')
const OWNER_A = makeReplicatedOwnerId('owner:alice')
const OWNER_B = makeReplicatedOwnerId('owner:bob')
const OWNER_C = makeReplicatedOwnerId('owner:charlie')
const OWNER_CONTAINER = makeReplicatedOwnerId('owner:container')
const OWNER_FURNACE = makeReplicatedOwnerId('owner:furnace')
const OWNER_VILLAGER = makeReplicatedOwnerId('owner:villager')
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

const worldSnapshot = (
  players: WorldSnapshot['players'] = [],
): WorldSnapshot => ({
  _tag: 'WorldSnapshot',
  blocks: [],
  levers: [],
  players,
  poweredRails: [],
  revision: 4,
  seed: 42,
  world: WORLD,
})

const playerSnapshot = (player: typeof PLAYER_A, x: number, name: string): WorldSnapshot['players'][number] => ({
  at: { x, y: 64, z: 0 },
  facing: { pitchRadians: 0, yawRadians: x },
  name: PlayerName.make(name),
  player,
  world: WORLD,
})

const snapshotInputs = (
  replicatedWorld: unknown = replicatedSnapshot(),
  locations: ServerOwnerLocationIndex = emptyLocations,
  worldSnapshotInput: unknown = worldSnapshot(),
  playerDimensions: ReadonlyMap<typeof PLAYER_A, 'overworld' | 'nether'> = new Map([
    [PLAYER_A, 'overworld'],
    [PLAYER_B, 'overworld'],
  ]),
): ServerSnapshotProjectionInputs => ({ locations, playerDimensions, replicatedWorld, worldSnapshot: worldSnapshotInput })

const interestChunk = (
  dimension: 'overworld' | 'nether' | 'end',
  x: number,
  z = 0,
): ServerLoadedInterestInput['chunks'][number] => ({
  dimension,
  x: Schema.decodeUnknownSync(ChunkCoordinateSchema)(x),
  z: Schema.decodeUnknownSync(ChunkCoordinateSchema)(z),
})

const makeAdapter = (
  interestInputFor: ServerAdapterConfiguration<never>['interestInputFor'] = (_identity, player) => ({
    chunks: [interestChunk(player === PLAYER_A ? 'nether' : 'overworld', 0)],
    ownerIds: [],
  }),
  blockStatesForChange: ServerAdapterConfiguration<never>['blockStatesForChange'] = () => Result.succeed({
    afterState: Schema.decodeUnknownSync(EncodedBlockStateSchema)(16),
    beforeState: Schema.decodeUnknownSync(EncodedBlockStateSchema)(0),
  }),
  blockStateForRead: ServerAdapterConfiguration<never>['blockStateForRead'] = () =>
    Result.succeed(Schema.decodeUnknownSync(EncodedBlockStateSchema)(0)),
  reconnectAuth: ServerAdapterConfiguration<never>['reconnectAuth'] = { resume: () => Effect.succeed(undefined) },
  commandContextFor: ServerAdapterConfiguration<never>['commandContextFor'] = (identity) => ({
    expectedDimensionRevision: Schema.decodeUnknownSync(DimensionRevisionSchema)(3),
    identity,
    targetTick: Schema.decodeUnknownSync(SimulationTickSchema)(12),
  }),
  applyAcceptedInbound: ServerAdapterConfiguration<never>['applyAcceptedInbound'] = () => Effect.succeed(undefined),
) => {
  const session = new AuthoritativeSession((world) => world === WORLD ? 4 : undefined)
  session.restore(authoritativeSnapshot())
  const config: ServerAdapterConfiguration<never> = {
    commandContextFor,
    commandServices: EMPTY_SERVICES,
    blockStatesForChange,
    blockStateForRead,
    interestInputFor,
    applyAcceptedInbound,
    ownerRegistry,
    reconnectAuth,
    session,
  }
  const serverAdapter = createServerAdapter(config)
  return {
    ...serverAdapter,
    connect: (player: typeof PLAYER_A, world: typeof WORLD) => {
      const outcome = Effect.runSync(serverAdapter.handle({ _tag: 'Connect', player, world }))
      if (outcome._tag !== 'Connected' && outcome._tag !== 'ConnectionRejected') {
        throw new Error('unexpected connection outcome')
      }
      return outcome
    },
    disconnect: (connection: unknown) => {
      const outcome = Effect.runSync(serverAdapter.handle({ _tag: 'Disconnect', connection }))
      if (outcome._tag !== 'Disconnected') {
        throw new Error('unexpected disconnect outcome')
      }
      return outcome.disconnected
    },
    receiveFrame: (connection: unknown, frame: unknown) => Effect.map(
      serverAdapter.handle({ _tag: 'ReceiveFrame', connection, frame }),
      (outcome): ServerInboundOutcome => {
        if (outcome._tag === 'FrameHandled') {
          return outcome.inbound
        }
        if (outcome._tag === 'FrameDeliveryRefused' && outcome.inbound !== undefined) {
          return outcome.inbound
        }
        throw new Error('unexpected inbound outcome')
      },
    ),
    resume: (token: unknown) => Effect.map(serverAdapter.handle({ _tag: 'Resume', token }), (outcome) => {
      if (outcome._tag !== 'ResumeAccepted' && outcome._tag !== 'ResumeRejected' && outcome._tag !== 'ResumeUnavailable') {
        throw new Error('unexpected resume outcome')
      }
      return outcome
    }),
    projectSnapshot: (
      connection: unknown,
      authoritative: unknown,
      inputs: ServerSnapshotProjectionInputs,
    ): Result.Result<TargetedSnapshotDelivery, ServerProjectionFailure> => {
      const outcome = Effect.runSync(serverAdapter.handle({
        _tag: 'PublishWorldState',
        delivery: { snapshots: [{ world: WORLD, authoritative, inputs }] },
      }))
      if (outcome._tag === 'WorldStateRefused') {
        return Result.fail(outcome.failure)
      }
      if (outcome._tag !== 'WorldStatePublished') {
        throw new Error('unexpected snapshot projection outcome')
      }
      const targeted = outcome.deliveries.snapshots.find((delivery) => delivery.connection === connection)
      return targeted === undefined
        ? Result.fail({ _tag: 'ServerProjectionRefused', reason: 'unknown-connection' })
        : Result.succeed(targeted)
    },
    projectDelta: (delta: unknown): Result.Result<ReadonlyArray<TargetedDeltaDelivery>, ServerProjectionFailure> => {
      const outcome = Effect.runSync(serverAdapter.handle({ _tag: 'PublishWorldState', delivery: { delta } }))
      if (outcome._tag === 'WorldStateRefused') {
        return Result.fail(outcome.failure)
      }
      if (outcome._tag !== 'WorldStatePublished') {
        throw new Error('unexpected delta projection outcome')
      }
      return Result.succeed(outcome.deliveries.deltas)
    },
  }
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
      { _tag: 'living' as const, at: { x: 0, y: 64, z: 0 }, entityId: EntityId.make('owner:charlie'), entityType: 'zombie', health: 20, maxHealth: 20 },
    ]
    const authoritativeWithEntities = { ...snapshot, entities }
    const worldWithOwners = replicatedSnapshot([
      { owner: OWNER_A, state: { value: 1 } },
      { owner: OWNER_B, state: { value: 2 } },
      { owner: OWNER_C, state: { value: 3 } },
    ])
    const locations: ServerOwnerLocationIndex = new Map([
      [OWNER_A, locatedAt('overworld', 16, 0)],
      [OWNER_B, locatedAt('overworld', 0, 0)],
      [OWNER_C, { _tag: 'Absent' }],
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
    const outsideBlockRead = {
      dimension: 'overworld' as const,
      position: Schema.decodeUnknownSync(BlockPositionSchema)({ x: 16, y: 64, z: 0 }),
      reading: { _tag: 'Block' as const, block: BLOCK_ID },
    }
    const unloadedBlockRead = {
      dimension: 'overworld' as const,
      position: Schema.decodeUnknownSync(BlockPositionSchema)({ x: 1, y: 64, z: 0 }),
      reading: { _tag: 'ChunkNotLoaded' as const },
    }
    const outOfWorldBlockRead = {
      dimension: 'overworld' as const,
      position: Schema.decodeUnknownSync(BlockPositionSchema)({ x: 2, y: 64, z: 0 }),
      reading: { _tag: 'OutOfWorld' as const },
    }
    const snapshot = replicatedSnapshot([], [blockRead, outsideBlockRead, unloadedBlockRead, outOfWorldBlockRead])
    expect(blockRead).not.toHaveProperty('state')
    const adapter = makeAdapter()
    const connectionB = connected(adapter, PLAYER_B)
    const projected = Result.getOrThrow(adapter.projectSnapshot(
      connectionB,
      authoritativeSnapshot(),
      snapshotInputs(snapshot),
    ))

    expect(projected.snapshot.replicatedWorld.blocks).toMatchObject([
      { reading: { _tag: 'Block', block: BLOCK_ID }, state: 0 },
      { reading: { _tag: 'ChunkNotLoaded' } },
      { reading: { _tag: 'OutOfWorld' } },
    ])
    expect(projected.snapshot.replicatedWorld.blocks).toHaveLength(3)

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

  it('projects every owner-indexed snapshot collection and omits entities when the source omits them', () => {
    const adapter = makeAdapter()
    const connectionB = connected(adapter, PLAYER_B)
    const snapshot = {
      ...authoritativeSnapshot(),
      containers: [{ containerId: OWNER_CONTAINER, kind: 'chest' as const, slots: [] }],
      entities: [
        { _tag: 'living' as const, at: { x: 0, y: 64, z: 0 }, entityId: EntityId.make('owner:alice'), entityType: 'zombie', health: 20, maxHealth: 20 },
      ],
      furnaces: [{ burnTicksRemaining: 0, cookTicks: 0, fuel: null, furnaceId: OWNER_FURNACE, input: null, output: null }],
      villagerTrades: [{
        offers: [{ input: [], maxUses: 1, offerId: 'trade:one', output: { item: 'emerald', count: 1 }, uses: 0 }],
        villagerId: OWNER_VILLAGER,
      }],
    }
    const locations: ServerOwnerLocationIndex = new Map([
      [OWNER_A, locatedAt('overworld', 0, 0)],
      [OWNER_CONTAINER, locatedAt('overworld', 0, 0)],
      [OWNER_FURNACE, locatedAt('overworld', 0, 0)],
      [OWNER_VILLAGER, locatedAt('overworld', 0, 0)],
    ])
    const projected = Result.getOrThrow(adapter.projectSnapshot(
      connectionB,
      snapshot,
      snapshotInputs(replicatedSnapshot(), locations),
    ))

    expect(projected.snapshot.authoritative.entities).toEqual(snapshot.entities)
    expect(projected.snapshot.authoritative.containers).toEqual(snapshot.containers)
    expect(projected.snapshot.authoritative.furnaces).toEqual(snapshot.furnaces)
    expect(projected.snapshot.authoritative.villagerTrades).toEqual(snapshot.villagerTrades)

    const withoutEntities: Record<string, unknown> = { ...snapshot }
    delete withoutEntities['entities']
    const omitted = Result.getOrThrow(adapter.projectSnapshot(
      connectionB,
      withoutEntities,
      snapshotInputs(replicatedSnapshot(), locations),
    ))
    expect(omitted.snapshot.authoritative).not.toHaveProperty('entities')
  })

  it('refuses malformed owner locations for every owner-indexed collection', () => {
    const location = {
      _tag: 'Located',
      blockPosition: { x: 0, y: 64, z: 0 },
      dimension: 'unknown',
    }
    const malformedRows: ReadonlyArray<Readonly<{
      owner: typeof OWNER_A
      snapshot: unknown
    }>> = [
      {
        owner: OWNER_A,
        snapshot: {
          ...authoritativeSnapshot(),
          entities: [{ _tag: 'living', at: { x: 0, y: 64, z: 0 }, entityId: EntityId.make('owner:alice'), entityType: 'zombie', health: 20, maxHealth: 20 }],
        },
      },
      { owner: OWNER_CONTAINER, snapshot: { ...authoritativeSnapshot(), containers: [{ containerId: OWNER_CONTAINER, kind: 'chest', slots: [] }] } },
      { owner: OWNER_FURNACE, snapshot: { ...authoritativeSnapshot(), furnaces: [{ burnTicksRemaining: 0, cookTicks: 0, fuel: null, furnaceId: OWNER_FURNACE, input: null, output: null }] } },
      {
        owner: OWNER_VILLAGER,
        snapshot: {
          ...authoritativeSnapshot(),
          villagerTrades: [{ offers: [], villagerId: OWNER_VILLAGER }],
        },
      },
    ]

    for (const row of malformedRows) {
      const adapter = makeAdapter()
      const connectionB = connected(adapter, PLAYER_B)
      const locations: ServerOwnerLocationIndex = new Map([[row.owner, location]])
      expect(adapter.projectSnapshot(connectionB, row.snapshot, snapshotInputs(replicatedSnapshot(), locations))).toMatchObject({
        _tag: 'Failure',
        failure: { _tag: 'ServerProjectionRefused', reason: 'invalid-owner-location' },
      })
    }
  })

  it('normalizes an out-of-range owner location and rejects malformed or cross-world snapshot input', () => {
    const adapter = makeAdapter()
    const connectionB = connected(adapter, PLAYER_B)
    const outOfRange: ServerOwnerLocationResolution = {
      _tag: 'Located',
      blockPosition: { x: Number.MAX_SAFE_INTEGER * 32, y: 64, z: 0 },
      dimension: 'overworld',
    }
    const locations: ServerOwnerLocationIndex = new Map([[OWNER_B, outOfRange]])
    const withOwner = replicatedSnapshot([{ owner: OWNER_B, state: { value: 2 } }])

    expect(adapter.projectSnapshot(connectionB, authoritativeSnapshot(), snapshotInputs(withOwner, locations))).toMatchObject({
      _tag: 'Failure',
      failure: { _tag: 'ServerProjectionRefused', reason: 'invalid-owner-location' },
    })
    expect(adapter.projectSnapshot(connectionB, null, snapshotInputs())).toMatchObject({
      _tag: 'Failure',
      failure: { _tag: 'ServerProjectionRefused', reason: 'invalid-authoritative-snapshot' },
    })
    expect(adapter.projectSnapshot(connectionB, authoritativeSnapshot(), snapshotInputs(null))).toMatchObject({
      _tag: 'Failure',
      failure: { _tag: 'ServerProjectionRefused', reason: 'invalid-replicated-snapshot' },
    })
    expect(adapter.projectSnapshot(
      connectionB,
      { ...authoritativeSnapshot(), world: WorldId.make('other-world') },
      snapshotInputs(),
    )).toMatchObject({
      _tag: 'Failure',
      failure: { _tag: 'ServerProjectionRefused', reason: 'cross-world-snapshot' },
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

    const secretFailure = new Error('resume token secret: do-not-log')
    const failingAuthAdapter = makeAdapter(undefined, undefined, undefined, {
      resume: () => Effect.fail(secretFailure),
    })
    const unavailable = await Effect.runPromise(failingAuthAdapter.handle({ _tag: 'Resume', token: ReconnectToken.make('A'.repeat(43)) }))
    expect(unavailable).toEqual({ _tag: 'ResumeUnavailable', reason: 'authentication-service-failed' })
    expect(JSON.stringify(unavailable)).not.toContain(secretFailure.message)
    const throwingResume: ServerAdapterConfiguration<never>['reconnectAuth']['resume'] = () => { throw secretFailure }
    const throwingAuthAdapter = makeAdapter(undefined, undefined, undefined, { resume: throwingResume })
    expect(await Effect.runPromise(throwingAuthAdapter.handle({ _tag: 'Resume', token: ReconnectToken.make('B'.repeat(43)) })))
      .toEqual({ _tag: 'ResumeUnavailable', reason: 'authentication-service-failed' })
  })

  it('accepts a rotated resume token and reports unavailable authentication failures', async () => {
    const tokenText = 'A'.repeat(43)
    const token = Schema.decodeUnknownSync(ReconnectToken)(tokenText)
    const acceptedAdapter = makeAdapter(undefined, undefined, undefined, {
      resume: () => Effect.succeed({ player: PLAYER_B, token }),
    })
    expect(await Effect.runPromise(acceptedAdapter.resume(tokenText))).toEqual({
      _tag: 'ResumeAccepted',
      player: PLAYER_B,
      token,
    })

    const rejectedAdapter = makeAdapter()
    expect(await Effect.runPromise(rejectedAdapter.resume(tokenText))).toEqual({
      _tag: 'ResumeRejected',
      reason: 'invalid-token',
    })

    const failure = new Error('auth store unavailable')
    const unavailableAdapter = makeAdapter(undefined, undefined, undefined, {
      resume: () => Effect.fail(failure),
    })
    expect(await Effect.runPromise(unavailableAdapter.resume(tokenText))).toEqual({
      _tag: 'ResumeUnavailable',
      reason: 'authentication-service-failed',
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

  it.effect('handles invalid, unrelated, and supported client messages at the connection boundary', () =>
    Effect.gen(function* () {
      const adapter = makeAdapter()
      const connectionA = connected(adapter, PLAYER_A)
      const foreignConnection = connected(makeAdapter(), PLAYER_A)
      const nullHandle = null
      const deltaFrame = makeFrame({
        _tag: 'ReplicatedWorldDelta',
        blockChanges: [],
        changes: [],
        revision: Schema.decodeUnknownSync(WorldRevisionSchema)(5),
        world: KERNEL_WORLD,
      })

      expect(yield* adapter.receiveFrame(foreignConnection, deltaFrame)).toMatchObject({
        _tag: 'ConnectionRefused',
        reason: 'unknown-connection',
      })
      expect(yield* adapter.receiveFrame(nullHandle, deltaFrame)).toMatchObject({
        _tag: 'ConnectionRefused',
        reason: 'unknown-connection',
      })
      expect(adapter.projectSnapshot(foreignConnection, authoritativeSnapshot(), snapshotInputs())).toMatchObject({
        _tag: 'Failure',
        failure: { reason: 'unknown-connection' },
      })
      expect(adapter.projectSnapshot(nullHandle, authoritativeSnapshot(), snapshotInputs())).toMatchObject({
        _tag: 'Failure',
        failure: { reason: 'unknown-connection' },
      })
      expect(adapter.disconnect(foreignConnection)).toBe(false)
      expect(adapter.disconnect(nullHandle)).toBe(false)

      expect(yield* adapter.receiveFrame(connectionA, 42)).toMatchObject({
        _tag: 'ConnectionRefused',
        reason: 'non-text-frame',
      })
      expect(yield* adapter.receiveFrame(connectionA, 'not-json')).toMatchObject({
        _tag: 'FrameRejected',
      })
      expect(yield* adapter.receiveFrame(connectionA, makeFrame({ _tag: 'Chat', player: PLAYER_B, text: 'spoofed' }))).toMatchObject({
        _tag: 'ConnectionRefused',
        reason: 'sender-mismatch',
      })
      expect(yield* adapter.receiveFrame(connectionA, makeFrame({
        _tag: 'PlayerMove',
        at: { x: 0.5, y: 65, z: 0.5 },
        facing: { pitchRadians: 0, yawRadians: 0 },
        player: PLAYER_B,
      }))).toMatchObject({ _tag: 'ConnectionRefused', reason: 'sender-mismatch' })
      expect(yield* adapter.receiveFrame(connectionA, makeFrame({
        _tag: 'PlayerMove',
        at: { x: 0.5, y: 65, z: 0.5 },
        facing: { pitchRadians: 0, yawRadians: 0 },
        player: PLAYER_A,
      }))).toMatchObject({ _tag: 'MovementReceived' })
      expect(yield* adapter.receiveFrame(connectionA, makeFrame({
        _tag: 'AuthoritativeResyncRequest',
        world: KERNEL_WORLD,
      }))).toMatchObject({ _tag: 'ResyncRequested' })
      expect(yield* adapter.receiveFrame(connectionA, makeFrame({
        _tag: 'AuthoritativeResyncRequest',
        world: Schema.decodeUnknownSync(KernelWorldIdSchema)('other-adapter-world'),
      }))).toMatchObject({ _tag: 'ConnectionRefused', reason: 'wrong-world' })
      expect(yield* adapter.receiveFrame(connectionA, makeFrame({
        _tag: 'BlockPlace',
        at: { x: 0, y: 64, z: 0 },
        block: 'stone',
        player: PLAYER_A,
        state: Schema.decodeUnknownSync(EncodedBlockStateSchema)(0),
      }))).toMatchObject({ _tag: 'ConnectionRefused', reason: 'unsupported-message' })

      const invalidContextAdapter = makeAdapter(
        undefined,
        undefined,
        undefined,
        undefined,
        (identity) => ({
          expectedDimensionRevision: Schema.decodeUnknownSync(DimensionRevisionSchema)(3),
          identity,
          targetTick: Number.NaN,
        }),
      )
      const invalidContextConnection = connected(invalidContextAdapter, PLAYER_A)
      expect(yield* invalidContextAdapter.receiveFrame(invalidContextConnection, makeFrame({
        _tag: 'FishingCommand',
        action: 'cast',
        commandId: CommandId.make('invalid-context-command'),
        expectedRevision: 4,
        player: PLAYER_A,
        world: WORLD,
      }))).toMatchObject({ _tag: 'CommandApplicationRefused' })
    })
  )

  it.effect('disconnects for global frame overflow and drops an over-rate movement frame', () =>
    Effect.gen(function* () {
      const adapter = makeAdapter()
      const globalConnection = connected(adapter, PLAYER_A)
      const resyncFrame = makeFrame({
        _tag: 'AuthoritativeResyncRequest',
        world: KERNEL_WORLD,
      })
      for (let frame = 0; frame < 80; frame += 1) {
        expect(yield* adapter.receiveFrame(globalConnection, resyncFrame)).toMatchObject({ _tag: 'ResyncRequested' })
      }
      expect(yield* adapter.receiveFrame(globalConnection, resyncFrame)).toMatchObject({
        _tag: 'RateLimited',
        action: 'disconnect',
        kind: undefined,
      })

      const movementConnection = connected(adapter, PLAYER_B)
      const movementFrame = makeFrame({
        _tag: 'PlayerMove',
        at: { x: 0.5, y: 65, z: 0.5 },
        facing: { pitchRadians: 0, yawRadians: 0 },
        player: PLAYER_B,
      })
      for (let frame = 0; frame < 40; frame += 1) {
        expect(yield* adapter.receiveFrame(movementConnection, movementFrame)).toMatchObject({ _tag: 'MovementReceived' })
      }
      expect(yield* adapter.receiveFrame(movementConnection, movementFrame)).toMatchObject({
        _tag: 'RateLimited',
        action: 'drop',
        kind: 'movement',
      })
    })
  )

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

  it('projects WorldSnapshot player position and facing to each recipient AOI', () => {
    const adapter = makeAdapter((_identity, player) => ({
      chunks: [interestChunk('overworld', player === PLAYER_A ? 0 : 1)],
      ownerIds: [],
    }))
    const connectionA = connected(adapter, PLAYER_A)
    const connectionB = connected(adapter, PLAYER_B)
    const inputs = snapshotInputs(
      replicatedSnapshot(),
      emptyLocations,
      worldSnapshot([playerSnapshot(PLAYER_A, 1, 'Alice'), playerSnapshot(PLAYER_B, 17, 'Bob')]),
      new Map([[PLAYER_A, 'overworld'], [PLAYER_B, 'overworld']]),
    )

    const result = Effect.runSync(adapter.handle({
      _tag: 'PublishWorldState',
      delivery: { snapshots: [{ world: WORLD, authoritative: authoritativeSnapshot(), inputs }] },
    }))
    expect(result._tag).toBe('WorldStatePublished')
    if (result._tag !== 'WorldStatePublished') {
      throw new Error('expected world state publication')
    }
    const snapshotA = result.deliveries.snapshots.find((delivery) => delivery.connection === connectionA)
    const snapshotB = result.deliveries.snapshots.find((delivery) => delivery.connection === connectionB)
    expect(snapshotA?.snapshot.worldSnapshot.players).toEqual([playerSnapshot(PLAYER_A, 1, 'Alice')])
    expect(snapshotB?.snapshot.worldSnapshot.players).toEqual([playerSnapshot(PLAYER_B, 17, 'Bob')])
  })

  it('handles a command through recipient delivery while enforcing privacy, AOI, capacity, and resume tokens', async () => {
    const attackState = {
      snapshots: [{
        world: WORLD,
        authoritative: authoritativeSnapshot(),
        inputs: snapshotInputs(
          replicatedSnapshot(),
          emptyLocations,
          worldSnapshot([playerSnapshot(PLAYER_A, 1, 'Alice'), playerSnapshot(PLAYER_B, 17, 'Bob')]),
          new Map([[PLAYER_A, 'overworld'], [PLAYER_B, 'overworld']]),
        ),
      }],
      delta: {
        _tag: 'ReplicatedWorldDelta',
        blockChanges: [{
          after: BLOCK_ID,
          before: BLOCK_ID,
          dimension: 'overworld',
          position: Schema.decodeUnknownSync(BlockPositionSchema)({ x: 1, y: 64, z: 0 }),
        }],
        changes: [],
        revision: Schema.decodeUnknownSync(WorldRevisionSchema)(5),
        world: KERNEL_WORLD,
      },
    }
    const applied: Array<ServerAcceptedInboundOutcome> = []
    const adapter = makeAdapter(
      (_identity, player) => ({
        chunks: [interestChunk('overworld', player === PLAYER_A ? 0 : 1)],
        ownerIds: [],
      }),
      undefined,
      undefined,
      undefined,
      undefined,
      (_connection, inbound) => {
        applied.push(inbound)
        return Effect.succeed(attackState)
      },
    )
    const connectionA = connected(adapter, PLAYER_A)
    const connectionB = connected(adapter, PLAYER_B)
    const frame = makeFrame({
      _tag: 'EntityAttackCommand',
      commandId: CommandId.make('melee-through-u6b'),
      entityId: EntityId.make('entity:target'),
      expectedRevision: 4,
      heldSlot: 2,
      player: PLAYER_A,
      world: WORLD,
    })

    const result = await Effect.runPromise(adapter.handle({ _tag: 'ReceiveFrame', connection: connectionA, frame }))
    expect(result._tag).toBe('FrameHandled')
    if (result._tag !== 'FrameHandled') {
      throw new Error('expected frame handling and recipient delivery')
    }
    expect(result.inbound).toMatchObject({
      _tag: 'CommandApplied',
      command: { _tag: 'EntityAttackCommand', entityId: 'entity:target', heldSlot: 2 },
      outcome: { _tag: 'AuthoritativeCommandIntentAccepted', intent: { payload: { _tag: 'MeleeAttack', actor: PLAYER_A } } },
    })
    expect(applied).toHaveLength(1)
    expect(applied[0]).toMatchObject({ _tag: 'CommandApplied', command: { heldSlot: 2, entityId: 'entity:target' } })
    expect(result.deliveries.snapshots).toHaveLength(2)
    const snapshotA = result.deliveries.snapshots.find((delivery) => delivery.connection === connectionA)
    const snapshotB = result.deliveries.snapshots.find((delivery) => delivery.connection === connectionB)
    expect(snapshotA?.snapshot.authoritative.inventories.map((entry) => entry.player)).toEqual([PLAYER_A])
    expect(snapshotA?.snapshot.authoritative.vitals.map((entry) => entry.player)).toEqual([PLAYER_A])
    expect(snapshotB?.snapshot.authoritative.inventories.map((entry) => entry.player)).toEqual([PLAYER_B])
    expect(snapshotB?.snapshot.authoritative.vitals.map((entry) => entry.player)).toEqual([PLAYER_B])
    expect(result.deliveries.deltas.map((delivery) => delivery.connection)).toEqual([connectionA])

    const capacityAdapter = makeAdapter()
    const admissions = await Promise.all(Array.from({ length: 20 }, (_, index) => Effect.runPromise(capacityAdapter.handle({
        _tag: 'Connect',
        player: PlayerId.make(`capacity-${index}`),
        world: WORLD,
      }))))
    for (const admission of admissions) {
      expect(admission._tag).toBe('Connected')
    }
    expect(await Effect.runPromise(capacityAdapter.handle({ _tag: 'Connect', player: PLAYER_A, world: WORLD }))).toMatchObject({
      _tag: 'ConnectionRejected',
      reason: 'connection-limit',
      limit: 20,
    })
    expect(await Effect.runPromise(capacityAdapter.handle({ _tag: 'Resume', token: undefined }))).toEqual({
      _tag: 'ResumeRejected',
      reason: 'missing-token',
    })
  })

  it('accepts ID-only deltas, enriches state-only changes, and targets the recipient AOI', () => {
    const adapter = makeAdapter()
    const connectionA = connected(adapter, PLAYER_A)
    const connectionB = connected(adapter, PLAYER_B)
    const snapshot = authoritativeSnapshot()
    const c4WorldSnapshot = replicatedSnapshot()
    expect(Result.isSuccess(adapter.projectSnapshot(connectionA, snapshot, snapshotInputs(c4WorldSnapshot)))).toBe(true)
    expect(Result.isSuccess(adapter.projectSnapshot(connectionB, snapshot, snapshotInputs(c4WorldSnapshot)))).toBe(true)

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

  it('delivers only changed blocks from chunks declared loaded in the recipient interest', () => {
    const adapter = makeAdapter(() => ({
      chunks: [interestChunk('overworld', 0)],
      ownerIds: [],
    }))
    const connection = connected(adapter, PLAYER_B)
    const snapshot = Effect.runSync(adapter.handle({
      _tag: 'PublishWorldState',
      delivery: {
        snapshots: [{ world: WORLD, authoritative: authoritativeSnapshot(), inputs: snapshotInputs() }],
      },
    }))
    expect(snapshot._tag).toBe('WorldStatePublished')

    const delta = Effect.runSync(adapter.handle({
      _tag: 'PublishWorldState',
      delivery: {
        delta: {
          _tag: 'ReplicatedWorldDelta',
          blockChanges: [15, 16].map((x) => ({
            after: BLOCK_ID,
            before: BLOCK_ID,
            dimension: 'overworld',
            position: Schema.decodeUnknownSync(BlockPositionSchema)({ x, y: 64, z: 0 }),
          })),
          changes: [],
          revision: Schema.decodeUnknownSync(WorldRevisionSchema)(5),
          world: KERNEL_WORLD,
        },
      },
    }))
    expect(delta._tag).toBe('WorldStatePublished')
    if (delta._tag !== 'WorldStatePublished') {
      throw new Error('expected delta publication')
    }
    expect(delta.deliveries.deltas).toHaveLength(1)
    expect(delta.deliveries.deltas[0]?.connection).toBe(connection)
    expect(delta.deliveries.deltas[0]?.outcome).toMatchObject({
      _tag: 'ProjectedDelta',
      message: { blockChanges: [{ position: { x: 15 } }] },
    })
  })

  it('tracks a successful AOI shrink and requests resync after a later expansion', () => {
    let chunks: Array<ServerLoadedInterestInput['chunks'][number]> = [
      interestChunk('overworld', 0),
      interestChunk('nether', 0),
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

    chunks = [interestChunk('nether', 0)]
    expect(Result.getOrThrow(adapter.projectDelta(emptyDelta))).toHaveLength(0)
    chunks = [
      interestChunk('overworld', 0),
      interestChunk('nether', 0),
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

    const incompatibleStateAdapter = makeAdapter(undefined, () => Result.succeed({
      afterState: AIR_BLOCK_INCOMPATIBLE_STATE,
      beforeState: Schema.decodeUnknownSync(EncodedBlockStateSchema)(0),
    }))
    const incompatibleDelta = {
      ...stateOnlyDelta,
      blockChanges: [{ ...stateOnlyDelta.blockChanges[0], after: AIR_BLOCK_ID, before: AIR_BLOCK_ID }],
    }
    expect(incompatibleStateAdapter.projectDelta(incompatibleDelta)).toMatchObject({
      _tag: 'Failure',
      failure: { _tag: 'ServerProjectionRefused', reason: 'invalid-block-state' },
    })
  })

  it('requests resync for a new recipient and rejects bad delta input', () => {
    const adapter = makeAdapter()
    const connectionB = connected(adapter, PLAYER_B)
    const otherWorld = adapter.connect(PLAYER_A, WorldId.make('other-adapter-world'))
    expect(otherWorld._tag).toBe('Connected')
    const delta = {
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
    const deliveries = Result.getOrThrow(adapter.projectDelta(delta))

    expect(deliveries).toHaveLength(1)
    expect(deliveries[0]?.connection).toBe(connectionB)
    expect(deliveries[0]?.outcome).toMatchObject({ _tag: 'ResyncRequired', reason: 'interest-expanded' })
    expect(adapter.projectDelta(null)).toMatchObject({
      _tag: 'Failure',
      failure: { _tag: 'ServerProjectionRefused', reason: 'invalid-replicated-delta' },
    })
  })

  it('rejects invalid server interest and owner changes outside the registry', () => {
    const invalidInterest: ServerLoadedInterestInput = { chunks: [], ownerIds: [] }
    Object.defineProperty(invalidInterest, 'chunks', { value: 'bad' })
    const invalidInterestAdapter = makeAdapter(() => invalidInterest)
    const connectionB = connected(invalidInterestAdapter, PLAYER_B)
    const emptyDelta = {
      _tag: 'ReplicatedWorldDelta',
      blockChanges: [],
      changes: [],
      revision: Schema.decodeUnknownSync(WorldRevisionSchema)(5),
      world: KERNEL_WORLD,
    }
    expect(invalidInterestAdapter.projectSnapshot(connectionB, authoritativeSnapshot(), snapshotInputs())).toMatchObject({
      _tag: 'Failure',
      failure: { _tag: 'ServerProjectionRefused', reason: 'invalid-server-interest' },
    })
    expect(invalidInterestAdapter.projectDelta(emptyDelta)).toMatchObject({
      _tag: 'Failure',
      failure: { _tag: 'ServerProjectionRefused', reason: 'invalid-server-interest' },
    })

    const unregisteredOwner = makeReplicatedOwnerId('owner:unregistered')
    const ownerAdapter = makeAdapter(() => ({ chunks: [], ownerIds: [unregisteredOwner] }))
    const ownerConnection = connected(ownerAdapter, PLAYER_B)
    expect(Result.isSuccess(ownerAdapter.projectSnapshot(
      ownerConnection,
      authoritativeSnapshot(),
      snapshotInputs(),
    ))).toBe(true)
    expect(ownerAdapter.projectDelta({
      ...emptyDelta,
      changes: [{ owner: unregisteredOwner, state: { value: 1 } }],
    })).toMatchObject({
      _tag: 'Failure',
      failure: { _tag: 'ServerProjectionRefused', reason: 'delta-projection-failed' },
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

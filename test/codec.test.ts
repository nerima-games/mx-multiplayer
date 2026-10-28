import { describe, expect, it } from '@effect/vitest'
import * as fc from 'fast-check'
import { BlockPositionSchema, WorldRevisionSchema } from '@nerima-games/mc-kernel'
import { makeReplicatedOwnerId, type ReplicatedOwnerRegistration } from '@nerima-games/mc-sim'
import { Effect, Result, Option, Schema } from 'effect'
import {
  createReplicatedOwnerRegistry,
  decodeFrame,
  decodeTransferredSnapshotFrame,
  encodeFrame,
  encodeFrameAsVersion,
  encodeTransferredSnapshotFrame,
  inspectReplicatedFrameTag,
  type ReplicatedOwnerRegistryLimits,
  wireFrameByteLength,
} from '../src/domain/codec'
import type { ProtocolError } from '../src/domain/errors'
import {
  CommandId,
  EndPortalUseCommand,
  EntityId,
  MESSAGE_TAGS,
  NetherPortalUseCommand,
  NetworkMessage,
  PROTOCOL_VERSION,
  PlayerId,
  PlayerName,
  RealmTransferSnapshot,
  ReplicatedWorldDeltaMessage,
  ReplicatedWorldSnapshot,
  ReplicatedWorldSnapshotChunk,
  ReplicatedWorldSnapshotEnd,
  ReplicatedWorldSnapshotStart,
  WorldId,
  WorldTimeWeatherAction,
} from '../src/domain/protocol'

const alice = PlayerId.make('alice')
const overworld = WorldId.make('overworld')
const end = WorldId.make('end')
const commandId = CommandId.make('command-1')
const GLOBAL_FRAME_CODE_UNIT_LIMIT = 1_048_576
const GLOBAL_FRAME_UTF8_LIMIT = 1_310_720
const GLOBAL_JSON_DEPTH_LIMIT = 13
const GLOBAL_JSON_COLLECTION_LIMIT = 31_149
const OLD_GLOBAL_FRAME_BASELINE = 1_048_576
const commandHeader = { commandId, expectedRevision: 12, player: alice, world: overworld }
const item = { count: 2, durability: { current: 63, max: 64 }, item: 'stone' }
const entityId = EntityId.make('entity-1')
const living = {
  _tag: 'living' as const,
  at: { x: 1, y: 64, z: 1 },
  entityId,
  entityType: 'zombie',
  health: 20,
  maxHealth: 20,
  mobState: { attackCooldownSecs: 0, charged: true, motionPhase: 0.5, persistent: true, provoked: false },
}
const itemDrop = { _tag: 'item-drop' as const, ageTicks: 1, at: { x: 2, y: 64, z: 1 }, entityId: EntityId.make('drop-1'), stack: item }
const arrow = { _tag: 'arrow' as const, ageTicks: 2, at: { x: 2, y: 65, z: 1 }, damage: 4, entityId: EntityId.make('arrow-1'), owner: alice, velocity: { x: 0, y: 0.1, z: 1 } }
const primedTnt = { _tag: 'primed-tnt' as const, at: { x: 3, y: 64, z: 1 }, burnedSecs: 1.5, entityId: EntityId.make('tnt-1'), owner: alice }
const replicatedWorldRevision = Result.getOrThrow(Schema.decodeUnknownResult(WorldRevisionSchema)(13))
const emptyWorldDelta = Result.getOrThrow(Schema.decodeUnknownResult(ReplicatedWorldDeltaMessage)({
  _tag: 'ReplicatedWorldDelta',
  world: overworld,
  revision: replicatedWorldRevision,
  changes: [],
  blockChanges: [],
}))
const emptyWorldSnapshot = Result.getOrThrow(Schema.decodeUnknownResult(ReplicatedWorldSnapshot)({
  _tag: 'ReplicatedWorldSnapshot',
  world: overworld,
  revision: replicatedWorldRevision,
  owners: [],
  blocks: [],
}))
const snapshotStart = Result.getOrThrow(Schema.decodeUnknownResult(ReplicatedWorldSnapshotStart)({
  _tag: 'ReplicatedWorldSnapshotStart',
  transferId: 'transfer-1',
  world: overworld,
  revision: replicatedWorldRevision,
  totalBytes: 1,
  chunkCount: 1,
  sha256: '0'.repeat(64),
}))
const snapshotChunk = Result.getOrThrow(Schema.decodeUnknownResult(ReplicatedWorldSnapshotChunk)({
  _tag: 'ReplicatedWorldSnapshotChunk',
  transferId: 'transfer-1',
  index: 0,
  data: 'AQ==',
}))
const snapshotEnd = Result.getOrThrow(Schema.decodeUnknownResult(ReplicatedWorldSnapshotEnd)({
  _tag: 'ReplicatedWorldSnapshotEnd',
  transferId: 'transfer-1',
}))

/**
 * One sample per message tag. `SAMPLES` is keyed by tag so that the
 * exhaustiveness test below can prove no message escapes the round-trip check.
 */
const SAMPLES: { readonly [Tag in NetworkMessage['_tag']]: Extract<NetworkMessage, { _tag: Tag }> } = {
  ReplicatedWorldDelta: emptyWorldDelta,
  ReplicatedWorldSnapshot: emptyWorldSnapshot,
  ReplicatedWorldSnapshotStart: snapshotStart,
  ReplicatedWorldSnapshotChunk: snapshotChunk,
  ReplicatedWorldSnapshotEnd: snapshotEnd,
  AnvilCommand: { _tag: 'AnvilCommand', ...commandHeader, name: 'Excalibur', slot: 0 },
  AnvilCommandAccepted: { _tag: 'AnvilCommandAccepted', commandId, revision: 13 },
  AnvilCommandRejected: { _tag: 'AnvilCommandRejected', commandId, reason: 'missing-iron', revision: 12 },
  AuthoritativeCommandAccepted: { _tag: 'AuthoritativeCommandAccepted', commandId, revision: 13, world: overworld },
  AuthoritativeCommandRejected: { _tag: 'AuthoritativeCommandRejected', commandId, reason: 'stale-revision', resyncRequired: true, revision: 12, world: overworld },
  AuthoritativeResyncRequest: { _tag: 'AuthoritativeResyncRequest', lastKnownRevision: replicatedWorldRevision, world: overworld },
  AuthoritativeSnapshot: {
    _tag: 'AuthoritativeSnapshot', containers: [], entities: [living, itemDrop, arrow, primedTnt], furnaces: [], inventories: [{ player: alice, state: { slots: [item], selectedSlot: 0 } }], revision: 12, timeWeather: { timeOfDay: 6000, weather: 'clear' }, villagerTrades: [], vitals: [{ player: alice, state: { health: 20, hunger: 20, experience: 1 } }], world: overworld,
  },
  BlockBreak: { _tag: 'BlockBreak', at: { x: -1, y: 0, z: -3 }, player: alice },
  BlockMutationRejected: {
    _tag: 'BlockMutationRejected',
    at: { x: 1, y: 2, z: 3 },
    operation: 'place',
    player: alice,
    reason: 'occupied',
    revision: 12,
    world: overworld,
  },
  BlockPlace: { _tag: 'BlockPlace', at: { x: 1, y: 2, z: 3 }, block: 'stone', player: alice },
  BowUseCommand: { _tag: 'BowUseCommand', ...commandHeader, action: 'release' },
  BrewingCommand: { _tag: 'BrewingCommand', ...commandHeader, action: { _tag: 'insert', slot: 0 }, at: { x: 1, y: 64, z: 1 } },
  BrewingCommandAccepted: { _tag: 'BrewingCommandAccepted', commandId, revision: 13 },
  BrewingCommandRejected: { _tag: 'BrewingCommandRejected', commandId, reason: 'missing-ingredients', revision: 12 },
  BrewingStandDelta: {
    _tag: 'BrewingStandDelta',
    at: { x: 1, y: 64, z: 1 },
    revision: 13,
    state: { bottle: 'water_bottle', brewing: { output: 'awkward', remainingSecs: 12 }, fuelUnits: 4, ingredient: 'nether_wart' },
    world: overworld,
  },
  BucketUseCommand: { _tag: 'BucketUseCommand', ...commandHeader },
  Chat: { _tag: 'Chat', player: alice, text: 'hello 世界' },
  ContainerCommand: { _tag: 'ContainerCommand', ...commandHeader, containerId: 'chest:1', action: { _tag: 'open' } },
  ContainerDelta: { _tag: 'ContainerDelta', revision: 13, state: { containerId: 'dropper:1', kind: 'dropper', slots: [item] }, world: overworld },
  CraftingCommand: { _tag: 'CraftingCommand', ...commandHeader, grid: { cells: ['stone', null, null, null], height: 2, width: 2 } },
  CraftingCommandAccepted: { _tag: 'CraftingCommandAccepted', commandId, revision: 13 },
  CraftingCommandRejected: { _tag: 'CraftingCommandRejected', commandId, reason: 'no-match', revision: 12 },
  DamageEnderDragonCommand: { _tag: 'DamageEnderDragonCommand', commandId, expectedRevision: 12, player: alice },
  DamageEnderDragonCommandAccepted: { _tag: 'DamageEnderDragonCommandAccepted', commandId, revision: 13 },
  DamageEnderDragonCommandRejected: { _tag: 'DamageEnderDragonCommandRejected', commandId, reason: 'stale-revision', revision: 12 },
  DamageWitherCommand: { _tag: 'DamageWitherCommand', amount: 4, commandId, expectedRevision: 12, kind: 'melee', player: alice, witherId: 'wither-1' },
  SummonWitherCommand: { _tag: 'SummonWitherCommand', commandId, dimension: 'end', expectedRevision: 12, player: alice, position: { x: 0, y: 70, z: 0 } },
  WitherCommandAccepted: { _tag: 'WitherCommandAccepted', commandId, revision: 13 },
  WitherCommandRejected: { _tag: 'WitherCommandRejected', commandId, reason: 'invalid-command', revision: 12 },
  WitherSnapshotDelta: {
    _tag: 'WitherSnapshotDelta',
    revision: 13,
    snapshot: {
      nextSkullId: 0,
      nextWitherId: 1,
      skulls: [],
      withers: [
        {
          dimension: 'end',
          id: 'wither-1',
          meleeCooldownSecs: 0,
          rangedCooldownSecs: 0,
          shotsFired: 0,
          state: {
            chargeRemainingSecs: 0,
            feetPosition: { x: 0, y: 70, z: 0 },
            healthPoints: 300,
            phase: 'airborne',
            velocity: { x: 0, y: 0, z: 0 },
          },
        },
      ],
    },
  },
  EnchantingCommand: { _tag: 'EnchantingCommand', ...commandHeader, offer: 1, slot: 0 },
  EnchantingCommandAccepted: { _tag: 'EnchantingCommandAccepted', commandId, revision: 13 },
  EnchantingCommandRejected: { _tag: 'EnchantingCommandRejected', commandId, reason: 'insufficient-lapis', revision: 12 },
  EndPortalUseCommand: { _tag: 'EndPortalUseCommand', ...commandHeader, portal: { x: 1, y: 64, z: 1 } },
  EnderDragonSnapshotDelta: {
    _tag: 'EnderDragonSnapshotDelta',
    revision: 13,
    snapshot: { health: 200, phase: 'circling', phaseTimerSecs: 0, rewardEmitted: false },
  },
  EnderPearlCommand: { _tag: 'EnderPearlCommand', ...commandHeader },
  EntityAttackCommand: { _tag: 'EntityAttackCommand', ...commandHeader, entityId },
  EntityDespawnDelta: { _tag: 'EntityDespawnDelta', entityId, revision: 13, world: overworld },
  EntityPickupCommand: { _tag: 'EntityPickupCommand', ...commandHeader, entityId },
  EntitySpawnDelta: { _tag: 'EntitySpawnDelta', entity: living, revision: 13, world: overworld },
  EntityUpdateDelta: { _tag: 'EntityUpdateDelta', entity: { ...living, health: 19 }, revision: 13, world: overworld },
  EyeOfEnderThrown: {
    _tag: 'EyeOfEnderThrown', breaks: false, origin: { x: 1, y: 65, z: 1 }, player: alice, revision: 13, target: { x: 100, y: 72, z: 100 }, world: overworld,
  },
  FishingCommand: { _tag: 'FishingCommand', ...commandHeader, action: 'cast' },
  FurnaceCommand: { _tag: 'FurnaceCommand', ...commandHeader, furnaceId: 'furnace:1', action: { _tag: 'take-output', source: { _tag: 'furnace-slot', slot: 'output' }, destination: { _tag: 'player-slot', slot: 3 }, count: 1 } },
  FurnaceDelta: { _tag: 'FurnaceDelta', revision: 13, state: { burnTicksRemaining: 10, cookTicks: 5, fuel: null, furnaceId: 'furnace:1', input: item, output: null }, world: overworld },
  IgniteTntCommand: { _tag: 'IgniteTntCommand', ...commandHeader, at: { x: 1, y: 64, z: 1 } },
  InsertEyeIntoEndPortalFrameCommand: {
    _tag: 'InsertEyeIntoEndPortalFrameCommand',
    ...commandHeader,
    frame: { x: 1, y: 64, z: 1 },
  },
  LightningStrikeDelta: { _tag: 'LightningStrikeDelta', at: { x: 3.5, y: 72, z: -4.5 }, revision: 13, world: overworld },
  NetherPortalUseCommand: { _tag: 'NetherPortalUseCommand', ...commandHeader, portal: { x: 1, y: 64, z: 1 } },
  Ping: { _tag: 'Ping', nonce: 7 },
  PlayerAnvilNamesDelta: { _tag: 'PlayerAnvilNamesDelta', names: [{ name: 'Excalibur', slot: 0 }], player: alice, revision: 13, world: overworld },
  PlayerDamageCommand: { _tag: 'PlayerDamageCommand', ...commandHeader, amount: 4 },
  PlayerDamageCommandAccepted: { _tag: 'PlayerDamageCommandAccepted', commandId, revision: 13 },
  PlayerDamageCommandRejected: { _tag: 'PlayerDamageCommandRejected', commandId, reason: 'invalid-command', revision: 12 },
  PlayerEnchantmentsDelta: {
    _tag: 'PlayerEnchantmentsDelta',
    items: [{ item: { durability: { current: 40, max: 250 }, enchantments: [{ id: 'sharpness', level: 3 }], item: 'iron_sword' }, slot: 0 }],
    player: alice,
    revision: 13,
    seed: 42,
    world: overworld,
  },
  PlayerFishingDelta: { _tag: 'PlayerFishingDelta', player: alice, revision: 13, state: { phase: 'bite', result: 'bite' }, world: overworld },
  PlayerInventoryCommand: { _tag: 'PlayerInventoryCommand', ...commandHeader, action: { _tag: 'select-slot', slot: 2 } },
  PlayerInventoryDelta: { _tag: 'PlayerInventoryDelta', player: alice, revision: 13, state: { selectedSlot: 0, slots: [item] }, world: overworld },
  PlayerJoin: {
    _tag: 'PlayerJoin',
    at: { x: 8.5, y: 65, z: -12.25 },
    name: PlayerName.make('Alice'),
    player: alice,
  },
  PlayerLeave: { _tag: 'PlayerLeave', player: alice },
  PlayerMove: {
    _tag: 'PlayerMove',
    at: { x: -0.5, y: 64.125, z: 1024 },
    facing: { pitchRadians: -1.5, yawRadians: 3.14159 },
    player: alice,
  },
  PlayerStatusEffectsDelta: {
    _tag: 'PlayerStatusEffectsDelta',
    player: alice,
    revision: 13,
    state: { effects: [{ amplifier: 1, pulseClockSecs: 0.5, remainingSecs: 30, type: 'regeneration' }] },
    world: overworld,
  },
  PlayerVitalsCommand: { _tag: 'PlayerVitalsCommand', ...commandHeader, action: { _tag: 'activity', activity: 'swim', amount: 3 } },
  PlayerVitalsDelta: { _tag: 'PlayerVitalsDelta', player: alice, revision: 13, state: { experience: 1, health: 19, hunger: 18 }, world: overworld },
  Pong: { _tag: 'Pong', nonce: 7 },
  RealmTransferSnapshot: {
    _tag: 'RealmTransferSnapshot', at: { x: 0.5, y: 64, z: -4.25 }, authoritativeSnapshot: {
      _tag: 'AuthoritativeSnapshot', containers: [], entities: [], furnaces: [], inventories: [{ player: alice, state: { slots: [item], selectedSlot: 0 } }], revision: 1, timeWeather: { timeOfDay: 6000, weather: 'clear' }, villagerTrades: [], vitals: [{ player: alice, state: { health: 20, hunger: 20, experience: 1 } }], world: end,
    }, commandId, destinationWorld: end, facing: { pitchRadians: -0.25, yawRadians: 1.5 }, fromWorld: overworld, player: alice, worldSnapshot: { _tag: 'WorldSnapshot', blocks: [], levers: [], players: [], poweredRails: [], revision: 1, seed: 42, world: end },
  },
  ThrowEyeOfEnderCommand: { _tag: 'ThrowEyeOfEnderCommand', ...commandHeader },
  ToggleLeverCommand: { _tag: 'ToggleLeverCommand', ...commandHeader, lever: { x: 1, y: 64, z: 2 } },
  VehicleCommand: { _tag: 'VehicleCommand', ...commandHeader, entityId, action: { _tag: 'move', direction: 'forward' } },
  VehicleUseCommand: { _tag: 'VehicleUseCommand', ...commandHeader },
  VillagerTradeCommand: { _tag: 'VillagerTradeCommand', ...commandHeader, villagerId: 'villager:1', offerId: 'offer:1', action: 'execute-trade' },
  VillagerTradeDelta: { _tag: 'VillagerTradeDelta', revision: 13, state: { offers: [{ offerId: 'offer:1', input: [item], output: { item: 'emerald', count: 1 }, uses: 0, maxUses: 4 }], villagerId: 'villager:1' }, world: overworld },
  WorldInfo: { _tag: 'WorldInfo', seed: -1_234_567, world: overworld },
  WorldSnapshot: {
    _tag: 'WorldSnapshot',
    blocks: [
      { world: overworld, at: { x: 1, y: 2, z: 3 }, block: 'stone' },
      { world: overworld, at: { x: -1, y: 0, z: -3 }, block: null },
    ],
    levers: [{ at: { x: 3, y: 64, z: 3 }, active: true }],
    players: [
      {
        player: alice,
        name: PlayerName.make('Alice'),
        world: overworld,
        at: { x: 8.5, y: 65, z: -12.25 },
        facing: { yawRadians: 3.14159, pitchRadians: -1.5 },
      },
    ],
    poweredRails: [{ at: { x: 2, y: 64, z: 3 }, powered: true }],
    revision: 12,
    seed: -1_234_567,
    world: overworld,
  },
  WorldTimeWeatherCommand: { _tag: 'WorldTimeWeatherCommand', ...commandHeader, action: { _tag: 'set-time', timeOfDay: 6000 } },
  WorldTimeWeatherDelta: { _tag: 'WorldTimeWeatherDelta', revision: 13, state: { timeOfDay: 7000, weather: 'rain' }, world: overworld },
}

const OWNER_STATE_SCHEMA = Schema.Struct({ count: Schema.Number.pipe(Schema.check(Schema.isInt())) })
const OWNER_ID = makeReplicatedOwnerId('codec-owner')
const OWNER_REGISTRATION: ReplicatedOwnerRegistration<typeof OWNER_STATE_SCHEMA> = {
  ownerId: OWNER_ID,
  schema: OWNER_STATE_SCHEMA,
  initialState: { count: 0 },
}
const EMPTY_OWNER_REGISTRY_LIMITS: ReplicatedOwnerRegistryLimits = {
  maxRegisteredOwners: 0,
  maxDeltaBlockChanges: 0,
  maxSnapshotBlockReads: 0,
  maxDepth: GLOBAL_JSON_DEPTH_LIMIT,
  maxCollectionItems: GLOBAL_JSON_COLLECTION_LIMIT,
  maxDeltaFrameBytes: 1_048_576,
  maxSnapshotFrameBytes: 1_048_576,
  ownerStates: [],
}
const EMPTY_OWNER_REGISTRY = Result.getOrThrow(createReplicatedOwnerRegistry([], EMPTY_OWNER_REGISTRY_LIMITS))
const OWNER_REGISTRY_LIMITS: ReplicatedOwnerRegistryLimits = {
  maxRegisteredOwners: 1,
  maxDeltaBlockChanges: 2,
  maxSnapshotBlockReads: 2,
  maxDepth: GLOBAL_JSON_DEPTH_LIMIT,
  maxCollectionItems: GLOBAL_JSON_COLLECTION_LIMIT,
  maxDeltaFrameBytes: 1_048_576,
  maxSnapshotFrameBytes: 1_048_576,
  ownerStates: [{
    ownerId: OWNER_ID,
    maxStateBytes: wireFrameByteLength(JSON.stringify({ count: Number.MAX_VALUE })),
    maxStateDepth: 2,
    maxCollectionItems: 1,
  }],
}
const OWNER_REGISTRY = Result.getOrThrow(createReplicatedOwnerRegistry([OWNER_REGISTRATION], OWNER_REGISTRY_LIMITS))
const OWNER_DELTA = Result.getOrThrow(Schema.decodeUnknownResult(ReplicatedWorldDeltaMessage)({
  _tag: 'ReplicatedWorldDelta',
  world: overworld,
  revision: replicatedWorldRevision,
  changes: [{ owner: OWNER_ID, state: { count: 1 } }],
  blockChanges: [],
}))
const OWNER_SNAPSHOT = { ...emptyWorldSnapshot, owners: [{ owner: OWNER_ID, state: { count: 1 } }] }
const encoded = (message: NetworkMessage): string => Result.getOrThrow(encodeFrame(message, EMPTY_OWNER_REGISTRY))

const MAXIMUM_OWNER_STATE_SCHEMA = Schema.Struct({ labels: Schema.Array(Schema.String) })
const MAXIMUM_OWNER_LABEL = 'x'.repeat(34)
const MAXIMUM_OWNER_STATE = { labels: [MAXIMUM_OWNER_LABEL, 'y'.repeat(34)] }
const MAXIMUM_C4_PROFILE_OWNER_COUNT = 3
const MAXIMUM_C4_PROFILE_DELTA_BLOCK_COUNT = 256
const MAXIMUM_C4_PROFILE_SNAPSHOT_BLOCK_COUNT = 15_000
const MAXIMUM_C4_PROFILE_OWNER_STATE_DEPTH = 3
const MAXIMUM_C4_PROFILE_FRAME_DEPTH = 6
const MAXIMUM_C4_OWNER_STATE_BYTES = wireFrameByteLength(JSON.stringify(MAXIMUM_OWNER_STATE))
const MAXIMUM_C4_OWNER_STATE_LIMIT_BYTES = Math.ceil(MAXIMUM_C4_OWNER_STATE_BYTES * 1.25)
const MAXIMUM_C4_OWNER_STATE_EMPTY_COLLECTION = { labels: ['', '', ''] }
const MAXIMUM_C4_OWNER_STATE_AT_LIMIT = {
  labels: [
    'x'.repeat(MAXIMUM_C4_OWNER_STATE_LIMIT_BYTES - wireFrameByteLength(JSON.stringify(MAXIMUM_C4_OWNER_STATE_EMPTY_COLLECTION))),
    '',
    '',
  ],
}
const MAXIMUM_C4_OWNER_STATE_OVER_LIMIT = {
  labels: [
    'x'.repeat(MAXIMUM_C4_OWNER_STATE_LIMIT_BYTES + 1 - wireFrameByteLength(JSON.stringify(MAXIMUM_C4_OWNER_STATE_EMPTY_COLLECTION))),
    '',
    '',
  ],
}
const MAXIMUM_C4_OWNER_IDS = [
  OWNER_ID,
  makeReplicatedOwnerId('codec-owner-2'),
  makeReplicatedOwnerId('codec-owner-3'),
  makeReplicatedOwnerId('codec-owner-4'),
] as const
const MAXIMUM_C4_BLOCK_BEFORE = 65_535
const MAXIMUM_C4_BLOCK_AFTER = 65_534
const MAXIMUM_C4_BLOCK_READ = 65_535
const MAXIMUM_C4_AXIS = Number.MIN_SAFE_INTEGER
const maximumC4BlockPosition = (index: number) => Schema.decodeUnknownSync(BlockPositionSchema)({
  x: MAXIMUM_C4_AXIS + index,
  y: MAXIMUM_C4_AXIS,
  z: MAXIMUM_C4_AXIS,
})
const MAXIMUM_C4_PROFILE_OWNER_IDS = MAXIMUM_C4_OWNER_IDS.slice(0, MAXIMUM_C4_PROFILE_OWNER_COUNT)
const MAXIMUM_C4_OWNER_CHANGES_AT_LIMIT = MAXIMUM_C4_OWNER_IDS.map((owner) => ({
  owner,
  state: MAXIMUM_C4_OWNER_STATE_AT_LIMIT,
}))
const MAXIMUM_C4_REGISTRATIONS: ReadonlyArray<ReplicatedOwnerRegistration<typeof MAXIMUM_OWNER_STATE_SCHEMA>> =
  MAXIMUM_C4_OWNER_IDS.map((ownerId) => ({
    ownerId,
    schema: MAXIMUM_OWNER_STATE_SCHEMA,
    initialState: MAXIMUM_OWNER_STATE,
  }))
const MAXIMUM_C4_OWNER_BOUNDS: ReplicatedOwnerRegistryLimits['ownerStates'] = MAXIMUM_C4_OWNER_IDS.map((ownerId) => ({
  ownerId,
  maxStateBytes: MAXIMUM_C4_OWNER_STATE_LIMIT_BYTES,
  maxStateDepth: Math.ceil(MAXIMUM_C4_PROFILE_OWNER_STATE_DEPTH * 1.25),
  maxCollectionItems: 3,
}))
const MAXIMUM_C4_OWNER_COUNT_LIMIT = Math.ceil(MAXIMUM_C4_PROFILE_OWNER_COUNT * 1.25)
const MAXIMUM_C4_DELTA_BLOCK_LIMIT = Math.ceil(MAXIMUM_C4_PROFILE_DELTA_BLOCK_COUNT * 1.25)
const MAXIMUM_C4_SNAPSHOT_BLOCK_LIMIT = Math.ceil(MAXIMUM_C4_PROFILE_SNAPSHOT_BLOCK_COUNT * 1.25)
const MAXIMUM_C4_DEPTH_LIMIT = Math.ceil(MAXIMUM_C4_PROFILE_FRAME_DEPTH * 1.25)
const MAXIMUM_C4_COLLECTION_LIMIT = MAXIMUM_C4_SNAPSHOT_BLOCK_LIMIT
const MAXIMUM_C4_SIZING_LIMITS: ReplicatedOwnerRegistryLimits = {
  maxRegisteredOwners: MAXIMUM_C4_OWNER_COUNT_LIMIT,
  maxDeltaBlockChanges: MAXIMUM_C4_DELTA_BLOCK_LIMIT,
  maxSnapshotBlockReads: MAXIMUM_C4_SNAPSHOT_BLOCK_LIMIT,
  maxDepth: MAXIMUM_C4_DEPTH_LIMIT,
  maxCollectionItems: MAXIMUM_C4_COLLECTION_LIMIT,
  maxDeltaFrameBytes: GLOBAL_FRAME_UTF8_LIMIT,
  maxSnapshotFrameBytes: 8 * 1_048_576,
  ownerStates: MAXIMUM_C4_OWNER_BOUNDS,
}
const MAXIMUM_C4_MEASUREMENT_REGISTRY = Result.getOrThrow(
  createReplicatedOwnerRegistry(MAXIMUM_C4_REGISTRATIONS, MAXIMUM_C4_SIZING_LIMITS),
)
const MAXIMUM_C4_REVISION = Result.getOrThrow(Schema.decodeUnknownResult(WorldRevisionSchema)(Number.MAX_SAFE_INTEGER))
const maximumOwnerChanges = MAXIMUM_C4_PROFILE_OWNER_IDS.map((owner) => ({
  owner,
  state: MAXIMUM_C4_OWNER_STATE_AT_LIMIT,
}))
const MAXIMUM_C4_DELTA = Result.getOrThrow(Schema.decodeUnknownResult(ReplicatedWorldDeltaMessage)({
  _tag: 'ReplicatedWorldDelta',
  world: overworld,
  revision: MAXIMUM_C4_REVISION,
  changes: maximumOwnerChanges,
  blockChanges: Array.from({ length: MAXIMUM_C4_PROFILE_DELTA_BLOCK_COUNT }, (_, index) => ({
    before: MAXIMUM_C4_BLOCK_BEFORE,
    dimension: 'overworld',
    position: maximumC4BlockPosition(index),
    after: MAXIMUM_C4_BLOCK_AFTER,
  })),
}))
const MAXIMUM_C4_DELTA_AT_COUNT_LIMIT = Result.getOrThrow(Schema.decodeUnknownResult(ReplicatedWorldDeltaMessage)({
  ...MAXIMUM_C4_DELTA,
  changes: MAXIMUM_C4_OWNER_CHANGES_AT_LIMIT,
  blockChanges: Array.from({ length: MAXIMUM_C4_DELTA_BLOCK_LIMIT }, (_, index) => ({
    before: MAXIMUM_C4_BLOCK_BEFORE,
    dimension: 'overworld',
    position: maximumC4BlockPosition(index),
    after: MAXIMUM_C4_BLOCK_AFTER,
  })),
}))
const MAXIMUM_C4_SNAPSHOT = Result.getOrThrow(Schema.decodeUnknownResult(ReplicatedWorldSnapshot)({
  _tag: 'ReplicatedWorldSnapshot',
  world: overworld,
  revision: MAXIMUM_C4_REVISION,
  owners: maximumOwnerChanges,
  blocks: Array.from({ length: MAXIMUM_C4_PROFILE_SNAPSHOT_BLOCK_COUNT }, (_, index) => ({
    dimension: 'overworld',
    position: maximumC4BlockPosition(index),
    reading: { _tag: 'Block' as const, block: MAXIMUM_C4_BLOCK_READ },
  })),
}))
const MAXIMUM_C4_SNAPSHOT_AT_COUNT_LIMIT = Result.getOrThrow(Schema.decodeUnknownResult(ReplicatedWorldSnapshot)({
  ...MAXIMUM_C4_SNAPSHOT,
  owners: MAXIMUM_C4_OWNER_CHANGES_AT_LIMIT,
  blocks: Array.from({ length: MAXIMUM_C4_SNAPSHOT_BLOCK_LIMIT }, (_, index) => ({
    dimension: 'overworld',
    position: maximumC4BlockPosition(index),
    reading: { _tag: 'Block' as const, block: MAXIMUM_C4_BLOCK_READ },
  })),
}))
const MAXIMUM_C4_DELTA_FRAME_BYTES = wireFrameByteLength(
  Result.getOrThrow(encodeFrame(MAXIMUM_C4_DELTA, MAXIMUM_C4_MEASUREMENT_REGISTRY)),
)
const MAXIMUM_C4_SNAPSHOT_FRAME_BYTES = wireFrameByteLength(
  Result.getOrThrow(encodeTransferredSnapshotFrame(
    MAXIMUM_C4_SNAPSHOT,
    MAXIMUM_C4_MEASUREMENT_REGISTRY,
    MAXIMUM_C4_SIZING_LIMITS.maxSnapshotFrameBytes,
  )),
)
const MAXIMUM_C4_DELTA_COUNT_FRAME_BYTES = wireFrameByteLength(
  Result.getOrThrow(encodeFrame(MAXIMUM_C4_DELTA_AT_COUNT_LIMIT, MAXIMUM_C4_MEASUREMENT_REGISTRY)),
)
const MAXIMUM_C4_SNAPSHOT_COUNT_FRAME_BYTES = wireFrameByteLength(
  Result.getOrThrow(encodeTransferredSnapshotFrame(
    MAXIMUM_C4_SNAPSHOT_AT_COUNT_LIMIT,
    MAXIMUM_C4_MEASUREMENT_REGISTRY,
    MAXIMUM_C4_SIZING_LIMITS.maxSnapshotFrameBytes,
  )),
)
const MAXIMUM_C4_DELTA_FRAME_LIMIT = Math.ceil(Math.max(
  MAXIMUM_C4_DELTA_FRAME_BYTES,
  MAXIMUM_C4_DELTA_COUNT_FRAME_BYTES,
) * 1.25)
const MAXIMUM_C4_SNAPSHOT_FRAME_LIMIT = Math.ceil(Math.max(
  MAXIMUM_C4_SNAPSHOT_FRAME_BYTES,
  MAXIMUM_C4_SNAPSHOT_COUNT_FRAME_BYTES,
) * 1.25)
const MAXIMUM_C4_LIMITS: ReplicatedOwnerRegistryLimits = {
  ...MAXIMUM_C4_SIZING_LIMITS,
  maxDeltaFrameBytes: MAXIMUM_C4_DELTA_FRAME_LIMIT,
  maxSnapshotFrameBytes: MAXIMUM_C4_SNAPSHOT_FRAME_LIMIT,
}
const MAXIMUM_C4_REGISTRY = Result.getOrThrow(createReplicatedOwnerRegistry(MAXIMUM_C4_REGISTRATIONS, MAXIMUM_C4_LIMITS))
const withWorldPaddingAtFrameLimit = <Message extends NetworkMessage & { readonly world: WorldId }>(
  message: Message,
  frameLimit: number,
): Message => {
  const baseFrame = Result.getOrThrow(encodeFrame(message, MAXIMUM_C4_MEASUREMENT_REGISTRY))
  const paddingBytes = frameLimit - wireFrameByteLength(baseFrame)
  return { ...message, world: WorldId.make(`${message.world}${'x'.repeat(paddingBytes)}`) }
}
const withWorldPaddingAtTransferredFrameLimit = <Message extends NetworkMessage & { readonly world: WorldId }>(
  message: Message,
  frameLimit: number,
): Message => {
  const baseFrame = Result.getOrThrow(encodeTransferredSnapshotFrame(
    message,
    MAXIMUM_C4_MEASUREMENT_REGISTRY,
    MAXIMUM_C4_SIZING_LIMITS.maxSnapshotFrameBytes,
  ))
  const paddingBytes = frameLimit - wireFrameByteLength(baseFrame)
  return { ...message, world: WorldId.make(`${message.world}${'x'.repeat(paddingBytes)}`) }
}
const MAXIMUM_C4_DELTA_AT_FRAME_LIMIT = withWorldPaddingAtFrameLimit(MAXIMUM_C4_DELTA, MAXIMUM_C4_DELTA_FRAME_LIMIT)
const MAXIMUM_C4_SNAPSHOT_AT_FRAME_LIMIT = withWorldPaddingAtTransferredFrameLimit(MAXIMUM_C4_SNAPSHOT, MAXIMUM_C4_SNAPSHOT_FRAME_LIMIT)

type FrameShape = Readonly<{ maxDepth: number; maxCollectionItems: number }>
const measureFrameShape = (value: unknown, parentDepth = 0): FrameShape => {
  if (Array.isArray(value)) {
    const depth = parentDepth + 1
    const childShapes = value.map((entry) => measureFrameShape(entry, depth))
    return {
      maxDepth: Math.max(depth, ...childShapes.map((shape) => shape.maxDepth)),
      maxCollectionItems: Math.max(value.length, ...childShapes.map((shape) => shape.maxCollectionItems)),
    }
  }
  if (typeof value === 'object' && value !== null) {
    const entries = Object.values(value)
    const depth = parentDepth + 1
    const childShapes = entries.map((entry) => measureFrameShape(entry, depth))
    return {
      maxDepth: Math.max(depth, ...childShapes.map((shape) => shape.maxDepth)),
      maxCollectionItems: Math.max(entries.length, ...childShapes.map((shape) => shape.maxCollectionItems)),
    }
  }
  return { maxDepth: parentDepth, maxCollectionItems: 0 }
}

type JsonPathSegment = string | number
type JsonPath = ReadonlyArray<JsonPathSegment>
type FrameBudget = Readonly<{ codeUnits: number; utf8Bytes: number }>

const GLOBAL_FRAME_BUDGET: FrameBudget = {
  codeUnits: GLOBAL_FRAME_CODE_UNIT_LIMIT,
  utf8Bytes: GLOBAL_FRAME_UTF8_LIMIT,
}
const LEGACY_FRAME_BUDGETS: ReadonlyMap<NetworkMessage['_tag'], FrameBudget> = new Map([
  ['PlayerDamageCommand', { codeUnits: 1_024, utf8Bytes: 4_096 }],
  ['CraftingCommand', { codeUnits: 1_024, utf8Bytes: 4_096 }],
  ['BrewingCommand', { codeUnits: 8_192, utf8Bytes: 32_768 }],
  ['AnvilCommand', { codeUnits: 2_048, utf8Bytes: 8_192 }],
  ['EnchantingCommand', { codeUnits: 32_768, utf8Bytes: 131_072 }],
  ['SummonWitherCommand', { codeUnits: 1_048_576, utf8Bytes: 4_194_304 }],
  ['DamageWitherCommand', { codeUnits: 1_048_576, utf8Bytes: 4_194_304 }],
  ['DamageEnderDragonCommand', { codeUnits: 16_384, utf8Bytes: 65_536 }],
])
const frameBudgetForTag = (tag: NetworkMessage['_tag']): FrameBudget => {
  const legacy = LEGACY_FRAME_BUDGETS.get(tag)
  return {
    codeUnits: Math.min(GLOBAL_FRAME_BUDGET.codeUnits, legacy?.codeUnits ?? GLOBAL_FRAME_BUDGET.codeUnits),
    utf8Bytes: Math.min(GLOBAL_FRAME_BUDGET.utf8Bytes, legacy?.utf8Bytes ?? GLOBAL_FRAME_BUDGET.utf8Bytes),
  }
}
const MAXIMUM_SAMPLE_PARSE_OPTIONS = { onExcessProperty: 'error' as const }
const decodeNetworkMessage = (value: unknown): NetworkMessage | undefined => {
  const decoded = Schema.decodeUnknownResult(NetworkMessage, MAXIMUM_SAMPLE_PARSE_OPTIONS)(value)
  return Result.isSuccess(decoded) ? decoded.success : undefined
}
const isRecordValue = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const stringPaths = (value: unknown, path: JsonPath = []): ReadonlyArray<JsonPath> => {
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => stringPaths(entry, [...path, index]))
  }
  if (isRecordValue(value)) {
    return Object.entries(value).flatMap(([key, entry]) => key === '_tag' ? [] : stringPaths(entry, [...path, key]))
  }
  return typeof value === 'string' ? [path] : []
}
const arrayPaths = (value: unknown, path: JsonPath = []): ReadonlyArray<JsonPath> => {
  if (Array.isArray(value)) {
    return [path, ...value.flatMap((entry, index) => arrayPaths(entry, [...path, index]))]
  }
  if (isRecordValue(value)) {
    return Object.entries(value).flatMap(([key, entry]) => key === '_tag' ? [] : arrayPaths(entry, [...path, key]))
  }
  return []
}
const canonicalArrayPath = (path: JsonPath): string => path.map((segment, index) =>
  typeof segment === 'number' ? '[]' : index === 0 ? segment : `.${segment}`,
).join('')
let MAXIMUM_ARRAY_FIXTURE_OBSERVED_DEPTH = 0
let MAXIMUM_ARRAY_FIXTURE_OBSERVED_COLLECTION = 0
const numberPaths = (value: unknown, path: JsonPath = []): ReadonlyArray<JsonPath> => {
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => numberPaths(entry, [...path, index]))
  }
  if (isRecordValue(value)) {
    return Object.entries(value).flatMap(([key, entry]) => numberPaths(entry, [...path, key]))
  }
  return typeof value === 'number' ? [path] : []
}
const replaceAtPath = (value: unknown, path: JsonPath, replacement: unknown): unknown => {
  const [segment, ...rest] = path
  if (segment === undefined) {
    return replacement
  }
  if (Array.isArray(value) && typeof segment === 'number') {
    return value.map((entry, index) => index === segment ? replaceAtPath(entry, rest, replacement) : entry)
  }
  if (isRecordValue(value) && typeof segment === 'string') {
    return { ...value, [segment]: replaceAtPath(value[segment], rest, replacement) }
  }
  return value
}
const valueAtPath = (value: unknown, path: JsonPath): unknown => {
  let current = value
  for (const segment of path) {
    if (Array.isArray(current) && typeof segment === 'number') {
      current = current[segment]
    } else if (isRecordValue(current) && typeof segment === 'string') {
      current = current[segment]
    } else {
      return undefined
    }
  }
  return current
}
type ArraySampleWitness = Readonly<{ path: JsonPath; value: unknown }>
const MAXIMUM_ARRAY_SAMPLE_WITNESSES: Partial<Record<NetworkMessage['_tag'], ReadonlyArray<ArraySampleWitness>>> = {
  AuthoritativeSnapshot: [
    { path: ['containers'], value: SAMPLES.ContainerDelta.state },
    { path: ['furnaces'], value: SAMPLES.FurnaceDelta.state },
    { path: ['villagerTrades'], value: SAMPLES.VillagerTradeDelta.state },
  ],
  RealmTransferSnapshot: [
    { path: ['authoritativeSnapshot', 'containers'], value: SAMPLES.ContainerDelta.state },
    { path: ['authoritativeSnapshot', 'entities'], value: living },
    { path: ['authoritativeSnapshot', 'furnaces'], value: SAMPLES.FurnaceDelta.state },
    { path: ['authoritativeSnapshot', 'villagerTrades'], value: SAMPLES.VillagerTradeDelta.state },
    { path: ['worldSnapshot', 'blocks'], value: { world: end, at: { x: 1, y: 64, z: 1 }, block: 'stone' } },
    { path: ['worldSnapshot', 'levers'], value: { at: { x: 2, y: 64, z: 1 }, active: true } },
    {
      path: ['worldSnapshot', 'players'],
      value: {
        player: alice,
        name: PlayerName.make('Alice'),
        world: end,
        at: { x: 1, y: 64, z: 1 },
        facing: { yawRadians: 0, pitchRadians: 0 },
      },
    },
    { path: ['worldSnapshot', 'poweredRails'], value: { at: { x: 3, y: 64, z: 1 }, powered: true } },
  ],
  WitherSnapshotDelta: [{
    path: ['snapshot', 'skulls'],
    value: {
      ageSecs: 0,
      descriptor: {
        destroysResistantBlocks: false,
        direction: { x: 0, y: 0, z: 1 },
        explosivePower: 1,
        origin: { x: 0, y: 70, z: 0 },
        speed: 1,
        variant: 'normal',
      },
      dimension: 'end',
      id: 'skull-1',
      ownerId: 'wither-1',
      position: { x: 0, y: 70, z: 0 },
    },
  }],
}
const withMaximumArraySampleWitnesses = (tag: NetworkMessage['_tag'], message: NetworkMessage): NetworkMessage => {
  const candidate = (MAXIMUM_ARRAY_SAMPLE_WITNESSES[tag] ?? []).reduce<unknown>((current, { path, value }) => {
    const array = valueAtPath(current, path)
    expect(Array.isArray(array), `${tag}.${canonicalArrayPath(path)} witness path must be an array`).toBe(true)
    return Array.isArray(array) && array.length === 0 ? replaceAtPath(current, path, [value]) : current
  }, message)
  const decoded = decodeNetworkMessage(candidate)
  expect(decoded, `${tag} seeded array witnesses must satisfy NetworkMessage`).toBeDefined()
  return decoded ?? message
}
const MAXIMUM_SCHEMA_NUMBER_CANDIDATES = [
  -Number.MAX_SAFE_INTEGER,
  -1_000_000,
  -300,
  -200,
  -100,
  -64,
  -50,
  -36,
  -20,
  -10,
  -3,
  -2,
  -1,
  0,
  0.5,
  1,
  2,
  3,
  4,
  9,
  20,
  24_000,
  35,
  36,
  50,
  64,
  100,
  200,
  300,
  1_000,
  65_535,
  1_000_000,
  1_000_000_000,
  Math.PI / 2,
  Number.MAX_SAFE_INTEGER,
  Number.MAX_VALUE,
].sort((left, right) => right - left)
const maximumSchemaNumbers = (message: NetworkMessage): NetworkMessage => {
  let current: NetworkMessage = message
  for (const path of numberPaths(current)) {
    const initial = valueAtPath(current, path)
    if (typeof initial !== 'number') {
      continue
    }
    const candidates = MAXIMUM_SCHEMA_NUMBER_CANDIDATES.filter((candidate) => candidate > initial)
    let maximumMessage = current
    let lower = 0
    let upper = candidates.length - 1
    while (lower <= upper) {
      const middle = Math.floor((lower + upper) / 2)
      const candidate = candidates[middle]
      if (candidate === undefined) {
        break
      }
      const decoded = decodeNetworkMessage(replaceAtPath(current, path, candidate))
      if (decoded !== undefined) {
        maximumMessage = decoded
        upper = middle - 1
      } else {
        lower = middle + 1
      }
    }
    current = maximumMessage
  }
  return current
}
const maximumDomainMessage = (sample: NetworkMessage): NetworkMessage => {
  switch (sample._tag) {
    case 'Chat':
      return { ...sample, text: 'x'.repeat(256) }
    case 'PlayerMove':
      return { ...sample, world: overworld }
    case 'BlockBreak':
      return { ...sample, world: overworld }
    case 'BlockPlace':
      return { ...sample, world: overworld }
    case 'PlayerInventoryCommand':
      return { ...sample, action: { _tag: 'move-item', count: 1, destination: 1, source: 0 } }
    case 'PlayerVitalsCommand':
      return { ...sample, action: { _tag: 'activity', activity: 'attack', amount: 100 } }
    case 'ContainerCommand':
      return {
        ...sample,
        action: {
          _tag: 'move-item',
          count: 1,
          destination: { _tag: 'container-slot', slot: 0 },
          source: { _tag: 'player-slot', slot: 0 },
        },
      }
    case 'FurnaceCommand':
      return {
        ...sample,
        action: {
          _tag: 'move-item',
          count: 1,
          destination: { _tag: 'furnace-slot', slot: 'input' },
          source: { _tag: 'player-slot', slot: 0 },
        },
      }
    case 'BowUseCommand':
      return { ...sample, action: 'release' }
    case 'FishingCommand':
      return { ...sample, action: 'reel' }
    case 'VehicleCommand':
      return { ...sample, action: { _tag: 'move', direction: 'backward' } }
    case 'AnvilCommand':
      return { ...sample, name: 'x'.repeat(50), slot: 35 }
    case 'PlayerAnvilNamesDelta':
      return {
        ...sample,
        names: Array.from({ length: 36 }, (_, slot) => ({ name: 'x'.repeat(50), slot })),
      }
    case 'CraftingCommand':
      return { ...sample, grid: { cells: Array.from({ length: 9 }, () => 'stone'), height: 3, width: 3 } }
    case 'PlayerDamageCommand':
      return { ...sample, amount: 20, minimumHealthPoints: 1 }
    case 'BrewingCommand':
      return { ...sample, action: { _tag: 'insert', slot: 35 } }
    case 'EnchantingCommand':
      return { ...sample, offer: 2, slot: 35 }
    case 'PlayerEnchantmentsDelta': {
      const template = sample.items[0]?.item
      if (template === undefined) {
        return sample
      }
      return {
        ...sample,
        items: Array.from({ length: 36 }, (_, slot) => ({ item: template, slot })),
      }
    }
    case 'DamageWitherCommand':
      return { ...sample, kind: 'explosion' }
    case 'EnderDragonSnapshotDelta':
      return { ...sample, snapshot: { ...sample.snapshot, health: 200, phase: 'perching', rewardEmitted: false } }
    case 'AnvilCommandRejected':
      return { ...sample, reason: 'insufficient-experience' }
    case 'AuthoritativeCommandRejected':
      return { ...sample, reason: 'unauthorized-player' }
    case 'CraftingCommandRejected':
      return { ...sample, reason: 'missing-ingredients' }
    case 'PlayerDamageCommandRejected':
      return { ...sample, reason: 'unauthorized-player' }
    case 'EnchantingCommandRejected':
      return { ...sample, reason: 'conflicting-enchantment' }
    case 'DamageEnderDragonCommandRejected':
      return { ...sample, reason: 'invalid-command' }
    case 'WitherCommandRejected':
      return { ...sample, reason: 'invalid-command' }
    default:
      return sample
  }
}
const maximumBooleanValues = (message: NetworkMessage): NetworkMessage => {
  let current: NetworkMessage = message
  const visit = (value: unknown, path: JsonPath = []): void => {
    if (Array.isArray(value)) {
      value.forEach((entry, index) => visit(entry, [...path, index]))
      return
    }
    if (isRecordValue(value)) {
      Object.entries(value).forEach(([key, entry]) => visit(entry, [...path, key]))
      return
    }
    if (typeof value !== 'boolean') {
      return
    }
    const decoded = decodeNetworkMessage(replaceAtPath(current, path, false))
    if (decoded !== undefined) {
      current = decoded
    }
  }
  visit(message)
  return current
}
const maximumFixedSample = (tag: NetworkMessage['_tag']): NetworkMessage => {
  if (tag === 'Ping' || tag === 'Pong') {
    return { _tag: tag, nonce: Number.MAX_SAFE_INTEGER }
  }
  return maximumDomainMessage(SAMPLES[tag])
}
const envelopeText = (message: unknown): string => JSON.stringify({ message, protocolVersion: PROTOCOL_VERSION })
const maximumFrameForStringPath = (
  message: NetworkMessage,
  path: JsonPath,
  budget: FrameBudget,
): Readonly<{ bytes: number; message: NetworkMessage; frame: string }> | undefined => {
  const emptyStringMessage = replaceAtPath(message, path, '')
  const emptyStringFrame = envelopeText(emptyStringMessage)
  const availableCodeUnits = budget.codeUnits - emptyStringFrame.length
  const availableUtf8Bytes = budget.utf8Bytes - wireFrameByteLength(emptyStringFrame)
  if (availableCodeUnits < 1 || availableUtf8Bytes < 1) {
    return undefined
  }

  const maximumFrameCandidate = (size: number, makeString: (size: number) => string) => {
    const candidate = decodeNetworkMessage(replaceAtPath(message, path, makeString(size)))
    if (candidate === undefined) {
      return undefined
    }
    const frame = envelopeText(candidate)
    const bytes = wireFrameByteLength(frame)
    if (frame.length > budget.codeUnits || bytes > budget.utf8Bytes) {
      return undefined
    }
    return { bytes, frame, message: candidate }
  }

  const largestAccepted = (
    maximumSize: number,
    makeString: (size: number) => string,
  ) => {
    const maximum = maximumFrameCandidate(maximumSize, makeString)
    if (maximum !== undefined) {
      return maximum
    }

    let lower = 1
    let upper = maximumSize - 1
    let best: ReturnType<typeof maximumFrameCandidate> = undefined
    while (lower <= upper) {
      const middle = Math.floor((lower + upper) / 2)
      const candidate = maximumFrameCandidate(middle, makeString)
      if (candidate !== undefined) {
        best = candidate
        lower = middle + 1
      } else {
        upper = middle - 1
      }
    }
    return best
  }

  const maximumUnicodeBytes = Math.min(availableUtf8Bytes, availableCodeUnits * 3)
  const unicodeFixture = largestAccepted(maximumUnicodeBytes, (byteCount) => {
    const triplets = Math.floor(byteCount / 3)
    const remainder = byteCount % 3
    return '\u0800'.repeat(triplets) + (remainder === 2 ? 'é' : remainder === 1 ? 'x' : '')
  })
  if (unicodeFixture !== undefined && (
    unicodeFixture.frame.length === budget.codeUnits || unicodeFixture.bytes === budget.utf8Bytes
  )) {
    return unicodeFixture
  }
  const maximumAsciiLength = Math.min(availableCodeUnits, availableUtf8Bytes)
  const asciiFixture = largestAccepted(maximumAsciiLength, (length) => 'x'.repeat(length))
  if (unicodeFixture === undefined) {
    return asciiFixture
  }
  if (asciiFixture === undefined) {
    return unicodeFixture
  }
  return unicodeFixture.bytes >= asciiFixture.bytes
    ? unicodeFixture
    : asciiFixture
}
const maximumWorldIdForFrame = (frame: string, worldId: WorldId, budget: FrameBudget): WorldId => {
  const serializedWorldId = JSON.stringify(worldId)
  const fixedCodeUnits = frame.length - serializedWorldId.length
  const fixedUtf8Bytes = wireFrameByteLength(frame) - wireFrameByteLength(serializedWorldId)
  const availableCodeUnits = budget.codeUnits - fixedCodeUnits - 2
  const availableUtf8Bytes = budget.utf8Bytes - fixedUtf8Bytes - 2
  const maximumUnicodeBytes = Math.min(availableUtf8Bytes, availableCodeUnits * 3)
  const triplets = Math.floor(maximumUnicodeBytes / 3)
  const remainder = maximumUnicodeBytes % 3
  return WorldId.make('\u0800'.repeat(triplets) + (remainder === 2 ? 'é' : remainder === 1 ? 'x' : ''))
}
const maximumWireFixtureForTag = (
  tag: NetworkMessage['_tag'],
): Readonly<{ message: NetworkMessage; frame: string; owners: typeof EMPTY_OWNER_REGISTRY }> => {
  if (tag === 'ReplicatedWorldDelta') {
    return {
      message: MAXIMUM_C4_DELTA_AT_FRAME_LIMIT,
      frame: envelopeText(MAXIMUM_C4_DELTA_AT_FRAME_LIMIT),
      owners: MAXIMUM_C4_REGISTRY,
    }
  }
  if (tag === 'ReplicatedWorldSnapshot') {
    return {
      message: MAXIMUM_C4_SNAPSHOT_AT_FRAME_LIMIT,
      frame: envelopeText(MAXIMUM_C4_SNAPSHOT_AT_FRAME_LIMIT),
      owners: MAXIMUM_C4_REGISTRY,
    }
  }

  let message = maximumFixedSample(tag)
  const budget = frameBudgetForTag(tag)
  if (tag === 'AuthoritativeSnapshot' && message._tag === 'AuthoritativeSnapshot') {
    const world = maximumWorldIdForFrame(envelopeText(message), message.world, budget)
    const maximumMessage = { ...message, world }
    return { message: maximumMessage, frame: envelopeText(maximumMessage), owners: EMPTY_OWNER_REGISTRY }
  }
  if (tag === 'WorldSnapshot' && message._tag === 'WorldSnapshot') {
    const world = maximumWorldIdForFrame(envelopeText(message), message.world, budget)
    const maximumMessage = { ...message, world }
    return { message: maximumMessage, frame: envelopeText(maximumMessage), owners: EMPTY_OWNER_REGISTRY }
  }
  if (tag === 'RealmTransferSnapshot' && message._tag === 'RealmTransferSnapshot') {
    const destinationWorld = maximumWorldIdForFrame(envelopeText(message), message.destinationWorld, budget)
    const maximumMessage = { ...message, destinationWorld }
    return { message: maximumMessage, frame: envelopeText(maximumMessage), owners: EMPTY_OWNER_REGISTRY }
  }
  message = maximumBooleanValues(maximumSchemaNumbers(maximumDomainMessage(message)))
  let largest: ReturnType<typeof maximumFrameForStringPath> = undefined
  for (const path of stringPaths(message)) {
    const candidate = maximumFrameForStringPath(message, path, budget)
    if (candidate === undefined) {
      continue
    }
    const candidateIsAtCeiling = candidate.frame.length === budget.codeUnits || candidate.bytes === budget.utf8Bytes
    const currentLargestIsAtCeiling = largest !== undefined && (
      largest.frame.length === budget.codeUnits || largest.bytes === budget.utf8Bytes
    )
    if (largest === undefined || candidate.bytes > largest.bytes) {
      largest = candidate
    }
    if (candidateIsAtCeiling || currentLargestIsAtCeiling) {
      break
    }
  }
  if (largest !== undefined) {
    return { ...largest, owners: EMPTY_OWNER_REGISTRY }
  }
  const frame = Result.getOrThrow(encodeFrame(message, EMPTY_OWNER_REGISTRY))
  return { message, frame, owners: EMPTY_OWNER_REGISTRY }
}
type MaximumArrayFixture = Readonly<{ message: NetworkMessage; frame: string; count: number }>
const maximumFrameForArrayPath = (
  message: NetworkMessage,
  path: JsonPath,
  budget: FrameBudget,
  owners: typeof EMPTY_OWNER_REGISTRY,
): MaximumArrayFixture | undefined => {
  const original = valueAtPath(message, path)
  if (!Array.isArray(original) || original.length === 0) {
    return undefined
  }
  const witness = original[0]
  const emptyArrayFrame = envelopeText(replaceAtPath(message, path, []))
  const witnessText = JSON.stringify(witness)
  const witnessBytes = wireFrameByteLength(witnessText)
  const fixedCodeUnits = emptyArrayFrame.length - 2
  const fixedBytes = wireFrameByteLength(emptyArrayFrame) - 2
  const maximumCount = Math.min(
    Math.floor((budget.codeUnits - fixedCodeUnits + 1) / (witnessText.length + 1)),
    Math.floor((budget.utf8Bytes - fixedBytes + 1) / (witnessBytes + 1)),
  )
  if (maximumCount < original.length) {
    return undefined
  }

  const makeMessage = (count: number): unknown => replaceAtPath(message, path, Array.from({ length: count }, () => witness))
  const makeFrame = (count: number): string => envelopeText(makeMessage(count))
  const isAccepted = (count: number): boolean => {
    const frame = makeFrame(count)
    if (frame.length > budget.codeUnits || wireFrameByteLength(frame) > budget.utf8Bytes) {
      return false
    }
    return decodeNetworkMessage(makeMessage(count)) !== undefined
  }

  let bestCount = original.length
  if (!isAccepted(bestCount)) {
    return undefined
  }
  if (maximumCount > bestCount && isAccepted(maximumCount)) {
    bestCount = maximumCount
  }
  else {
    let low = bestCount + 1
    let high = maximumCount - 1
    while (low <= high) {
      const middle = Math.floor((low + high) / 2)
      if (isAccepted(middle)) {
        bestCount = middle
        low = middle + 1
      } else {
        high = middle - 1
      }
    }
  }

  const messageCandidate = decodeNetworkMessage(makeMessage(bestCount))
  if (messageCandidate === undefined) {
    return undefined
  }
  const frame = Result.getOrThrow(encodeFrame(messageCandidate, owners))
  return { message: messageCandidate, frame, count: bestCount }
}
const maximumRealmTransferLeverArrayFixture = (): Readonly<{
  count: number
  frame: string
  message: Extract<NetworkMessage, { _tag: 'RealmTransferSnapshot' }>
}> => {
  const sample = maximumBooleanValues(
    maximumSchemaNumbers(maximumDomainMessage(maximumFixedSample('RealmTransferSnapshot'))),
  )
  const seeded = withMaximumArraySampleWitnesses('RealmTransferSnapshot', sample)
  if (seeded._tag !== 'RealmTransferSnapshot') {
    throw new Error('RealmTransferSnapshot array witnesses changed the message tag')
  }
  const witness = seeded.worldSnapshot.levers[0]
  if (witness === undefined) {
    throw new Error('RealmTransferSnapshot lever witness is missing')
  }
  const emptyMessage = { ...seeded, worldSnapshot: { ...seeded.worldSnapshot, levers: [] } }
  const emptyFrame = envelopeText(emptyMessage)
  const witnessText = JSON.stringify(witness)
  const fixedCodeUnits = emptyFrame.length - 2
  const fixedBytes = wireFrameByteLength(emptyFrame) - 2
  const budget = frameBudgetForTag('RealmTransferSnapshot')
  const count = Math.min(
    Math.floor((budget.codeUnits - fixedCodeUnits + 1) / (witnessText.length + 1)),
    Math.floor((budget.utf8Bytes - fixedBytes + 1) / (wireFrameByteLength(witnessText) + 1)),
  )
  const message = {
    ...seeded,
    worldSnapshot: {
      ...seeded.worldSnapshot,
      levers: Array.from({ length: count }, () => witness),
    },
  }
  return { count, frame: envelopeText(message), message }
}
const maximumArrayFixtureMeasurementsForTag = (tag: NetworkMessage['_tag']): string => {
  if (tag === 'AuthoritativeSnapshot') {
    return 'maximum global collection fixture: RealmTransferSnapshot.worldSnapshot.levers'
  }
  if (tag === 'RealmTransferSnapshot') {
    const fixture = maximumRealmTransferLeverArrayFixture()
    const bytes = wireFrameByteLength(fixture.frame)
    const shape = measureFrameShape({ message: fixture.message, protocolVersion: PROTOCOL_VERSION })
    const budget = frameBudgetForTag(tag)
    MAXIMUM_ARRAY_FIXTURE_OBSERVED_DEPTH = Math.max(MAXIMUM_ARRAY_FIXTURE_OBSERVED_DEPTH, shape.maxDepth)
    MAXIMUM_ARRAY_FIXTURE_OBSERVED_COLLECTION = Math.max(MAXIMUM_ARRAY_FIXTURE_OBSERVED_COLLECTION, shape.maxCollectionItems)
    expect(fixture.frame.length).toBeLessThanOrEqual(budget.codeUnits)
    expect(bytes).toBeLessThanOrEqual(budget.utf8Bytes)
    expect(fixture.message.worldSnapshot.levers).toHaveLength(fixture.count)
    expect(shape.maxCollectionItems).toBeLessThanOrEqual(GLOBAL_JSON_COLLECTION_LIMIT)
    const firstLever = fixture.message.worldSnapshot.levers[0]
    if (firstLever === undefined) {
      throw new Error('RealmTransferSnapshot lever fixture is empty')
    }
    const nextMessage = {
      ...fixture.message,
      worldSnapshot: {
        ...fixture.message.worldSnapshot,
        levers: [...fixture.message.worldSnapshot.levers, firstLever],
      },
    }
    const nextFrame = envelopeText(nextMessage)
    expect(nextFrame.length > budget.codeUnits || wireFrameByteLength(nextFrame) > budget.utf8Bytes).toBe(true)
    return `worldSnapshot.levers: ${fixture.count} items | ${bytes} UTF-8 bytes | depth ${shape.maxDepth}`
  }
  const isC4Tag = tag === 'ReplicatedWorldDelta' || tag === 'ReplicatedWorldSnapshot'
  const owners = isC4Tag ? MAXIMUM_C4_REGISTRY : EMPTY_OWNER_REGISTRY
  const sample = tag === 'ReplicatedWorldDelta'
    ? MAXIMUM_C4_DELTA
    : tag === 'ReplicatedWorldSnapshot'
      ? MAXIMUM_C4_SNAPSHOT
      : maximumBooleanValues(maximumSchemaNumbers(maximumDomainMessage(maximumFixedSample(tag))))
  const message = withMaximumArraySampleWitnesses(tag, sample)
  const paths = arrayPaths(message)
  if (paths.length === 0) {
    return 'no array fields in valid domain sample'
  }

  const c4MessageFrame = isC4Tag
    ? tag === 'ReplicatedWorldSnapshot'
      ? Result.getOrThrow(encodeTransferredSnapshotFrame(
          message,
          owners,
          MAXIMUM_C4_SIZING_LIMITS.maxSnapshotFrameBytes,
        ))
      : Result.getOrThrow(encodeFrame(message, owners))
    : ''
  const measuredPaths = new Set<string>()
  return paths.map((path) => {
    const original = valueAtPath(message, path)
    const pathName = canonicalArrayPath(path) || '<root>'
    if (measuredPaths.has(pathName)) {
      return undefined
    }
    measuredPaths.add(pathName)
    if (!Array.isArray(original) || original.length === 0) {
      return `${pathName}: no sample member`
    }

    if (isC4Tag) {
      const messageFrame = c4MessageFrame
      const count = valueAtPath(message, path)
      if (!Array.isArray(count)) {
        return `${pathName}: schema path did not resolve to an array`
      }
      const items = count
      const shape = measureFrameShape({ message, protocolVersion: PROTOCOL_VERSION })
      MAXIMUM_ARRAY_FIXTURE_OBSERVED_DEPTH = Math.max(MAXIMUM_ARRAY_FIXTURE_OBSERVED_DEPTH, shape.maxDepth)
      MAXIMUM_ARRAY_FIXTURE_OBSERVED_COLLECTION = Math.max(MAXIMUM_ARRAY_FIXTURE_OBSERVED_COLLECTION, shape.maxCollectionItems)
      expect(shape.maxDepth, `${tag}.${pathName} exceeds global depth`).toBeLessThanOrEqual(GLOBAL_JSON_DEPTH_LIMIT)
      expect(shape.maxCollectionItems, `${tag}.${pathName} exceeds global collection count`).toBeLessThanOrEqual(GLOBAL_JSON_COLLECTION_LIMIT)
      expect(shape.maxDepth, `${tag}.${pathName} exceeds typed depth`).toBeLessThanOrEqual(MAXIMUM_C4_LIMITS.maxDepth)
      expect(shape.maxCollectionItems, `${tag}.${pathName} exceeds typed collection count`).toBeLessThanOrEqual(MAXIMUM_C4_LIMITS.maxCollectionItems)
      if (pathName === 'changes' || pathName === 'owners') {
        const ownerIds = items.flatMap((ownerChange) => isRecordValue(ownerChange) && typeof ownerChange['owner'] === 'string' ? [ownerChange['owner']] : [])
        expect(new Set(ownerIds).size, `${tag}.${pathName} must use distinct owner ids`).toBe(items.length)
      }
      if (pathName === 'blockChanges' || pathName === 'blocks') {
        const positions = items.flatMap((blockChange) => {
          if (!isRecordValue(blockChange) || !isRecordValue(blockChange['position'])) {
            return []
          }
          const { x, y, z } = blockChange['position']
          return typeof x === 'number' && typeof y === 'number' && typeof z === 'number' ? [`${x},${y},${z}`] : []
        })
        expect(new Set(positions).size, `${tag}.${pathName} must use distinct block positions`).toBe(items.length)
      }
      return `${pathName}: ${items.length} typed-max items | ${wireFrameByteLength(messageFrame)} UTF-8 bytes | depth ${shape.maxDepth} | unique members`
    }

    const budget = frameBudgetForTag(tag)
    const fixture = maximumFrameForArrayPath(message, path, budget, owners)
    if (fixture === undefined) {
      return `${pathName}: no valid repeated-member witness at sample count ${original.length}`
    }

    const fixtureShape = measureFrameShape({ message: fixture.message, protocolVersion: PROTOCOL_VERSION })
    MAXIMUM_ARRAY_FIXTURE_OBSERVED_DEPTH = Math.max(MAXIMUM_ARRAY_FIXTURE_OBSERVED_DEPTH, fixtureShape.maxDepth)
    MAXIMUM_ARRAY_FIXTURE_OBSERVED_COLLECTION = Math.max(MAXIMUM_ARRAY_FIXTURE_OBSERVED_COLLECTION, fixtureShape.maxCollectionItems)
    expect(fixtureShape.maxDepth, `${tag}.${pathName} exceeds global depth`).toBeLessThanOrEqual(GLOBAL_JSON_DEPTH_LIMIT)
    expect(fixtureShape.maxCollectionItems, `${tag}.${pathName} exceeds global collection count`).toBeLessThanOrEqual(GLOBAL_JSON_COLLECTION_LIMIT)
    const count = valueAtPath(fixture.message, path)
    expect(Array.isArray(count)).toBe(true)
    expect(count).toHaveLength(fixture.count)
    return `${pathName}: ${fixture.count} items | ${wireFrameByteLength(fixture.frame)} UTF-8 bytes | depth ${fixtureShape.maxDepth}`
  }).filter((measurement): measurement is string => measurement !== undefined).join('; ')
}
const MAXIMUM_FIXTURE_MEASUREMENTS = new Map<NetworkMessage['_tag'], string>()
let MAXIMUM_FIXTURE_OBSERVED_DEPTH = 0
const REPRESENTATIVE_SAMPLE_FRAME_MEASUREMENTS = MESSAGE_TAGS.map((tag) => {
  const text = encoded(SAMPLES[tag])
  const shape = measureFrameShape(JSON.parse(text))
  return `${tag} | ${wireFrameByteLength(text)} UTF-8 bytes | depth ${shape.maxDepth} | max collection ${shape.maxCollectionItems}`
}).join('\n')

/** The ProtocolError a decode produced, or undefined if it succeeded. */
const failure = (result: Result.Result<unknown, ProtocolError>): ProtocolError | undefined =>
  Option.getOrUndefined(Result.getFailure(result))
const STRICT_PARSE_OPTIONS = { onExcessProperty: 'error' as const }

describe('frame round trip', () => {
  // REGRESSION: "every message survives encode -> text -> decode unchanged".
  // This is the whole contract of the repository. A protocol change that breaks
  // It is only observable at the far end of a socket, where the frame is gone.
  it.effect('every message decodes back to a value strictly equal to the one encoded', () =>
    Effect.sync(() => {
      for (const tag of MESSAGE_TAGS) {
        const original = SAMPLES[tag]
        const result = decodeFrame(encoded(original), EMPTY_OWNER_REGISTRY)
        expect(Result.isSuccess(result), `${tag} failed to decode`).toBe(true)
        expect(Result.getOrThrow(result)).toStrictEqual(original)
      }
    }),
  )

  // REGRESSION: "a new message type cannot be added without a round-trip test".
  // Without this, MESSAGE_TAGS and SAMPLES drift and the loop above silently
  // Stops covering the new case.
  it.effect('has a sample for every declared tag, and declares every sampled tag', () =>
    Effect.sync(() => {
      expect([...MESSAGE_TAGS].sort()).toStrictEqual(Object.keys(SAMPLES).sort())
    }),
  )

  it.effect('records UTF-8 size and JSON shape for one valid representative of every tag', () =>
    Effect.sync(() => {
      expect(REPRESENTATIVE_SAMPLE_FRAME_MEASUREMENTS.split('\n')).toHaveLength(MESSAGE_TAGS.length)
      expect(REPRESENTATIVE_SAMPLE_FRAME_MEASUREMENTS).toMatchInlineSnapshot(`
        "PlayerJoin | 119 UTF-8 bytes | depth 3 | max collection 4
        PlayerLeave | 72 UTF-8 bytes | depth 2 | max collection 2
        PlayerMove | 159 UTF-8 bytes | depth 3 | max collection 4
        BlockPlace | 112 UTF-8 bytes | depth 3 | max collection 4
        BlockBreak | 98 UTF-8 bytes | depth 3 | max collection 3
        Chat | 87 UTF-8 bytes | depth 2 | max collection 3
        WorldInfo | 89 UTF-8 bytes | depth 2 | max collection 3
        WorldSnapshot | 507 UTF-8 bytes | depth 5 | max collection 8
        BlockMutationRejected | 181 UTF-8 bytes | depth 3 | max collection 7
        AuthoritativeSnapshot | 1036 UTF-8 bytes | depth 8 | max collection 10
        RealmTransferSnapshot | 783 UTF-8 bytes | depth 9 | max collection 10
        EyeOfEnderThrown | 190 UTF-8 bytes | depth 3 | max collection 7
        PlayerInventoryDelta | 216 UTF-8 bytes | depth 6 | max collection 5
        PlayerVitalsDelta | 161 UTF-8 bytes | depth 3 | max collection 5
        PlayerFishingDelta | 154 UTF-8 bytes | depth 3 | max collection 5
        WorldTimeWeatherDelta | 143 UTF-8 bytes | depth 3 | max collection 4
        ContainerDelta | 219 UTF-8 bytes | depth 6 | max collection 4
        FurnaceDelta | 260 UTF-8 bytes | depth 5 | max collection 6
        VillagerTradeDelta | 298 UTF-8 bytes | depth 8 | max collection 5
        EntitySpawnDelta | 322 UTF-8 bytes | depth 4 | max collection 7
        EntityUpdateDelta | 323 UTF-8 bytes | depth 4 | max collection 7
        EntityDespawnDelta | 118 UTF-8 bytes | depth 2 | max collection 4
        LightningStrikeDelta | 129 UTF-8 bytes | depth 3 | max collection 4
        PlayerInventoryCommand | 190 UTF-8 bytes | depth 3 | max collection 6
        PlayerVitalsCommand | 204 UTF-8 bytes | depth 3 | max collection 6
        WorldTimeWeatherCommand | 196 UTF-8 bytes | depth 3 | max collection 6
        ContainerCommand | 192 UTF-8 bytes | depth 3 | max collection 7
        FurnaceCommand | 302 UTF-8 bytes | depth 4 | max collection 7
        VillagerTradeCommand | 218 UTF-8 bytes | depth 2 | max collection 8
        EntityAttackCommand | 168 UTF-8 bytes | depth 2 | max collection 6
        EntityPickupCommand | 168 UTF-8 bytes | depth 2 | max collection 6
        BowUseCommand | 159 UTF-8 bytes | depth 2 | max collection 6
        IgniteTntCommand | 169 UTF-8 bytes | depth 3 | max collection 6
        EndPortalUseCommand | 176 UTF-8 bytes | depth 3 | max collection 6
        ThrowEyeOfEnderCommand | 149 UTF-8 bytes | depth 2 | max collection 5
        InsertEyeIntoEndPortalFrameCommand | 190 UTF-8 bytes | depth 3 | max collection 6
        NetherPortalUseCommand | 179 UTF-8 bytes | depth 3 | max collection 6
        ToggleLeverCommand | 174 UTF-8 bytes | depth 3 | max collection 6
        EnderPearlCommand | 144 UTF-8 bytes | depth 2 | max collection 5
        BucketUseCommand | 143 UTF-8 bytes | depth 2 | max collection 5
        VehicleUseCommand | 144 UTF-8 bytes | depth 2 | max collection 5
        FishingCommand | 157 UTF-8 bytes | depth 2 | max collection 6
        VehicleCommand | 210 UTF-8 bytes | depth 3 | max collection 7
        AuthoritativeCommandAccepted | 130 UTF-8 bytes | depth 2 | max collection 4
        AuthoritativeCommandRejected | 178 UTF-8 bytes | depth 2 | max collection 6
        AuthoritativeResyncRequest | 113 UTF-8 bytes | depth 2 | max collection 3
        Ping | 58 UTF-8 bytes | depth 2 | max collection 2
        Pong | 58 UTF-8 bytes | depth 2 | max collection 2
        AnvilCommand | 167 UTF-8 bytes | depth 2 | max collection 7
        AnvilCommandAccepted | 102 UTF-8 bytes | depth 2 | max collection 3
        AnvilCommandRejected | 126 UTF-8 bytes | depth 2 | max collection 4
        PlayerAnvilNamesDelta | 156 UTF-8 bytes | depth 4 | max collection 5
        CraftingCommand | 205 UTF-8 bytes | depth 4 | max collection 6
        CraftingCommandAccepted | 105 UTF-8 bytes | depth 2 | max collection 3
        CraftingCommandRejected | 125 UTF-8 bytes | depth 2 | max collection 4
        PlayerDamageCommand | 157 UTF-8 bytes | depth 2 | max collection 6
        PlayerDamageCommandAccepted | 109 UTF-8 bytes | depth 2 | max collection 3
        PlayerDamageCommandRejected | 136 UTF-8 bytes | depth 2 | max collection 4
        BrewingCommand | 203 UTF-8 bytes | depth 3 | max collection 7
        BrewingCommandAccepted | 104 UTF-8 bytes | depth 2 | max collection 3
        BrewingCommandRejected | 135 UTF-8 bytes | depth 2 | max collection 4
        BrewingStandDelta | 246 UTF-8 bytes | depth 4 | max collection 5
        PlayerStatusEffectsDelta | 219 UTF-8 bytes | depth 5 | max collection 5
        EnchantingCommand | 163 UTF-8 bytes | depth 2 | max collection 7
        EnchantingCommandAccepted | 107 UTF-8 bytes | depth 2 | max collection 3
        EnchantingCommandRejected | 137 UTF-8 bytes | depth 2 | max collection 4
        PlayerEnchantmentsDelta | 262 UTF-8 bytes | depth 7 | max collection 6
        DamageEnderDragonCommand | 131 UTF-8 bytes | depth 2 | max collection 4
        DamageEnderDragonCommandAccepted | 114 UTF-8 bytes | depth 2 | max collection 3
        DamageEnderDragonCommandRejected | 140 UTF-8 bytes | depth 2 | max collection 4
        EnderDragonSnapshotDelta | 168 UTF-8 bytes | depth 3 | max collection 4
        SummonWitherCommand | 176 UTF-8 bytes | depth 3 | max collection 6
        DamageWitherCommand | 174 UTF-8 bytes | depth 2 | max collection 7
        WitherCommandAccepted | 103 UTF-8 bytes | depth 2 | max collection 3
        WitherCommandRejected | 130 UTF-8 bytes | depth 2 | max collection 4
        WitherSnapshotDelta | 382 UTF-8 bytes | depth 7 | max collection 6
        ReplicatedWorldDelta | 129 UTF-8 bytes | depth 3 | max collection 5
        ReplicatedWorldSnapshot | 125 UTF-8 bytes | depth 3 | max collection 5
        ReplicatedWorldSnapshotStart | 238 UTF-8 bytes | depth 2 | max collection 7
        ReplicatedWorldSnapshotChunk | 122 UTF-8 bytes | depth 2 | max collection 4
        ReplicatedWorldSnapshotEnd | 96 UTF-8 bytes | depth 2 | max collection 2"
      `)
    }),
  )

  MESSAGE_TAGS.forEach((tag) => {
    it.effect(`measures the maximum legitimate wire frame for ${tag}`, () =>
      Effect.sync(() => {
        const fixture = maximumWireFixtureForTag(tag)
        let decodedMessage = fixture.message
        if (fixture.message._tag === 'AuthoritativeSnapshot') {
          expect(Schema.is(WorldId)(fixture.message.world)).toBe(true)
        } else if (fixture.message._tag === 'RealmTransferSnapshot') {
          expect(Schema.is(WorldId)(fixture.message.destinationWorld)).toBe(true)
        } else {
          const decoded = fixture.message._tag === 'ReplicatedWorldSnapshot'
            ? decodeTransferredSnapshotFrame(fixture.frame, fixture.owners, MAXIMUM_C4_LIMITS.maxSnapshotFrameBytes)
            : decodeFrame(fixture.frame, fixture.owners)
          expect(Result.isSuccess(decoded), `${tag} maximum fixture failed to decode`).toBe(true)
          decodedMessage = Result.getOrThrow(decoded)
          expect(decodedMessage, `${tag} maximum fixture changed during round trip`).toStrictEqual(fixture.message)
        }

        const bytes = wireFrameByteLength(fixture.frame)
        const shape = measureFrameShape({ message: decodedMessage, protocolVersion: PROTOCOL_VERSION })
        MAXIMUM_FIXTURE_OBSERVED_DEPTH = Math.max(MAXIMUM_FIXTURE_OBSERVED_DEPTH, shape.maxDepth)
        const isC4Tag = tag === 'ReplicatedWorldDelta' || tag === 'ReplicatedWorldSnapshot'
        const depthLimit = isC4Tag ? MAXIMUM_C4_LIMITS.maxDepth : GLOBAL_JSON_DEPTH_LIMIT
        const collectionLimit = isC4Tag ? MAXIMUM_C4_LIMITS.maxCollectionItems : GLOBAL_JSON_COLLECTION_LIMIT
        const budget = tag === 'ReplicatedWorldDelta'
          ? { codeUnits: GLOBAL_FRAME_CODE_UNIT_LIMIT, utf8Bytes: MAXIMUM_C4_LIMITS.maxDeltaFrameBytes }
          : tag === 'ReplicatedWorldSnapshot'
            ? { codeUnits: MAXIMUM_C4_LIMITS.maxSnapshotFrameBytes, utf8Bytes: MAXIMUM_C4_LIMITS.maxSnapshotFrameBytes }
            : frameBudgetForTag(tag)
        expect(fixture.frame.length, `${tag} exceeds UTF-16 code-unit budget`).toBeLessThanOrEqual(budget.codeUnits)
        expect(bytes, `${tag} exceeds UTF-8 byte budget`).toBeLessThanOrEqual(budget.utf8Bytes)
        expect(shape.maxDepth, `${tag} exceeds the global JSON depth cap`).toBeLessThanOrEqual(GLOBAL_JSON_DEPTH_LIMIT)
        expect(shape.maxCollectionItems, `${tag} exceeds the global collection cap`).toBeLessThanOrEqual(GLOBAL_JSON_COLLECTION_LIMIT)
        if (tag === 'ReplicatedWorldDelta' || tag === 'ReplicatedWorldSnapshot') {
          expect(shape.maxDepth, `${tag} exceeds its typed depth bound`).toBeLessThanOrEqual(MAXIMUM_C4_LIMITS.maxDepth)
          expect(shape.maxCollectionItems, `${tag} exceeds its typed collection bound`).toBeLessThanOrEqual(MAXIMUM_C4_LIMITS.maxCollectionItems)
        }

        const schemaBoundedTag = tag === 'Ping' || tag === 'Pong' || tag === 'EnderDragonSnapshotDelta'
        if (!schemaBoundedTag) {
          expect(
            fixture.frame.length === budget.codeUnits || bytes === budget.utf8Bytes,
            `${tag} does not reach its enforced frame ceiling`,
          ).toBe(true)
        }

        const ceiling = tag === 'Ping' || tag === 'Pong' || tag === 'EnderDragonSnapshotDelta'
          ? 'schema'
          : tag === 'ReplicatedWorldDelta' || tag === 'ReplicatedWorldSnapshot'
            ? 'C4 typed'
            : LEGACY_FRAME_BUDGETS.has(tag)
              ? 'legacy'
              : 'global'
        const profile = tag === 'ReplicatedWorldDelta'
          ? `profile ${MAXIMUM_C4_PROFILE_OWNER_COUNT} owners/${MAXIMUM_C4_PROFILE_DELTA_BLOCK_COUNT} unique blocks ${MAXIMUM_C4_DELTA_FRAME_BYTES} bytes; count-limit ${MAXIMUM_C4_OWNER_COUNT_LIMIT} owners/${MAXIMUM_C4_DELTA_BLOCK_LIMIT} blocks ${MAXIMUM_C4_DELTA_COUNT_FRAME_BYTES} bytes; owner-state ${MAXIMUM_C4_OWNER_STATE_LIMIT_BYTES} bytes/depth ${MAXIMUM_C4_LIMITS.ownerStates[0]?.maxStateDepth}/collection ${MAXIMUM_C4_LIMITS.ownerStates[0]?.maxCollectionItems}`
          : tag === 'ReplicatedWorldSnapshot'
            ? `profile ${MAXIMUM_C4_PROFILE_OWNER_COUNT} owners/${MAXIMUM_C4_PROFILE_SNAPSHOT_BLOCK_COUNT} logical reads ${MAXIMUM_C4_SNAPSHOT_FRAME_BYTES} transferred bytes; count-limit ${MAXIMUM_C4_OWNER_COUNT_LIMIT} owners/${MAXIMUM_C4_SNAPSHOT_BLOCK_LIMIT} reads ${MAXIMUM_C4_SNAPSHOT_COUNT_FRAME_BYTES} transferred bytes; owner-state ${MAXIMUM_C4_OWNER_STATE_LIMIT_BYTES} bytes/depth ${MAXIMUM_C4_LIMITS.ownerStates[0]?.maxStateDepth}/collection ${MAXIMUM_C4_LIMITS.ownerStates[0]?.maxCollectionItems}`
            : undefined
        MAXIMUM_FIXTURE_MEASUREMENTS.set(tag, [
          `${tag} | observed ${bytes} UTF-8 bytes/${fixture.frame.length} code units, depth ${shape.maxDepth}, collection ${shape.maxCollectionItems}`,
          `cap ${budget.utf8Bytes} UTF-8 bytes/${budget.codeUnits} code units, depth ${depthLimit} (global ${GLOBAL_JSON_DEPTH_LIMIT}), collection ${collectionLimit} (global ${GLOBAL_JSON_COLLECTION_LIMIT})`,
          ceiling,
          profile,
          `arrays ${maximumArrayFixtureMeasurementsForTag(tag)}`,
        ].filter((measurement): measurement is string => measurement !== undefined).join(' | '))
      }),
    )
  })

  it.effect('records the maximum frame and collection fixtures for every message tag', () =>
    Effect.sync(() => {
      const measurements = MESSAGE_TAGS.flatMap((tag) => {
        const measurement = MAXIMUM_FIXTURE_MEASUREMENTS.get(tag)
        return measurement === undefined ? [] : [measurement]
      })
      expect(MAXIMUM_FIXTURE_MEASUREMENTS.size).toBe(MESSAGE_TAGS.length)
      expect(measurements.map((measurement) => measurement.split(' | ')[0])).toStrictEqual([...MESSAGE_TAGS])
      expect(MAXIMUM_FIXTURE_OBSERVED_DEPTH).toBe(9)
      expect(MAXIMUM_ARRAY_FIXTURE_OBSERVED_DEPTH).toBe(10)
      expect(GLOBAL_JSON_DEPTH_LIMIT).toBeGreaterThanOrEqual(MAXIMUM_ARRAY_FIXTURE_OBSERVED_DEPTH)
      expect(GLOBAL_JSON_DEPTH_LIMIT).toBe(Math.ceil(
        Math.max(MAXIMUM_FIXTURE_OBSERVED_DEPTH, MAXIMUM_ARRAY_FIXTURE_OBSERVED_DEPTH) * 1.25,
      ))
      expect(MAXIMUM_ARRAY_FIXTURE_OBSERVED_COLLECTION).toBe(24_919)
      expect(GLOBAL_JSON_COLLECTION_LIMIT).toBe(Math.ceil(MAXIMUM_ARRAY_FIXTURE_OBSERVED_COLLECTION * 1.25))
      expect(measurements.join('\n')).toMatchInlineSnapshot(`
        "PlayerJoin | observed 1310720 UTF-8 bytes/437022 code units, depth 3, collection 4 | cap 1310720 UTF-8 bytes/1048576 code units, depth 13 (global 13), collection 31149 (global 31149) | global | arrays no array fields in valid domain sample
        PlayerLeave | observed 1310720 UTF-8 bytes/436952 code units, depth 2, collection 2 | cap 1310720 UTF-8 bytes/1048576 code units, depth 13 (global 13), collection 31149 (global 31149) | global | arrays no array fields in valid domain sample
        PlayerMove | observed 1310720 UTF-8 bytes/437080 code units, depth 3, collection 5 | cap 1310720 UTF-8 bytes/1048576 code units, depth 13 (global 13), collection 31149 (global 31149) | global | arrays no array fields in valid domain sample
        BlockPlace | observed 1310720 UTF-8 bytes/437022 code units, depth 3, collection 5 | cap 1310720 UTF-8 bytes/1048576 code units, depth 13 (global 13), collection 31149 (global 31149) | global | arrays no array fields in valid domain sample
        BlockBreak | observed 1310720 UTF-8 bytes/437011 code units, depth 3, collection 4 | cap 1310720 UTF-8 bytes/1048576 code units, depth 13 (global 13), collection 31149 (global 31149) | global | arrays no array fields in valid domain sample
        Chat | observed 1310720 UTF-8 bytes/437124 code units, depth 2, collection 3 | cap 1310720 UTF-8 bytes/1048576 code units, depth 13 (global 13), collection 31149 (global 31149) | global | arrays no array fields in valid domain sample
        WorldInfo | observed 1310720 UTF-8 bytes/436966 code units, depth 2, collection 3 | cap 1310720 UTF-8 bytes/1048576 code units, depth 13 (global 13), collection 31149 (global 31149) | global | arrays no array fields in valid domain sample
        WorldSnapshot | observed 1310720 UTF-8 bytes/437239 code units, depth 5, collection 8 | cap 1310720 UTF-8 bytes/1048576 code units, depth 13 (global 13), collection 31149 (global 31149) | global | arrays blocks: 9703 items | 1048506 UTF-8 bytes | depth 5; levers: 12044 items | 1048536 UTF-8 bytes | depth 5; players: 4616 items | 1048400 UTF-8 bytes | depth 5; poweredRails: 11907 items | 1048523 UTF-8 bytes | depth 5
        BlockMutationRejected | observed 1310720 UTF-8 bytes/437064 code units, depth 3, collection 7 | cap 1310720 UTF-8 bytes/1048576 code units, depth 13 (global 13), collection 31149 (global 31149) | global | arrays no array fields in valid domain sample
        AuthoritativeSnapshot | observed 1310720 UTF-8 bytes/437592 code units, depth 8, collection 10 | cap 1310720 UTF-8 bytes/1048576 code units, depth 13 (global 13), collection 31149 (global 31149) | global | arrays maximum global collection fixture: RealmTransferSnapshot.worldSnapshot.levers
        RealmTransferSnapshot | observed 1310720 UTF-8 bytes/437427 code units, depth 9, collection 10 | cap 1310720 UTF-8 bytes/1048576 code units, depth 13 (global 13), collection 31149 (global 31149) | global | arrays worldSnapshot.levers: 24919 items | 1048555 UTF-8 bytes | depth 10
        EyeOfEnderThrown | observed 1310720 UTF-8 bytes/437121 code units, depth 3, collection 7 | cap 1310720 UTF-8 bytes/1048576 code units, depth 13 (global 13), collection 31149 (global 31149) | global | arrays no array fields in valid domain sample
        PlayerInventoryDelta | observed 1310720 UTF-8 bytes/437093 code units, depth 6, collection 5 | cap 1310720 UTF-8 bytes/1048576 code units, depth 13 (global 13), collection 31149 (global 31149) | global | arrays state.slots: 9798 items | 1048567 UTF-8 bytes | depth 6
        PlayerVitalsDelta | observed 1310720 UTF-8 bytes/437060 code units, depth 3, collection 5 | cap 1310720 UTF-8 bytes/1048576 code units, depth 13 (global 13), collection 31149 (global 31149) | global | arrays no array fields in valid domain sample
        PlayerFishingDelta | observed 1310720 UTF-8 bytes/437013 code units, depth 3, collection 5 | cap 1310720 UTF-8 bytes/1048576 code units, depth 13 (global 13), collection 31149 (global 31149) | global | arrays no array fields in valid domain sample
        WorldTimeWeatherDelta | observed 1310720 UTF-8 bytes/437014 code units, depth 3, collection 4 | cap 1310720 UTF-8 bytes/1048576 code units, depth 13 (global 13), collection 31149 (global 31149) | global | arrays no array fields in valid domain sample
        ContainerDelta | observed 1310720 UTF-8 bytes/437085 code units, depth 6, collection 4 | cap 1310720 UTF-8 bytes/1048576 code units, depth 13 (global 13), collection 31149 (global 31149) | global | arrays state.slots: 9798 items | 1048555 UTF-8 bytes | depth 6
        FurnaceDelta | observed 1310720 UTF-8 bytes/437132 code units, depth 5, collection 6 | cap 1310720 UTF-8 bytes/1048576 code units, depth 13 (global 13), collection 31149 (global 31149) | global | arrays no array fields in valid domain sample
        VillagerTradeDelta | observed 1310720 UTF-8 bytes/437168 code units, depth 8, collection 5 | cap 1310720 UTF-8 bytes/1048576 code units, depth 13 (global 13), collection 31149 (global 31149) | global | arrays state.offers: 4314 items | 1048459 UTF-8 bytes | depth 8; state.offers[].input: 9797 items | 1048572 UTF-8 bytes | depth 8
        EntitySpawnDelta | observed 1310720 UTF-8 bytes/437226 code units, depth 4, collection 7 | cap 1310720 UTF-8 bytes/1048576 code units, depth 13 (global 13), collection 31149 (global 31149) | global | arrays no array fields in valid domain sample
        EntityUpdateDelta | observed 1310720 UTF-8 bytes/437226 code units, depth 4, collection 7 | cap 1310720 UTF-8 bytes/1048576 code units, depth 13 (global 13), collection 31149 (global 31149) | global | arrays no array fields in valid domain sample
        EntityDespawnDelta | observed 1310720 UTF-8 bytes/436989 code units, depth 2, collection 4 | cap 1310720 UTF-8 bytes/1048576 code units, depth 13 (global 13), collection 31149 (global 31149) | global | arrays no array fields in valid domain sample
        LightningStrikeDelta | observed 1310720 UTF-8 bytes/437036 code units, depth 3, collection 4 | cap 1310720 UTF-8 bytes/1048576 code units, depth 13 (global 13), collection 31149 (global 31149) | global | arrays no array fields in valid domain sample
        PlayerInventoryCommand | observed 1310720 UTF-8 bytes/437084 code units, depth 3, collection 6 | cap 1310720 UTF-8 bytes/1048576 code units, depth 13 (global 13), collection 31149 (global 31149) | global | arrays no array fields in valid domain sample
        PlayerVitalsCommand | observed 1310720 UTF-8 bytes/437049 code units, depth 3, collection 6 | cap 1310720 UTF-8 bytes/1048576 code units, depth 13 (global 13), collection 31149 (global 31149) | global | arrays no array fields in valid domain sample
        WorldTimeWeatherCommand | observed 1310720 UTF-8 bytes/437049 code units, depth 3, collection 6 | cap 1310720 UTF-8 bytes/1048576 code units, depth 13 (global 13), collection 31149 (global 31149) | global | arrays no array fields in valid domain sample
        ContainerCommand | observed 1310720 UTF-8 bytes/437138 code units, depth 4, collection 7 | cap 1310720 UTF-8 bytes/1048576 code units, depth 13 (global 13), collection 31149 (global 31149) | global | arrays no array fields in valid domain sample
        FurnaceCommand | observed 1310720 UTF-8 bytes/437130 code units, depth 4, collection 7 | cap 1310720 UTF-8 bytes/1048576 code units, depth 13 (global 13), collection 31149 (global 31149) | global | arrays no array fields in valid domain sample
        VillagerTradeCommand | observed 1310720 UTF-8 bytes/437056 code units, depth 2, collection 8 | cap 1310720 UTF-8 bytes/1048576 code units, depth 13 (global 13), collection 31149 (global 31149) | global | arrays no array fields in valid domain sample
        EntityAttackCommand | observed 1310720 UTF-8 bytes/437022 code units, depth 2, collection 6 | cap 1310720 UTF-8 bytes/1048576 code units, depth 13 (global 13), collection 31149 (global 31149) | global | arrays no array fields in valid domain sample
        EntityPickupCommand | observed 1310720 UTF-8 bytes/437022 code units, depth 2, collection 6 | cap 1310720 UTF-8 bytes/1048576 code units, depth 13 (global 13), collection 31149 (global 31149) | global | arrays no array fields in valid domain sample
        BowUseCommand | observed 1310720 UTF-8 bytes/437016 code units, depth 2, collection 6 | cap 1310720 UTF-8 bytes/1048576 code units, depth 13 (global 13), collection 31149 (global 31149) | global | arrays no array fields in valid domain sample
        IgniteTntCommand | observed 1310720 UTF-8 bytes/437052 code units, depth 3, collection 6 | cap 1310720 UTF-8 bytes/1048576 code units, depth 13 (global 13), collection 31149 (global 31149) | global | arrays no array fields in valid domain sample
        EndPortalUseCommand | observed 1310720 UTF-8 bytes/437057 code units, depth 3, collection 6 | cap 1310720 UTF-8 bytes/1048576 code units, depth 13 (global 13), collection 31149 (global 31149) | global | arrays no array fields in valid domain sample
        ThrowEyeOfEnderCommand | observed 1310720 UTF-8 bytes/437010 code units, depth 2, collection 5 | cap 1310720 UTF-8 bytes/1048576 code units, depth 13 (global 13), collection 31149 (global 31149) | global | arrays no array fields in valid domain sample
        InsertEyeIntoEndPortalFrameCommand | observed 1310720 UTF-8 bytes/437066 code units, depth 3, collection 6 | cap 1310720 UTF-8 bytes/1048576 code units, depth 13 (global 13), collection 31149 (global 31149) | global | arrays no array fields in valid domain sample
        NetherPortalUseCommand | observed 1310720 UTF-8 bytes/437059 code units, depth 3, collection 6 | cap 1310720 UTF-8 bytes/1048576 code units, depth 13 (global 13), collection 31149 (global 31149) | global | arrays no array fields in valid domain sample
        ToggleLeverCommand | observed 1310720 UTF-8 bytes/437056 code units, depth 3, collection 6 | cap 1310720 UTF-8 bytes/1048576 code units, depth 13 (global 13), collection 31149 (global 31149) | global | arrays no array fields in valid domain sample
        EnderPearlCommand | observed 1310720 UTF-8 bytes/437006 code units, depth 2, collection 5 | cap 1310720 UTF-8 bytes/1048576 code units, depth 13 (global 13), collection 31149 (global 31149) | global | arrays no array fields in valid domain sample
        BucketUseCommand | observed 1310720 UTF-8 bytes/437006 code units, depth 2, collection 5 | cap 1310720 UTF-8 bytes/1048576 code units, depth 13 (global 13), collection 31149 (global 31149) | global | arrays no array fields in valid domain sample
        VehicleUseCommand | observed 1310720 UTF-8 bytes/437006 code units, depth 2, collection 5 | cap 1310720 UTF-8 bytes/1048576 code units, depth 13 (global 13), collection 31149 (global 31149) | global | arrays no array fields in valid domain sample
        FishingCommand | observed 1310720 UTF-8 bytes/437015 code units, depth 2, collection 6 | cap 1310720 UTF-8 bytes/1048576 code units, depth 13 (global 13), collection 31149 (global 31149) | global | arrays no array fields in valid domain sample
        VehicleCommand | observed 1310720 UTF-8 bytes/437051 code units, depth 3, collection 7 | cap 1310720 UTF-8 bytes/1048576 code units, depth 13 (global 13), collection 31149 (global 31149) | global | arrays no array fields in valid domain sample
        AuthoritativeCommandAccepted | observed 1310720 UTF-8 bytes/436997 code units, depth 2, collection 4 | cap 1310720 UTF-8 bytes/1048576 code units, depth 13 (global 13), collection 31149 (global 31149) | global | arrays no array fields in valid domain sample
        AuthoritativeCommandRejected | observed 1310720 UTF-8 bytes/437033 code units, depth 2, collection 6 | cap 1310720 UTF-8 bytes/1048576 code units, depth 13 (global 13), collection 31149 (global 31149) | global | arrays no array fields in valid domain sample
        AuthoritativeResyncRequest | observed 1310720 UTF-8 bytes/436986 code units, depth 2, collection 3 | cap 1310720 UTF-8 bytes/1048576 code units, depth 13 (global 13), collection 31149 (global 31149) | global | arrays no array fields in valid domain sample
        Ping | observed 73 UTF-8 bytes/73 code units, depth 2, collection 2 | cap 1310720 UTF-8 bytes/1048576 code units, depth 13 (global 13), collection 31149 (global 31149) | schema | arrays no array fields in valid domain sample
        Pong | observed 73 UTF-8 bytes/73 code units, depth 2, collection 2 | cap 1310720 UTF-8 bytes/1048576 code units, depth 13 (global 13), collection 31149 (global 31149) | schema | arrays no array fields in valid domain sample
        AnvilCommand | observed 5716 UTF-8 bytes/2048 code units, depth 2, collection 7 | cap 8192 UTF-8 bytes/2048 code units, depth 13 (global 13), collection 31149 (global 31149) | legacy | arrays no array fields in valid domain sample
        AnvilCommandAccepted | observed 1310720 UTF-8 bytes/436978 code units, depth 2, collection 3 | cap 1310720 UTF-8 bytes/1048576 code units, depth 13 (global 13), collection 31149 (global 31149) | global | arrays no array fields in valid domain sample
        AnvilCommandRejected | observed 1310720 UTF-8 bytes/437002 code units, depth 2, collection 4 | cap 1310720 UTF-8 bytes/1048576 code units, depth 13 (global 13), collection 31149 (global 31149) | global | arrays no array fields in valid domain sample
        PlayerAnvilNamesDelta | observed 1310720 UTF-8 bytes/438725 code units, depth 4, collection 36 | cap 1310720 UTF-8 bytes/1048576 code units, depth 13 (global 13), collection 31149 (global 31149) | global | arrays names: 14561 items | 1048532 UTF-8 bytes | depth 4
        CraftingCommand | observed 2554 UTF-8 bytes/1024 code units, depth 4, collection 9 | cap 4096 UTF-8 bytes/1024 code units, depth 13 (global 13), collection 31149 (global 31149) | legacy | arrays grid.cells: 9 items | 268 UTF-8 bytes | depth 4
        CraftingCommandAccepted | observed 1310720 UTF-8 bytes/436980 code units, depth 2, collection 3 | cap 1310720 UTF-8 bytes/1048576 code units, depth 13 (global 13), collection 31149 (global 31149) | global | arrays no array fields in valid domain sample
        CraftingCommandRejected | observed 1310720 UTF-8 bytes/437001 code units, depth 2, collection 4 | cap 1310720 UTF-8 bytes/1048576 code units, depth 13 (global 13), collection 31149 (global 31149) | global | arrays no array fields in valid domain sample
        PlayerDamageCommand | observed 2698 UTF-8 bytes/1024 code units, depth 2, collection 7 | cap 4096 UTF-8 bytes/1024 code units, depth 13 (global 13), collection 31149 (global 31149) | legacy | arrays no array fields in valid domain sample
        PlayerDamageCommandAccepted | observed 1310720 UTF-8 bytes/436983 code units, depth 2, collection 3 | cap 1310720 UTF-8 bytes/1048576 code units, depth 13 (global 13), collection 31149 (global 31149) | global | arrays no array fields in valid domain sample
        PlayerDamageCommandRejected | observed 1310720 UTF-8 bytes/437004 code units, depth 2, collection 4 | cap 1310720 UTF-8 bytes/1048576 code units, depth 13 (global 13), collection 31149 (global 31149) | global | arrays no array fields in valid domain sample
        BrewingCommand | observed 24070 UTF-8 bytes/8192 code units, depth 3, collection 7 | cap 32768 UTF-8 bytes/8192 code units, depth 13 (global 13), collection 31149 (global 31149) | legacy | arrays no array fields in valid domain sample
        BrewingCommandAccepted | observed 1310720 UTF-8 bytes/436980 code units, depth 2, collection 3 | cap 1310720 UTF-8 bytes/1048576 code units, depth 13 (global 13), collection 31149 (global 31149) | global | arrays no array fields in valid domain sample
        BrewingCommandRejected | observed 1310720 UTF-8 bytes/437000 code units, depth 2, collection 4 | cap 1310720 UTF-8 bytes/1048576 code units, depth 13 (global 13), collection 31149 (global 31149) | global | arrays no array fields in valid domain sample
        BrewingStandDelta | observed 1310720 UTF-8 bytes/437128 code units, depth 4, collection 5 | cap 1310720 UTF-8 bytes/1048576 code units, depth 13 (global 13), collection 31149 (global 31149) | global | arrays no array fields in valid domain sample
        PlayerStatusEffectsDelta | observed 1310720 UTF-8 bytes/437096 code units, depth 5, collection 5 | cap 1310720 UTF-8 bytes/1048576 code units, depth 13 (global 13), collection 31149 (global 31149) | global | arrays state.effects: 7824 items | 1048571 UTF-8 bytes | depth 5
        EnchantingCommand | observed 97966 UTF-8 bytes/32768 code units, depth 2, collection 7 | cap 131072 UTF-8 bytes/32768 code units, depth 13 (global 13), collection 31149 (global 31149) | legacy | arrays no array fields in valid domain sample
        EnchantingCommandAccepted | observed 1310720 UTF-8 bytes/436982 code units, depth 2, collection 3 | cap 1310720 UTF-8 bytes/1048576 code units, depth 13 (global 13), collection 31149 (global 31149) | global | arrays no array fields in valid domain sample
        EnchantingCommandRejected | observed 1310720 UTF-8 bytes/437005 code units, depth 2, collection 4 | cap 1310720 UTF-8 bytes/1048576 code units, depth 13 (global 13), collection 31149 (global 31149) | global | arrays no array fields in valid domain sample
        PlayerEnchantmentsDelta | observed 1310720 UTF-8 bytes/441019 code units, depth 7, collection 36 | cap 1310720 UTF-8 bytes/1048576 code units, depth 13 (global 13), collection 31149 (global 31149) | global | arrays items: 6277 items | 1048425 UTF-8 bytes | depth 7; items[].item.enchantments: 23691 items | 1048538 UTF-8 bytes | depth 7
        DamageEnderDragonCommand | observed 48880 UTF-8 bytes/16384 code units, depth 2, collection 4 | cap 65536 UTF-8 bytes/16384 code units, depth 13 (global 13), collection 31149 (global 31149) | legacy | arrays no array fields in valid domain sample
        DamageEnderDragonCommandAccepted | observed 1310720 UTF-8 bytes/436986 code units, depth 2, collection 3 | cap 1310720 UTF-8 bytes/1048576 code units, depth 13 (global 13), collection 31149 (global 31149) | global | arrays no array fields in valid domain sample
        DamageEnderDragonCommandRejected | observed 1310720 UTF-8 bytes/437004 code units, depth 2, collection 4 | cap 1310720 UTF-8 bytes/1048576 code units, depth 13 (global 13), collection 31149 (global 31149) | global | arrays no array fields in valid domain sample
        EnderDragonSnapshotDelta | observed 204 UTF-8 bytes/204 code units, depth 3, collection 4 | cap 1310720 UTF-8 bytes/1048576 code units, depth 13 (global 13), collection 31149 (global 31149) | schema | arrays no array fields in valid domain sample
        SummonWitherCommand | observed 1310720 UTF-8 bytes/437071 code units, depth 3, collection 6 | cap 1310720 UTF-8 bytes/1048576 code units, depth 13 (global 13), collection 31149 (global 31149) | legacy | arrays no array fields in valid domain sample
        DamageWitherCommand | observed 1310720 UTF-8 bytes/437044 code units, depth 2, collection 7 | cap 1310720 UTF-8 bytes/1048576 code units, depth 13 (global 13), collection 31149 (global 31149) | legacy | arrays no array fields in valid domain sample
        WitherCommandAccepted | observed 1310720 UTF-8 bytes/436979 code units, depth 2, collection 3 | cap 1310720 UTF-8 bytes/1048576 code units, depth 13 (global 13), collection 31149 (global 31149) | global | arrays no array fields in valid domain sample
        WitherCommandRejected | observed 1310720 UTF-8 bytes/436997 code units, depth 2, collection 4 | cap 1310720 UTF-8 bytes/1048576 code units, depth 13 (global 13), collection 31149 (global 31149) | global | arrays no array fields in valid domain sample
        WitherSnapshotDelta | observed 1310720 UTF-8 bytes/437330 code units, depth 7, collection 6 | cap 1310720 UTF-8 bytes/1048576 code units, depth 13 (global 13), collection 31149 (global 31149) | global | arrays snapshot.skulls: 4077 items | 1048426 UTF-8 bytes | depth 7; snapshot.withers: 2344 items | 1048215 UTF-8 bytes | depth 7
        ReplicatedWorldDelta | observed 54489 UTF-8 bytes/54489 code units, depth 6, collection 256 | cap 54489 UTF-8 bytes/1048576 code units, depth 8 (global 13), collection 18750 (global 31149) | C4 typed | profile 3 owners/256 unique blocks 34872 bytes; count-limit 4 owners/320 blocks 43591 bytes; owner-state 108 bytes/depth 4/collection 3 | arrays blockChanges: 256 typed-max items | 34872 UTF-8 bytes | depth 6 | unique members; changes: 3 typed-max items | 34872 UTF-8 bytes | depth 6 | unique members; changes[].state.labels: 3 typed-max items | 34872 UTF-8 bytes | depth 6 | unique members
        ReplicatedWorldSnapshot | observed 3422759 UTF-8 bytes/3422759 code units, depth 6, collection 15000 | cap 3422759 UTF-8 bytes/3422759 code units, depth 8 (global 13), collection 18750 (global 31149) | C4 typed | profile 3 owners/15000 logical reads 2190564 transferred bytes; count-limit 4 owners/18750 reads 2738207 transferred bytes; owner-state 108 bytes/depth 4/collection 3 | arrays blocks: 15000 typed-max items | 2190564 UTF-8 bytes | depth 6 | unique members; owners: 3 typed-max items | 2190564 UTF-8 bytes | depth 6 | unique members; owners[].state.labels: 3 typed-max items | 2190564 UTF-8 bytes | depth 6 | unique members
        ReplicatedWorldSnapshotStart | observed 1310720 UTF-8 bytes/437088 code units, depth 2, collection 7 | cap 1310720 UTF-8 bytes/1048576 code units, depth 13 (global 13), collection 31149 (global 31149) | global | arrays no array fields in valid domain sample
        ReplicatedWorldSnapshotChunk | observed 1310720 UTF-8 bytes/436992 code units, depth 2, collection 4 | cap 1310720 UTF-8 bytes/1048576 code units, depth 13 (global 13), collection 31149 (global 31149) | global | arrays no array fields in valid domain sample
        ReplicatedWorldSnapshotEnd | observed 1310720 UTF-8 bytes/436964 code units, depth 2, collection 2 | cap 1310720 UTF-8 bytes/1048576 code units, depth 13 (global 13), collection 31149 (global 31149) | global | arrays no array fields in valid domain sample"
      `)
    }),
  )

  it.effect('measures a maximum grouped-delta rate fixture at the simulation tick cadence', () =>
    Effect.sync(() => {
      // The old compose multiplayer server advances at 20 ticks per second.
      const tickMilliseconds = 50
      const windowMilliseconds = 1_000
      const fixtureFrameCount = windowMilliseconds / tickMilliseconds
      const frames = Array.from({ length: fixtureFrameCount }, (_, index) => {
        const revision = Result.getOrThrow(
          Schema.decodeUnknownResult(WorldRevisionSchema)(Number.MAX_SAFE_INTEGER - fixtureFrameCount + index),
        )
        return Result.getOrThrow(encodeFrame({ ...MAXIMUM_C4_DELTA_AT_COUNT_LIMIT, revision }, MAXIMUM_C4_REGISTRY))
      })
      const frameBytes = frames.map((frame) => wireFrameByteLength(frame))
      const measuredBytesPerSecond = frameBytes.reduce((total, bytes) => total + bytes, 0)
      const frameRateLimit = Math.ceil(fixtureFrameCount * 1.25)
      const frameBytesPerSecondLimit = frameRateLimit * Math.max(...frameBytes)

      expect(frames).toHaveLength(20)
      expect(new Set(frameBytes)).toStrictEqual(new Set([MAXIMUM_C4_DELTA_COUNT_FRAME_BYTES]))
      expect(measuredBytesPerSecond).toBe(MAXIMUM_C4_DELTA_COUNT_FRAME_BYTES * fixtureFrameCount)
      expect(frameRateLimit).toBe(25)
      expect(frameBytesPerSecondLimit).toBe(MAXIMUM_C4_DELTA_COUNT_FRAME_BYTES * frameRateLimit)
      expect({
        measuredFramesPerSecond: fixtureFrameCount,
        measuredBytesPerSecond,
        frameRateLimit,
        frameBytesPerSecondLimit,
        burstFrameCount: 64,
        burstFrameLimit: Math.ceil(64 * 1.25),
      }).toMatchInlineSnapshot(`
        {
          "burstFrameCount": 64,
          "burstFrameLimit": 80,
          "frameBytesPerSecondLimit": 1089775,
          "frameRateLimit": 25,
          "measuredBytesPerSecond": 871820,
          "measuredFramesPerSecond": 20,
        }
      `)
    }),
  )

  it.effect('produces text — the codec stops at a string, so no platform global is needed', () =>
    Effect.sync(() => {
      const frame = encoded(SAMPLES.Ping)
      expect(typeof frame).toBe('string')
      expect(JSON.parse(frame)).toStrictEqual({
        message: { _tag: 'Ping', nonce: 7 },
        protocolVersion: PROTOCOL_VERSION,
      })
    }),
  )

  // REGRESSION: "fractional coordinates survive". The reference implementation
  // Carries positions as finite doubles; a codec that rounded, or that went
  // Through a fixed-point integer encoding, would show up as peer avatars
  // Snapping to the block grid rather than as a test failure.
  it.effect('preserves fractional coordinates exactly rather than snapping them to the grid', () =>
    Effect.sync(() => {
      const moved = decodeFrame(encoded(SAMPLES.PlayerMove))
      expect(Result.getOrThrow(moved)).toStrictEqual(SAMPLES.PlayerMove)
    }),
  )

  it.effect('preserves an optional world on protocol-v1 movement and block mutations', () =>
    Effect.sync(() => {
      const messages: ReadonlyArray<NetworkMessage> = [
        { ...SAMPLES.PlayerMove, world: overworld },
        { ...SAMPLES.BlockPlace, world: WorldId.make('nether') },
        { ...SAMPLES.BlockBreak, world: WorldId.make('end') },
      ]

      for (const message of messages) {
        expect(Result.getOrThrow(decodeFrame(encoded(message)))).toStrictEqual(message)
      }
    }),
  )

  it.effect('accepts protocol-v1 authoritative state that omits new optional fields', () =>
    Effect.sync(() => {
      const legacySnapshot = JSON.stringify({
        message: {
          _tag: 'AuthoritativeSnapshot',
          containers: [],
          entities: [{ _tag: 'living', entityId, entityType: 'zombie', at: { x: 1, y: 64, z: 1 }, health: 20, maxHealth: 20 }],
          furnaces: [],
          inventories: [{ player: alice, state: { slots: [{ item: 'stone', count: 2 }], selectedSlot: 0 } }],
          revision: 12,
          timeWeather: { timeOfDay: 6000, weather: 'clear' },
          villagerTrades: [],
          vitals: [{ player: alice, state: { health: 20, hunger: 20, experience: 1 } }],
          world: overworld,
        },
        protocolVersion: PROTOCOL_VERSION,
      })

      expect(Result.isSuccess(decodeFrame(legacySnapshot))).toBe(true)
    }),
  )

  it.effect('preserves executable payloads for every authoritative operation', () =>
    Effect.sync(() => {
      const commands: ReadonlyArray<NetworkMessage> = [
        { _tag: 'PlayerInventoryCommand', ...commandHeader, action: { _tag: 'select-slot', slot: 4 } },
        { _tag: 'PlayerInventoryCommand', ...commandHeader, action: { _tag: 'move-item', count: 2, destination: 7, source: 1 } },
        { _tag: 'PlayerInventoryCommand', ...commandHeader, action: { _tag: 'swap-items', destination: 7, source: 1 } },
        { _tag: 'PlayerInventoryCommand', ...commandHeader, action: { _tag: 'drop-item', count: 1, destination: 'world', source: 7 } },
        { _tag: 'PlayerInventoryCommand', ...commandHeader, action: { _tag: 'equip-item', equipmentSlot: 'head', source: 1 } },
        { _tag: 'PlayerInventoryCommand', ...commandHeader, action: { _tag: 'unequip-item', destination: 7, equipmentSlot: 'head' } },
        { _tag: 'WorldTimeWeatherCommand', ...commandHeader, action: { _tag: 'set-time', timeOfDay: 18_000 } },
        { _tag: 'WorldTimeWeatherCommand', ...commandHeader, action: { _tag: 'set-weather', weather: 'thunder' } },
        { _tag: 'ContainerCommand', ...commandHeader, containerId: 'chest:1', action: { _tag: 'move-item', count: 2, destination: { _tag: 'container-slot', slot: 5 }, source: { _tag: 'player-slot', slot: 1 } } },
        { _tag: 'ContainerCommand', ...commandHeader, containerId: 'chest:1', action: { _tag: 'move-item', count: 1, destination: { _tag: 'player-slot', slot: 1 }, source: { _tag: 'container-slot', slot: 5 } } },
        { _tag: 'FurnaceCommand', ...commandHeader, furnaceId: 'furnace:1', action: { _tag: 'move-item', count: 2, destination: { _tag: 'furnace-slot', slot: 'input' }, source: { _tag: 'player-slot', slot: 1 } } },
          { _tag: 'FurnaceCommand', ...commandHeader, furnaceId: 'furnace:1', action: { _tag: 'move-item', count: 1, destination: { _tag: 'player-slot', slot: 1 }, source: { _tag: 'furnace-slot', slot: 'fuel' } } },
          { _tag: 'FurnaceCommand', ...commandHeader, furnaceId: 'furnace:1', action: { _tag: 'take-output', count: 1, destination: { _tag: 'player-slot', slot: 1 }, source: { _tag: 'furnace-slot', slot: 'output' } } },
          { _tag: 'VehicleCommand', ...commandHeader, entityId, action: { _tag: 'move', direction: 'backward' } },
      ]

      for (const original of commands) {
        expect(Result.getOrThrow(decodeFrame(encoded(original)))).toStrictEqual(original)
      }
    }),
  )

  it.effect('preserves non-ASCII chat text', () =>
    Effect.sync(() => {
      const chat = decodeFrame(encoded(SAMPLES.Chat))
      expect(Result.getOrThrow(chat)).toStrictEqual(SAMPLES.Chat)
    }),
  )
})

describe('registered C4 owner messages', () => {
  it.effect('round-trips registered states and accepts an empty owner registry for empty groups', () =>
    Effect.sync(() => {
      const encodedOwner = Result.getOrThrow(encodeFrame(OWNER_DELTA, OWNER_REGISTRY))
      expect(Result.getOrThrow(decodeFrame(encodedOwner, OWNER_REGISTRY))).toStrictEqual(OWNER_DELTA)
      const encodedSnapshot = Result.getOrThrow(encodeFrame(OWNER_SNAPSHOT, OWNER_REGISTRY))
      expect(Result.getOrThrow(decodeFrame(encodedSnapshot, OWNER_REGISTRY))).toStrictEqual(OWNER_SNAPSHOT)
      expect(Result.getOrThrow(decodeFrame(encoded(emptyWorldDelta), EMPTY_OWNER_REGISTRY))).toStrictEqual(emptyWorldDelta)
    }),
  )

  it.effect('accepts the configured owner, block, shape, and byte boundaries for C4 delta and snapshot fixtures', () =>
    Effect.sync(() => {
      const deltaFrame = Result.getOrThrow(encodeFrame(MAXIMUM_C4_DELTA_AT_FRAME_LIMIT, MAXIMUM_C4_REGISTRY))
      const snapshotFrame = Result.getOrThrow(encodeTransferredSnapshotFrame(
        MAXIMUM_C4_SNAPSHOT_AT_FRAME_LIMIT,
        MAXIMUM_C4_REGISTRY,
        MAXIMUM_C4_LIMITS.maxSnapshotFrameBytes,
      ))
      const deltaShape = measureFrameShape({ message: MAXIMUM_C4_DELTA_AT_FRAME_LIMIT, protocolVersion: PROTOCOL_VERSION })
      const snapshotShape = measureFrameShape({
        message: MAXIMUM_C4_SNAPSHOT_AT_FRAME_LIMIT,
        protocolVersion: PROTOCOL_VERSION,
      })
      const boundaryMetrics = {
        ownerStateUtf8Bytes: MAXIMUM_C4_OWNER_STATE_BYTES,
        configuredOwnerStateBytes: MAXIMUM_C4_OWNER_STATE_LIMIT_BYTES,
        delta: {
          ownerCount: MAXIMUM_C4_DELTA_AT_FRAME_LIMIT.changes.length,
          blockCount: MAXIMUM_C4_DELTA_AT_FRAME_LIMIT.blockChanges.length,
          profileUtf8Bytes: MAXIMUM_C4_DELTA_FRAME_BYTES,
          countLimitFixtureUtf8Bytes: MAXIMUM_C4_DELTA_COUNT_FRAME_BYTES,
          configuredFrameLimitBytes: MAXIMUM_C4_LIMITS.maxDeltaFrameBytes,
          utf8Bytes: wireFrameByteLength(deltaFrame),
          ...deltaShape,
        },
        snapshot: {
          ownerCount: MAXIMUM_C4_SNAPSHOT_AT_FRAME_LIMIT.owners.length,
          blockReadCount: MAXIMUM_C4_SNAPSHOT_AT_FRAME_LIMIT.blocks.length,
          profileUtf8Bytes: MAXIMUM_C4_SNAPSHOT_FRAME_BYTES,
          countLimitFixtureUtf8Bytes: MAXIMUM_C4_SNAPSHOT_COUNT_FRAME_BYTES,
          configuredFrameLimitBytes: MAXIMUM_C4_LIMITS.maxSnapshotFrameBytes,
          utf8Bytes: wireFrameByteLength(snapshotFrame),
          ...snapshotShape,
        },
      }

      expect(boundaryMetrics).toMatchInlineSnapshot(`
        {
          "configuredOwnerStateBytes": 108,
          "delta": {
            "blockCount": 256,
            "configuredFrameLimitBytes": 54489,
            "countLimitFixtureUtf8Bytes": 43591,
            "maxCollectionItems": 256,
            "maxDepth": 6,
            "ownerCount": 3,
            "profileUtf8Bytes": 34872,
            "utf8Bytes": 54489,
          },
          "ownerStateUtf8Bytes": 86,
          "snapshot": {
            "blockReadCount": 15000,
            "configuredFrameLimitBytes": 3422759,
            "countLimitFixtureUtf8Bytes": 2738207,
            "maxCollectionItems": 15000,
            "maxDepth": 6,
            "ownerCount": 3,
            "profileUtf8Bytes": 2190564,
            "utf8Bytes": 3422759,
          },
        }
      `)
      expect(MAXIMUM_C4_DELTA_AT_FRAME_LIMIT.changes).toHaveLength(MAXIMUM_C4_PROFILE_OWNER_COUNT)
      expect(MAXIMUM_C4_DELTA_AT_FRAME_LIMIT.blockChanges).toHaveLength(MAXIMUM_C4_PROFILE_DELTA_BLOCK_COUNT)
      expect(MAXIMUM_C4_SNAPSHOT_AT_FRAME_LIMIT.owners).toHaveLength(MAXIMUM_C4_PROFILE_OWNER_COUNT)
      expect(MAXIMUM_C4_SNAPSHOT_AT_FRAME_LIMIT.blocks).toHaveLength(MAXIMUM_C4_PROFILE_SNAPSHOT_BLOCK_COUNT)
      expect(MAXIMUM_C4_OWNER_STATE_LIMIT_BYTES).toBe(Math.ceil(MAXIMUM_C4_OWNER_STATE_BYTES * 1.25))
      expect(MAXIMUM_C4_OWNER_STATE_LIMIT_BYTES).toBe(MAXIMUM_C4_LIMITS.ownerStates[0]?.maxStateBytes)
      expect(MAXIMUM_C4_LIMITS.ownerStates[0]?.maxStateDepth).toBe(Math.ceil(MAXIMUM_C4_PROFILE_OWNER_STATE_DEPTH * 1.25))
      expect(MAXIMUM_C4_OWNER_COUNT_LIMIT).toBe(Math.ceil(MAXIMUM_C4_PROFILE_OWNER_COUNT * 1.25))
      expect(MAXIMUM_C4_DELTA_BLOCK_LIMIT).toBe(Math.ceil(MAXIMUM_C4_PROFILE_DELTA_BLOCK_COUNT * 1.25))
      expect(MAXIMUM_C4_SNAPSHOT_BLOCK_LIMIT).toBe(Math.ceil(MAXIMUM_C4_PROFILE_SNAPSHOT_BLOCK_COUNT * 1.25))
      expect(MAXIMUM_C4_DEPTH_LIMIT).toBe(Math.ceil(MAXIMUM_C4_PROFILE_FRAME_DEPTH * 1.25))
      expect(MAXIMUM_C4_COLLECTION_LIMIT).toBe(MAXIMUM_C4_PROFILE_SNAPSHOT_BLOCK_COUNT * 1.25)
      expect(MAXIMUM_C4_DELTA_FRAME_LIMIT).toBe(Math.ceil(Math.max(
        MAXIMUM_C4_DELTA_FRAME_BYTES,
        MAXIMUM_C4_DELTA_COUNT_FRAME_BYTES,
      ) * 1.25))
      expect(MAXIMUM_C4_SNAPSHOT_FRAME_LIMIT).toBe(Math.ceil(Math.max(
        MAXIMUM_C4_SNAPSHOT_FRAME_BYTES,
        MAXIMUM_C4_SNAPSHOT_COUNT_FRAME_BYTES,
      ) * 1.25))
      expect(deltaShape.maxDepth).toBeLessThanOrEqual(MAXIMUM_C4_LIMITS.maxDepth)
      expect(deltaShape.maxCollectionItems).toBeLessThanOrEqual(MAXIMUM_C4_LIMITS.maxCollectionItems)
      expect(snapshotShape.maxDepth).toBeLessThanOrEqual(MAXIMUM_C4_LIMITS.maxDepth)
      expect(snapshotShape.maxCollectionItems).toBeLessThanOrEqual(MAXIMUM_C4_LIMITS.maxCollectionItems)
      expect(snapshotShape.maxDepth).toBe(MAXIMUM_C4_PROFILE_FRAME_DEPTH)
      expect(snapshotShape.maxCollectionItems).toBe(MAXIMUM_C4_PROFILE_SNAPSHOT_BLOCK_COUNT)
      expect(wireFrameByteLength(deltaFrame)).toBe(MAXIMUM_C4_LIMITS.maxDeltaFrameBytes)
      expect(wireFrameByteLength(snapshotFrame)).toBe(MAXIMUM_C4_LIMITS.maxSnapshotFrameBytes)
      expect(Result.getOrThrow(decodeFrame(deltaFrame, MAXIMUM_C4_REGISTRY))).toStrictEqual(MAXIMUM_C4_DELTA_AT_FRAME_LIMIT)
      expect(Result.getOrThrow(decodeTransferredSnapshotFrame(
        snapshotFrame,
        MAXIMUM_C4_REGISTRY,
        MAXIMUM_C4_LIMITS.maxSnapshotFrameBytes,
      ))).toStrictEqual(MAXIMUM_C4_SNAPSHOT_AT_FRAME_LIMIT)
    }),
  )

  it.effect('accepts exact C4 owner and block counts, then rejects each count one above its typed limit', () =>
    Effect.sync(() => {
      const frameFor = (message: unknown) => JSON.stringify({ message, protocolVersion: PROTOCOL_VERSION })
      const deltaFrame = Result.getOrThrow(encodeFrame(MAXIMUM_C4_DELTA_AT_COUNT_LIMIT, MAXIMUM_C4_REGISTRY))
      const smallSnapshotLimits = { ...MAXIMUM_C4_LIMITS, maxSnapshotBlockReads: 2 }
      const smallSnapshotOwners = Result.getOrThrow(
        createReplicatedOwnerRegistry(MAXIMUM_C4_REGISTRATIONS, smallSnapshotLimits),
      )
      const exactCountSnapshot = {
        ...MAXIMUM_C4_SNAPSHOT_AT_COUNT_LIMIT,
        blocks: MAXIMUM_C4_SNAPSHOT_AT_COUNT_LIMIT.blocks.slice(0, smallSnapshotLimits.maxSnapshotBlockReads),
      }
      const overOwnerDelta = {
        ...MAXIMUM_C4_DELTA_AT_COUNT_LIMIT,
        changes: [...MAXIMUM_C4_DELTA_AT_COUNT_LIMIT.changes, MAXIMUM_C4_DELTA_AT_COUNT_LIMIT.changes[0]],
      }
      const overDeltaBlocks = {
        ...MAXIMUM_C4_DELTA_AT_COUNT_LIMIT,
        blockChanges: [...MAXIMUM_C4_DELTA_AT_COUNT_LIMIT.blockChanges, {
          before: 0,
          dimension: 'overworld',
          position: { x: MAXIMUM_C4_DELTA_BLOCK_LIMIT, y: 64, z: 0 },
          after: 65_535,
        }],
      }
      const overOwnerSnapshot = {
        ...exactCountSnapshot,
        owners: [...exactCountSnapshot.owners, exactCountSnapshot.owners[0]],
      }
      const overSnapshotBlocks = {
        ...exactCountSnapshot,
        blocks: [...exactCountSnapshot.blocks, exactCountSnapshot.blocks[0]],
      }
      const exactSnapshotFrame = Result.getOrThrow(encodeTransferredSnapshotFrame(
        exactCountSnapshot,
        smallSnapshotOwners,
        smallSnapshotLimits.maxSnapshotFrameBytes,
      ))

      expect(MAXIMUM_C4_DELTA_AT_COUNT_LIMIT.changes).toHaveLength(MAXIMUM_C4_LIMITS.maxRegisteredOwners)
      expect(MAXIMUM_C4_DELTA_AT_COUNT_LIMIT.blockChanges).toHaveLength(MAXIMUM_C4_LIMITS.maxDeltaBlockChanges)
      expect(MAXIMUM_C4_SNAPSHOT_AT_COUNT_LIMIT.owners).toHaveLength(MAXIMUM_C4_LIMITS.maxRegisteredOwners)
      expect(MAXIMUM_C4_SNAPSHOT_AT_COUNT_LIMIT.blocks).toHaveLength(MAXIMUM_C4_LIMITS.maxSnapshotBlockReads)
      expect(measureFrameShape({ message: exactCountSnapshot, protocolVersion: PROTOCOL_VERSION }).maxCollectionItems)
        .toBeLessThanOrEqual(smallSnapshotLimits.maxCollectionItems)
      expect(Result.getOrThrow(decodeFrame(deltaFrame, MAXIMUM_C4_REGISTRY))).toStrictEqual(MAXIMUM_C4_DELTA_AT_COUNT_LIMIT)
      expect(Result.getOrThrow(decodeTransferredSnapshotFrame(
        exactSnapshotFrame,
        smallSnapshotOwners,
        smallSnapshotLimits.maxSnapshotFrameBytes,
      ))).toStrictEqual(exactCountSnapshot)
      expect(failure(decodeFrame(frameFor(overOwnerDelta), MAXIMUM_C4_REGISTRY))?.reason).toBe('malformed-frame')
      expect(failure(decodeFrame(frameFor(overDeltaBlocks), MAXIMUM_C4_REGISTRY))?.reason).toBe('malformed-frame')
      expect(failure(decodeTransferredSnapshotFrame(
        frameFor(overOwnerSnapshot),
        smallSnapshotOwners,
        smallSnapshotLimits.maxSnapshotFrameBytes,
      ))?.reason).toBe('malformed-frame')
      expect(failure(decodeTransferredSnapshotFrame(
        frameFor(overSnapshotBlocks),
        smallSnapshotOwners,
        smallSnapshotLimits.maxSnapshotFrameBytes,
      ))?.reason).toBe('malformed-frame')
    }),
  )

  it.effect('accepts owner state at its typed byte and collection limits, and rejects the next value', () =>
    Effect.sync(() => {
      const overStateBytes = {
        ...MAXIMUM_C4_DELTA,
        changes: MAXIMUM_C4_OWNER_CHANGES_AT_LIMIT.map((change, index) => index === 0
          ? { ...change, state: MAXIMUM_C4_OWNER_STATE_OVER_LIMIT }
          : change),
      }
      const overStateCollection = {
        ...MAXIMUM_C4_DELTA,
        changes: MAXIMUM_C4_OWNER_IDS.map((owner) => ({
          owner,
          state: { labels: ['', '', '', ''] },
        })),
      }
      const atStateLimit = { ...MAXIMUM_C4_DELTA, changes: MAXIMUM_C4_OWNER_CHANGES_AT_LIMIT }
      const atStateLimitFrame = Result.getOrThrow(encodeFrame(atStateLimit, MAXIMUM_C4_REGISTRY))
      const stateShape = measureFrameShape(MAXIMUM_C4_OWNER_STATE_AT_LIMIT)

      expect(wireFrameByteLength(JSON.stringify(MAXIMUM_C4_OWNER_STATE_AT_LIMIT))).toBe(MAXIMUM_C4_OWNER_STATE_LIMIT_BYTES)
      expect(stateShape.maxDepth).toBeLessThanOrEqual(MAXIMUM_C4_LIMITS.ownerStates[0]?.maxStateDepth ?? 0)
      expect(stateShape.maxCollectionItems).toBe(MAXIMUM_C4_LIMITS.ownerStates[0]?.maxCollectionItems)
      expect(Result.getOrThrow(decodeFrame(atStateLimitFrame, MAXIMUM_C4_REGISTRY))).toStrictEqual(atStateLimit)
      expect(failure(encodeFrame(overStateBytes, MAXIMUM_C4_REGISTRY))?.reason).toBe('unencodable-message')
      expect(failure(encodeFrame(overStateCollection, MAXIMUM_C4_REGISTRY))?.reason).toBe('unencodable-message')
    }),
  )

  it.effect('rejects C4 frames one UTF-8 byte above the exact delta and snapshot limits', () =>
    Effect.sync(() => {
      const frameFor = (message: unknown) => JSON.stringify({ message, protocolVersion: PROTOCOL_VERSION })
      const overDelta = {
        ...MAXIMUM_C4_DELTA_AT_FRAME_LIMIT,
        world: WorldId.make(`${MAXIMUM_C4_DELTA_AT_FRAME_LIMIT.world}x`),
      }
      const overSnapshot = {
        ...MAXIMUM_C4_SNAPSHOT_AT_FRAME_LIMIT,
        world: WorldId.make(`${MAXIMUM_C4_SNAPSHOT_AT_FRAME_LIMIT.world}x`),
      }
      const overDeltaFrame = frameFor(overDelta)
      const overSnapshotFrame = frameFor(overSnapshot)

      expect(wireFrameByteLength(overDeltaFrame)).toBe(MAXIMUM_C4_LIMITS.maxDeltaFrameBytes + 1)
      expect(wireFrameByteLength(overSnapshotFrame)).toBe(MAXIMUM_C4_LIMITS.maxSnapshotFrameBytes + 1)
      expect(failure(decodeFrame(overDeltaFrame, MAXIMUM_C4_REGISTRY))?.reason).toBe('frame-too-large')
      expect(failure(decodeTransferredSnapshotFrame(
        overSnapshotFrame,
        MAXIMUM_C4_REGISTRY,
        MAXIMUM_C4_LIMITS.maxSnapshotFrameBytes,
      ))?.reason).toBe('frame-too-large')
    }),
  )

  it.effect('requires a registry for C4 messages even when their owner list is empty', () =>
    Effect.sync(() => {
      const unregisteredDelta = JSON.stringify({ message: emptyWorldDelta, protocolVersion: PROTOCOL_VERSION })
      const unregisteredSnapshot = JSON.stringify({ message: emptyWorldSnapshot, protocolVersion: PROTOCOL_VERSION })

      expect(failure(decodeFrame(unregisteredDelta))?.reason).toBe('malformed-frame')
      expect(failure(decodeFrame(unregisteredSnapshot))?.reason).toBe('malformed-frame')
    }),
  )

  it.effect('rejects duplicate registrations, unknown owners, duplicate changes, and invalid owner state', () =>
    Effect.sync(() => {
      const duplicateRegistry = createReplicatedOwnerRegistry([OWNER_REGISTRATION, OWNER_REGISTRATION], {
        ...OWNER_REGISTRY_LIMITS,
        maxRegisteredOwners: 2,
      })
      expect(failure(duplicateRegistry)?.reason).toBe('malformed-frame')

      const unknownOwner = {
        ...OWNER_DELTA,
        changes: [{ owner: makeReplicatedOwnerId('unknown-owner'), state: { count: 2 } }],
      }
      const duplicateChanges = {
        ...OWNER_DELTA,
        changes: [
          { owner: OWNER_ID, state: { count: 2 } },
          { owner: OWNER_ID, state: { count: 3 } },
        ],
      }
      const firstMaximumOwnerChange = MAXIMUM_C4_OWNER_CHANGES_AT_LIMIT.at(0)
      if (firstMaximumOwnerChange === undefined) {
        throw new Error('maximum C4 fixture must contain an owner change')
      }
      const duplicateRegisteredOwnerChanges = {
        ...MAXIMUM_C4_DELTA,
        changes: [firstMaximumOwnerChange, firstMaximumOwnerChange],
      }
      const invalidState = {
        ...OWNER_DELTA,
        changes: [{ owner: OWNER_ID, state: { count: 2, extra: true } }],
      }
      const frameFor = (message: unknown) => JSON.stringify({ message, protocolVersion: PROTOCOL_VERSION })

      expect(failure(decodeFrame(frameFor(unknownOwner), OWNER_REGISTRY))?.reason).toBe('malformed-frame')
      expect(failure(decodeFrame(frameFor(duplicateChanges), OWNER_REGISTRY))?.reason).toBe('malformed-frame')
      expect(failure(decodeFrame(frameFor(duplicateRegisteredOwnerChanges), MAXIMUM_C4_REGISTRY))?.reason).toBe('malformed-frame')
      expect(failure(decodeFrame(frameFor(invalidState), OWNER_REGISTRY))?.reason).toBe('malformed-frame')
      expect(failure(encodeFrame(invalidState, OWNER_REGISTRY))?.reason).toBe('unencodable-message')
    }),
  )

  it.effect('rejects invalid registry limits and mismatched owner-state bounds', () =>
    Effect.sync(() => {
      const [ownerBounds] = OWNER_REGISTRY_LIMITS.ownerStates
      if (ownerBounds === undefined) {
        throw new Error('owner registry fixture must contain its state bounds')
      }
      const invalidOwnerId = makeReplicatedOwnerId('')
      const invalidOwnerRegistration: ReplicatedOwnerRegistration<typeof OWNER_STATE_SCHEMA> = {
        ...OWNER_REGISTRATION,
        ownerId: invalidOwnerId,
      }

      const invalidCountLimit = createReplicatedOwnerRegistry([OWNER_REGISTRATION], {
        ...OWNER_REGISTRY_LIMITS,
        maxRegisteredOwners: 0,
      })
      const invalidOwnerIdentity = createReplicatedOwnerRegistry([invalidOwnerRegistration], {
        ...OWNER_REGISTRY_LIMITS,
        ownerStates: [{ ...ownerBounds, ownerId: invalidOwnerId }],
      })
      const invalidDepthLimit = createReplicatedOwnerRegistry([OWNER_REGISTRATION], {
        ...OWNER_REGISTRY_LIMITS,
        maxDepth: GLOBAL_JSON_DEPTH_LIMIT + 1,
      })
      const invalidOwnerStateBound = createReplicatedOwnerRegistry([OWNER_REGISTRATION], {
        ...OWNER_REGISTRY_LIMITS,
        ownerStates: [{ ...ownerBounds, maxStateBytes: 0 }],
      })
      const duplicateOwnerStateBound = createReplicatedOwnerRegistry([OWNER_REGISTRATION], {
        ...OWNER_REGISTRY_LIMITS,
        ownerStates: [ownerBounds, ownerBounds],
      })
      const missingOwnerStateBound = createReplicatedOwnerRegistry([OWNER_REGISTRATION], {
        ...OWNER_REGISTRY_LIMITS,
        ownerStates: [],
      })
      const unusedOwnerStateBound = createReplicatedOwnerRegistry([], {
        ...EMPTY_OWNER_REGISTRY_LIMITS,
        ownerStates: [ownerBounds],
      })

      for (const invalidRegistry of [
        invalidCountLimit,
        invalidOwnerIdentity,
        invalidDepthLimit,
        invalidOwnerStateBound,
        duplicateOwnerStateBound,
        missingOwnerStateBound,
        unusedOwnerStateBound,
      ]) {
        expect(failure(invalidRegistry)?.reason).toBe('malformed-frame')
      }
    }),
  )

  it.effect('enforces the owner-state depth bound on validated state', () =>
    Effect.sync(() => {
      const nestedOwnerId = makeReplicatedOwnerId('codec-nested-owner')
      const nestedStateSchema = Schema.Struct({ nested: Schema.Struct({ value: Schema.Number }) })
      const registration: ReplicatedOwnerRegistration<typeof nestedStateSchema> = {
        ownerId: nestedOwnerId,
        schema: nestedStateSchema,
        initialState: { nested: { value: 1 } },
      }
      const registry = Result.getOrThrow(createReplicatedOwnerRegistry([registration], {
        ...OWNER_REGISTRY_LIMITS,
        ownerStates: [{ ownerId: nestedOwnerId, maxStateBytes: 1_024, maxStateDepth: 2, maxCollectionItems: 1 }],
      }))
      const message = Result.getOrThrow(Schema.decodeUnknownResult(ReplicatedWorldDeltaMessage)({
        _tag: 'ReplicatedWorldDelta',
        world: overworld,
        revision: replicatedWorldRevision,
        changes: [{ owner: nestedOwnerId, state: { nested: { value: 2 } } }],
        blockChanges: [],
      }))

      expect(failure(encodeFrame(message, registry))?.reason).toBe('unencodable-message')
    }),
  )

  it.effect('requires a registry and its block-read allowance for C4 snapshots', () =>
    Effect.sync(() => {
      const snapshot = {
        ...emptyWorldSnapshot,
        blocks: [{
          dimension: 'overworld',
          position: { x: 0, y: 64, z: 0 },
          reading: { _tag: 'Block' as const, block: 1 },
        }],
      }
      const frame = JSON.stringify({ message: snapshot, protocolVersion: PROTOCOL_VERSION })

      expect(failure(decodeFrame(encoded(emptyWorldSnapshot)))?.reason).toBe('malformed-frame')
      expect(failure(decodeFrame(frame, EMPTY_OWNER_REGISTRY))?.reason).toBe('malformed-frame')
      expect(failure(encodeFrame(snapshot, EMPTY_OWNER_REGISTRY))?.reason).toBe('unencodable-message')
    }),
  )

  it.effect('validates snapshot-transfer byte limits and snapshot message tags', () =>
    Effect.sync(() => {
      const pingFrame = encoded(SAMPLES.Ping)
      const snapshotFrame = encoded(emptyWorldSnapshot)

      expect(failure(encodeTransferredSnapshotFrame(emptyWorldSnapshot, EMPTY_OWNER_REGISTRY, 0))?.reason).toBe('unencodable-message')
      expect(failure(encodeTransferredSnapshotFrame(emptyWorldDelta, EMPTY_OWNER_REGISTRY, GLOBAL_FRAME_UTF8_LIMIT))?.reason).toBe('unencodable-message')
      expect(failure(encodeTransferredSnapshotFrame(emptyWorldSnapshot, EMPTY_OWNER_REGISTRY, 1))?.reason).toBe('frame-too-large')
      expect(failure(decodeTransferredSnapshotFrame(snapshotFrame, EMPTY_OWNER_REGISTRY, 0))?.reason).toBe('malformed-frame')
      expect(failure(decodeTransferredSnapshotFrame(snapshotFrame, EMPTY_OWNER_REGISTRY, 1))?.reason).toBe('frame-too-large')
      expect(failure(decodeTransferredSnapshotFrame(pingFrame, EMPTY_OWNER_REGISTRY, GLOBAL_FRAME_UTF8_LIMIT))?.reason).toBe('malformed-frame')
    }),
  )

  it.effect('enforces the configured C4 frame depth before accepting a valid delta', () =>
    Effect.sync(() => {
      const shallowRegistry = Result.getOrThrow(createReplicatedOwnerRegistry([], {
        ...EMPTY_OWNER_REGISTRY_LIMITS,
        maxDepth: 2,
      }))
      const frame = JSON.stringify({ message: emptyWorldDelta, protocolVersion: PROTOCOL_VERSION })

      expect(failure(decodeFrame(frame, shallowRegistry))?.reason).toBe('frame-too-large')
    }),
  )

  it.effect('rejects extra fields in v10 C4 messages and the version envelope', () =>
    Effect.sync(() => {
      const c4ExtraField = JSON.stringify({
        message: { ...emptyWorldDelta, future: true },
        protocolVersion: PROTOCOL_VERSION,
      })
      const envelopeExtraField = JSON.stringify({
        message: { _tag: 'Ping', nonce: 1 },
        protocolVersion: PROTOCOL_VERSION,
        future: true,
      })

      expect(failure(decodeFrame(c4ExtraField, EMPTY_OWNER_REGISTRY))?.reason).toBe('malformed-frame')
      expect(failure(decodeFrame(envelopeExtraField))?.reason).toBe('malformed-frame')
    }),
  )

  it.effect('identifies a supported C4 envelope before rejecting its invalid message body', () =>
    Effect.sync(() => {
      const malformedDelta = JSON.stringify({
        message: { _tag: 'ReplicatedWorldDelta', revision: 'wrong' },
        protocolVersion: PROTOCOL_VERSION,
      })

      const tag = inspectReplicatedFrameTag(malformedDelta)
      expect(Result.isSuccess(tag)).toBe(true)
      expect(Result.isSuccess(decodeFrame(malformedDelta, EMPTY_OWNER_REGISTRY))).toBe(false)
      if (Result.isSuccess(tag)) {
        expect(tag.success).toBe('ReplicatedWorldDelta')
      }

      for (const c4Tag of [
        'ReplicatedWorldDelta',
        'ReplicatedWorldSnapshot',
        'ReplicatedWorldSnapshotStart',
        'ReplicatedWorldSnapshotChunk',
        'ReplicatedWorldSnapshotEnd',
      ] as const) {
        const validFrame = encoded(SAMPLES[c4Tag])
        const inspectedTag = inspectReplicatedFrameTag(validFrame)
        expect(Result.isSuccess(inspectedTag)).toBe(true)
        if (Result.isSuccess(inspectedTag)) {
          expect(inspectedTag.success).toBe(c4Tag)
        }
      }
    }),
  )

  it.effect('does not classify unrelated, malformed-envelope, or unsupported-version frames as C4', () =>
    Effect.sync(() => {
      const ordinary = JSON.stringify({ message: SAMPLES.Ping, protocolVersion: PROTOCOL_VERSION })
      const malformedEnvelope = JSON.stringify({ message: emptyWorldDelta, protocolVersion: PROTOCOL_VERSION, extra: true })
      const oldVersion = JSON.stringify({ message: emptyWorldDelta, protocolVersion: PROTOCOL_VERSION - 1 })

      const ordinaryTag = inspectReplicatedFrameTag(ordinary)
      expect(Result.isSuccess(ordinaryTag)).toBe(true)
      if (Result.isSuccess(ordinaryTag)) {
        expect(ordinaryTag.success).toBeUndefined()
      }
      const nonObjectMessage = inspectReplicatedFrameTag(JSON.stringify({
        message: 'Ping',
        protocolVersion: PROTOCOL_VERSION,
      }))
      expect(Result.isSuccess(nonObjectMessage)).toBe(true)
      if (Result.isSuccess(nonObjectMessage)) {
        expect(nonObjectMessage.success).toBeUndefined()
      }
      expect(failure(inspectReplicatedFrameTag(malformedEnvelope))?.reason).toBe('malformed-frame')
      expect(failure(inspectReplicatedFrameTag(oldVersion))?.reason).toBe('unsupported-protocol-version')

      const oversizedMalformedC4 = JSON.stringify({
        message: { ...emptyWorldDelta, unexpected: 'x'.repeat(2_048) },
        protocolVersion: PROTOCOL_VERSION,
      })
      expect(oversizedMalformedC4.length).toBeGreaterThan(1_024)
      const oversizedTag = inspectReplicatedFrameTag(oversizedMalformedC4)
      expect(Result.isSuccess(oversizedTag)).toBe(true)
      expect(failure(decodeFrame(oversizedMalformedC4, EMPTY_OWNER_REGISTRY))?.reason).toBe('malformed-frame')
      if (Result.isSuccess(oversizedTag)) {
        expect(oversizedTag.success).toBe('ReplicatedWorldDelta')
      }
    }),
  )
})

describe('wire byte accounting', () => {
  it.effect('counts UTF-8 bytes including surrogate pairs and replacement of lone surrogates', () =>
    Effect.sync(() => {
      expect(wireFrameByteLength('')).toBe(0)
      expect(wireFrameByteLength('a')).toBe(1)
      expect(wireFrameByteLength('世')).toBe(3)
      expect(wireFrameByteLength('😀')).toBe(4)
      expect(wireFrameByteLength('\ud800')).toBe(3)
      expect(wireFrameByteLength('世'.repeat(1_024))).toBe(3_072)
    }),
  )

  it.effect('retains the 1 MiB ASCII frame baseline in both UTF-8 bytes and code units', () =>
    Effect.sync(() => {
      const baseMessage = { ...SAMPLES.PlayerMove, world: WorldId.make('x') }
      const baseFrame = envelopeText(baseMessage)
      const worldPadding = OLD_GLOBAL_FRAME_BASELINE - baseFrame.length
      const message = { ...baseMessage, world: WorldId.make('x'.repeat(worldPadding + 1)) }
      const frame = Result.getOrThrow(encodeFrame(message))

      expect(frame.length).toBe(OLD_GLOBAL_FRAME_BASELINE)
      expect(wireFrameByteLength(frame)).toBe(OLD_GLOBAL_FRAME_BASELINE)
      expect(Result.getOrThrow(decodeFrame(frame))).toStrictEqual(message)
    }),
  )

  it.effect('accepts the exact global UTF-8 byte cap with 3-byte BMP text and rejects its next character', () =>
    Effect.sync(() => {
      const baseMessage = { ...SAMPLES.PlayerMove, world: WorldId.make('x') }
      const baseFrame = envelopeText(baseMessage)
      const bytesForWorld = GLOBAL_FRAME_UTF8_LIMIT - wireFrameByteLength(baseFrame)
      const triplets = Math.floor(bytesForWorld / 3)
      const remainder = bytesForWorld % 3
      const world = `x${'\u0800'.repeat(triplets)}${remainder === 2 ? 'é' : remainder === 1 ? 'x' : ''}`
      const message = { ...baseMessage, world: WorldId.make(world) }
      const exactFrame = Result.getOrThrow(encodeFrame(message))
      const overMessage = { ...message, world: WorldId.make(`${world}\u0800`) }
      const overFrame = envelopeText(overMessage)

      expect(wireFrameByteLength(exactFrame)).toBe(GLOBAL_FRAME_UTF8_LIMIT)
      expect(exactFrame.length).toBeLessThanOrEqual(GLOBAL_FRAME_CODE_UNIT_LIMIT)
      expect(Result.getOrThrow(decodeFrame(exactFrame))).toStrictEqual(message)
      expect(wireFrameByteLength(overFrame)).toBe(GLOBAL_FRAME_UTF8_LIMIT + 3)
      expect(failure(decodeFrame(overFrame))?.reason).toBe('frame-too-large')
      expect(failure(encodeFrame(overMessage))?.reason).toBe('frame-too-large')
      expect(failure(inspectReplicatedFrameTag(overFrame))?.reason).toBe('frame-too-large')
    }),
  )

  it.effect('enforces exact global JSON depth and collection ceilings before schema decoding', () =>
    Effect.sync(() => {
      const frameWithNestedArrays = (depth: number): string => {
        let extra: unknown = 0
        for (let currentDepth = 2; currentDepth < depth; currentDepth += 1) {
          extra = [extra]
        }
        return JSON.stringify({
          message: { _tag: 'Ping', nonce: Number.MAX_SAFE_INTEGER, extra },
          protocolVersion: PROTOCOL_VERSION,
        })
      }
      const frameWithCollection = (count: number): string => JSON.stringify({
        message: { _tag: 'Ping', nonce: Number.MAX_SAFE_INTEGER, extra: Array.from({ length: count }, () => 0) },
        protocolVersion: PROTOCOL_VERSION,
      })
      const depthLimitFrame = frameWithNestedArrays(GLOBAL_JSON_DEPTH_LIMIT)
      const overDepthFrame = frameWithNestedArrays(GLOBAL_JSON_DEPTH_LIMIT + 1)
      const collectionLimitFrame = frameWithCollection(GLOBAL_JSON_COLLECTION_LIMIT)
      const overCollectionFrame = frameWithCollection(GLOBAL_JSON_COLLECTION_LIMIT + 1)

      expect(measureFrameShape(JSON.parse(depthLimitFrame)).maxDepth).toBe(GLOBAL_JSON_DEPTH_LIMIT)
      expect(measureFrameShape(JSON.parse(collectionLimitFrame)).maxCollectionItems).toBe(GLOBAL_JSON_COLLECTION_LIMIT)
      expect(wireFrameByteLength(depthLimitFrame)).toBeLessThan(GLOBAL_FRAME_UTF8_LIMIT)
      expect(wireFrameByteLength(overDepthFrame)).toBeLessThan(GLOBAL_FRAME_UTF8_LIMIT)
      expect(wireFrameByteLength(collectionLimitFrame)).toBeLessThan(GLOBAL_FRAME_UTF8_LIMIT)
      expect(wireFrameByteLength(overCollectionFrame)).toBeLessThan(GLOBAL_FRAME_UTF8_LIMIT)
      expect(Result.isSuccess(decodeFrame(depthLimitFrame))).toBe(true)
      expect(failure(decodeFrame(overDepthFrame))?.reason).toBe('frame-too-large')
      expect(Result.isSuccess(decodeFrame(collectionLimitFrame))).toBe(true)
      expect(failure(decodeFrame(overCollectionFrame))?.reason).toBe('frame-too-large')
    }),
  )
})

describe('legacy frame ceilings', () => {
  it.effect('enforces the PlayerDamageCommand UTF-16 ceiling and reports oversized frames distinctly', () =>
    Effect.sync(() => {
      const withCommandId = (id: string): string => JSON.stringify({
        message: { ...SAMPLES.PlayerDamageCommand, commandId: id },
        protocolVersion: PROTOCOL_VERSION,
      })
      const emptyIdFrame = withCommandId('')
      const commandIdLength = 1_024 - emptyIdFrame.length
      const atLimit = withCommandId('x'.repeat(commandIdLength))
      const overLimit = withCommandId('x'.repeat(commandIdLength + 1))

      expect(atLimit.length).toBe(1_024)
      expect(Result.isSuccess(decodeFrame(atLimit))).toBe(true)

      const tooLarge = failure(decodeFrame(overLimit))
      expect(tooLarge?.reason).toBe('frame-too-large')
      expect(tooLarge?.detail).toContain('UTF-16 code units 1025 exceed limit 1024')
      expect(failure(inspectReplicatedFrameTag(overLimit))?.reason).toBe('frame-too-large')
      expect(failure(encodeFrame({ ...SAMPLES.PlayerDamageCommand, commandId: 'x'.repeat(1_024) }))?.reason).toBe('frame-too-large')

      const escapedKeys = overLimit
        .replace('"message":', '"mes\\u0073age":')
        .replace('"_tag":', '"\\u005ftag":')
      const escapedKeyFailure = failure(decodeFrame(escapedKeys))
      expect(escapedKeyFailure?.reason).toBe('frame-too-large')
      expect(escapedKeyFailure?.detail).toContain('PlayerDamageCommand')
    }),
  )

  it.effect('counts the derived PlayerDamageCommand UTF-8 boundary while UTF-16 remains the effective ceiling', () =>
    Effect.sync(() => {
      const withCommandId = (id: string): string => JSON.stringify({
        message: { ...SAMPLES.PlayerDamageCommand, commandId: id },
        protocolVersion: PROTOCOL_VERSION,
      })
      const emptyIdFrame = withCommandId('')
      const bytesToLimit = 3_072 - wireFrameByteLength(emptyIdFrame)
      const unicodeCommandId = '世'.repeat(Math.floor(bytesToLimit / 3)) + 'a'.repeat(bytesToLimit % 3)
      const atByteLimit = withCommandId(unicodeCommandId)

      expect(wireFrameByteLength(atByteLimit)).toBe(3_072)
      expect(atByteLimit.length).toBeGreaterThan(1_024)
      const tooLarge = failure(decodeFrame(atByteLimit))
      expect(tooLarge?.reason).toBe('frame-too-large')
      expect(tooLarge?.detail).toContain('UTF-16 code units')
    }),
  )

  it.effect('uses only the root message tag and returns no scanner tag for malformed JSON', () =>
    Effect.sync(() => {
      const nestedSpoof = JSON.stringify({
        message: {
          _tag: 'Ping',
          nonce: 7,
          nested: { _tag: 'PlayerDamageCommand', commandId: 'x'.repeat(2_048) },
        },
        protocolVersion: PROTOCOL_VERSION,
      })
      expect(Result.isSuccess(decodeFrame(nestedSpoof))).toBe(true)

      const duplicateMessage = `{"message":{"_tag":"PlayerDamageCommand","commandId":"${'x'.repeat(2_048)}"},"message":{"_tag":"Ping","nonce":7},"protocolVersion":${PROTOCOL_VERSION}}`
      expect(Result.isSuccess(decodeFrame(duplicateMessage))).toBe(true)

      const duplicateTag = `{"message":{"_tag":"PlayerDamageCommand","commandId":"${'x'.repeat(2_048)}","_tag":"Ping","nonce":7},"protocolVersion":${PROTOCOL_VERSION}}`
      expect(Result.isSuccess(decodeFrame(duplicateTag))).toBe(true)

      const malformed = `{"message":{"_tag":"PlayerDamageCommand","commandId":"${'x'.repeat(2_048)}",},"protocolVersion":${PROTOCOL_VERSION}}`
      expect(failure(decodeFrame(malformed))?.reason).toBe('malformed-frame')
    }),
  )

  it.effect('scans valid JSON escapes, whitespace, containers, and number forms before decoding the envelope', () =>
    Effect.sync(() => {
      const escapedValue = '\\/\\b\\f\\n\\r\\t\\"\\\\\\u0041\\u00af\\u00AF'
      const frame = '{\r\n\t"message":{"_tag":"Ping","nonce":7,"ignored":"' +
        escapedValue +
        '","nested":[true,false,null,-0,1.25e+2,1E2,{"empty":[]}]},\r\n\t"protocolVersion":' +
        PROTOCOL_VERSION +
        '\r\n}'
      const decoded = decodeFrame(frame)

      expect(Result.isSuccess(decoded)).toBe(true)
      expect(failure(inspectReplicatedFrameTag(frame))).toBeUndefined()
    }),
  )

  it.effect('rejects malformed JSON strings, numbers, delimiters, and trailing content during frame inspection', () =>
    Effect.sync(() => {
      const validPrefix = '{"message":{"_tag":"Ping","nonce":1},"protocolVersion":' + PROTOCOL_VERSION + '}'
      const unfinishedEscape = '{"message":{"_tag":"Ping","nonce":1,"ignored":"\\'
      const invalidFrames = [
        { id: 'invalid simple escape', frame: '{"message":{"_tag":"Ping","nonce":1,"ignored":"\\q"},"protocolVersion":' + PROTOCOL_VERSION + '}' },
        { id: 'invalid Unicode hex digit', frame: '{"message":{"_tag":"Ping","nonce":1,"ignored":"\\u00g0"},"protocolVersion":' + PROTOCOL_VERSION + '}' },
        { id: 'unterminated string escape', frame: unfinishedEscape },
        { id: 'unterminated string body', frame: '{"message":{"_tag":"Ping","nonce":1,"ignored":"' },
        { id: 'invalid string in array', frame: '{"message":{"_tag":"Ping","nonce":1,"ignored":["\\q"]},"protocolVersion":' + PROTOCOL_VERSION + '}' },
        { id: 'unescaped control character', frame: '{"message":{"_tag":"Ping","nonce":1,"ignored":"' + String.fromCharCode(1) + '"},"protocolVersion":' + PROTOCOL_VERSION + '}' },
        { id: 'leading zero in integer', frame: '{"message":{"_tag":"Ping","nonce":01},"protocolVersion":' + PROTOCOL_VERSION + '}' },
        { id: 'missing integer digits', frame: '{"message":{"_tag":"Ping","nonce":+1},"protocolVersion":' + PROTOCOL_VERSION + '}' },
        { id: 'missing fraction digits', frame: '{"message":{"_tag":"Ping","nonce":1.},"protocolVersion":' + PROTOCOL_VERSION + '}' },
        { id: 'missing exponent digits', frame: '{"message":{"_tag":"Ping","nonce":1e+},"protocolVersion":' + PROTOCOL_VERSION + '}' },
        { id: 'missing object colon', frame: '{"message" {"_tag":"Ping","nonce":1},"protocolVersion":' + PROTOCOL_VERSION + '}' },
        { id: 'mismatched object closer', frame: '{"message":{"_tag":"Ping","nonce":1]},"protocolVersion":' + PROTOCOL_VERSION + '}' },
        { id: 'trailing object comma', frame: '{"message":{"_tag":"Ping","nonce":1,},"protocolVersion":' + PROTOCOL_VERSION + '}' },
        { id: 'trailing array comma', frame: '{"message":{"_tag":"Ping","nonce":1,"ignored":[1,]},"protocolVersion":' + PROTOCOL_VERSION + '}' },
        { id: 'trailing non-whitespace', frame: validPrefix + ' x' },
        { id: 'truncated after whitespace', frame: validPrefix.slice(0, -1) + ' \r\n' },
      ]

      for (const { frame, id } of invalidFrames) {
        expect(failure(inspectReplicatedFrameTag(frame))?.reason, id).toBe('malformed-frame')
      }
    }),
  )

  it.effect('keeps new snapshot-transfer tags at the shared global ceiling', () =>
    Effect.sync(() => {
      const message = { ...snapshotStart, transferId: 'x'.repeat(1_024) }
      const text = JSON.stringify({ message, protocolVersion: PROTOCOL_VERSION })

      expect(text.length).toBeGreaterThan(1_024)
      expect(Result.isSuccess(decodeFrame(text))).toBe(true)
    }),
  )

  it.effect('counts object nesting while scanning frame shape', () =>
    Effect.sync(() => {
      const depth = GLOBAL_JSON_DEPTH_LIMIT + 1
      const nestedObjects = '{"child":'.repeat(depth) + 'null' + '}'.repeat(depth)
      const frame = '{"message":{"_tag":"Ping","nonce":1,"ignored":' +
        nestedObjects +
        '},"protocolVersion":' +
        PROTOCOL_VERSION +
        '}'

      expect(failure(decodeFrame(frame))?.reason).toBe('frame-too-large')
    }),
  )
})

describe('protocol version', () => {
  // REGRESSION: "a rolling upgrade is distinguishable from corruption".
  // The reference implementation had no version field, so a peer on an older
  // Build produced decode failures indistinguishable from a damaged frame.
  it.effect('rejects a frame from a version this build does not speak, and says so specifically', () =>
    Effect.sync(() => {
      const fromTheFuture = Result.getOrThrow(encodeFrameAsVersion(PROTOCOL_VERSION + 1, SAMPLES.Ping))
      const result = decodeFrame(fromTheFuture)

      expect(Result.isFailure(result)).toBe(true)
      const error = failure(result)
      expect(error?._tag).toBe('ProtocolError')
      expect(error?.reason).toBe('unsupported-protocol-version')
      expect(error?.detail).toContain(String(PROTOCOL_VERSION + 1))
    }),
  )

  it.effect('reports a version mismatch as a version problem, never as a malformed frame', () =>
    Effect.sync(() => {
      const older = Result.getOrThrow(encodeFrameAsVersion(0, SAMPLES.PlayerLeave))
      expect(failure(decodeFrame(older))?.reason).not.toBe('malformed-frame')
    }),
  )

  it.effect('rejects an unknown future message before interpreting its shape', () =>
    Effect.sync(() => {
      const futureFrame = JSON.stringify({
        message: { _tag: 'EntitySnapshot', entities: [{ future: true }] },
        protocolVersion: PROTOCOL_VERSION + 1,
      })

      expect(failure(decodeFrame(futureFrame))?.reason).toBe('unsupported-protocol-version')
    }),
  )

  it.effect('rejects a non-integral protocol version while encoding a frame', () =>
    Effect.sync(() => {
      expect(failure(encodeFrameAsVersion(1.5, SAMPLES.Ping))?.reason).toBe('unencodable-message')
    }),
  )
})

describe('malformed input', () => {
  const rejected = (text: string) => failure(decodeFrame(text))

  it.effect('rejects an empty player id at the encode boundary', () =>
    Effect.sync(() => {
      expect(failure(encodeFrame({ _tag: 'PlayerLeave', player: '' }))?.reason).toBe('unencodable-message')
    }),
  )

  it.effect('rejects text that is not JSON at all', () =>
    Effect.sync(() => {
      expect(rejected('not json')?.reason).toBe('malformed-frame')
      expect(rejected('')?.reason).toBe('malformed-frame')
    }),
  )

  it.effect('rejects JSON that is not a frame', () =>
    Effect.sync(() => {
      expect(rejected('{}')?.reason).toBe('malformed-frame')
      expect(rejected('[]')?.reason).toBe('malformed-frame')
      expect(rejected('null')?.reason).toBe('malformed-frame')
    }),
  )

  it.effect('rejects a missing or malformed envelope version', () =>
    Effect.sync(() => {
      expect(rejected(JSON.stringify({ message: SAMPLES.Ping }))?.reason).toBe('malformed-frame')
      expect(
        rejected(JSON.stringify({ message: SAMPLES.Ping, protocolVersion: '1' }))?.reason,
      ).toBe('malformed-frame')
      expect(
        rejected(JSON.stringify({ message: SAMPLES.Ping, protocolVersion: 1.5 }))?.reason,
      ).toBe('malformed-frame')
    }),
  )

  // REGRESSION: "an unknown tag is rejected, not coerced into a neighbouring
  // Case". A union that fell back to a default would apply a peer's message as
  // The wrong action.
  it.effect('rejects a message tag this build does not know instead of guessing', () =>
    Effect.sync(() => {
      const text = JSON.stringify({
        message: { _tag: 'DetonateEverything', player: 'alice' },
        protocolVersion: PROTOCOL_VERSION,
      })
      expect(rejected(text)?.reason).toBe('malformed-frame')
    }),
  )

  // REGRESSION: "JSON.stringify(NaN) === 'null'". This is why every coordinate
  // Carries `finite()`: without the refinement a NaN produced by a division by
  // Zero on the sender becomes a decode failure on the RECEIVER, where the
  // Originating code is no longer visible.
  it.effect('rejects a coordinate that arrived as null, which is what a NaN turns into over JSON', () =>
    Effect.sync(() => {
      const text = JSON.stringify({
        message: { _tag: 'PlayerMove', at: { x: null, y: 1, z: 2 }, facing: { pitchRadians: 0, yawRadians: 0 }, player: 'alice' },
        protocolVersion: PROTOCOL_VERSION,
      })
      expect(rejected(text)?.reason).toBe('malformed-frame')
    }),
  )

  it.effect('rejects a non-integral block coordinate', () =>
    Effect.sync(() => {
      const text = JSON.stringify({
        message: { _tag: 'BlockBreak', at: { x: 0.5, y: 1, z: 2 }, player: 'alice' },
        protocolVersion: PROTOCOL_VERSION,
      })
      expect(rejected(text)?.reason).toBe('malformed-frame')
    }),
  )

  it.effect('rejects negative or fractional authoritative revisions', () =>
    Effect.sync(() => {
      for (const revision of [-1, 0.5]) {
        const text = JSON.stringify({
          message: {
            _tag: 'WorldSnapshot',
            blocks: [],
            players: [],
            poweredRails: [],
            revision,
            seed: 1,
            world: 'overworld',
          },
          protocolVersion: PROTOCOL_VERSION,
        })
        expect(rejected(text)?.reason).toBe('malformed-frame')
      }
    }),
  )

  it.effect('rejects malformed snapshot members and unknown rejection reasons', () =>
    Effect.sync(() => {
      const malformedPlayer = JSON.stringify({
        message: {
          _tag: 'WorldSnapshot',
          blocks: [],
          players: [{ player: 'alice', name: '', at: { x: 0, y: 0, z: 0 }, facing: { yawRadians: 0, pitchRadians: 0 } }],
          poweredRails: [],
          revision: 0,
          seed: 1,
          world: 'overworld',
        },
        protocolVersion: PROTOCOL_VERSION,
      })
      const malformedPoweredRail = JSON.stringify({
        message: {
          _tag: 'WorldSnapshot',
          blocks: [],
          players: [],
          poweredRails: [{ at: { x: 0, y: 64, z: 0 }, powered: true, requestedBy: 'client' }],
          revision: 0,
          seed: 1,
          world: 'overworld',
        },
        protocolVersion: PROTOCOL_VERSION,
      })
      const unknownReason = JSON.stringify({
        message: {
          _tag: 'BlockMutationRejected',
          at: { x: 0, y: 0, z: 0 },
          operation: 'break',
          player: 'alice',
          reason: 'because-i-said-so',
          revision: 0,
          world: 'overworld',
        },
        protocolVersion: PROTOCOL_VERSION,
      })
      const missingContainerKind = JSON.stringify({
        message: {
          _tag: 'ContainerDelta',
          revision: 0,
          state: { containerId: 'chest:1', slots: [] },
          world: 'overworld',
        },
        protocolVersion: PROTOCOL_VERSION,
      })

      expect(rejected(malformedPlayer)?.reason).toBe('malformed-frame')
      expect(rejected(malformedPoweredRail)?.reason).toBe('malformed-frame')
      expect(rejected(unknownReason)?.reason).toBe('malformed-frame')
      expect(rejected(missingContainerKind)?.reason).toBe('malformed-frame')
    }),
  )

  // REGRESSION: "pitch outside ±π/2 is not a rotation a player can be in".
  // Letting it through produces an upside-down peer avatar, which nobody files
  // As a protocol bug.
  it.effect('rejects a pitch outside the range a head can actually turn', () =>
    Effect.sync(() => {
      const text = JSON.stringify({
        message: {
          _tag: 'PlayerMove',
          at: { x: 0, y: 0, z: 0 },
          facing: { pitchRadians: 3.2, yawRadians: 0 },
          player: 'alice',
        },
        protocolVersion: PROTOCOL_VERSION,
      })
      expect(rejected(text)?.reason).toBe('malformed-frame')
    }),
  )

  it.effect('rejects an empty player id, so an unidentified peer cannot be addressed', () =>
    Effect.sync(() => {
      const text = JSON.stringify({
        message: { _tag: 'PlayerLeave', player: '' },
        protocolVersion: PROTOCOL_VERSION,
      })
      expect(rejected(text)?.reason).toBe('malformed-frame')
    }),
  )

  it.effect('rejects command actions whose discriminant and payload cannot be executed', () =>
    Effect.sync(() => {
      const invalidActions: ReadonlyArray<unknown> = [
        'select-slot',
        { _tag: 'select-slot' },
        { _tag: 'move-item', count: 0, destination: 1, source: 0 },
        { _tag: 'swap-items', source: 0 },
        { _tag: 'drop-item', count: 1, destination: 1, source: 0 },
        { _tag: 'equip-item', source: 0 },
        { _tag: 'unequip-item', equipmentSlot: 'helmet' },
        { _tag: 'set-time', weather: 'clear' },
        { _tag: 'set-weather', weather: 'snow' },
      ]

      for (const action of invalidActions) {
        const messageTag = typeof action === 'object' && action !== null && '_tag' in action &&
            (action._tag === 'set-time' || action._tag === 'set-weather')
          ? 'WorldTimeWeatherCommand'
          : 'PlayerInventoryCommand'
        const text = JSON.stringify({
          message: { _tag: messageTag, ...commandHeader, action },
          protocolVersion: PROTOCOL_VERSION,
        })
        expect(rejected(text)?.reason).toBe('malformed-frame')
      }
    }),
  )

  it.effect('rejects impossible container and furnace transfer directions', () =>
    Effect.sync(() => {
      const invalidCommands = [
        {
          _tag: 'ContainerCommand',
          ...commandHeader,
          containerId: 'chest:1',
          action: { _tag: 'move-item', count: 1, destination: { _tag: 'player-slot', slot: 1 }, source: { _tag: 'player-slot', slot: 0 } },
        },
        {
          _tag: 'FurnaceCommand',
          ...commandHeader,
          furnaceId: 'furnace:1',
          action: { _tag: 'move-item', count: 1, destination: { _tag: 'player-slot', slot: 1 }, source: { _tag: 'furnace-slot', slot: 'output' } },
        },
        {
          _tag: 'FurnaceCommand',
          ...commandHeader,
          furnaceId: 'furnace:1',
          action: { _tag: 'take-output', count: 1, destination: { _tag: 'player-slot', slot: 1 }, source: { _tag: 'furnace-slot', slot: 'input' } },
        },
      ]

      for (const message of invalidCommands) {
        const text = JSON.stringify({ message, protocolVersion: PROTOCOL_VERSION })
        expect(rejected(text)?.reason).toBe('malformed-frame')
      }
    }),
  )

  it.effect('rejects payload fields from a different action instead of stripping them', () =>
    Effect.sync(() => {
      const text = JSON.stringify({
        message: {
          _tag: 'WorldTimeWeatherCommand',
          ...commandHeader,
          action: { _tag: 'set-time', timeOfDay: 6000, weather: 'rain' },
        },
        protocolVersion: PROTOCOL_VERSION,
      })

      expect(rejected(text)?.reason).toBe('malformed-frame')
    }),
  )

  it.effect('rejects malformed gameplay extension payloads', () =>
    Effect.sync(() => {
      const invalidMessages = [
        { _tag: 'BowUseCommand', ...commandHeader, action: 'draw' },
        { _tag: 'IgniteTntCommand', ...commandHeader, at: { x: 0.5, y: 64, z: 1 } },
          { _tag: 'FishingCommand', ...commandHeader, action: 'wait' },
          { _tag: 'VehicleCommand', ...commandHeader, entityId, action: { _tag: 'move' } },
          { _tag: 'VehicleCommand', ...commandHeader, entityId, action: { _tag: 'move', direction: 'sideways' } },
          { _tag: 'VehicleCommand', ...commandHeader, entityId, action: { _tag: 'move', at: { x: 2, y: 64, z: 2 }, direction: 'forward' } },
          { _tag: 'PlayerFishingDelta', player: alice, revision: 13, state: { phase: 'bite', result: 'cast' }, world: overworld },
        { _tag: 'PlayerInventoryDelta', player: alice, revision: 13, state: { selectedSlot: 0, slots: [{ item: 'bow', count: 1, durability: { current: 1.5, max: 64 } }] }, world: overworld },
      ]

      for (const message of invalidMessages) {
        const text = JSON.stringify({ message, protocolVersion: PROTOCOL_VERSION })
        expect(rejected(text)?.reason).toBe('malformed-frame')
      }
    }),
  )

  // REGRESSION (Wave 1 lowering): anvil, crafting and player-damage each carry
  // a domain-specific invariant `SAMPLES` never violates — an out-of-range
  // slot, a name over the wire limit, a grid whose `cells.length` disagrees
  // with `width * height`, and a damage amount outside the vanilla range. A
  // codec that best-effort-coerced any of these would desync the two peers
  // silently instead of rejecting the frame.
  it.effect('rejects malformed anvil, crafting and player-damage payloads', () =>
    Effect.sync(() => {
      const invalidMessages = [
        { _tag: 'AnvilCommand', ...commandHeader, name: 'Excalibur', slot: -1 },
        { _tag: 'AnvilCommand', ...commandHeader, name: 'Excalibur', slot: 36 },
        { _tag: 'AnvilCommand', ...commandHeader, name: 'x'.repeat(51), slot: 0 },
        { _tag: 'PlayerAnvilNamesDelta', names: [{ name: 'x'.repeat(51), slot: 0 }], player: alice, revision: 13, world: overworld },
        { _tag: 'CraftingCommand', ...commandHeader, grid: { cells: ['stone', null, null], height: 2, width: 2 } },
        { _tag: 'CraftingCommand', ...commandHeader, grid: { cells: ['stone', null, null, null, null], height: 2, width: 2 } },
        { _tag: 'CraftingCommand', ...commandHeader, grid: { cells: [], height: 4, width: 4 } },
        { _tag: 'CraftingCommand', ...commandHeader, grid: { cells: ['', null, null, null], height: 2, width: 2 } },
        { _tag: 'CraftingCommand', ...commandHeader, grid: { cells: ['stone', null, null, null], extra: true, height: 2, width: 2 } },
        { _tag: 'PlayerDamageCommand', ...commandHeader, amount: 0 },
        { _tag: 'PlayerDamageCommand', ...commandHeader, amount: 21 },
        { _tag: 'PlayerDamageCommand', ...commandHeader, amount: 4, minimumHealthPoints: -1 },
        { _tag: 'PlayerDamageCommand', ...commandHeader, amount: 4, minimumHealthPoints: 1.5 },
      ]

      for (const message of invalidMessages) {
        const text = JSON.stringify({ message, protocolVersion: PROTOCOL_VERSION })
        expect(rejected(text)?.reason).toBe('malformed-frame')
      }
    }),
  )

  // REGRESSION (Wave 1 lowering): `BrewingStandState` and `StatusEffectState`
  // are mirrored locally (see `protocol/brewing.ts`'s file header), and a
  // mirror that drifted from what it mirrors would show up exactly here — as
  // a shape this build's own schema silently accepted or wrongly rejected.
  it.effect('rejects malformed brewing and status-effect payloads', () =>
    Effect.sync(() => {
      const invalidMessages = [
        { _tag: 'BrewingCommand', ...commandHeader, action: { _tag: 'insert', slot: 36 }, at: { x: 1, y: 64, z: 1 } },
        { _tag: 'BrewingCommand', ...commandHeader, action: { _tag: 'insert', slot: -1 }, at: { x: 1, y: 64, z: 1 } },
        { _tag: 'BrewingCommand', ...commandHeader, action: { _tag: 'insert', slot: 0, extra: true }, at: { x: 1, y: 64, z: 1 } },
        { _tag: 'BrewingCommand', ...commandHeader, action: { _tag: 'brew' }, at: { x: 1, y: 64, z: 1 } },
        {
          _tag: 'BrewingStandDelta',
          at: { x: 1, y: 64, z: 1 },
          revision: 13,
          state: { bottle: { potion: 'not-a-real-potion' }, fuelUnits: 4 },
          world: overworld,
        },
        {
          _tag: 'BrewingStandDelta',
          at: { x: 1, y: 64, z: 1 },
          revision: 13,
          state: { fuelUnits: -1 },
          world: overworld,
        },
        {
          _tag: 'BrewingStandDelta',
          at: { x: 1, y: 64, z: 1 },
          revision: 13,
          state: { brewing: { output: 'awkward', remainingSecs: -1 }, fuelUnits: 4 },
          world: overworld,
        },
        {
          _tag: 'BrewingStandDelta',
          at: { x: 1, y: 64, z: 1 },
          revision: 13,
          state: { bottle: { potion: 'awkward', extra: true }, fuelUnits: 4 },
          world: overworld,
        },
        {
          _tag: 'PlayerStatusEffectsDelta',
          player: alice,
          revision: 13,
          state: { effects: [{ pulseClockSecs: 0, remainingSecs: 0, type: 'poison' }] },
          world: overworld,
        },
        {
          _tag: 'PlayerStatusEffectsDelta',
          player: alice,
          revision: 13,
          state: { effects: [{ amplifier: -1, pulseClockSecs: 0, remainingSecs: 30, type: 'poison' }] },
          world: overworld,
        },
        {
          _tag: 'PlayerStatusEffectsDelta',
          player: alice,
          revision: 13,
          state: { effects: [{ pulseClockSecs: 0, remainingSecs: 30, type: 'invisibility' }] },
          world: overworld,
        },
      ]

      for (const message of invalidMessages) {
        const text = JSON.stringify({ message, protocolVersion: PROTOCOL_VERSION })
        expect(rejected(text)?.reason).toBe('malformed-frame')
      }
    }),
  )

  // REGRESSION (Wave 1 lowering): `EnchantedItem` is mirrored locally too
  // (`protocol/enchanting.ts`'s file header) — an enchantment level of zero,
  // an unknown enchantment id, or an offer index outside 0..2 must all be
  // rejected, not coerced into whichever offer the decoder found easiest.
  it.effect('rejects malformed enchanting payloads', () =>
    Effect.sync(() => {
      const enchantedItem = { durability: null, enchantments: [{ id: 'sharpness', level: 1 }], item: 'iron_sword' }
      const invalidMessages = [
        { _tag: 'EnchantingCommand', ...commandHeader, offer: 3, slot: 0 },
        { _tag: 'EnchantingCommand', ...commandHeader, offer: 1, slot: -1 },
        { _tag: 'EnchantingCommand', ...commandHeader, offer: 1, slot: 36 },
        {
          _tag: 'PlayerEnchantmentsDelta',
          items: [{ item: { ...enchantedItem, enchantments: [{ id: 'not-a-real-enchantment', level: 1 }] }, slot: 0 }],
          player: alice,
          revision: 13,
          seed: 42,
          world: overworld,
        },
        {
          _tag: 'PlayerEnchantmentsDelta',
          items: [{ item: { ...enchantedItem, enchantments: [{ id: 'sharpness', level: 0 }] }, slot: 0 }],
          player: alice,
          revision: 13,
          seed: 42,
          world: overworld,
        },
        {
          _tag: 'PlayerEnchantmentsDelta',
          items: [{ item: { ...enchantedItem, item: '' }, slot: 0 }],
          player: alice,
          revision: 13,
          seed: 42,
          world: overworld,
        },
        {
          _tag: 'PlayerEnchantmentsDelta',
          items: [{ item: enchantedItem, slot: 0 }],
          player: alice,
          revision: -1,
          seed: 42,
          world: overworld,
        },
      ]

      for (const message of invalidMessages) {
        const text = JSON.stringify({ message, protocolVersion: PROTOCOL_VERSION })
        expect(rejected(text)?.reason).toBe('malformed-frame')
      }
    }),
  )

  // REGRESSION (Wave 1 lowering): the Ender Dragon encounter snapshot mirrors
  // `mx-gameplay`'s structural shape only (see `protocol/ender-dragon.ts`'s
  // file header) — health outside 0..200, an unknown phase, and a negative
  // timer must still all be rejected at the frame boundary.
  it.effect('rejects malformed ender-dragon payloads', () =>
    Effect.sync(() => {
      const snapshot = { health: 200, phase: 'circling', phaseTimerSecs: 0, rewardEmitted: false }
      const invalidMessages = [
        { _tag: 'EnderDragonSnapshotDelta', revision: 13, snapshot: { ...snapshot, health: 201 } },
        { _tag: 'EnderDragonSnapshotDelta', revision: 13, snapshot: { ...snapshot, health: -1 } },
        { _tag: 'EnderDragonSnapshotDelta', revision: 13, snapshot: { ...snapshot, phase: 'flying' } },
        { _tag: 'EnderDragonSnapshotDelta', revision: 13, snapshot: { ...snapshot, phaseTimerSecs: -1 } },
        { _tag: 'EnderDragonSnapshotDelta', revision: 13, snapshot: { ...snapshot, extra: true } },
        { _tag: 'DamageEnderDragonCommandRejected', commandId, reason: 'dragon-defeated', revision: 12 },
      ]

      for (const message of invalidMessages) {
        const text = JSON.stringify({ message, protocolVersion: PROTOCOL_VERSION })
        expect(rejected(text)?.reason).toBe('malformed-frame')
      }
    }),
  )

  // REGRESSION (Wave 1 lowering): the wither runtime snapshot is a mirror of
  // the composing app's `WitherRuntimeSnapshot` (see `protocol/wither.ts`'s
  // file header) — an out-of-range health, an unknown phase, and a negative
  // cooldown must all still be rejected.
  it.effect('rejects malformed wither payloads', () =>
    Effect.sync(() => {
      const witherState = {
        chargeRemainingSecs: 0,
        feetPosition: { x: 0, y: 70, z: 0 },
        healthPoints: 300,
        phase: 'airborne',
        velocity: { x: 0, y: 0, z: 0 },
      }
      const witherEntry = { dimension: 'end', id: 'wither-1', meleeCooldownSecs: 0, rangedCooldownSecs: 0, shotsFired: 0, state: witherState }
      const invalidMessages = [
        { _tag: 'DamageWitherCommand', amount: -1, commandId, expectedRevision: 12, kind: 'melee', player: alice, witherId: 'wither-1' },
        { _tag: 'DamageWitherCommand', amount: 4, commandId, expectedRevision: 12, kind: 'poison', player: alice, witherId: 'wither-1' },
        {
          _tag: 'WitherSnapshotDelta',
          revision: 13,
          snapshot: { nextSkullId: 0, nextWitherId: 1, skulls: [], withers: [{ ...witherEntry, state: { ...witherState, healthPoints: 301 } }] },
        },
        {
          _tag: 'WitherSnapshotDelta',
          revision: 13,
          snapshot: { nextSkullId: 0, nextWitherId: 1, skulls: [], withers: [{ ...witherEntry, state: { ...witherState, phase: 'enraged' } }] },
        },
        {
          _tag: 'WitherSnapshotDelta',
          revision: 13,
          snapshot: { nextSkullId: 0, nextWitherId: 1, skulls: [], withers: [{ ...witherEntry, meleeCooldownSecs: -1 }] },
        },
        {
          _tag: 'WitherSnapshotDelta',
          revision: 13,
          snapshot: { nextSkullId: -1, nextWitherId: 1, skulls: [], withers: [] },
        },
      ]

      for (const message of invalidMessages) {
        const text = JSON.stringify({ message, protocolVersion: PROTOCOL_VERSION })
        expect(rejected(text)?.reason).toBe('malformed-frame')
      }
    }),
  )

  it('applies action-level excess-property rejection with strict parse options', () => {
    expect(() =>
      Schema.decodeUnknownSync(WorldTimeWeatherAction, STRICT_PARSE_OPTIONS)({
        _tag: 'set-time',
        timeOfDay: 6_000,
        weather: 'rain',
      }),
    ).toThrow()
  })

  it('rejects client-selected portal transfer state with strict parse options', () => {
    expect(() =>
      Schema.decodeUnknownSync(EndPortalUseCommand, STRICT_PARSE_OPTIONS)({
        ...SAMPLES.EndPortalUseCommand,
        destinationWorld: end,
      }),
    ).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(NetherPortalUseCommand, STRICT_PARSE_OPTIONS)({
        ...SAMPLES.NetherPortalUseCommand,
        destinationWorld: end,
      }),
    ).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(RealmTransferSnapshot, STRICT_PARSE_OPTIONS)({
        ...SAMPLES.RealmTransferSnapshot,
        spawn: { x: 0, y: 64, z: 0 },
      }),
    ).toThrow()
  })

  // A block name this build does not know must still DECODE: rejecting it here
  // Would turn "your client is older than mine" into a parse error. Deciding
  // What to do with an unknown block is mc-sim's, not the protocol's.
  it.effect('accepts a block name this build does not know, because content skew is not frame corruption', () =>
    Effect.sync(() => {
      const text = JSON.stringify({
        message: { _tag: 'BlockPlace', at: { x: 0, y: 0, z: 0 }, block: 'unobtainium', player: 'alice' },
        protocolVersion: PROTOCOL_VERSION,
      })
      expect(Result.isSuccess(decodeFrame(text))).toBe(true)
    }),
  )
})


describe('codec properties', () => {
  it.effect('returns a typed result without throwing for arbitrary byte sequences', () =>
    Effect.sync(() => {
      fc.assert(fc.property(fc.uint8Array(), (bytes) => {
        const text = Buffer.from(bytes).toString('utf8')
        const decoded = decodeFrame(text, EMPTY_OWNER_REGISTRY)
        if (Result.isFailure(decoded)) {
          return true
        }

        return Result.isSuccess(
          Schema.decodeUnknownResult(NetworkMessage, STRICT_PARSE_OPTIONS)(decoded.success),
        )
      }))
    }),
  )

  it.effect('accepts only values that the public message schema validates and never throws on arbitrary text', () =>
    Effect.sync(() => {
      fc.assert(fc.property(fc.string(), (text) => {
        const decoded = decodeFrame(text, EMPTY_OWNER_REGISTRY)
        if (Result.isFailure(decoded)) {
          return true
        }

        return Result.isSuccess(
          Schema.decodeUnknownResult(NetworkMessage, STRICT_PARSE_OPTIONS)(decoded.success),
        )
      }))
    }),
  )

  it.effect('preserves the encode/decode identity for arbitrary valid ping messages', () =>
    Effect.sync(() => {
      fc.assert(fc.property(fc.integer(), (nonce) => {
        const message = { _tag: 'Ping' as const, nonce }
        const encodeResult = encodeFrame(message, EMPTY_OWNER_REGISTRY)
        if (Result.isFailure(encodeResult)) {
          return false
        }

        const decoded = decodeFrame(encodeResult.success, EMPTY_OWNER_REGISTRY)
        if (Result.isFailure(decoded)) {
          return false
        }

        expect(decoded.success).toStrictEqual(message)
        return true
      }))
    }),
  )

  it.effect('refuses arbitrary JSON payloads with a typed result and never throws', () =>
    Effect.sync(() => {
      fc.assert(fc.property(fc.jsonValue(), (message) => {
        const text = JSON.stringify({ message, protocolVersion: PROTOCOL_VERSION })
        const decoded = decodeFrame(text, EMPTY_OWNER_REGISTRY)
        if (Result.isFailure(decoded)) {
          return true
        }

        return Result.isSuccess(
          Schema.decodeUnknownResult(NetworkMessage, STRICT_PARSE_OPTIONS)(decoded.success),
        )
      }))
    }),
  )
})

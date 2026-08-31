import { describe, expect, it } from '@effect/vitest'
import { Effect, Either, Option, Schema } from 'effect'
import { decodeFrame, encodeFrame, encodeFrameAsVersion } from '../src/domain/codec'
import type { ProtocolError } from '../src/domain/errors'
import {
  CommandId,
  EndPortalUseCommand,
  EntityId,
  MESSAGE_TAGS,
  NetherPortalUseCommand,
  type NetworkMessage,
  PROTOCOL_VERSION,
  PlayerId,
  PlayerName,
  RealmTransferSnapshot,
  WorldId,
  WorldTimeWeatherAction,
} from '../src/domain/protocol'

const alice = PlayerId.make('alice')
const overworld = WorldId.make('overworld')
const end = WorldId.make('end')
const commandId = CommandId.make('command-1')
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

/**
 * One sample per message tag. `SAMPLES` is keyed by tag so that the
 * exhaustiveness test below can prove no message escapes the round-trip check.
 */
const SAMPLES: { readonly [Tag in NetworkMessage['_tag']]: Extract<NetworkMessage, { _tag: Tag }> } = {
  AnvilCommand: { _tag: 'AnvilCommand', ...commandHeader, name: 'Excalibur', slot: 0 },
  AnvilCommandAccepted: { _tag: 'AnvilCommandAccepted', commandId, revision: 13 },
  AnvilCommandRejected: { _tag: 'AnvilCommandRejected', commandId, reason: 'missing-iron', revision: 12 },
  AuthoritativeCommandAccepted: { _tag: 'AuthoritativeCommandAccepted', commandId, revision: 13, world: overworld },
  AuthoritativeCommandRejected: { _tag: 'AuthoritativeCommandRejected', commandId, reason: 'stale-revision', resyncRequired: true, revision: 12, world: overworld },
  AuthoritativeResyncRequest: { _tag: 'AuthoritativeResyncRequest', lastKnownRevision: 12, world: overworld },
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

const encoded = (message: NetworkMessage): string => Either.getOrThrow(encodeFrame(message))

/** The ProtocolError a decode produced, or undefined if it succeeded. */
const failure = (result: Either.Either<unknown, ProtocolError>): ProtocolError | undefined =>
  Option.getOrUndefined(Either.getLeft(result))

describe('frame round trip', () => {
  // REGRESSION: "every message survives encode -> text -> decode unchanged".
  // This is the whole contract of the repository. A protocol change that breaks
  // It is only observable at the far end of a socket, where the frame is gone.
  it.effect('every message decodes back to a value strictly equal to the one encoded', () =>
    Effect.sync(() => {
      for (const tag of MESSAGE_TAGS) {
        const original = SAMPLES[tag]
        const result = decodeFrame(encoded(original))
        expect(Either.isRight(result), `${tag} failed to decode`).toBe(true)
        expect(Either.getOrThrow(result)).toStrictEqual(original)
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
      expect(Either.getOrThrow(moved)).toStrictEqual(SAMPLES.PlayerMove)
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
        expect(Either.getOrThrow(decodeFrame(encoded(message)))).toStrictEqual(message)
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

      expect(Either.isRight(decodeFrame(legacySnapshot))).toBe(true)
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
        expect(Either.getOrThrow(decodeFrame(encoded(original)))).toStrictEqual(original)
      }
    }),
  )

  it.effect('preserves non-ASCII chat text', () =>
    Effect.sync(() => {
      const chat = decodeFrame(encoded(SAMPLES.Chat))
      expect(Either.getOrThrow(chat)).toStrictEqual(SAMPLES.Chat)
    }),
  )
})

describe('protocol version', () => {
  // REGRESSION: "a rolling upgrade is distinguishable from corruption".
  // The reference implementation had no version field, so a peer on an older
  // Build produced decode failures indistinguishable from a damaged frame.
  it.effect('rejects a frame from a version this build does not speak, and says so specifically', () =>
    Effect.sync(() => {
      const fromTheFuture = Either.getOrThrow(encodeFrameAsVersion(PROTOCOL_VERSION + 1, SAMPLES.Ping))
      const result = decodeFrame(fromTheFuture)

      expect(Either.isLeft(result)).toBe(true)
      const error = failure(result)
      expect(error?._tag).toBe('ProtocolError')
      expect(error?.reason).toBe('unsupported-protocol-version')
      expect(error?.detail).toContain(String(PROTOCOL_VERSION + 1))
    }),
  )

  it.effect('reports a version mismatch as a version problem, never as a malformed frame', () =>
    Effect.sync(() => {
      const older = Either.getOrThrow(encodeFrameAsVersion(0, SAMPLES.PlayerLeave))
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
})

describe('malformed input', () => {
  const rejected = (text: string) => failure(decodeFrame(text))

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

  it('applies action-level excess-property rejection without decoder options', () => {
    expect(() =>
      Schema.decodeUnknownSync(WorldTimeWeatherAction)({
        _tag: 'set-time',
        timeOfDay: 6_000,
        weather: 'rain',
      }),
    ).toThrow()
  })

  it('rejects client-selected portal transfer state without decoder options', () => {
    expect(() =>
      Schema.decodeUnknownSync(EndPortalUseCommand)({
        ...SAMPLES.EndPortalUseCommand,
        destinationWorld: end,
      }),
    ).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(NetherPortalUseCommand)({
        ...SAMPLES.NetherPortalUseCommand,
        destinationWorld: end,
      }),
    ).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(RealmTransferSnapshot)({
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
      expect(Either.isRight(decodeFrame(text))).toBe(true)
    }),
  )
})

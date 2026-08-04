import { describe, expect, it } from '@effect/vitest'
import { Effect, Either, Option, Schema } from 'effect'
import { decodeFrame, encodeFrame, encodeFrameAsVersion } from '../src/domain/codec'
import type { ProtocolError } from '../src/domain/errors'
import {
  MESSAGE_TAGS,
  PROTOCOL_VERSION,
  CommandId,
  EntityId,
  PlayerId,
  PlayerName,
  WorldTimeWeatherAction,
  WorldId,
  type NetworkMessage,
} from '../src/domain/protocol'

const alice = PlayerId.make('alice')
const overworld = WorldId.make('overworld')
const commandId = CommandId.make('command-1')
const commandHeader = { commandId, player: alice, world: overworld, expectedRevision: 12 }
const item = { item: 'stone', count: 2, durability: { current: 63, max: 64 } }
const entityId = EntityId.make('entity-1')
const living = {
  _tag: 'living' as const,
  entityId,
  entityType: 'zombie',
  at: { x: 1, y: 64, z: 1 },
  health: 20,
  maxHealth: 20,
  mobState: { attackCooldownSecs: 0, motionPhase: 0.5, provoked: false, persistent: true },
}
const itemDrop = { _tag: 'item-drop' as const, entityId: EntityId.make('drop-1'), at: { x: 2, y: 64, z: 1 }, stack: item, ageTicks: 1 }
const arrow = { _tag: 'arrow' as const, entityId: EntityId.make('arrow-1'), at: { x: 2, y: 65, z: 1 }, velocity: { x: 0, y: 0.1, z: 1 }, damage: 4, owner: alice, ageTicks: 2 }
const primedTnt = { _tag: 'primed-tnt' as const, entityId: EntityId.make('tnt-1'), at: { x: 3, y: 64, z: 1 }, burnedSecs: 1.5, owner: alice }

/**
 * One sample per message tag. `SAMPLES` is keyed by tag so that the
 * exhaustiveness test below can prove no message escapes the round-trip check.
 */
const SAMPLES: { readonly [Tag in NetworkMessage['_tag']]: Extract<NetworkMessage, { _tag: Tag }> } = {
  PlayerJoin: {
    _tag: 'PlayerJoin',
    player: alice,
    name: PlayerName.make('Alice'),
    at: { x: 8.5, y: 65, z: -12.25 },
  },
  PlayerLeave: { _tag: 'PlayerLeave', player: alice },
  PlayerMove: {
    _tag: 'PlayerMove',
    player: alice,
    at: { x: -0.5, y: 64.125, z: 1024 },
    facing: { yawRadians: 3.14159, pitchRadians: -1.5 },
  },
  BlockPlace: { _tag: 'BlockPlace', player: alice, at: { x: 1, y: 2, z: 3 }, block: 'stone' },
  BlockBreak: { _tag: 'BlockBreak', player: alice, at: { x: -1, y: 0, z: -3 } },
  Chat: { _tag: 'Chat', player: alice, text: 'hello 世界' },
  WorldInfo: { _tag: 'WorldInfo', world: overworld, seed: -1_234_567 },
  WorldSnapshot: {
    _tag: 'WorldSnapshot',
    world: overworld,
    seed: -1_234_567,
    revision: 12,
    players: [
      {
        player: alice,
        name: PlayerName.make('Alice'),
        world: overworld,
        at: { x: 8.5, y: 65, z: -12.25 },
        facing: { yawRadians: 3.14159, pitchRadians: -1.5 },
      },
    ],
    blocks: [
      { world: overworld, at: { x: 1, y: 2, z: 3 }, block: 'stone' },
      { world: overworld, at: { x: -1, y: 0, z: -3 }, block: null },
    ],
  },
  BlockMutationRejected: {
    _tag: 'BlockMutationRejected',
    player: alice,
    world: overworld,
    at: { x: 1, y: 2, z: 3 },
    operation: 'place',
    reason: 'occupied',
    revision: 12,
  },
  AuthoritativeSnapshot: {
    _tag: 'AuthoritativeSnapshot', world: overworld, revision: 12,
    inventories: [{ player: alice, state: { slots: [item], selectedSlot: 0 } }],
    vitals: [{ player: alice, state: { health: 20, hunger: 20, experience: 1 } }],
    timeWeather: { timeOfDay: 6000, weather: 'clear' }, containers: [], furnaces: [], villagerTrades: [], entities: [living, itemDrop, arrow, primedTnt],
  },
  PlayerInventoryDelta: { _tag: 'PlayerInventoryDelta', world: overworld, revision: 13, player: alice, state: { slots: [item], selectedSlot: 0 } },
  PlayerVitalsDelta: { _tag: 'PlayerVitalsDelta', world: overworld, revision: 13, player: alice, state: { health: 19, hunger: 18, experience: 1 } },
  PlayerFishingDelta: { _tag: 'PlayerFishingDelta', world: overworld, revision: 13, player: alice, state: { phase: 'bite', result: 'bite' } },
  WorldTimeWeatherDelta: { _tag: 'WorldTimeWeatherDelta', world: overworld, revision: 13, state: { timeOfDay: 7000, weather: 'rain' } },
  ContainerDelta: { _tag: 'ContainerDelta', world: overworld, revision: 13, state: { containerId: 'chest:1', kind: 'chest', slots: [item] } },
  FurnaceDelta: { _tag: 'FurnaceDelta', world: overworld, revision: 13, state: { furnaceId: 'furnace:1', input: item, fuel: null, output: null, burnTicksRemaining: 10, cookTicks: 5 } },
  VillagerTradeDelta: { _tag: 'VillagerTradeDelta', world: overworld, revision: 13, state: { villagerId: 'villager:1', offers: [{ offerId: 'offer:1', input: [item], output: { item: 'emerald', count: 1 }, uses: 0, maxUses: 4 }] } },
  EntitySpawnDelta: { _tag: 'EntitySpawnDelta', world: overworld, revision: 13, entity: living },
  EntityUpdateDelta: { _tag: 'EntityUpdateDelta', world: overworld, revision: 13, entity: { ...living, health: 19 } },
  EntityDespawnDelta: { _tag: 'EntityDespawnDelta', world: overworld, revision: 13, entityId },
  PlayerInventoryCommand: { _tag: 'PlayerInventoryCommand', ...commandHeader, action: { _tag: 'select-slot', slot: 2 } },
  PlayerVitalsCommand: { _tag: 'PlayerVitalsCommand', ...commandHeader, action: { _tag: 'activity', activity: 'swim', amount: 3 } },
  WorldTimeWeatherCommand: { _tag: 'WorldTimeWeatherCommand', ...commandHeader, action: { _tag: 'set-time', timeOfDay: 6000 } },
  ContainerCommand: { _tag: 'ContainerCommand', ...commandHeader, containerId: 'chest:1', action: { _tag: 'open' } },
  FurnaceCommand: { _tag: 'FurnaceCommand', ...commandHeader, furnaceId: 'furnace:1', action: { _tag: 'take-output', source: { _tag: 'furnace-slot', slot: 'output' }, destination: { _tag: 'player-slot', slot: 3 }, count: 1 } },
  VillagerTradeCommand: { _tag: 'VillagerTradeCommand', ...commandHeader, villagerId: 'villager:1', offerId: 'offer:1', action: 'execute-trade' },
  EntityAttackCommand: { _tag: 'EntityAttackCommand', ...commandHeader, entityId },
  EntityPickupCommand: { _tag: 'EntityPickupCommand', ...commandHeader, entityId },
  BowUseCommand: { _tag: 'BowUseCommand', ...commandHeader, action: 'release' },
  IgniteTntCommand: { _tag: 'IgniteTntCommand', ...commandHeader, at: { x: 1, y: 64, z: 1 } },
  EnderPearlCommand: { _tag: 'EnderPearlCommand', ...commandHeader },
  BucketUseCommand: { _tag: 'BucketUseCommand', ...commandHeader },
  VehicleUseCommand: { _tag: 'VehicleUseCommand', ...commandHeader },
  FishingCommand: { _tag: 'FishingCommand', ...commandHeader, action: 'cast' },
  VehicleCommand: { _tag: 'VehicleCommand', ...commandHeader, entityId, action: { _tag: 'move', direction: 'forward' } },
  AuthoritativeCommandAccepted: { _tag: 'AuthoritativeCommandAccepted', commandId, world: overworld, revision: 13 },
  AuthoritativeCommandRejected: { _tag: 'AuthoritativeCommandRejected', commandId, world: overworld, revision: 12, reason: 'stale-revision', resyncRequired: true },
  AuthoritativeResyncRequest: { _tag: 'AuthoritativeResyncRequest', world: overworld, lastKnownRevision: 12 },
  Ping: { _tag: 'Ping', nonce: 7 },
  Pong: { _tag: 'Pong', nonce: 7 },
}

const encoded = (message: NetworkMessage): string => Either.getOrThrow(encodeFrame(message))

/** The ProtocolError a decode produced, or undefined if it succeeded. */
const failure = (result: Either.Either<unknown, ProtocolError>): ProtocolError | undefined =>
  Option.getOrUndefined(Either.getLeft(result))

describe('frame round trip', () => {
  // REGRESSION: "every message survives encode -> text -> decode unchanged".
  // This is the whole contract of the repository. A protocol change that breaks
  // it is only observable at the far end of a socket, where the frame is gone.
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
  // stops covering the new case.
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
        protocolVersion: PROTOCOL_VERSION,
        message: { _tag: 'Ping', nonce: 7 },
      })
    }),
  )

  // REGRESSION: "fractional coordinates survive". The reference implementation
  // carries positions as finite doubles; a codec that rounded, or that went
  // through a fixed-point integer encoding, would show up as peer avatars
  // snapping to the block grid rather than as a test failure.
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
        protocolVersion: PROTOCOL_VERSION,
        message: {
          _tag: 'AuthoritativeSnapshot',
          world: overworld,
          revision: 12,
          inventories: [{ player: alice, state: { slots: [{ item: 'stone', count: 2 }], selectedSlot: 0 } }],
          vitals: [{ player: alice, state: { health: 20, hunger: 20, experience: 1 } }],
          timeWeather: { timeOfDay: 6000, weather: 'clear' },
          containers: [],
          furnaces: [],
          villagerTrades: [],
          entities: [{ _tag: 'living', entityId, entityType: 'zombie', at: { x: 1, y: 64, z: 1 }, health: 20, maxHealth: 20 }],
        },
      })

      expect(Either.isRight(decodeFrame(legacySnapshot))).toBe(true)
    }),
  )

  it.effect('preserves executable payloads for every authoritative operation', () =>
    Effect.sync(() => {
      const commands: ReadonlyArray<NetworkMessage> = [
        { _tag: 'PlayerInventoryCommand', ...commandHeader, action: { _tag: 'select-slot', slot: 4 } },
          { _tag: 'PlayerInventoryCommand', ...commandHeader, action: { _tag: 'move-item', source: 1, destination: 7, count: 2 } },
          { _tag: 'PlayerInventoryCommand', ...commandHeader, action: { _tag: 'drop-item', source: 7, destination: 'world', count: 1 } },
          { _tag: 'PlayerInventoryCommand', ...commandHeader, action: { _tag: 'swap-items', source: 1, destination: 7 } },
        { _tag: 'PlayerInventoryCommand', ...commandHeader, action: { _tag: 'equip-item', source: 1, equipmentSlot: 'head' } },
        { _tag: 'PlayerInventoryCommand', ...commandHeader, action: { _tag: 'unequip-item', equipmentSlot: 'head', destination: 7 } },
        { _tag: 'WorldTimeWeatherCommand', ...commandHeader, action: { _tag: 'set-time', timeOfDay: 18_000 } },
        { _tag: 'WorldTimeWeatherCommand', ...commandHeader, action: { _tag: 'set-weather', weather: 'thunder' } },
        { _tag: 'ContainerCommand', ...commandHeader, containerId: 'chest:1', action: { _tag: 'move-item', source: { _tag: 'player-slot', slot: 1 }, destination: { _tag: 'container-slot', slot: 5 }, count: 2 } },
        { _tag: 'ContainerCommand', ...commandHeader, containerId: 'chest:1', action: { _tag: 'move-item', source: { _tag: 'container-slot', slot: 5 }, destination: { _tag: 'player-slot', slot: 1 }, count: 1 } },
        { _tag: 'FurnaceCommand', ...commandHeader, furnaceId: 'furnace:1', action: { _tag: 'move-item', source: { _tag: 'player-slot', slot: 1 }, destination: { _tag: 'furnace-slot', slot: 'input' }, count: 2 } },
          { _tag: 'FurnaceCommand', ...commandHeader, furnaceId: 'furnace:1', action: { _tag: 'move-item', source: { _tag: 'furnace-slot', slot: 'fuel' }, destination: { _tag: 'player-slot', slot: 1 }, count: 1 } },
          { _tag: 'FurnaceCommand', ...commandHeader, furnaceId: 'furnace:1', action: { _tag: 'take-output', source: { _tag: 'furnace-slot', slot: 'output' }, destination: { _tag: 'player-slot', slot: 1 }, count: 1 } },
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
  // build produced decode failures indistinguishable from a damaged frame.
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
  // case". A union that fell back to a default would apply a peer's message as
  // the wrong action.
  it.effect('rejects a message tag this build does not know instead of guessing', () =>
    Effect.sync(() => {
      const text = JSON.stringify({
        protocolVersion: PROTOCOL_VERSION,
        message: { _tag: 'DetonateEverything', player: 'alice' },
      })
      expect(rejected(text)?.reason).toBe('malformed-frame')
    }),
  )

  // REGRESSION: "JSON.stringify(NaN) === 'null'". This is why every coordinate
  // carries `finite()`: without the refinement a NaN produced by a division by
  // zero on the sender becomes a decode failure on the RECEIVER, where the
  // originating code is no longer visible.
  it.effect('rejects a coordinate that arrived as null, which is what a NaN turns into over JSON', () =>
    Effect.sync(() => {
      const text = JSON.stringify({
        protocolVersion: PROTOCOL_VERSION,
        message: { _tag: 'PlayerMove', player: 'alice', at: { x: null, y: 1, z: 2 }, facing: { yawRadians: 0, pitchRadians: 0 } },
      })
      expect(rejected(text)?.reason).toBe('malformed-frame')
    }),
  )

  it.effect('rejects a non-integral block coordinate', () =>
    Effect.sync(() => {
      const text = JSON.stringify({
        protocolVersion: PROTOCOL_VERSION,
        message: { _tag: 'BlockBreak', player: 'alice', at: { x: 0.5, y: 1, z: 2 } },
      })
      expect(rejected(text)?.reason).toBe('malformed-frame')
    }),
  )

  it.effect('rejects negative or fractional authoritative revisions', () =>
    Effect.sync(() => {
      for (const revision of [-1, 0.5]) {
        const text = JSON.stringify({
          protocolVersion: PROTOCOL_VERSION,
          message: {
            _tag: 'WorldSnapshot',
            world: 'overworld',
            seed: 1,
            revision,
            players: [],
            blocks: [],
          },
        })
        expect(rejected(text)?.reason).toBe('malformed-frame')
      }
    }),
  )

  it.effect('rejects malformed snapshot members and unknown rejection reasons', () =>
    Effect.sync(() => {
      const malformedPlayer = JSON.stringify({
        protocolVersion: PROTOCOL_VERSION,
        message: {
          _tag: 'WorldSnapshot',
          world: 'overworld',
          seed: 1,
          revision: 0,
          players: [{ player: 'alice', name: '', at: { x: 0, y: 0, z: 0 }, facing: { yawRadians: 0, pitchRadians: 0 } }],
          blocks: [],
        },
      })
      const unknownReason = JSON.stringify({
        protocolVersion: PROTOCOL_VERSION,
        message: {
          _tag: 'BlockMutationRejected',
          player: 'alice',
          world: 'overworld',
          at: { x: 0, y: 0, z: 0 },
          operation: 'break',
          reason: 'because-i-said-so',
          revision: 0,
        },
      })
      const missingContainerKind = JSON.stringify({
        protocolVersion: PROTOCOL_VERSION,
        message: {
          _tag: 'ContainerDelta',
          world: 'overworld',
          revision: 0,
          state: { containerId: 'chest:1', slots: [] },
        },
      })

      expect(rejected(malformedPlayer)?.reason).toBe('malformed-frame')
      expect(rejected(unknownReason)?.reason).toBe('malformed-frame')
      expect(rejected(missingContainerKind)?.reason).toBe('malformed-frame')
    }),
  )

  // REGRESSION: "pitch outside ±π/2 is not a rotation a player can be in".
  // Letting it through produces an upside-down peer avatar, which nobody files
  // as a protocol bug.
  it.effect('rejects a pitch outside the range a head can actually turn', () =>
    Effect.sync(() => {
      const text = JSON.stringify({
        protocolVersion: PROTOCOL_VERSION,
        message: {
          _tag: 'PlayerMove',
          player: 'alice',
          at: { x: 0, y: 0, z: 0 },
          facing: { yawRadians: 0, pitchRadians: 3.2 },
        },
      })
      expect(rejected(text)?.reason).toBe('malformed-frame')
    }),
  )

  it.effect('rejects an empty player id, so an unidentified peer cannot be addressed', () =>
    Effect.sync(() => {
      const text = JSON.stringify({
        protocolVersion: PROTOCOL_VERSION,
        message: { _tag: 'PlayerLeave', player: '' },
      })
      expect(rejected(text)?.reason).toBe('malformed-frame')
    }),
  )

  it.effect('rejects command actions whose discriminant and payload cannot be executed', () =>
    Effect.sync(() => {
      const invalidActions: ReadonlyArray<unknown> = [
        'select-slot',
        { _tag: 'select-slot' },
        { _tag: 'move-item', source: 0, destination: 1, count: 0 },
          { _tag: 'drop-item', source: 0, destination: 1, count: 1 },
          { _tag: 'swap-items', source: 0 },
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
          protocolVersion: PROTOCOL_VERSION,
          message: { _tag: messageTag, ...commandHeader, action },
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
          action: { _tag: 'move-item', source: { _tag: 'player-slot', slot: 0 }, destination: { _tag: 'player-slot', slot: 1 }, count: 1 },
        },
        {
          _tag: 'FurnaceCommand',
          ...commandHeader,
          furnaceId: 'furnace:1',
          action: { _tag: 'move-item', source: { _tag: 'furnace-slot', slot: 'output' }, destination: { _tag: 'player-slot', slot: 1 }, count: 1 },
        },
        {
          _tag: 'FurnaceCommand',
          ...commandHeader,
          furnaceId: 'furnace:1',
          action: { _tag: 'take-output', source: { _tag: 'furnace-slot', slot: 'input' }, destination: { _tag: 'player-slot', slot: 1 }, count: 1 },
        },
      ]

      for (const message of invalidCommands) {
        const text = JSON.stringify({ protocolVersion: PROTOCOL_VERSION, message })
        expect(rejected(text)?.reason).toBe('malformed-frame')
      }
    }),
  )

  it.effect('rejects payload fields from a different action instead of stripping them', () =>
    Effect.sync(() => {
      const text = JSON.stringify({
        protocolVersion: PROTOCOL_VERSION,
        message: {
          _tag: 'WorldTimeWeatherCommand',
          ...commandHeader,
          action: { _tag: 'set-time', timeOfDay: 6000, weather: 'rain' },
        },
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
          { _tag: 'VehicleCommand', ...commandHeader, entityId, action: { _tag: 'move', direction: 'forward', at: { x: 2, y: 64, z: 2 } } },
          { _tag: 'PlayerFishingDelta', world: overworld, revision: 13, player: alice, state: { phase: 'bite', result: 'cast' } },
        { _tag: 'PlayerInventoryDelta', world: overworld, revision: 13, player: alice, state: { slots: [{ item: 'bow', count: 1, durability: { current: 1.5, max: 64 } }], selectedSlot: 0 } },
      ]

      for (const message of invalidMessages) {
        const text = JSON.stringify({ protocolVersion: PROTOCOL_VERSION, message })
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

  // A block name this build does not know must still DECODE: rejecting it here
  // would turn "your client is older than mine" into a parse error. Deciding
  // what to do with an unknown block is mc-sim's, not the protocol's.
  it.effect('accepts a block name this build does not know, because content skew is not frame corruption', () =>
    Effect.sync(() => {
      const text = JSON.stringify({
        protocolVersion: PROTOCOL_VERSION,
        message: { _tag: 'BlockPlace', player: 'alice', at: { x: 0, y: 0, z: 0 }, block: 'unobtainium' },
      })
      expect(Either.isRight(decodeFrame(text))).toBe(true)
    }),
  )
})

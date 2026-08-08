/**
 * The wire protocol: the set of messages two peers may exchange, and nothing
 * else.
 *
 * ---------------------------------------------------------------------------
 * Scope
 * ---------------------------------------------------------------------------
 *
 * plan.md §3.14: this repository is "limited to transport and protocol". The
 * reference implementation's main-menu flow and multiplayer screens
 * (`packages/presentation/multiplayer`) belong to mx-ui. Nothing here renders,
 * and nothing here decides game rules — a `BlockBreak` message says a peer
 * claims a block broke, it does not say what drops.
 *
 * ---------------------------------------------------------------------------
 * Why the payload types are re-declared here instead of imported from kernel
 * ---------------------------------------------------------------------------
 *
 * `Vec3` and `BlockPos` below deliberately resemble `@nerima-games/mc-kernel`
 * value types but are not imported from them. A wire format and a domain type
 * have different change budgets: kernel values may be refactored without
 * changing the protocol, while wire changes require a version transition.
 * Keeping their schemas separate makes those two events explicit.
 */
import { Schema } from 'effect'

/**
 * The protocol version this build speaks.
 *
 * A frame carrying any other value is rejected as
 * `unsupported-protocol-version` rather than being best-effort parsed. See
 * `docs/design-notes.md` — the reference implementation had no version field at
 * all, which makes a rolling upgrade indistinguishable from corruption.
 */
export const PROTOCOL_VERSION = 8

/** The floor every branded/free-text identifier and content string in this protocol shares: not blank. */
const MIN_NON_EMPTY_LENGTH = 1

// ---------------------------------------------------------------------------
// Identifiers and payload shapes
// ---------------------------------------------------------------------------

/** A peer's stable identity for the lifetime of a session. */
export const PlayerId = Schema.String.pipe(Schema.minLength(MIN_NON_EMPTY_LENGTH), Schema.brand('PlayerId'))
export type PlayerId = typeof PlayerId.Type

/** A peer's display name. Not unique, not an identity — never key on it. */
export const PlayerName = Schema.String.pipe(Schema.minLength(MIN_NON_EMPTY_LENGTH), Schema.brand('PlayerName'))
export type PlayerName = typeof PlayerName.Type

/** Identifies which world a session is playing. */
export const WorldId = Schema.String.pipe(Schema.minLength(MIN_NON_EMPTY_LENGTH), Schema.brand('WorldId'))
export type WorldId = typeof WorldId.Type

/** Stable client-generated identity used to make command retries idempotent. */
export const CommandId = Schema.String.pipe(Schema.minLength(MIN_NON_EMPTY_LENGTH), Schema.brand('CommandId'))
export type CommandId = typeof CommandId.Type

/** Stable identity of a server-owned world entity. */
export const EntityId = Schema.String.pipe(Schema.minLength(MIN_NON_EMPTY_LENGTH), Schema.brand('EntityId'))
export type EntityId = typeof EntityId.Type

export const Revision = Schema.Number.pipe(Schema.int(), Schema.nonNegative())
export type Revision = typeof Revision.Type

/**
 * A continuous position. `finite()` is load-bearing: `JSON.stringify(NaN)` is
 * the literal `null`, so an unconstrained number silently becomes a decode
 * failure at the far end instead of a rejected send at the near end.
 */
export const Vec3 = Schema.Struct({
  x: Schema.Number.pipe(Schema.finite()),
  y: Schema.Number.pipe(Schema.finite()),
  z: Schema.Number.pipe(Schema.finite()),
})
export type Vec3 = typeof Vec3.Type

/** A block-grid position. Integral by construction. */
export const BlockPos = Schema.Struct({
  x: Schema.Number.pipe(Schema.int()),
  y: Schema.Number.pipe(Schema.int()),
  z: Schema.Number.pipe(Schema.int()),
})
export type BlockPos = typeof BlockPos.Type

const HALF_TURN_DIVISOR = 2

/** A quarter turn, in radians (half of `Math.PI`). Pitch's legal range (see `Orientation` below). */
const QUARTER_TURN_RADIANS = Math.PI / HALF_TURN_DIVISOR

/**
 * Look direction. Radians, matching kernel's `CameraPoseSnapshot`; pitch is
 * clamped to ±π/2 because a value outside that range is not a rotation a
 * player can be in, and letting it through produces a peer avatar that is
 * upside down rather than an error anyone can find.
 */
export const Orientation = Schema.Struct({
  pitchRadians: Schema.Number.pipe(Schema.between(-QUARTER_TURN_RADIANS, QUARTER_TURN_RADIANS)),
  yawRadians: Schema.Number.pipe(Schema.finite()),
})
export type Orientation = typeof Orientation.Type

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export const PlayerJoin = Schema.TaggedStruct('PlayerJoin', {
  at: Vec3,
  name: PlayerName,
  player: PlayerId,
})
export type PlayerJoin = typeof PlayerJoin.Type

export const PlayerLeave = Schema.TaggedStruct('PlayerLeave', {
  player: PlayerId,
})
export type PlayerLeave = typeof PlayerLeave.Type

export const PlayerMove = Schema.TaggedStruct('PlayerMove', {
  at: Vec3,
  facing: Orientation,
  player: PlayerId,
  /** Optional for protocol-v1 peers; authoritative servers should include it. */
  world: Schema.optional(WorldId),
})
export type PlayerMove = typeof PlayerMove.Type

export const BlockPlace = Schema.TaggedStruct('BlockPlace', {
  at: BlockPos,
  /**
   * A block type name, kept as an opaque non-empty string on the wire.
   *
   * It is NOT typed as kernel's `BlockType` literal union on purpose: a peer
   * running a build that knows a block this one does not must produce a
   * decodable frame that this build can then reject as unknown *content*, not
   * a malformed *frame*. Making the wire type the literal union would turn
   * "your client is older than mine" into a parse error.
   */
  block: Schema.String.pipe(Schema.minLength(MIN_NON_EMPTY_LENGTH)),
  player: PlayerId,
  /** Optional for protocol-v1 peers; authoritative servers should include it. */
  world: Schema.optional(WorldId),
})
export type BlockPlace = typeof BlockPlace.Type

export const BlockBreak = Schema.TaggedStruct('BlockBreak', {
  at: BlockPos,
  player: PlayerId,
  /** Optional for protocol-v1 peers; authoritative servers should include it. */
  world: Schema.optional(WorldId),
})
export type BlockBreak = typeof BlockBreak.Type

/** A chat message longer than this is rejected rather than truncated, so the sender knows to resend. */
const MAX_CHAT_TEXT_LENGTH = 256

export const Chat = Schema.TaggedStruct('Chat', {
  player: PlayerId,
  text: Schema.String.pipe(Schema.minLength(MIN_NON_EMPTY_LENGTH), Schema.maxLength(MAX_CHAT_TEXT_LENGTH)),
})
export type Chat = typeof Chat.Type

export const WorldInfo = Schema.TaggedStruct('WorldInfo', {
  /** Integral so that a seed survives a JSON round trip exactly. */
  seed: Schema.Number.pipe(Schema.int()),
  world: WorldId,
})
export type WorldInfo = typeof WorldInfo.Type

/** A player as observed in an authoritative world snapshot. */
export const PlayerSnapshot = Schema.Struct({
  at: Vec3,
  facing: Orientation,
  name: PlayerName,
  player: PlayerId,
  world: WorldId,
})
export type PlayerSnapshot = typeof PlayerSnapshot.Type

/**
 * The latest authoritative value of one block position.
 *
 * `null` records a break relative to the generated world. Keeping breaks in
 * the snapshot is necessary because the seed alone would otherwise restore
 * the generated block when a client reconnects.
 */
export const BlockMutationSnapshot = Schema.Struct({
  at: BlockPos,
  block: Schema.NullOr(Schema.String.pipe(Schema.minLength(MIN_NON_EMPTY_LENGTH))),
  world: WorldId,
})
export type BlockMutationSnapshot = typeof BlockMutationSnapshot.Type

/** The authoritative powered state of one rail block in a world snapshot. */
export const PoweredRailSnapshot = Schema.Struct({
  at: BlockPos,
  powered: Schema.Boolean,
}).annotations({ parseOptions: { onExcessProperty: 'error' as const } })
export type PoweredRailSnapshot = typeof PoweredRailSnapshot.Type

export const LeverSnapshot = Schema.Struct({
  active: Schema.Boolean,
  at: BlockPos,
}).annotations({ parseOptions: { onExcessProperty: 'error' as const } })
export type LeverSnapshot = typeof LeverSnapshot.Type

/**
 * Complete state needed by a late joiner or reconnecting client.
 *
 * The revision is monotonic within a server process. A client can ignore an
 * older snapshot delivered after newer live traffic without relying on wall
 * clock time.
 */
export const WorldSnapshot = Schema.TaggedStruct('WorldSnapshot', {
  blocks: Schema.Array(BlockMutationSnapshot),
  levers: Schema.Array(LeverSnapshot),
  players: Schema.Array(PlayerSnapshot),
  poweredRails: Schema.Array(PoweredRailSnapshot),
  revision: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
  seed: Schema.Number.pipe(Schema.int()),
  world: WorldId,
})
export type WorldSnapshot = typeof WorldSnapshot.Type

/** Stable machine-readable reasons an authoritative server may reject a mutation. */
export const BlockMutationRejectionReason = Schema.Literal(
  'unauthorized-player',
  'unknown-block',
  'occupied',
  'missing-block',
  'out-of-bounds',
  'stale-revision',
)
export type BlockMutationRejectionReason = typeof BlockMutationRejectionReason.Type

/** A block mutation was not applied; the client should retain server state. */
export const BlockMutationRejected = Schema.TaggedStruct('BlockMutationRejected', {
  at: BlockPos,
  operation: Schema.Literal('place', 'break'),
  player: PlayerId,
  reason: BlockMutationRejectionReason,
  revision: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
  world: WorldId,
})
export type BlockMutationRejected = typeof BlockMutationRejected.Type

const ItemDurability = Schema.Struct({
  current: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
  max: Schema.Number.pipe(Schema.int(), Schema.positive()),
})

const ItemStack = Schema.Struct({
  count: Schema.Number.pipe(Schema.int(), Schema.positive()),
  durability: Schema.optional(
    Schema.Struct({
      current: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
      max: Schema.Number.pipe(Schema.int(), Schema.positive()),
    }),
  ),
  item: Schema.String.pipe(Schema.minLength(MIN_NON_EMPTY_LENGTH)),
})

export const EquipmentSlot = Schema.Literal('head', 'chest', 'legs', 'feet', 'offhand')
export type EquipmentSlot = typeof EquipmentSlot.Type

const EquipmentState = Schema.Struct({
  chest: Schema.NullOr(ItemStack),
  feet: Schema.NullOr(ItemStack),
  head: Schema.NullOr(ItemStack),
  legs: Schema.NullOr(ItemStack),
  offhand: Schema.NullOr(ItemStack),
})

const InventoryState = Schema.Struct({
  // Accepted for protocol-v1 peers that sent durability out-of-band.
  durability: Schema.optional(Schema.Array(Schema.NullOr(ItemDurability))),
  equipment: Schema.optional(EquipmentState),
  selectedSlot: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
  slots: Schema.Array(Schema.NullOr(ItemStack)),
})

const VitalsState = Schema.Struct({
  experience: Schema.Number.pipe(Schema.finite(), Schema.nonNegative()),
  health: Schema.Number.pipe(Schema.finite(), Schema.nonNegative()),
  hunger: Schema.Number.pipe(Schema.finite(), Schema.nonNegative()),
})

const TimeWeatherState = Schema.Struct({
  timeOfDay: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
  weather: Schema.Literal('clear', 'rain', 'thunder'),
})

export const ContainerKind = Schema.Literal('chest', 'shulker_box', 'dispenser', 'dropper', 'hopper')
export type ContainerKind = typeof ContainerKind.Type

const ContainerState = Schema.Struct({
  containerId: Schema.String.pipe(Schema.minLength(MIN_NON_EMPTY_LENGTH)),
  kind: ContainerKind,
  slots: Schema.Array(Schema.NullOr(ItemStack)),
})

const FurnaceState = Schema.Struct({
  burnTicksRemaining: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
  cookTicks: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
  fuel: Schema.NullOr(ItemStack),
  furnaceId: Schema.String.pipe(Schema.minLength(MIN_NON_EMPTY_LENGTH)),
  input: Schema.NullOr(ItemStack),
  output: Schema.NullOr(ItemStack),
})

const VillagerTradeState = Schema.Struct({
  offers: Schema.Array(
    Schema.Struct({
      input: Schema.Array(ItemStack),
      maxUses: Schema.Number.pipe(Schema.int(), Schema.positive()),
      offerId: Schema.String.pipe(Schema.minLength(MIN_NON_EMPTY_LENGTH)),
      output: ItemStack,
      uses: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
    }),
  ),
  villagerId: Schema.String.pipe(Schema.minLength(MIN_NON_EMPTY_LENGTH)),
})

const MobState = Schema.Struct({
  ageTicks: Schema.optional(Schema.Number.pipe(Schema.int(), Schema.nonNegative())),
  attackCooldownSecs: Schema.Number.pipe(Schema.finite(), Schema.nonNegative()),
  /** Present only for creepers struck by server-authoritative lightning. */
  charged: Schema.optional(Schema.Boolean),
  motionPhase: Schema.Number.pipe(Schema.finite(), Schema.nonNegative()),
  named: Schema.optional(Schema.Boolean),
  persistent: Schema.optional(Schema.Boolean),
  provoked: Schema.Boolean,
  tamed: Schema.optional(Schema.Boolean),
})

export const LivingEntityState = Schema.TaggedStruct('living', {
  at: Vec3,
  entityId: EntityId,
  entityType: Schema.String.pipe(Schema.minLength(MIN_NON_EMPTY_LENGTH)),
  health: Schema.Number.pipe(Schema.finite(), Schema.positive()),
  maxHealth: Schema.Number.pipe(Schema.finite(), Schema.positive()),
  mobState: Schema.optional(MobState),
})
export const ItemDropEntityState = Schema.TaggedStruct('item-drop', {
  ageTicks: Schema.optional(Schema.Number.pipe(Schema.int(), Schema.nonNegative())),
  at: Vec3,
  entityId: EntityId,
  stack: ItemStack,
})
export const ArrowEntityState = Schema.TaggedStruct('arrow', {
  ageTicks: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
  at: Vec3,
  damage: Schema.Number.pipe(Schema.finite(), Schema.nonNegative()),
  entityId: EntityId,
  owner: Schema.NullOr(PlayerId),
  velocity: Vec3,
})
export type ArrowEntityState = typeof ArrowEntityState.Type
export const PrimedTntEntityState = Schema.TaggedStruct('primed-tnt', {
  at: Vec3,
  burnedSecs: Schema.Number.pipe(Schema.finite(), Schema.nonNegative()),
  entityId: EntityId,
  owner: Schema.NullOr(PlayerId),
})
export type PrimedTntEntityState = typeof PrimedTntEntityState.Type
export const VehicleEntityState = Schema.TaggedStruct('vehicle', {
  at: Vec3,
  entityId: EntityId,
  occupant: Schema.NullOr(PlayerId),
  vehicleType: Schema.String.pipe(Schema.minLength(MIN_NON_EMPTY_LENGTH)),
})
export const AuthoritativeEntityState = Schema.Union(
  LivingEntityState,
  ItemDropEntityState,
  ArrowEntityState,
  PrimedTntEntityState,
  VehicleEntityState,
)
export type AuthoritativeEntityState = typeof AuthoritativeEntityState.Type

/** Complete server state used for initial connection and reconnect recovery. */
export const AuthoritativeSnapshot = Schema.TaggedStruct('AuthoritativeSnapshot', {
  containers: Schema.Array(ContainerState),
  entities: Schema.optional(Schema.Array(AuthoritativeEntityState)),
  furnaces: Schema.Array(FurnaceState),
  inventories: Schema.Array(Schema.Struct({ player: PlayerId, state: InventoryState })),
  revision: Revision,
  timeWeather: TimeWeatherState,
  villagerTrades: Schema.Array(VillagerTradeState),
  vitals: Schema.Array(Schema.Struct({ player: PlayerId, state: VitalsState })),
  world: WorldId,
})
export type AuthoritativeSnapshot = typeof AuthoritativeSnapshot.Type

/** Server-authoritative result of using an End portal. */
export const RealmTransferSnapshot = Schema.TaggedStruct('RealmTransferSnapshot', {
  at: Vec3,
  authoritativeSnapshot: AuthoritativeSnapshot,
  commandId: CommandId,
  destinationWorld: WorldId,
  facing: Orientation,
  fromWorld: WorldId,
  player: PlayerId,
  worldSnapshot: WorldSnapshot,
}).annotations({ parseOptions: { onExcessProperty: 'error' as const } })
export type RealmTransferSnapshot = typeof RealmTransferSnapshot.Type

const DeltaHeader = { revision: Revision, world: WorldId }
export const PlayerInventoryDelta = Schema.TaggedStruct('PlayerInventoryDelta', {
  ...DeltaHeader,
  player: PlayerId,
  state: InventoryState,
})
export const PlayerVitalsDelta = Schema.TaggedStruct('PlayerVitalsDelta', {
  ...DeltaHeader,
  player: PlayerId,
  state: VitalsState,
})
const PlayerFishingState = Schema.Union(
  Schema.Struct({ phase: Schema.Literal('idle'), result: Schema.Literal('invalid-rod', 'no-water', 'cancelled', 'caught', 'too-early', 'too-late', 'lost-water') }),
  Schema.Struct({ phase: Schema.Literal('waiting'), result: Schema.Literal('cast') }),
  Schema.Struct({ phase: Schema.Literal('bite'), result: Schema.Literal('bite') }),
  Schema.Struct({ phase: Schema.Literal('escaped'), result: Schema.Literal('escaped') }),
).annotations({ parseOptions: { onExcessProperty: 'error' as const } })
export const PlayerFishingDelta = Schema.TaggedStruct('PlayerFishingDelta', {
  ...DeltaHeader,
  player: PlayerId,
  state: PlayerFishingState,
})
export const WorldTimeWeatherDelta = Schema.TaggedStruct('WorldTimeWeatherDelta', {
  ...DeltaHeader,
  state: TimeWeatherState,
})
export const ContainerDelta = Schema.TaggedStruct('ContainerDelta', {
  ...DeltaHeader,
  state: ContainerState,
})
export const FurnaceDelta = Schema.TaggedStruct('FurnaceDelta', {
  ...DeltaHeader,
  state: FurnaceState,
})
export const VillagerTradeDelta = Schema.TaggedStruct('VillagerTradeDelta', {
  ...DeltaHeader,
  state: VillagerTradeState,
})
export const EntitySpawnDelta = Schema.TaggedStruct('EntitySpawnDelta', {
  ...DeltaHeader,
  entity: AuthoritativeEntityState,
})
export const EntityUpdateDelta = Schema.TaggedStruct('EntityUpdateDelta', {
  ...DeltaHeader,
  entity: AuthoritativeEntityState,
})
export const EntityDespawnDelta = Schema.TaggedStruct('EntityDespawnDelta', {
  ...DeltaHeader,
  entityId: EntityId,
})
/** A server-authoritative lightning impact rendered by connected clients. */
export const LightningStrikeDelta = Schema.TaggedStruct('LightningStrikeDelta', {
  ...DeltaHeader,
  at: Vec3,
})
/**
 * A server-derived Eye of Ender flight. It is deliberately separate from
 * persistent entity deltas: the client renders the short-lived flight, while
 * a recoverable Eye becomes an ordinary server-owned item drop afterwards.
 */
export const EyeOfEnderThrown = Schema.TaggedStruct('EyeOfEnderThrown', {
  ...DeltaHeader,
  breaks: Schema.Boolean,
  origin: Vec3,
  player: PlayerId,
  target: Vec3,
})
export type EyeOfEnderThrown = typeof EyeOfEnderThrown.Type
export const AuthoritativeDelta = Schema.Union(
  PlayerInventoryDelta,
  PlayerVitalsDelta,
  PlayerFishingDelta,
  WorldTimeWeatherDelta,
  ContainerDelta,
  FurnaceDelta,
  VillagerTradeDelta,
  EntitySpawnDelta,
  EntityUpdateDelta,
  EntityDespawnDelta,
  LightningStrikeDelta,
)
export type AuthoritativeDelta = typeof AuthoritativeDelta.Type

const CommandHeader = {
  commandId: CommandId,
  expectedRevision: Revision,
  player: PlayerId,
  world: WorldId,
}

export const CommandSlotIndex = Schema.Number.pipe(Schema.int(), Schema.nonNegative())
export const CommandItemCount = Schema.Number.pipe(Schema.int(), Schema.positive())

const strictAction = { parseOptions: { onExcessProperty: 'error' as const } }

export const PlayerInventoryAction = Schema.Union(
  Schema.TaggedStruct('select-slot', { slot: CommandSlotIndex }),
  Schema.TaggedStruct('move-item', {
    count: CommandItemCount,
    destination: CommandSlotIndex,
    source: CommandSlotIndex,
  }),
  Schema.TaggedStruct('swap-items', {
    destination: CommandSlotIndex,
    source: CommandSlotIndex,
  }),
  Schema.TaggedStruct('drop-item', {
    count: CommandItemCount,
    destination: Schema.Literal('world'),
    source: CommandSlotIndex,
  }),
  Schema.TaggedStruct('equip-item', {
    equipmentSlot: EquipmentSlot,
    source: CommandSlotIndex,
  }),
  Schema.TaggedStruct('unequip-item', {
    destination: Schema.optional(CommandSlotIndex),
    equipmentSlot: EquipmentSlot,
  }),
).annotations(strictAction)
export type PlayerInventoryAction = typeof PlayerInventoryAction.Type

export const WorldTimeWeatherAction = Schema.Union(
  Schema.TaggedStruct('set-time', { timeOfDay: Schema.Number.pipe(Schema.int(), Schema.nonNegative()) }),
  Schema.TaggedStruct('set-weather', { weather: Schema.Literal('clear', 'rain', 'thunder') }),
).annotations(strictAction)
export type WorldTimeWeatherAction = typeof WorldTimeWeatherAction.Type

export const PlayerSlotEndpoint = Schema.TaggedStruct('player-slot', { slot: CommandSlotIndex })
export type PlayerSlotEndpoint = typeof PlayerSlotEndpoint.Type
export const ContainerSlotEndpoint = Schema.TaggedStruct('container-slot', { slot: CommandSlotIndex })
export type ContainerSlotEndpoint = typeof ContainerSlotEndpoint.Type

export const ContainerAction = Schema.Union(
  Schema.TaggedStruct('open', {}),
  Schema.TaggedStruct('move-item', {
    count: CommandItemCount,
    destination: ContainerSlotEndpoint,
    source: PlayerSlotEndpoint,
  }),
  Schema.TaggedStruct('move-item', {
    count: CommandItemCount,
    destination: PlayerSlotEndpoint,
    source: ContainerSlotEndpoint,
  }),
  Schema.TaggedStruct('close', {}),
).annotations(strictAction)
export type ContainerAction = typeof ContainerAction.Type

export const FurnaceSlotEndpoint = Schema.TaggedStruct('furnace-slot', {
  slot: Schema.Literal('input', 'fuel'),
})
export type FurnaceSlotEndpoint = typeof FurnaceSlotEndpoint.Type
const FurnaceOutputEndpoint = Schema.TaggedStruct('furnace-slot', {
  slot: Schema.Literal('output'),
})

export const FurnaceAction = Schema.Union(
  Schema.TaggedStruct('move-item', {
    count: CommandItemCount,
    destination: FurnaceSlotEndpoint,
    source: PlayerSlotEndpoint,
  }),
  Schema.TaggedStruct('move-item', {
    count: CommandItemCount,
    destination: PlayerSlotEndpoint,
    source: FurnaceSlotEndpoint,
  }),
  Schema.TaggedStruct('take-output', {
    count: CommandItemCount,
    destination: PlayerSlotEndpoint,
    source: FurnaceOutputEndpoint,
  }),
).annotations(strictAction)
export type FurnaceAction = typeof FurnaceAction.Type

export const PlayerInventoryCommand = Schema.TaggedStruct('PlayerInventoryCommand', {
  ...CommandHeader,
  action: PlayerInventoryAction,
})
/** `PlayerVitalsCommand`'s `activity` variant reports a percentage; a caller cannot claim more than a whole one. */
const MAX_VITALS_ACTIVITY_AMOUNT = 100

export const PlayerVitalsCommand = Schema.TaggedStruct('PlayerVitalsCommand', {
  ...CommandHeader,
  action: Schema.Union(
    Schema.Literal('respawn'),
    Schema.TaggedStruct('activity', {
      activity: Schema.Literal('walk', 'swim', 'jump', 'attack', 'mine'),
      amount: Schema.Number.pipe(Schema.finite(), Schema.positive(), Schema.lessThanOrEqualTo(MAX_VITALS_ACTIVITY_AMOUNT)),
    }),
    Schema.TaggedStruct('eat', { item: Schema.String.pipe(Schema.minLength(MIN_NON_EMPTY_LENGTH)) }),
  ),
})
export const WorldTimeWeatherCommand = Schema.TaggedStruct('WorldTimeWeatherCommand', {
  ...CommandHeader,
  action: WorldTimeWeatherAction,
})
export const ContainerCommand = Schema.TaggedStruct('ContainerCommand', {
  ...CommandHeader,
  action: ContainerAction,
  containerId: Schema.String.pipe(Schema.minLength(MIN_NON_EMPTY_LENGTH)),
})
export const FurnaceCommand = Schema.TaggedStruct('FurnaceCommand', {
  ...CommandHeader,
  action: FurnaceAction,
  furnaceId: Schema.String.pipe(Schema.minLength(MIN_NON_EMPTY_LENGTH)),
})
export const VillagerTradeCommand = Schema.TaggedStruct('VillagerTradeCommand', {
  ...CommandHeader,
  action: Schema.Literal('execute-trade'),
  offerId: Schema.String.pipe(Schema.minLength(MIN_NON_EMPTY_LENGTH)),
  villagerId: Schema.String.pipe(Schema.minLength(MIN_NON_EMPTY_LENGTH)),
})
export const EntityAttackCommand = Schema.TaggedStruct('EntityAttackCommand', {
  ...CommandHeader,
  entityId: EntityId,
})
export const EntityPickupCommand = Schema.TaggedStruct('EntityPickupCommand', {
  ...CommandHeader,
  entityId: EntityId,
})
export const BowUseCommand = Schema.TaggedStruct('BowUseCommand', {
  ...CommandHeader,
  action: Schema.Literal('start', 'release'),
})
export type BowUseCommand = typeof BowUseCommand.Type
export const IgniteTntCommand = Schema.TaggedStruct('IgniteTntCommand', {
  ...CommandHeader,
  at: BlockPos,
})
export type IgniteTntCommand = typeof IgniteTntCommand.Type

/** A client requests End portal use; destination and spawn are server authority. */
export const EndPortalUseCommand = Schema.TaggedStruct('EndPortalUseCommand', {
  ...CommandHeader,
  portal: BlockPos,
}).annotations({ parseOptions: { onExcessProperty: 'error' as const } })
export type EndPortalUseCommand = typeof EndPortalUseCommand.Type

/** The server validates the held Eye and derives the stronghold from the world seed. */
export const ThrowEyeOfEnderCommand = Schema.TaggedStruct('ThrowEyeOfEnderCommand', {
  ...CommandHeader,
}).annotations({ parseOptions: { onExcessProperty: 'error' as const } })
export type ThrowEyeOfEnderCommand = typeof ThrowEyeOfEnderCommand.Type

/** The server validates that this is an empty generated stronghold frame. */
export const InsertEyeIntoEndPortalFrameCommand = Schema.TaggedStruct('InsertEyeIntoEndPortalFrameCommand', {
  ...CommandHeader,
  frame: BlockPos,
}).annotations({ parseOptions: { onExcessProperty: 'error' as const } })
export type InsertEyeIntoEndPortalFrameCommand = typeof InsertEyeIntoEndPortalFrameCommand.Type

/** A client requests Nether portal use; destination and spawn are server authority. */
export const NetherPortalUseCommand = Schema.TaggedStruct('NetherPortalUseCommand', {
  ...CommandHeader,
  portal: BlockPos,
}).annotations({ parseOptions: { onExcessProperty: 'error' as const } })
export type NetherPortalUseCommand = typeof NetherPortalUseCommand.Type

/** A client requests a lever toggle; the server owns its active state. */
export const ToggleLeverCommand = Schema.TaggedStruct('ToggleLeverCommand', {
  ...CommandHeader,
  lever: BlockPos,
}).annotations({ parseOptions: { onExcessProperty: 'error' as const } })
export type ToggleLeverCommand = typeof ToggleLeverCommand.Type

export const EnderPearlCommand = Schema.TaggedStruct('EnderPearlCommand', { ...CommandHeader })
export type EnderPearlCommand = typeof EnderPearlCommand.Type
export const BucketUseCommand = Schema.TaggedStruct('BucketUseCommand', { ...CommandHeader })
export type BucketUseCommand = typeof BucketUseCommand.Type
export const VehicleUseCommand = Schema.TaggedStruct('VehicleUseCommand', { ...CommandHeader })
export type VehicleUseCommand = typeof VehicleUseCommand.Type
export const FishingCommand = Schema.TaggedStruct('FishingCommand', {
  ...CommandHeader,
  action: Schema.Literal('cast', 'reel'),
})
export type FishingCommand = typeof FishingCommand.Type
export const VehicleCommand = Schema.TaggedStruct('VehicleCommand', {
  ...CommandHeader,
  action: Schema.Union(
    Schema.Literal('mount', 'dismount'),
    Schema.TaggedStruct('move', { direction: Schema.Literal('forward', 'backward') }),
  ).annotations(strictAction),
  entityId: EntityId,
})
export const AuthoritativeCommand = Schema.Union(
  PlayerInventoryCommand,
  PlayerVitalsCommand,
  WorldTimeWeatherCommand,
  ContainerCommand,
  FurnaceCommand,
  VillagerTradeCommand,
  EntityAttackCommand,
  EntityPickupCommand,
  BowUseCommand,
  IgniteTntCommand,
  EndPortalUseCommand,
  ThrowEyeOfEnderCommand,
  InsertEyeIntoEndPortalFrameCommand,
  NetherPortalUseCommand,
  ToggleLeverCommand,
  EnderPearlCommand,
  BucketUseCommand,
  VehicleUseCommand,
  FishingCommand,
  VehicleCommand,
)
export type AuthoritativeCommand = typeof AuthoritativeCommand.Type

export const CommandRejectionReason = Schema.Literal(
  'unauthorized-player',
  'invalid-command',
  'stale-revision',
  'snapshot-required',
  'resource-not-found',
  'insufficient-items',
  'offer-exhausted',
  'out-of-range',
  'entity-dead',
  'not-mounted',
  'vehicle-occupied',
)
export type CommandRejectionReason = typeof CommandRejectionReason.Type
export const AuthoritativeCommandAccepted = Schema.TaggedStruct('AuthoritativeCommandAccepted', {
  commandId: CommandId,
  revision: Revision,
  world: WorldId,
})
export const AuthoritativeCommandRejected = Schema.TaggedStruct('AuthoritativeCommandRejected', {
  commandId: CommandId,
  reason: CommandRejectionReason,
  resyncRequired: Schema.Boolean,
  revision: Revision,
  world: WorldId,
})
export const AuthoritativeCommandResult = Schema.Union(
  AuthoritativeCommandAccepted,
  AuthoritativeCommandRejected,
)
export type AuthoritativeCommandResult = typeof AuthoritativeCommandResult.Type

export const AuthoritativeResyncRequest = Schema.TaggedStruct('AuthoritativeResyncRequest', {
  lastKnownRevision: Schema.optional(Revision),
  world: WorldId,
})
export type AuthoritativeResyncRequest = typeof AuthoritativeResyncRequest.Type

/**
 * Liveness probe.
 *
 * `nonce` rather than a timestamp is deliberate: `Date.now()` is banned
 * repository-wide (kernel's clock Port), and a nonce is what actually matches a
 * `Pong` to its `Ping`. Round-trip *time* is measured by the caller, against
 * the injected clock, at both ends of the wait.
 */
export const Ping = Schema.TaggedStruct('Ping', {
  nonce: Schema.Number.pipe(Schema.int()),
})
export type Ping = typeof Ping.Type

export const Pong = Schema.TaggedStruct('Pong', {
  nonce: Schema.Number.pipe(Schema.int()),
})
export type Pong = typeof Pong.Type

/**
 * Everything that may cross the wire.
 *
 * A union of tagged structs, so `Schema.decodeUnknown` discriminates on `_tag`
 * and an unknown tag fails as `malformed-frame` rather than being coerced into
 * a neighbouring case.
 */
export const NetworkMessage = Schema.Union(
  PlayerJoin,
  PlayerLeave,
  PlayerMove,
  BlockPlace,
  BlockBreak,
  Chat,
  WorldInfo,
  WorldSnapshot,
  BlockMutationRejected,
  AuthoritativeSnapshot,
  RealmTransferSnapshot,
  EyeOfEnderThrown,
  AuthoritativeDelta,
  AuthoritativeCommand,
  AuthoritativeCommandResult,
  AuthoritativeResyncRequest,
  Ping,
  Pong,
)
export type NetworkMessage = typeof NetworkMessage.Type

/** Every message tag this build knows, for exhaustiveness checks and tests. */
export const MESSAGE_TAGS = [
  'PlayerJoin',
  'PlayerLeave',
  'PlayerMove',
  'BlockPlace',
  'BlockBreak',
  'Chat',
  'WorldInfo',
  'WorldSnapshot',
  'BlockMutationRejected',
  'AuthoritativeSnapshot',
  'RealmTransferSnapshot',
  'EyeOfEnderThrown',
  'PlayerInventoryDelta',
  'PlayerVitalsDelta',
  'PlayerFishingDelta',
  'WorldTimeWeatherDelta',
  'ContainerDelta',
  'FurnaceDelta',
  'VillagerTradeDelta',
  'EntitySpawnDelta',
  'EntityUpdateDelta',
  'EntityDespawnDelta',
  'LightningStrikeDelta',
  'PlayerInventoryCommand',
  'PlayerVitalsCommand',
  'WorldTimeWeatherCommand',
  'ContainerCommand',
  'FurnaceCommand',
  'VillagerTradeCommand',
  'EntityAttackCommand',
  'EntityPickupCommand',
  'BowUseCommand',
  'IgniteTntCommand',
  'EndPortalUseCommand',
  'ThrowEyeOfEnderCommand',
  'InsertEyeIntoEndPortalFrameCommand',
  'NetherPortalUseCommand',
  'ToggleLeverCommand',
  'EnderPearlCommand',
  'BucketUseCommand',
  'VehicleUseCommand',
  'FishingCommand',
  'VehicleCommand',
  'AuthoritativeCommandAccepted',
  'AuthoritativeCommandRejected',
  'AuthoritativeResyncRequest',
  'Ping',
  'Pong',
] as const satisfies ReadonlyArray<NetworkMessage['_tag']>

/**
 * What actually travels: a versioned envelope around one message.
 *
 * The version lives on the envelope, not inside the message, so that a frame
 * from an unknown protocol version can be rejected without first having to
 * parse a message shape that may no longer exist.
 */
export const Frame = Schema.Struct({
  message: NetworkMessage,
  protocolVersion: Schema.Number.pipe(Schema.int()),
})
export type Frame = typeof Frame.Type

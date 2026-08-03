/**
 * The wire protocol: the set of messages two peers may exchange, and nothing
 * else.
 *
 * PRE-AUDIT FIRST CUT (叩き台). The message roster below is a representative
 * subset, not the reference implementation's full set — see
 * `docs/porting.md`.
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
 * `Vec3` and `BlockPos` below look like `@nerima-games/mc-kernel`'s `Position`
 * and chunk coordinates, and eventually the *domain-side* of the codec should
 * decode into kernel types. It does not yet, for two reasons:
 *
 * 1. Nothing in the 16-repository roster is published (plan.md §6 Step 3), so
 *    this skeleton has no sibling package to depend on.
 * 2. More durably: a wire format and a domain type have different change
 *    budgets. Kernel's `Position` may be refactored freely; the wire encoding
 *    of a position may not, because an old client is still sending it. Keeping
 *    a declared wire schema — even one that currently mirrors kernel exactly —
 *    is what makes "kernel changed" and "the protocol changed" two separate
 *    events. See docs/design-notes.md.
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
export const PROTOCOL_VERSION = 1

// ---------------------------------------------------------------------------
// Identifiers and payload shapes
// ---------------------------------------------------------------------------

/** A peer's stable identity for the lifetime of a session. */
export const PlayerId = Schema.String.pipe(Schema.minLength(1), Schema.brand('PlayerId'))
export type PlayerId = typeof PlayerId.Type

/** A peer's display name. Not unique, not an identity — never key on it. */
export const PlayerName = Schema.String.pipe(Schema.minLength(1), Schema.brand('PlayerName'))
export type PlayerName = typeof PlayerName.Type

/** Identifies which world a session is playing. */
export const WorldId = Schema.String.pipe(Schema.minLength(1), Schema.brand('WorldId'))
export type WorldId = typeof WorldId.Type

/** Stable client-generated identity used to make command retries idempotent. */
export const CommandId = Schema.String.pipe(Schema.minLength(1), Schema.brand('CommandId'))
export type CommandId = typeof CommandId.Type

/** Stable identity of a server-owned world entity. */
export const EntityId = Schema.String.pipe(Schema.minLength(1), Schema.brand('EntityId'))
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

/**
 * Look direction. Radians, matching kernel's `CameraPoseSnapshot`; pitch is
 * clamped to ±π/2 because a value outside that range is not a rotation a
 * player can be in, and letting it through produces a peer avatar that is
 * upside down rather than an error anyone can find.
 */
export const Orientation = Schema.Struct({
  yawRadians: Schema.Number.pipe(Schema.finite()),
  pitchRadians: Schema.Number.pipe(Schema.between(-Math.PI / 2, Math.PI / 2)),
})
export type Orientation = typeof Orientation.Type

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export const PlayerJoin = Schema.TaggedStruct('PlayerJoin', {
  player: PlayerId,
  name: PlayerName,
  at: Vec3,
})
export type PlayerJoin = typeof PlayerJoin.Type

export const PlayerLeave = Schema.TaggedStruct('PlayerLeave', {
  player: PlayerId,
})
export type PlayerLeave = typeof PlayerLeave.Type

export const PlayerMove = Schema.TaggedStruct('PlayerMove', {
  player: PlayerId,
  /** Optional for protocol-v1 peers; authoritative servers should include it. */
  world: Schema.optional(WorldId),
  at: Vec3,
  facing: Orientation,
})
export type PlayerMove = typeof PlayerMove.Type

export const BlockPlace = Schema.TaggedStruct('BlockPlace', {
  player: PlayerId,
  /** Optional for protocol-v1 peers; authoritative servers should include it. */
  world: Schema.optional(WorldId),
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
  block: Schema.String.pipe(Schema.minLength(1)),
})
export type BlockPlace = typeof BlockPlace.Type

export const BlockBreak = Schema.TaggedStruct('BlockBreak', {
  player: PlayerId,
  /** Optional for protocol-v1 peers; authoritative servers should include it. */
  world: Schema.optional(WorldId),
  at: BlockPos,
})
export type BlockBreak = typeof BlockBreak.Type

export const Chat = Schema.TaggedStruct('Chat', {
  player: PlayerId,
  text: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(256)),
})
export type Chat = typeof Chat.Type

export const WorldInfo = Schema.TaggedStruct('WorldInfo', {
  world: WorldId,
  /** Integral so that a seed survives a JSON round trip exactly. */
  seed: Schema.Number.pipe(Schema.int()),
})
export type WorldInfo = typeof WorldInfo.Type

/** A player as observed in an authoritative world snapshot. */
export const PlayerSnapshot = Schema.Struct({
  player: PlayerId,
  name: PlayerName,
  world: WorldId,
  at: Vec3,
  facing: Orientation,
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
  world: WorldId,
  at: BlockPos,
  block: Schema.NullOr(Schema.String.pipe(Schema.minLength(1))),
})
export type BlockMutationSnapshot = typeof BlockMutationSnapshot.Type

/**
 * Complete state needed by a late joiner or reconnecting client.
 *
 * The revision is monotonic within a server process. A client can ignore an
 * older snapshot delivered after newer live traffic without relying on wall
 * clock time.
 */
export const WorldSnapshot = Schema.TaggedStruct('WorldSnapshot', {
  world: WorldId,
  seed: Schema.Number.pipe(Schema.int()),
  revision: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
  players: Schema.Array(PlayerSnapshot),
  blocks: Schema.Array(BlockMutationSnapshot),
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
  player: PlayerId,
  world: WorldId,
  at: BlockPos,
  operation: Schema.Literal('place', 'break'),
  reason: BlockMutationRejectionReason,
  revision: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
})
export type BlockMutationRejected = typeof BlockMutationRejected.Type

const ItemStack = Schema.Struct({
  item: Schema.String.pipe(Schema.minLength(1)),
  count: Schema.Number.pipe(Schema.int(), Schema.positive()),
})

const ItemDurability = Schema.Struct({
  current: Schema.Number.pipe(Schema.int(), Schema.positive()),
  max: Schema.Number.pipe(Schema.int(), Schema.positive()),
})

const InventoryState = Schema.Struct({
  slots: Schema.Array(Schema.NullOr(ItemStack)),
  selectedSlot: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
  durability: Schema.optional(Schema.Array(Schema.NullOr(ItemDurability))),
})

const VitalsState = Schema.Struct({
  health: Schema.Number.pipe(Schema.finite(), Schema.nonNegative()),
  hunger: Schema.Number.pipe(Schema.finite(), Schema.nonNegative()),
  experience: Schema.Number.pipe(Schema.finite(), Schema.nonNegative()),
})

const TimeWeatherState = Schema.Struct({
  timeOfDay: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
  weather: Schema.Literal('clear', 'rain', 'thunder'),
})

const ContainerState = Schema.Struct({
  containerId: Schema.String.pipe(Schema.minLength(1)),
  slots: Schema.Array(Schema.NullOr(ItemStack)),
})

const FurnaceState = Schema.Struct({
  furnaceId: Schema.String.pipe(Schema.minLength(1)),
  input: Schema.NullOr(ItemStack),
  fuel: Schema.NullOr(ItemStack),
  output: Schema.NullOr(ItemStack),
  burnTicksRemaining: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
  cookTicks: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
})

const VillagerTradeState = Schema.Struct({
  villagerId: Schema.String.pipe(Schema.minLength(1)),
  offers: Schema.Array(
    Schema.Struct({
      offerId: Schema.String.pipe(Schema.minLength(1)),
      input: Schema.Array(ItemStack),
      output: ItemStack,
      uses: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
      maxUses: Schema.Number.pipe(Schema.int(), Schema.positive()),
    }),
  ),
})

export const LivingEntityState = Schema.TaggedStruct('living', {
  entityId: EntityId,
  entityType: Schema.String.pipe(Schema.minLength(1)),
  at: Vec3,
  health: Schema.Number.pipe(Schema.finite(), Schema.positive()),
  maxHealth: Schema.Number.pipe(Schema.finite(), Schema.positive()),
  // Optional so peers can continue decoding living entities without AI state.
  mobState: Schema.optional(Schema.Struct({
    attackCooldownSecs: Schema.Number.pipe(Schema.finite(), Schema.nonNegative()),
    motionPhase: Schema.Number.pipe(Schema.finite()),
    provoked: Schema.Boolean,
    // Host-owned lifecycle data. Optional fields preserve older reconnect snapshots.
    ageTicks: Schema.optional(Schema.Number.pipe(Schema.int(), Schema.nonNegative())),
    persistent: Schema.optional(Schema.Boolean),
    named: Schema.optional(Schema.Boolean),
    tamed: Schema.optional(Schema.Boolean),
  })),
})
export const ItemDropEntityState = Schema.TaggedStruct('item-drop', {
  entityId: EntityId,
  at: Vec3,
  stack: ItemStack,
  // Optional so snapshots written before item aging remain decodable.
  ageTicks: Schema.optional(Schema.Number.pipe(Schema.int(), Schema.nonNegative())),
})
export const VehicleEntityState = Schema.TaggedStruct('vehicle', {
  entityId: EntityId,
  vehicleType: Schema.String.pipe(Schema.minLength(1)),
  at: Vec3,
  occupant: Schema.NullOr(PlayerId),
})
export const ArrowEntityState = Schema.TaggedStruct('arrow', {
  entityId: EntityId,
  at: Vec3,
  velocity: Vec3,
  damage: Schema.Number.pipe(Schema.finite(), Schema.positive()),
  owner: PlayerId,
  ageTicks: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
})
export const PrimedTntEntityState = Schema.TaggedStruct('primed-tnt', {
  entityId: EntityId,
  at: Vec3,
  burnedSecs: Schema.Number.pipe(Schema.finite(), Schema.nonNegative()),
  owner: PlayerId,
})
export const AuthoritativeEntityState = Schema.Union(
  LivingEntityState,
  ItemDropEntityState,
  VehicleEntityState,
  ArrowEntityState,
  PrimedTntEntityState,
)
export type AuthoritativeEntityState = typeof AuthoritativeEntityState.Type

/** Complete server state used for initial connection and reconnect recovery. */
export const AuthoritativeSnapshot = Schema.TaggedStruct('AuthoritativeSnapshot', {
  world: WorldId,
  revision: Revision,
  inventories: Schema.Array(Schema.Struct({ player: PlayerId, state: InventoryState })),
  vitals: Schema.Array(Schema.Struct({ player: PlayerId, state: VitalsState })),
  timeWeather: TimeWeatherState,
  containers: Schema.Array(ContainerState),
  furnaces: Schema.Array(FurnaceState),
  villagerTrades: Schema.Array(VillagerTradeState),
  entities: Schema.optional(Schema.Array(AuthoritativeEntityState)),
})
export type AuthoritativeSnapshot = typeof AuthoritativeSnapshot.Type

const DeltaHeader = { world: WorldId, revision: Revision }
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
export const PlayerFishingDelta = Schema.TaggedStruct('PlayerFishingDelta', {
  ...DeltaHeader,
  player: PlayerId,
  state: Schema.Struct({
    phase: Schema.Literal('idle', 'waiting', 'bite', 'escaped'),
    result: Schema.Literal('idle', 'cast', 'bite', 'escaped', 'caught', 'too-early', 'too-late', 'lost-water', 'cancelled', 'invalid-rod', 'no-water'),
  }),
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
)
export type AuthoritativeDelta = typeof AuthoritativeDelta.Type

const CommandHeader = {
  commandId: CommandId,
  player: PlayerId,
  world: WorldId,
  expectedRevision: Revision,
}

export const CommandSlotIndex = Schema.Number.pipe(Schema.int(), Schema.nonNegative())
export const CommandItemCount = Schema.Number.pipe(Schema.int(), Schema.positive())

const strictAction = { parseOptions: { onExcessProperty: 'error' as const } }

export const PlayerInventoryAction = Schema.Union(
  Schema.TaggedStruct('select-slot', { slot: CommandSlotIndex }),
  Schema.TaggedStruct('move-item', {
    source: CommandSlotIndex,
    destination: CommandSlotIndex,
    count: CommandItemCount,
  }),
  Schema.TaggedStruct('drop-item', {
    source: CommandSlotIndex,
    destination: Schema.Literal('world'),
    count: CommandItemCount,
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
    source: PlayerSlotEndpoint,
    destination: ContainerSlotEndpoint,
    count: CommandItemCount,
  }),
  Schema.TaggedStruct('move-item', {
    source: ContainerSlotEndpoint,
    destination: PlayerSlotEndpoint,
    count: CommandItemCount,
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
    source: PlayerSlotEndpoint,
    destination: FurnaceSlotEndpoint,
    count: CommandItemCount,
  }),
  Schema.TaggedStruct('move-item', {
    source: FurnaceSlotEndpoint,
    destination: PlayerSlotEndpoint,
    count: CommandItemCount,
  }),
  Schema.TaggedStruct('take-output', {
    source: FurnaceOutputEndpoint,
    destination: PlayerSlotEndpoint,
    count: CommandItemCount,
  }),
).annotations(strictAction)
export type FurnaceAction = typeof FurnaceAction.Type

export const PlayerInventoryCommand = Schema.TaggedStruct('PlayerInventoryCommand', {
  ...CommandHeader,
  action: PlayerInventoryAction,
})
export const PlayerVitalsCommand = Schema.TaggedStruct('PlayerVitalsCommand', {
  ...CommandHeader,
  action: Schema.Union(
    Schema.Literal('respawn'),
    Schema.TaggedStruct('activity', {
      activity: Schema.Literal('walk', 'swim', 'jump', 'attack', 'mine'),
      amount: Schema.Number.pipe(Schema.finite(), Schema.positive(), Schema.lessThanOrEqualTo(100)),
    }),
    Schema.TaggedStruct('eat', { item: Schema.String.pipe(Schema.minLength(1)) }),
  ),
})
export const WorldTimeWeatherCommand = Schema.TaggedStruct('WorldTimeWeatherCommand', {
  ...CommandHeader,
  action: WorldTimeWeatherAction,
})
export const ContainerCommand = Schema.TaggedStruct('ContainerCommand', {
  ...CommandHeader,
  containerId: Schema.String.pipe(Schema.minLength(1)),
  action: ContainerAction,
})
export const FurnaceCommand = Schema.TaggedStruct('FurnaceCommand', {
  ...CommandHeader,
  furnaceId: Schema.String.pipe(Schema.minLength(1)),
  action: FurnaceAction,
})
export const VillagerTradeCommand = Schema.TaggedStruct('VillagerTradeCommand', {
  ...CommandHeader,
  villagerId: Schema.String.pipe(Schema.minLength(1)),
  offerId: Schema.String.pipe(Schema.minLength(1)),
  action: Schema.Literal('execute-trade'),
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
export const IgniteTntCommand = Schema.TaggedStruct('IgniteTntCommand', {
  ...CommandHeader,
  at: BlockPos,
})
export const EnderPearlCommand = Schema.TaggedStruct('EnderPearlCommand', {
  ...CommandHeader,
})
export const FishingCommand = Schema.TaggedStruct('FishingCommand', {
  ...CommandHeader,
  action: Schema.Literal('cast', 'reel'),
})
export const VehicleCommand = Schema.TaggedStruct('VehicleCommand', {
  ...CommandHeader,
  entityId: EntityId,
  action: Schema.Union(
    Schema.Literal('mount', 'dismount'),
    Schema.TaggedStruct('move', { at: Vec3 }),
  ),
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
  EnderPearlCommand,
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
  world: WorldId,
  revision: Revision,
})
export const AuthoritativeCommandRejected = Schema.TaggedStruct('AuthoritativeCommandRejected', {
  commandId: CommandId,
  world: WorldId,
  revision: Revision,
  reason: CommandRejectionReason,
  resyncRequired: Schema.Boolean,
})
export const AuthoritativeCommandResult = Schema.Union(
  AuthoritativeCommandAccepted,
  AuthoritativeCommandRejected,
)
export type AuthoritativeCommandResult = typeof AuthoritativeCommandResult.Type

export const AuthoritativeResyncRequest = Schema.TaggedStruct('AuthoritativeResyncRequest', {
  world: WorldId,
  lastKnownRevision: Schema.optional(Revision),
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
  'EnderPearlCommand',
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
  protocolVersion: Schema.Number.pipe(Schema.int()),
  message: NetworkMessage,
})
export type Frame = typeof Frame.Type

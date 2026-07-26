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
  at: Vec3,
  facing: Orientation,
})
export type PlayerMove = typeof PlayerMove.Type

export const BlockPlace = Schema.TaggedStruct('BlockPlace', {
  player: PlayerId,
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

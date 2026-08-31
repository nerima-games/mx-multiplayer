/**
 * @nerima-games/mx-multiplayer — network synchronisation for the nerima-games
 * Minecraft-clone rebuild.
 *
 * Tier 3 (experience module) in the four-tier architecture. Its one runtime
 * dependency in the plan's graph is `@nerima-games/mc-sim`; it has no edge to
 * mx-gameplay, mx-redstone or mx-ui, because experience modules do not know one
 * another (plan.md §2.3-1).
 *
 * Scope, per plan.md §3.14: TRANSPORT AND PROTOCOL ONLY. The server list, the
 * join dialog, the player-roster overlay and the main-menu flow that reaches
 * them are mx-ui's. Applying a remote peer's action to the world is done by
 * writing through an mc-sim service, never by calling into a rules module.
 */

export * from './application/browser-transport.js'
export * from './domain/codec.js'
export * from './domain/authoritative-sync.js'
export * from './domain/authoritative-session.js'
export * from './domain/connection.js'
export * from './domain/errors.js'
export * from './domain/hunger-authority.js'
export * from './domain/protocol.js'
export * from './domain/snapshot-interpolation.js'
export * from './domain/survival-authority.js'
export * from './domain/transport.js'

// --- Stages: this repository's contribution to the frame ---------------------
//
// `multiplayerModule` is what a host merges; `MULTIPLAYER_STAGE_IDS` is what a
// Consumer names. mc-compose's standard stage skeleton owns their placement:
// Inbound precedes simulation and outbound follows authoritative simulation.
export * from './stages/registration.js'
export * from './stages/stage-ids.js'

// `StageId`, `DeltaTimeSecs`, `StageRegistration` and `GameModule` come from
// @nerima-games/mc-kernel and are deliberately NOT re-exported here: doing so
// Would make them part of THIS package's published surface, and a consumer
// That took them from here rather than from kernel would be depending on this
// Package for kernel's own types. mx-gameplay and mx-redstone make the same
// Call for the same reason.

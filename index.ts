/**
 * @nerima-games/mx-multiplayer — network synchronisation for the nerima-games
 * Minecraft-clone rebuild.
 *
 * PRE-AUDIT FIRST CUT (叩き台). See README.md 現状.
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

export * from './domain/codec'
export * from './domain/connection'
export * from './domain/errors'
export * from './domain/protocol'
export * from './domain/transport'

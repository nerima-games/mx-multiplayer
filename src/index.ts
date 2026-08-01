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
export * from './domain/authoritative-sync'
export * from './domain/connection'
export * from './domain/errors'
export * from './domain/protocol'
export * from './domain/snapshot-interpolation'
export * from './domain/transport'

// --- Stages: this repository's contribution to the frame ---------------------
//
// `multiplayerModule` is what a host merges; `MULTIPLAYER_STAGE_IDS` is what a
// consumer names. Read `stages/stage-ids.ts` before either: mc-compose's
// standard stage skeleton has no phase that claims a `multiplayer:` id, so both
// stages currently resolve to the END of the frame, after the HUD.
export * from './stages/registration'
export * from './stages/stage-ids'

// `domain/frame-contract.ts` is a temporary local stand-in for
// @nerima-games/mc-kernel and is NOT re-exported: it carries a deletion date
// (see its "WHY THIS FILE EXISTS AND WHEN IT DIES" header), and re-exporting it
// would make `StageId`, `DeltaTimeSecs` and `StageRegistration` part of THIS
// package's published surface — so a consumer would still be importing them
// from here on the day the file is deleted. They appear in `api-lock.md`'s
// "supporting declarations" section instead: not exported, but named by an
// export. mx-gameplay and mx-redstone make the same call for the same reason.

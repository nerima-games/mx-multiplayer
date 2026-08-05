/**
 * Every `StageId` this repository writes down, in one file.
 *
 * Two kinds live here and the distinction is the point:
 *
 *   - `MULTIPLAYER_STAGE_IDS` — stages mx-multiplayer OWNS and registers.
 *   - `UPSTREAM_STAGE_IDS` — stages owned by somebody else that mx-multiplayer
 *     names in an `after` constraint.
 *
 * A stage id is a string, so naming one creates no import and no dependency
 * edge. That is exactly why they must be collected here rather than scattered:
 * an `after` edge is invisible to the dependency-whitelist gate, so the only way
 * to review "who does mx-multiplayer claim to run after" is to be able to read
 * the whole answer at once. `test/stage-registration.test.ts` reads this file and
 * fails if an edge points at a sibling experience module.
 *
 * mc-compose's `STANDARD_STAGE_SKELETON` owns cross-repository placement.
 * `multiplayer:inbound` runs in its network-inbound phase before simulation;
 * `multiplayer:outbound` runs in network-outbound after authoritative simulation
 * and before rendering. Keeping that placement outside this package prevents a
 * transport package from claiming gameplay or presentation authority.
 */
import { StageId } from '../domain/frame-contract'

/**
 * Stages owned by mx-multiplayer.
 *
 * ---------------------------------------------------------------------------
 * Why two stages and not one
 * ---------------------------------------------------------------------------
 *
 * The two halves of network synchronisation have opposite ordering
 * requirements, and a single stage can satisfy only one of them:
 *
 *   - what arrived from a peer must be applied BEFORE the simulation reads it,
 *     or every remote action lands one frame late;
 *   - what the local player did must be published AFTER the simulation has
 *     written it, or every peer sees a pre-integration position — the same
 *     one-frame lag mc-render's `render:camera-mirror` exists to avoid, pointed
 *     outwards.
 *
 * One stage would have to sit either before or after simulation, so one of the
 * two lags would be built in permanently. Two stages state the requirement
 * honestly and cost nothing: a stage is a registration, not a fiber.
 *
 * They are also independent, which is why neither declares an edge to the
 * other: `inbound` drains the transport's receive queue and `outbound` drains an
 * outbox, and no read of either depends on the other having run.
 */
export const MULTIPLAYER_STAGE_IDS = {
  /**
   * Drain the transport's inbound queue, decode each frame, and hand the
   * decoded messages to the seam.
   *
   * Decoding is not interpreting. This stage does not know what a `BlockBreak`
   * means and must not learn: plan.md §3.14 confines this repository to
   * transport and protocol, and DN-9 records what happened in the reference
   * implementation when it did not hold — first-come claim arbitration ended up
   * in `server-handlers.ts`, so changing an inventory rule meant editing the
   * network layer.
   */
  inbound: StageId('multiplayer:inbound'),
  /**
   * Publish the frames the local session wants to send, if the connection
   * permits sending.
   *
   * `domain/connection.ts`'s `canSend` is the permission. This stage checks it
   * before draining queued application work; socket adapters enforce the same
   * invariant at their boundary with `connectionGatedTransport`. `sendMessage`
   * remains state-agnostic for handshake traffic and backward compatibility.
   */
  outbound: StageId('multiplayer:outbound'),
} as const

/**
 * Stages owned by OTHER repositories that mx-multiplayer orders itself against.
 *
 * Exactly one entry, and it is the only edge this repository is entitled to
 * declare.
 *
 * `sim:physics` is a stage of mc-sim, this repository's one declared parent
 * (plan.md §2.1). `multiplayer:outbound` must publish the position the
 * simulation RESOLVED this frame; publishing the pre-integration one puts every
 * peer's view of this player a frame behind, which reads as network lag rather
 * than as a bug and is therefore the kind of thing nobody files. That is
 * mc-render's argument for `render:camera-mirror after sim:physics`, and it is
 * the same argument because it is the same one-frame lag seen from the far end
 * of a socket.
 *
 * Note what is NOT declared, and why each absence is deliberate:
 *
 * - NOTHING for `multiplayer:inbound`. Its requirement is that it run BEFORE
 *   `sim:physics`, and `after` cannot express "before". Inverting it into
 *   `after: [StageId('render:input')]` would be a claim about the global order
 *   that plan.md §2.3-3 reserves to mc-compose, would not be true of a headless
 *   build that registers no input stage, and would still not order this stage
 *   against `sim:physics` — it would only pin it behind a stage that happens to
 *   precede it today.
 *
 * - NO EDGE BETWEEN THE TWO STAGES. `outbound after inbound` would be a claim
 *   about the global order too: the two belong to different phases, so once
 *   mc-compose adds them the skeleton chain provides the ordering, and declaring
 *   it here would be redundant. mx-gameplay's `stages/stage-ids.ts:50-58`
 *   refuses a redundant edge for exactly this reason — "Declare what your own
 *   correctness needs; let mc-compose have the rest" — and neither stage's
 *   correctness depends on the other, because they touch disjoint state.
 *
 * - NOTHING NAMING `gameplay:`, `redstone:` OR `ui:`. §2.3-1: experience modules
 *   have zero edges between them, and an `after` naming one would evade
 *   `pnpm check:deps` — it is a string — while coupling this repository's frame
 *   position to a sibling's existence. `test/stage-registration.test.ts` closes
 *   that gap.
 */
export const UPSTREAM_STAGE_IDS = {
  simPhysics: StageId('sim:physics'),
} as const

/**
 * The `<repo>:` prefixes belonging to the four experience modules (plan.md
 * §2.2).
 *
 * Used by the regression test that enforces §2.3-1's zero-edge rule at the
 * ordering level as well as the import level. `multiplayer:` is in the list and
 * is also this repository's own prefix, so the test excludes `OWN_STAGE_PREFIX`
 * before checking — the same shape mx-gameplay, mx-redstone, mx-ui and mc-render
 * all use.
 */
export const EXPERIENCE_MODULE_STAGE_PREFIXES = ['gameplay:', 'redstone:', 'ui:', 'multiplayer:'] as const

/** This repository's own prefix, excluded when checking for sibling edges. */
export const OWN_STAGE_PREFIX = 'multiplayer:'

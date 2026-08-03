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
 * ---------------------------------------------------------------------------
 * READ THIS BEFORE TRUSTING THESE IDS: THE SKELETON HAS NO PHASE FOR EITHER
 * ---------------------------------------------------------------------------
 *
 * mc-compose's `domain/stage-order.ts` assigns a stage to a phase by the NAME
 * half of its id — the part after the last colon — or by a whole namespace when
 * a phase lists one ending in `:`. `domain/stage-skeleton.ts`'s twelve phases
 * claim these names and nothing else:
 *
 *   input | physics | interactions | entities | fluids | redstone (+ `redstone:`)
 *   | time-weather | weather | camera-mirror | chunk-sync | mesh-sync | render
 *   | draw | post-fx | hud-sync (+ `ui:`)
 *
 * `inbound` is not there. Neither is `outbound`, nor `multiplayer:`, nor any
 * name a network stage would plausibly use. `priorityOf` answers
 * `MAX_SAFE_INTEGER` for a stage in no phase, which sorts it after every stage
 * that is in one, and the skeleton contributes no implicit edge to or from it.
 *
 * MEASURED, against mc-compose's real resolver and skeleton with the roster
 * exactly as `mc-compose/test/e2e/roster.ts` transcribes it plus `sim:physics`:
 *
 *    0 render:input           7 gameplay:time-weather   14 multiplayer:inbound
 *    1 sim:physics            8 render:camera-mirror    15 multiplayer:outbound
 *    2 gameplay:interactions  9 render:chunk-sync
 *    3 gameplay:entities     10 render:draw
 *    4 gameplay:fluids       11 render:post-fx
 *    5 redstone:power        12 ui:hud-sync
 *    6 redstone:effects      13 ui:overlay-sync
 *
 *    unmatchedPhase: multiplayer:inbound, multiplayer:outbound
 *
 * BOTH STAGES RUN AFTER THE HUD. Remote state would be applied one frame late,
 * every frame, and the local player's position would be published a frame after
 * the renderer already drew it. Neither is a crash and neither is visible from
 * inside this repository, which is what makes it the kind of defect that ships.
 *
 * THE FIX IS NOT HERE. plan.md §2.3-3 gives the skeleton to mc-compose alone,
 * and there is no `before` in `StageRegistration` — see `domain/frame-contract.ts`
 * — so `multiplayer:inbound` in particular CANNOT be placed by anything this
 * repository writes. What mc-compose needs is two phases, and this file names
 * them precisely so the request is not a guess:
 *
 *   - a phase between `STAGE_PHASE_INPUT` and `STAGE_PHASE_SIM_PHYSICS`, whose
 *     `members` claim the stage name `inbound`. Remote state has to be in the
 *     world before the world is simulated, exactly as `render:input` has to be
 *     sampled before anything reacts to it — and `render:input` is the precedent
 *     in every respect: it declares no `after` either, and its comment says
 *     "where that lands in the frame is mc-compose's to decide — its skeleton
 *     claims the NAME half of this id (`input`) for the first phase."
 *
 *   - a phase between `STAGE_PHASE_SIM_TIME_WEATHER` and
 *     `STAGE_PHASE_CAMERA_MIRROR`, whose `members` claim the stage name
 *     `outbound`. The frame's authoritative state is settled at the end of
 *     simulation; everything after it is presentation, which is local and never
 *     crosses the wire. Publishing after `render`/`post-fx` would add the
 *     frame's largest cost to the latency of state that was already final.
 *
 * A namespace phase (`multiplayer:`) would NOT work, and the reason is worth
 * recording: it would claim both stages for one position, and the whole point of
 * splitting them is that they belong at opposite ends of the frame.
 *
 * The alternative — naming these stages something the skeleton already claims,
 * so they land somewhere plausible today — was rejected. `multiplayer:entities`
 * would resolve into the `simulation:entities` phase and the frame would look
 * correct, but this repository would be claiming to do entity simulation, which
 * plan.md §3.14 forbids it from doing, and the missing phase would stop being
 * visible to anyone. An id that is honest and unplaced is a question somebody
 * can answer; an id that is dishonest and placed is not.
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

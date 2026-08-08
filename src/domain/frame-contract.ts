/**
 * The frame / module composition contract (plan.md §4.1), restated locally.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXISTS AND WHEN IT DIES
 * ---------------------------------------------------------------------------
 *
 * These declarations belong to `@nerima-games/mc-kernel` (`domain/frame.ts`,
 * `domain/identifiers.ts`, `domain/quantities.ts`). This repository does not
 * import them, because the roll-out is bottom-up publish-then-pin: nothing is on
 * GitHub Packages yet, so there is no version of kernel to depend on. Declaring
 * a dependency we cannot install would leave a skeleton that does not build.
 *
 * So the contract is restated here, deliberately character-identical to kernel's
 * copy in the parts that matter (`StageRegistration`, the brands' predicates and
 * error messages), and this file is DELETED the moment mc-kernel is published:
 *
 *     import type { StageRegistration } from '@nerima-games/mc-kernel'
 *
 * The one intentional divergence is `FrameServices`; see its note below.
 *
 * It is NOT re-exported from `index.ts`, for the same reason mx-gameplay and
 * mx-redstone do not re-export theirs: `StageId` and `DeltaTimeSecs` would
 * become part of mx-multiplayer's published surface, and a consumer that took
 * them from here rather than from kernel would still be importing them from here
 * on the day this file is deleted.
 *
 * Nothing else in this repository may restate a kernel type. Note that
 * `domain/protocol.ts` re-declares `Vec3`, `PlayerId` and friends and that is a
 * DIFFERENT decision with its own argument (a wire schema and a domain type have
 * different change budgets — see that file's header); these are contract types,
 * not wire types, and there is no version of them that an old peer is still
 * sending.
 */
import { Brand, type Effect, type Layer } from 'effect'

/**
 * Identifies a frame stage. Stage ids are the vertices of the per-frame ordering
 * graph and are STRINGS ON PURPOSE: `after: [StageId('sim:physics')]` expresses
 * "run me after mc-sim's physics" without importing anything from mc-sim's stage
 * module, and `after: [StageId('gameplay:interactions')]` would express an
 * ordering relative to a sibling experience module without creating a dependency
 * edge to it (plan.md §2.3-1, §2.3-3).
 *
 * Convention: `<owning-repo-suffix>:<stage>`. Everything this repository owns is
 * prefixed `multiplayer:`.
 */
export type StageId = string & Brand.Brand<'StageId'>

/** A trimmed `StageId` shorter than this (i.e. empty) fails the brand's refinement. */
const MIN_STAGE_ID_LENGTH = 0

export const StageId = Brand.refined<StageId>(
  (value) => value.trim().length > MIN_STAGE_ID_LENGTH,
  (value) => Brand.error(`StageId must be a non-blank string, received ${JSON.stringify(value)}`),
)

/**
 * Elapsed simulation time for one frame, in seconds.
 *
 * Non-negative and finite. A zero delta is legal and must be handled by stages
 * rather than rejected — which for this repository means "move whatever frames
 * are queued", because a network stage's work is driven by what arrived, not by
 * how much time passed. Nothing here divides by `dt`; nothing here should.
 */
export type DeltaTimeSecs = number & Brand.Brand<'DeltaTimeSecs'>

/** A zero delta is legal (see the header comment above); only a negative one fails the brand's refinement. */
const MIN_DELTA_TIME_SECS = 0

export const DeltaTimeSecs = Brand.refined<DeltaTimeSecs>(
  (value) => Number.isFinite(value) && value >= MIN_DELTA_TIME_SECS,
  (value) => Brand.error(`DeltaTimeSecs must be a finite, non-negative number of seconds, received ${value}`),
)

/**
 * The context every frame stage may assume is present.
 *
 * kernel aliases this to `ClockPort`; here it is `never`, and that is a
 * deliberate divergence rather than an oversight. Restating `ClockPort` locally
 * would mean constructing a second `Context.Tag` with the same textual
 * identifier as kernel's — two tags that look identical and are not, which is a
 * far worse failure than a narrower type.
 *
 * `never` is forward-compatible in the direction that matters: an
 * `Effect<void, never, never>` is assignable wherever `Effect<void, never,
 * ClockPort>` is wanted, so every stage written against this file keeps
 * typechecking when the alias is replaced by the kernel import. Widening
 * `FrameServices` is a breaking change for whoever BUILDS the runtime, never for
 * stage authors — see kernel's note on the same alias.
 *
 * It also happens to be honest here in a way it is not everywhere: DN-3 bans a
 * wall clock from this repository outright, and the stages below read no clock
 * of any kind. `Ping`/`Pong` carry a nonce precisely so that the round-trip
 * measurement — the one thing here that would want a clock — belongs to the
 * caller and not to the protocol.
 */
export type FrameServices = never

/**
 * One unit of per-frame work, contributed by a repository.
 *
 * `after` declares ORDERING EDGES ONLY. It is not a dependency on the named
 * stage existing, and it is not a request for a position in the sequence: the
 * total order over all stages from all modules is resolved solely by mc-compose
 * (plan.md §2.3-3, §4.2). A module that tried to declare its own absolute
 * position would be making a decision it cannot make correctly, because it
 * cannot see the other modules.
 *
 * NOTE WHAT IS NOT HERE: a `before`. This matters more to mx-multiplayer than to
 * anyone else in the roster, because half of this repository's frame work has to
 * run BEFORE the simulation reads it and the contract gives no way to say so.
 * See `stages/stage-ids.ts`.
 *
 * Reproduced verbatim from plan.md §4.1, `interface` and all.
 */
export interface StageRegistration {
  readonly id: StageId
  readonly after?: ReadonlyArray<StageId>
  readonly run: (dt: DeltaTimeSecs) => Effect.Effect<void, never, FrameServices>
}

/**
 * A repository's contribution to a running game.
 *
 * `ROut`      — services this module provides.
 * `Err`       — errors that can occur while *building* those services.
 * `RIn`       — services this module needs to be given in order to build.
 * `RRegister` — services this module needs in order to REGISTER its stages.
 *
 * `frameStages` is an Effect rather than an array because a module needs a
 * moment at which it can ACQUIRE a service in order to build a stage. With a
 * value the only channel was `run`, which forced every service any stage touched
 * into `FrameServices`, and that in turn would have forced kernel to name
 * mc-sim's and mc-render's services — which plan.md §2.2's tier model forbids
 * outright.
 *
 * mx-multiplayer is the case that shows `RRegister` is not merely `ROut`
 * rephrased. mc-render acquires `InputService`, which it PROVIDES; this
 * repository acquires `TransportPort`, which it DEFINES and does not provide —
 * the real socket adapter is a platform layer outside this repository
 * (`domain/transport.ts`). So `RRegister` here is a genuine external
 * requirement with `ROut = never`, and a host has to satisfy it before a single
 * `multiplayer:` stage can be registered.
 */
export interface GameModule<ROut, Err, RIn, RRegister = never> {
  readonly layers: Layer.Layer<ROut, Err, RIn>
  readonly frameStages: Effect.Effect<ReadonlyArray<StageRegistration>, never, RRegister>
}

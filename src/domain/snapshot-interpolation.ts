import type { Orientation, PlayerId, Vec3 } from './protocol.js'
import { Result } from 'effect'
import { SnapshotInterpolationConfigError } from './errors.js'

export type PlayerTransformSnapshot = {
  /** Monotonic server-assigned packet sequence for this player. */
  readonly sequence: number
  /** Monotonic simulation tick at which the authoritative transform was produced. */
  readonly tick: number
  readonly at: Vec3
  readonly facing: Orientation
}

export type SnapshotInterpolatorConfig = {
  /** Maximum snapshots retained per player, including the newest one. */
  readonly historyLimit: number
  /** Distance at or above which movement is treated as a teleport. */
  readonly teleportDistance: number
}

export type SnapshotIngestResult =
  | { readonly accepted: true; readonly historySize: number }
  | { readonly accepted: false; readonly reason: 'invalid' | 'duplicate-or-stale' }

/** Shared lower bound for `sequence` and `tick`: both are counts, never negative. */
const MIN_SEQUENCE_OR_TICK = 0

/** The literal zero, named at each call site below for what that particular zero means. */
const ZERO = 0

/** `Array#at`'s index for "the last element". */
const LAST_INDEX = -1

/** A full turn is two half turns (`Math.PI` each). */
const FULL_TURN_MULTIPLIER = 2

/** Below this, `sample`'s neighbor-pair scan has no earlier snapshot to interpolate from. */
const NEIGHBOR_OFFSET = 1

/** A buffer holding fewer than this cannot bracket a render tick between two snapshots. */
const MIN_HISTORY_LIMIT = 2
const SQRT_THREE = Math.sqrt(3)
const MAX_FINITE_NUMBER = Number.MAX_VALUE

const validSnapshot = (snapshot: PlayerTransformSnapshot): boolean =>
  Number.isSafeInteger(snapshot.sequence) &&
  snapshot.sequence >= MIN_SEQUENCE_OR_TICK &&
  Number.isSafeInteger(snapshot.tick) &&
  snapshot.tick >= MIN_SEQUENCE_OR_TICK &&
  Number.isFinite(snapshot.at.x) &&
  Number.isFinite(snapshot.at.y) &&
  Number.isFinite(snapshot.at.z) &&
  Number.isFinite(snapshot.facing.yawRadians) &&
  Number.isFinite(snapshot.facing.pitchRadians)

const isNonEmptyHistory = (
  history: ReadonlyArray<PlayerTransformSnapshot>,
): history is readonly [PlayerTransformSnapshot, ...Array<PlayerTransformSnapshot>] => history.length > ZERO

const axisDistance = (left: number, right: number): number | undefined => {
  const crossesZero = (left < ZERO && right > ZERO) || (left > ZERO && right < ZERO)
  const leftMagnitude = Math.abs(left)
  const rightMagnitude = Math.abs(right)
  if (crossesZero && leftMagnitude > MAX_FINITE_NUMBER - rightMagnitude) {
    return undefined
  }
  return Math.abs(right - left)
}

const atOrBeyondDistance = (left: Vec3, right: Vec3, threshold: number): boolean => {
  const x = axisDistance(left.x, right.x)
  const y = axisDistance(left.y, right.y)
  const z = axisDistance(left.z, right.z)
  if (x === undefined || y === undefined || z === undefined) {
    return true
  }

  const scale = Math.max(x, y, z)
  if (scale === ZERO) {
    return false
  }
  if (scale >= threshold) {
    return true
  }
  if (scale < threshold / SQRT_THREE) {
    return false
  }

  const scaledDistance = Math.sqrt((x / scale) ** 2 + (y / scale) ** 2 + (z / scale) ** 2)
  return scaledDistance >= threshold / scale
}

const lerp = (left: number, right: number, alpha: number): number =>
  left * (1 - alpha) + right * alpha

const interpolateYaw = (left: number, right: number, alpha: number): number => {
  const fullTurn = Math.PI * FULL_TURN_MULTIPLIER
  const leftTurn = left % fullTurn
  const rightTurn = right % fullTurn
  const shortest = ((rightTurn - leftTurn + Math.PI) % fullTurn + fullTurn) % fullTurn - Math.PI
  return left + shortest * alpha
}

/**
 * Per-player authoritative snapshot history and deterministic render sampling.
 *
 * The buffer deliberately does not read a clock. Callers choose `renderTick`
 * (normally server tick minus an interpolation delay), making replay tests and
 * production rendering use exactly the same calculation.
 */
export class SnapshotInterpolator {
  readonly #config: SnapshotInterpolatorConfig
  readonly #history = new Map<PlayerId, Array<PlayerTransformSnapshot>>()

  static make(
    config: SnapshotInterpolatorConfig,
  ): Result.Result<SnapshotInterpolator, SnapshotInterpolationConfigError> {
    if (!Number.isSafeInteger(config.historyLimit) || config.historyLimit < MIN_HISTORY_LIMIT) {
      return Result.fail(
        new SnapshotInterpolationConfigError({
          detail: 'historyLimit must be a safe integer of at least 2',
          reason: 'invalid-history-limit',
        }),
      )
    }
    if (!Number.isFinite(config.teleportDistance) || config.teleportDistance <= ZERO) {
      return Result.fail(
        new SnapshotInterpolationConfigError({
          detail: 'teleportDistance must be finite and greater than zero',
          reason: 'invalid-teleport-distance',
        }),
      )
    }
    return Result.succeed(new SnapshotInterpolator(config))
  }

  private constructor(config: SnapshotInterpolatorConfig) {
    this.#config = { ...config }
  }

  ingest(player: PlayerId, snapshot: PlayerTransformSnapshot): SnapshotIngestResult {
    if (!validSnapshot(snapshot)) {
      return { accepted: false, reason: 'invalid' }
    }

    const history = this.#history.get(player) ?? []
    if (SnapshotInterpolator.#isStaleOrDuplicate(history, snapshot)) {
      return { accepted: false, reason: 'duplicate-or-stale' }
    }

    history.push(snapshot)
    this.#trimToLimit(history)
    this.#history.set(player, history)
    return { accepted: true, historySize: history.length }
  }

  static #isStaleOrDuplicate(history: ReadonlyArray<PlayerTransformSnapshot>, snapshot: PlayerTransformSnapshot): boolean {
    const newest = history.at(LAST_INDEX)
    return newest !== undefined && (snapshot.sequence <= newest.sequence || snapshot.tick <= newest.tick)
  }

  #trimToLimit(history: Array<PlayerTransformSnapshot>): void {
    if (history.length > this.#config.historyLimit) {
      history.splice(ZERO, history.length - this.#config.historyLimit)
    }
  }

  sample(player: PlayerId, renderTick: number): PlayerTransformSnapshot | undefined {
    if (!Number.isFinite(renderTick)) {
      return undefined
    }
    const history = this.#history.get(player)
    if (history === undefined || !isNonEmptyHistory(history)) {
      return undefined
    }

    const boundary = SnapshotInterpolator.#sampleAtBoundary(history, renderTick)
    if (boundary !== undefined) {
      return boundary
    }

    return this.#interpolate(history, renderTick)
  }

  /** Precondition, enforced by the only caller (`sample`): `history` is non-empty. */
  static #sampleAtBoundary(
    history: readonly [PlayerTransformSnapshot, ...Array<PlayerTransformSnapshot>],
    renderTick: number,
  ): PlayerTransformSnapshot | undefined {
    // The tuple type guarantees that the first element exists; the loop keeps
    // `last` aligned with the final history entry without a non-null assertion.
    const [first] = history
    let last = first
    for (const snapshot of history) {
      last = snapshot
    }
    if (renderTick <= first.tick) {
      return first
    }
    if (renderTick >= last.tick) {
      return last
    }
    return undefined
  }

  /** Precondition, enforced by the only caller (`sample`): `first.tick < renderTick < last.tick`. */
  #interpolate(
    history: readonly [PlayerTransformSnapshot, ...Array<PlayerTransformSnapshot>],
    renderTick: number,
  ): PlayerTransformSnapshot | undefined {
    let [left] = history
    for (const right of history.slice(NEIGHBOR_OFFSET)) {
      // The tuple and slice preserve the non-empty history invariant, so both
      // Interpolation endpoints are defined for every iteration.
      if (renderTick <= right.tick) {
        return this.#interpolatePair(left, right, renderTick)
      }
      left = right
      // Unreachable: the precondition above guarantees some `right` in this
      // Loop satisfies `renderTick <= right.tick` no later than the final
      // Element, so the loop always returns from inside the `if` above. The
      // `-- @preserve` suffix is required under vitest 4 (Vitest 4.1 restored
      // Ignore-hint support but esbuild strips ignore comments lacking it).
      /* v8 ignore next -- @preserve */
    }
    return history.at(LAST_INDEX)
  }

  #interpolatePair(
    left: PlayerTransformSnapshot,
    right: PlayerTransformSnapshot,
    renderTick: number,
  ): PlayerTransformSnapshot {
    if (atOrBeyondDistance(left.at, right.at, this.#config.teleportDistance)) {
      if (renderTick < right.tick) {
        return left
      }
      return right
    }

    const alpha = (renderTick - left.tick) / (right.tick - left.tick)
    return {
      at: {
        x: lerp(left.at.x, right.at.x, alpha),
        y: lerp(left.at.y, right.at.y, alpha),
        z: lerp(left.at.z, right.at.z, alpha),
      },
      facing: {
        pitchRadians: lerp(left.facing.pitchRadians, right.facing.pitchRadians, alpha),
        yawRadians: interpolateYaw(left.facing.yawRadians, right.facing.yawRadians, alpha),
      },
      sequence: right.sequence,
      tick: renderTick,
    }
  }

  historySize(player: PlayerId): number {
    return this.#history.get(player)?.length ?? ZERO
  }

  /** Remove one peer on leave, or every peer when the transport disconnects. */
  disconnect(player?: PlayerId): void {
    if (player === undefined) {this.#history.clear()}
    else {this.#history.delete(player)}
  }
}

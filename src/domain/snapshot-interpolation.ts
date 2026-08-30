import type { Orientation, PlayerId, Vec3 } from './protocol.js'

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

const distance = (left: Vec3, right: Vec3): number =>
  Math.hypot(right.x - left.x, right.y - left.y, right.z - left.z)

const lerp = (left: number, right: number, alpha: number): number =>
  left + (right - left) * alpha

const interpolateYaw = (left: number, right: number, alpha: number): number => {
  const fullTurn = Math.PI * FULL_TURN_MULTIPLIER
  const shortest = ((right - left + Math.PI) % fullTurn + fullTurn) % fullTurn - Math.PI
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

  constructor(config: SnapshotInterpolatorConfig) {
    if (!Number.isSafeInteger(config.historyLimit) || config.historyLimit < MIN_HISTORY_LIMIT) {
      throw new RangeError('historyLimit must be a safe integer of at least 2')
    }
    if (!Number.isFinite(config.teleportDistance) || config.teleportDistance <= ZERO) {
      throw new RangeError('teleportDistance must be finite and greater than zero')
    }
    this.#config = config
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
    if (history === undefined || history.length === ZERO) {
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
    history: ReadonlyArray<PlayerTransformSnapshot>,
    renderTick: number,
  ): PlayerTransformSnapshot | undefined {
    // Non-null: a non-empty array's first element and `.at(-1)` are always
    // Present; there is no runtime path here where either is `undefined`.
    const [first] = history as [PlayerTransformSnapshot, ...Array<PlayerTransformSnapshot>]
    const last = history.at(LAST_INDEX) as PlayerTransformSnapshot
    if (renderTick <= first.tick) {
      return first
    }
    if (renderTick >= last.tick) {
      return last
    }
    return undefined
  }

  /** Precondition, enforced by the only caller (`sample`): `first.tick < renderTick < last.tick`. */
  #interpolate(history: ReadonlyArray<PlayerTransformSnapshot>, renderTick: number): PlayerTransformSnapshot {
    for (let index = NEIGHBOR_OFFSET; index < history.length; index += NEIGHBOR_OFFSET) {
      // Non-null: `index` ranges over `[NEIGHBOR_OFFSET, history.length)`, so both
      // `history[index]` and `history[index - NEIGHBOR_OFFSET]` are always in
      // Bounds — the same array-length invariant `#sampleAtBoundary` relies on.
      // Without this, `left !== undefined && right !== undefined` would add two
      // Branches no test can take the false side of, since the loop bounds
      // Already guarantee both are defined.
      const right = history[index] as PlayerTransformSnapshot
      const left = history[index - NEIGHBOR_OFFSET] as PlayerTransformSnapshot
      if (renderTick <= right.tick) {
        return this.#interpolatePair(left, right, renderTick)
      }
      // Unreachable: the precondition above guarantees some `right` in this
      // Loop satisfies `renderTick <= right.tick` no later than the final
      // Element, so the loop always returns from inside the `if` above. The
      // `-- @preserve` suffix is required under vitest 4 (Vitest 4.1 restored
      // Ignore-hint support but esbuild strips ignore comments lacking it).
      /* v8 ignore next -- @preserve */
    }
    /* v8 ignore next -- @preserve */
    throw new Error('unreachable: renderTick was not strictly within the sampled history')
  }

  #interpolatePair(
    left: PlayerTransformSnapshot,
    right: PlayerTransformSnapshot,
    renderTick: number,
  ): PlayerTransformSnapshot {
    if (distance(left.at, right.at) >= this.#config.teleportDistance) {
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

import type { Orientation, PlayerId, Vec3 } from './protocol'

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

const validSnapshot = (snapshot: PlayerTransformSnapshot): boolean =>
  Number.isSafeInteger(snapshot.sequence) &&
  snapshot.sequence >= 0 &&
  Number.isSafeInteger(snapshot.tick) &&
  snapshot.tick >= 0 &&
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
  const fullTurn = Math.PI * 2
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
    if (!Number.isSafeInteger(config.historyLimit) || config.historyLimit < 2) {
      throw new RangeError('historyLimit must be a safe integer of at least 2')
    }
    if (!Number.isFinite(config.teleportDistance) || config.teleportDistance <= 0) {
      throw new RangeError('teleportDistance must be finite and greater than zero')
    }
    this.#config = config
  }

  ingest(player: PlayerId, snapshot: PlayerTransformSnapshot): SnapshotIngestResult {
    if (!validSnapshot(snapshot)) return { accepted: false, reason: 'invalid' }

    const history = this.#history.get(player) ?? []
    const newest = history.at(-1)
    if (
      newest !== undefined &&
      (snapshot.sequence <= newest.sequence || snapshot.tick <= newest.tick)
    ) {
      return { accepted: false, reason: 'duplicate-or-stale' }
    }

    history.push(snapshot)
    if (history.length > this.#config.historyLimit) {
      history.splice(0, history.length - this.#config.historyLimit)
    }
    this.#history.set(player, history)
    return { accepted: true, historySize: history.length }
  }

  sample(player: PlayerId, renderTick: number): PlayerTransformSnapshot | undefined {
    if (!Number.isFinite(renderTick)) return undefined
    const history = this.#history.get(player)
    if (history === undefined || history.length === 0) return undefined

    const first = history[0]
    const last = history.at(-1)
    if (first === undefined || last === undefined) return undefined
    if (renderTick <= first.tick) return first
    if (renderTick >= last.tick) return last

    for (let index = 1; index < history.length; index += 1) {
      const right = history[index]
      const left = history[index - 1]
      if (left === undefined || right === undefined || renderTick > right.tick) continue

      if (distance(left.at, right.at) >= this.#config.teleportDistance) {
        return renderTick < right.tick ? left : right
      }

      const alpha = (renderTick - left.tick) / (right.tick - left.tick)
      return {
        sequence: right.sequence,
        tick: renderTick,
        at: {
          x: lerp(left.at.x, right.at.x, alpha),
          y: lerp(left.at.y, right.at.y, alpha),
          z: lerp(left.at.z, right.at.z, alpha),
        },
        facing: {
          yawRadians: interpolateYaw(left.facing.yawRadians, right.facing.yawRadians, alpha),
          pitchRadians: lerp(left.facing.pitchRadians, right.facing.pitchRadians, alpha),
        },
      }
    }

    return last
  }

  historySize(player: PlayerId): number {
    return this.#history.get(player)?.length ?? 0
  }

  /** Remove one peer on leave, or every peer when the transport disconnects. */
  disconnect(player?: PlayerId): void {
    if (player === undefined) this.#history.clear()
    else this.#history.delete(player)
  }
}

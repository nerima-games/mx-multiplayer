import { Data, Result, Schema } from 'effect'
import {
  type EntityId,
  type Orientation,
  type PlayerId,
  type Vec3,
  Vec3 as Vec3Schema,
} from './protocol.js'
import { SnapshotInterpolationConfigError } from './errors.js'

export type PlayerTransformSnapshot = {
  /** Monotonic server-assigned packet sequence for this player. */
  readonly sequence: number
  /** Monotonic simulation tick at which the authoritative transform was produced. */
  readonly tick: number
  readonly at: Vec3
  readonly facing: Orientation
}

export type EntityTransformSnapshot = {
  /** Monotonic server-assigned packet sequence for this entity. */
  readonly sequence: PlayerTransformSnapshot['sequence']
  /** Monotonic simulation tick at which the authoritative transform was produced. */
  readonly tick: PlayerTransformSnapshot['tick']
  readonly at: Vec3
}

export type SnapshotInterpolatorConfig = {
  /** Maximum snapshots retained per player or entity, including the newest one. */
  readonly historyLimit: number
  /** Distance above which movement is treated as a teleport. */
  readonly teleportDistance: number
}

export type SnapshotIngestResult =
  | { readonly accepted: true; readonly historySize: number }
  | { readonly accepted: false; readonly reason: 'invalid' | 'duplicate-or-stale' }

export type ServerCorrectionPlan = Readonly<{
  readonly sample: (simulationTick: PlayerTransformSnapshot['tick']) => Result.Result<Vec3, ServerCorrectionError>
}>

export type ServerCorrectionErrorReason = 'invalid-plan-input' | 'invalid-sample-tick'

const ServerCorrectionError_base: ReturnType<typeof Data.TaggedError<'ServerCorrectionError'>> =
  Data.TaggedError('ServerCorrectionError')

export class ServerCorrectionError extends ServerCorrectionError_base<{
  readonly detail: string
  readonly reason: ServerCorrectionErrorReason
}> {}

/** Shared lower bound for `sequence` and `tick`: both are counts, never negative. */
const MIN_SEQUENCE_OR_TICK = 0

/** The literal zero, named at each call site below for what that particular zero means. */
const ZERO = 0

/** `Array#at`'s index for "the last element". */
const LAST_INDEX = -1

/** A full turn is two half turns (`Math.PI` each). */
const FULL_TURN_MULTIPLIER = 2
const VECTOR_COMPONENT_COUNT = 3
const VECTOR_COMPONENT_POWER = 2
const INTERPOLATION_TOTAL_WEIGHT = 1

/** Below this, `sample`'s neighbor-pair scan has no earlier snapshot to interpolate from. */
const NEIGHBOR_OFFSET = 1

/** A buffer holding fewer than this cannot bracket a render tick between two snapshots. */
const MIN_HISTORY_LIMIT = 2
const SQRT_VECTOR_COMPONENT_COUNT = Math.sqrt(VECTOR_COMPONENT_COUNT)
const MAX_FINITE_NUMBER = Number.MAX_VALUE

const NonNegativeTickSchema: Schema.Codec<number, number> = Schema.Number.pipe(
  Schema.check(Schema.isInt()),
  Schema.check(Schema.isGreaterThanOrEqualTo(MIN_SEQUENCE_OR_TICK)),
  Schema.check(Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)),
)
const PositiveTickDurationSchema: Schema.Codec<number, number> = Schema.Number.pipe(
  Schema.check(Schema.isInt()),
  Schema.check(Schema.isGreaterThan(ZERO)),
  Schema.check(Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)),
)
const PositiveDistanceSchema: Schema.Codec<number, number> = Schema.Finite.pipe(
  Schema.check(Schema.isGreaterThan(ZERO)),
)
const ServerCorrectionPlanInputSchema: Schema.Struct<{
  correctionDurationTicks: typeof PositiveTickDurationSchema
  from: typeof Vec3Schema
  startTick: typeof NonNegativeTickSchema
  teleportDistance: typeof PositiveDistanceSchema
  to: typeof Vec3Schema
}> = Schema.Struct({
  correctionDurationTicks: PositiveTickDurationSchema,
  from: Vec3Schema,
  startTick: NonNegativeTickSchema,
  teleportDistance: PositiveDistanceSchema,
  to: Vec3Schema,
})

type PositionSnapshot = Pick<EntityTransformSnapshot, 'sequence' | 'tick' | 'at'>

type SampleHistoryOptions<Snapshot extends PositionSnapshot> = Readonly<{
  history: ReadonlyArray<Snapshot>
  renderTick: number
  teleportDistance: number
  interpolate: (left: Snapshot, right: Snapshot, renderTick: number) => Snapshot
}>

type SnapshotAdmissionOptions<Id, Snapshot extends PositionSnapshot> = Readonly<{
  histories: Map<Id, Array<Snapshot>>
  id: Id
  snapshot: unknown
  isValid: (snapshot: unknown) => snapshot is Snapshot
}>

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const ownDataValue = (record: Record<string, unknown>, key: string): unknown => {
  const descriptor = Object.getOwnPropertyDescriptor(record, key)
  if (descriptor === undefined || !('value' in descriptor)) {
    return undefined
  }
  return descriptor.value
}

const isPosition = (value: unknown): value is Vec3 => {
  if (!isRecord(value)) {
    return false
  }
  const x = ownDataValue(value, 'x')
  const y = ownDataValue(value, 'y')
  const z = ownDataValue(value, 'z')
  return typeof x === 'number' && Number.isFinite(x)
    && typeof y === 'number' && Number.isFinite(y)
    && typeof z === 'number' && Number.isFinite(z)
}

const validPositionSnapshot = (snapshot: unknown): snapshot is PositionSnapshot => {
  if (!isRecord(snapshot)) {
    return false
  }
  const sequence = ownDataValue(snapshot, 'sequence')
  const tick = ownDataValue(snapshot, 'tick')
  const at = ownDataValue(snapshot, 'at')
  return typeof sequence === 'number'
    && Number.isSafeInteger(sequence)
    && sequence >= MIN_SEQUENCE_OR_TICK
    && typeof tick === 'number'
    && Number.isSafeInteger(tick)
    && tick >= MIN_SEQUENCE_OR_TICK
    && isPosition(at)
}

const validSnapshot = (snapshot: unknown): snapshot is PlayerTransformSnapshot => {
  if (!validPositionSnapshot(snapshot) || !isRecord(snapshot)) {
    return false
  }
  const facing = ownDataValue(snapshot, 'facing')
  if (!isRecord(facing)) {
    return false
  }
  const yawRadians = ownDataValue(facing, 'yawRadians')
  const pitchRadians = ownDataValue(facing, 'pitchRadians')
  return typeof yawRadians === 'number' && Number.isFinite(yawRadians)
    && typeof pitchRadians === 'number' && Number.isFinite(pitchRadians)
}

const validEntitySnapshot = (snapshot: unknown): snapshot is EntityTransformSnapshot =>
  validPositionSnapshot(snapshot)

const isNonEmptyHistory = <Snapshot extends PositionSnapshot>(
  history: ReadonlyArray<Snapshot>,
): history is readonly [Snapshot, ...Array<Snapshot>] => history.length > ZERO

const axisDistance = (left: number, right: number): number | undefined => {
  const crossesZero = (left < ZERO && right > ZERO) || (left > ZERO && right < ZERO)
  const leftMagnitude = Math.abs(left)
  const rightMagnitude = Math.abs(right)
  if (crossesZero && leftMagnitude > MAX_FINITE_NUMBER - rightMagnitude) {
    return undefined
  }
  return Math.abs(right - left)
}

const scaledDistanceBeyondThreshold = (
  distances: Readonly<{ readonly x: number; readonly y: number; readonly z: number }>,
  threshold: number,
): boolean => {
  const { x, y, z } = distances
  const scale = Math.max(x, y, z)
  if (scale === ZERO) {
    return false
  }
  if (scale > threshold) {
    return true
  }
  if (scale <= threshold / SQRT_VECTOR_COMPONENT_COUNT) {
    return false
  }
  const scaledDistance = Math.sqrt(
    (x / scale) ** VECTOR_COMPONENT_POWER +
      (y / scale) ** VECTOR_COMPONENT_POWER +
      (z / scale) ** VECTOR_COMPONENT_POWER,
  )
  return scaledDistance > threshold / scale
}

const beyondDistance = (left: Vec3, right: Vec3, threshold: number): boolean => {
  const x = axisDistance(left.x, right.x)
  const y = axisDistance(left.y, right.y)
  const z = axisDistance(left.z, right.z)
  if (x === undefined || y === undefined || z === undefined) {
    return true
  }
  return scaledDistanceBeyondThreshold({ x, y, z }, threshold)
}

const lerp = (left: number, right: number, alpha: number): number =>
  left * (INTERPOLATION_TOTAL_WEIGHT - alpha) + right * alpha

const interpolateYaw = (left: number, right: number, alpha: number): number => {
  const fullTurn = Math.PI * FULL_TURN_MULTIPLIER
  const leftTurn = left % fullTurn
  const rightTurn = right % fullTurn
  const shortest = ((rightTurn - leftTurn + Math.PI) % fullTurn + fullTurn) % fullTurn - Math.PI
  return left + shortest * alpha
}

const interpolatePosition = (left: Vec3, right: Vec3, alpha: number): Vec3 => ({
  x: lerp(left.x, right.x, alpha),
  y: lerp(left.y, right.y, alpha),
  z: lerp(left.z, right.z, alpha),
})

const interpolateEntityPair = (
  left: EntityTransformSnapshot,
  right: EntityTransformSnapshot,
  renderTick: number,
): EntityTransformSnapshot => {
  const alpha = (renderTick - left.tick) / (right.tick - left.tick)
  return {
    at: interpolatePosition(left.at, right.at, alpha),
    sequence: right.sequence,
    tick: renderTick,
  }
}

const interpolatePlayerPair = (
  left: PlayerTransformSnapshot,
  right: PlayerTransformSnapshot,
  renderTick: number,
): PlayerTransformSnapshot => {
  const alpha = (renderTick - left.tick) / (right.tick - left.tick)
  return {
    at: interpolatePosition(left.at, right.at, alpha),
    facing: {
      pitchRadians: lerp(left.facing.pitchRadians, right.facing.pitchRadians, alpha),
      yawRadians: interpolateYaw(left.facing.yawRadians, right.facing.yawRadians, alpha),
    },
    sequence: right.sequence,
    tick: renderTick,
  }
}

const sampleSnapshotPair = <Snapshot extends PositionSnapshot>(
  options: SampleHistoryOptions<Snapshot> & Readonly<{ left: Snapshot; right: Snapshot }>,
): Snapshot => {
  const { left, right, renderTick, teleportDistance, interpolate } = options
  if (beyondDistance(left.at, right.at, teleportDistance)) {
    if (renderTick < right.tick) {
      return left
    }
    return right
  }
  return interpolate(left, right, renderTick)
}

const findSnapshotPair = <Snapshot extends PositionSnapshot>(
  history: readonly [Snapshot, ...Array<Snapshot>],
  renderTick: number,
): readonly [Snapshot, Snapshot] | undefined => {
  let [left] = history
  for (const right of history.slice(NEIGHBOR_OFFSET)) {
    if (renderTick <= right.tick) {
      return [left, right]
    }
    left = right
  }
  return undefined
}

const sampleHistory = <Snapshot extends PositionSnapshot>(
  options: SampleHistoryOptions<Snapshot>,
): Snapshot | undefined => {
  const { history, renderTick } = options
  if (!Number.isFinite(renderTick) || !isNonEmptyHistory(history)) {
    return undefined
  }

  const [first] = history
  if (renderTick <= first.tick) {
    return first
  }

  const pair = findSnapshotPair(history, renderTick)
  if (pair === undefined) {
    return history.at(LAST_INDEX)
  }
  return sampleSnapshotPair({ ...options, left: pair[ZERO], right: pair[NEIGHBOR_OFFSET] })
}

/**
 * Creates a correction that can be sampled at an absolute simulation tick.
 * Sampling is deterministic and never advances hidden elapsed-time state.
 */
export const createServerCorrectionPlan = (
  input: unknown,
): Result.Result<ServerCorrectionPlan, ServerCorrectionError> => {
  const decoded = Schema.decodeUnknownResult(ServerCorrectionPlanInputSchema, { onExcessProperty: 'error' })(input)
  if (Result.isFailure(decoded)) {
    return Result.fail(new ServerCorrectionError({
      detail: 'correction plan input is invalid',
      reason: 'invalid-plan-input',
    }))
  }

  const { correctionDurationTicks, from, startTick, teleportDistance, to } = decoded.success
  const teleported = beyondDistance(from, to, teleportDistance)
  return Result.succeed(Object.freeze({
    sample: (simulationTick: PlayerTransformSnapshot['tick']): Result.Result<Vec3, ServerCorrectionError> => {
      if (!Number.isFinite(simulationTick) || simulationTick < MIN_SEQUENCE_OR_TICK) {
        return Result.fail(new ServerCorrectionError({
          detail: 'simulation tick must be finite and nonnegative',
          reason: 'invalid-sample-tick',
        }))
      }
      if (simulationTick < startTick) {
        return Result.succeed(from)
      }
      if (teleported) {
        return Result.succeed(to)
      }

      const elapsedTicks = Math.min(correctionDurationTicks, Math.max(ZERO, simulationTick - startTick))
      const alpha = elapsedTicks / correctionDurationTicks
      return Result.succeed(interpolatePosition(from, to, alpha))
    },
  }))
}

/**
 * Per-player and per-entity snapshot history with deterministic tick sampling.
 *
 * The buffer deliberately does not read a clock. Callers choose `renderTick`
 * (normally server tick minus an interpolation delay), making replay tests and
 * production rendering use exactly the same calculation.
 */
export class SnapshotInterpolator {
  readonly #config: SnapshotInterpolatorConfig
  readonly #playerHistory = new Map<PlayerId, Array<PlayerTransformSnapshot>>()
  readonly #entityHistory = new Map<EntityId, Array<EntityTransformSnapshot>>()

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

  ingest(player: PlayerId, snapshot: unknown): SnapshotIngestResult {
    return this.#ingest({
      histories: this.#playerHistory,
      id: player,
      isValid: validSnapshot,
      snapshot,
    })
  }

  ingestEntity(entity: EntityId, snapshot: unknown): SnapshotIngestResult {
    return this.#ingest({
      histories: this.#entityHistory,
      id: entity,
      isValid: validEntitySnapshot,
      snapshot,
    })
  }

  #ingest<Id, Snapshot extends PositionSnapshot>(
    options: SnapshotAdmissionOptions<Id, Snapshot>,
  ): SnapshotIngestResult {
    const { histories, id, snapshot, isValid } = options
    if (!isValid(snapshot)) {
      return { accepted: false, reason: 'invalid' }
    }

    const history = histories.get(id) ?? []
    if (SnapshotInterpolator.#isStaleOrDuplicate(history, snapshot)) {
      return { accepted: false, reason: 'duplicate-or-stale' }
    }

    history.push(snapshot)
    this.#trimToLimit(history)
    histories.set(id, history)
    return { accepted: true, historySize: history.length }
  }

  static #isStaleOrDuplicate<Snapshot extends PositionSnapshot>(
    history: ReadonlyArray<Snapshot>,
    snapshot: Snapshot,
  ): boolean {
    const newest = history.at(LAST_INDEX)
    return newest !== undefined && (snapshot.sequence <= newest.sequence || snapshot.tick <= newest.tick)
  }

  #trimToLimit<Snapshot>(history: Array<Snapshot>): void {
    if (history.length > this.#config.historyLimit) {
      history.splice(ZERO, history.length - this.#config.historyLimit)
    }
  }

  sample(player: PlayerId, renderTick: number): PlayerTransformSnapshot | undefined {
    const history = this.#playerHistory.get(player)
    if (history === undefined) {
      return undefined
    }
    return sampleHistory({
      history,
      interpolate: interpolatePlayerPair,
      renderTick,
      teleportDistance: this.#config.teleportDistance,
    })
  }

  sampleEntity(entity: EntityId, renderTick: PlayerTransformSnapshot['tick']): EntityTransformSnapshot | undefined {
    const history = this.#entityHistory.get(entity)
    if (history === undefined) {
      return undefined
    }
    return sampleHistory({
      history,
      interpolate: interpolateEntityPair,
      renderTick,
      teleportDistance: this.#config.teleportDistance,
    })
  }

  historySize(player: PlayerId): number {
    return this.#playerHistory.get(player)?.length ?? ZERO
  }

  entityHistorySize(entity: EntityId): number {
    return this.#entityHistory.get(entity)?.length ?? ZERO
  }

  /** Remove one peer on leave, or every peer when the transport disconnects. */
  disconnect(player?: PlayerId): void {
    if (player === undefined) {
      this.#playerHistory.clear()
      this.#entityHistory.clear()
    } else {
      this.#playerHistory.delete(player)
    }
  }

  disconnectEntity(entity?: EntityId): void {
    if (entity === undefined) {
      this.#entityHistory.clear()
    } else {
      this.#entityHistory.delete(entity)
    }
  }
}

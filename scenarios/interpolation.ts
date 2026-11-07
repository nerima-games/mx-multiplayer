import { PlayerId, WorldId } from '../src/index.js'
import { type PlayerTransformSnapshot, SnapshotInterpolator } from '../src/domain/snapshot-interpolation.js'
import { Result } from 'effect'
import type { ScenarioDefinition } from './types.js'

const WORLD = WorldId.make('overworld')
const SAMPLE_PLAYER = PlayerId.make('s5-interpolation-sample')
const ZERO = 0
const ONE = 1
const TWO = 2
const THREE = 3
const FIVE = 5
const TEN = 10
const ELEVEN = 11
const NEGATIVE_ONE = -ONE
const NEGATIVE_TEN = -TEN
const HISTORY_LIMIT = 4
const TELEPORT_DISTANCE = 100
const EXPECTED_HISTORY_SIZE = TWO
const INTERPOLATOR_CONFIG = { historyLimit: HISTORY_LIMIT, teleportDistance: TELEPORT_DISTANCE }

const FIRST_SAMPLE = { sequence: ONE, tick: ZERO, x: ZERO }
const LAST_SAMPLE = { sequence: TWO, tick: TEN, x: TEN }
const DUPLICATE_SAMPLE = LAST_SAMPLE
const DELAYED_SAMPLE = { sequence: THREE, tick: FIVE, x: 50 }
const REORDERED_SAMPLE = { sequence: ONE, tick: ZERO, x: NEGATIVE_TEN }

const sampleSnapshot = (sequence: number, tick: number, x: number): PlayerTransformSnapshot => ({
  at: { x, y: ZERO, z: ZERO },
  facing: { pitchRadians: ZERO, yawRadians: ZERO },
  sequence,
  tick,
})

const createSampleInterpolator = (): SnapshotInterpolator | undefined => {
  const created = SnapshotInterpolator.make(INTERPOLATOR_CONFIG)
  if (Result.isFailure(created)) {
    return undefined
  }
  return created.success
}

const hasExpectedSamples = (interpolator: SnapshotInterpolator): boolean => {
  const first = sampleSnapshot(FIRST_SAMPLE.sequence, FIRST_SAMPLE.tick, FIRST_SAMPLE.x)
  const last = sampleSnapshot(LAST_SAMPLE.sequence, LAST_SAMPLE.tick, LAST_SAMPLE.x)
  const acceptedFirst = interpolator.ingest(SAMPLE_PLAYER, first).accepted
  const acceptedLast = interpolator.ingest(SAMPLE_PLAYER, last).accepted
  if (!acceptedFirst || !acceptedLast) {
    return false
  }

  const middle = interpolator.sample(SAMPLE_PLAYER, FIVE)
  return middle !== undefined
    && middle.at.x === FIVE
    && middle.tick === FIVE
    && interpolator.sample(SAMPLE_PLAYER, ZERO)?.at.x === ZERO
    && interpolator.sample(SAMPLE_PLAYER, TEN)?.at.x === TEN
    && interpolator.sample(SAMPLE_PLAYER, NEGATIVE_ONE)?.at.x === ZERO
    && interpolator.sample(SAMPLE_PLAYER, ELEVEN)?.at.x === TEN
}

const staleSamplesAreIgnored = (interpolator: SnapshotInterpolator): boolean => {
  const duplicate = interpolator.ingest(SAMPLE_PLAYER, sampleSnapshot(
    DUPLICATE_SAMPLE.sequence,
    DUPLICATE_SAMPLE.tick,
    DUPLICATE_SAMPLE.x,
  ))
  const delayed = interpolator.ingest(SAMPLE_PLAYER, sampleSnapshot(
    DELAYED_SAMPLE.sequence,
    DELAYED_SAMPLE.tick,
    DELAYED_SAMPLE.x,
  ))
  const reordered = interpolator.ingest(SAMPLE_PLAYER, sampleSnapshot(
    REORDERED_SAMPLE.sequence,
    REORDERED_SAMPLE.tick,
    REORDERED_SAMPLE.x,
  ))
  return !duplicate.accepted
    && !delayed.accepted
    && !reordered.accepted
    && interpolator.historySize(SAMPLE_PLAYER) === EXPECTED_HISTORY_SIZE
}

const interpolationPasses = (): boolean => {
  const interpolator = createSampleInterpolator()
  return interpolator !== undefined
    && hasExpectedSamples(interpolator)
    && staleSamplesAreIgnored(interpolator)
}

export const interpolationScenario: ScenarioDefinition = {
  actions: ({ frame, clients }) => clients.map((client) => ({
    clientId: client.id,
    kind: 'message',
    message: {
      _tag: 'PlayerMove',
      at: { x: frame, y: ZERO, z: ZERO },
      facing: { pitchRadians: ZERO, yawRadians: ZERO },
      player: PlayerId.make(client.player),
      world: WORLD,
    },
  })),
  angle: 'A4',
  description: 'Two clients send movement snapshots; interpolation clamps at history bounds and ignores duplicate, delayed, and reordered samples.',
  evaluate: ({ clients, wireLog }) => {
    const everyClientSentMovement = clients.every((client) => wireLog.some((entry) =>
      entry.from === client.id && entry.tag === 'PlayerMove' && entry.outcome === 'delivered'))
    if (!interpolationPasses()) {
      return { status: 'fail', summary: 'snapshot interpolation or stale-snapshot rejection failed' }
    }
    if (!everyClientSentMovement) {
      return { status: 'incomplete', summary: 'waiting for both clients to deliver a movement snapshot' }
    }
    return { status: 'pass', summary: 'linear interpolation passed; duplicate, delayed, and reordered snapshots were ignored' }
  },
  group: 'interpolation',
  id: 's5.interpolation.delayed-reordered-snapshots',
  title: 'Interpolate movement while ignoring stale snapshots',
}

import type { CommandUnsupportedReason } from '../../src/application/server/command-application.js'
import { MESSAGE_TAGS } from '../../src/domain/protocol.js'
import { SCENARIO_ANGLE_MEANINGS, type ScenarioAngleMeaning } from '../../scenarios/types.js'
import { containers } from './containers.js'
import { dimensionsBosses } from './dimensions-bosses.js'
import { entities } from './entities.js'
import { playerState } from './player-state.js'
import { workbenches } from './workbenches.js'
import { worldSync } from './world-sync.js'

export const MATRIX_ANGLES = ['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'A8'] as const

export type MatrixAngle = (typeof MATRIX_ANGLES)[number]
export const MATRIX_ANGLE_MEANINGS: Readonly<Record<MatrixAngle, ScenarioAngleMeaning>> = {
  ...SCENARIO_ANGLE_MEANINGS,
  A8: {
    title: 'Compatibility (optional)',
    meaning: 'Check whether the current codec accepts or explicitly rejects frozen legacy wire frames; record a reasoned exclusion if this optional angle is not implemented.',
  },
}

export type MessageTag = (typeof MESSAGE_TAGS)[number]
export type TestReference = {
  readonly file: `test/${string}`
  readonly line: number
  readonly testName: string
}

export type MatrixCell =
  | {
      readonly status: 'covered'
      readonly tests: readonly [TestReference, ...TestReference[]]
      readonly unsupportedCommandReason?: CommandUnsupportedReason
    }
  | { readonly status: 'pending'; readonly reason?: string }
  | { readonly status: 'excluded'; readonly reason: string }
  | { readonly status: 'blocked-on-mc-sim'; readonly reason: string }
  | { readonly status: 'gap'; readonly reason: string; readonly evidence: ReadonlyArray<string> }

export type MatrixRow = Record<MatrixAngle, MatrixCell>
export type GroupManifest = Partial<Record<MessageTag, MatrixRow>>
export type MatrixGroup = {
  readonly name: string
  readonly rows: GroupManifest
}

export const matrixGroups: readonly MatrixGroup[] = [
  { name: 'world-sync', rows: worldSync },
  { name: 'player-state', rows: playerState },
  { name: 'containers', rows: containers },
  { name: 'workbenches', rows: workbenches },
  { name: 'entities', rows: entities },
  { name: 'dimensions-bosses', rows: dimensionsBosses },
]

export const matrixRows: Record<MessageTag, MatrixRow> = {
  ...worldSync,
  ...playerState,
  ...containers,
  ...workbenches,
  ...entities,
  ...dimensionsBosses,
}

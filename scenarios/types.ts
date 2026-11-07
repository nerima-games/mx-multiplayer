import { Effect } from 'effect'
import type { NetworkMessage } from '../src/domain/protocol.js'
import type { ReplicatedOwnerRegistry } from '../src/domain/codec.js'
import type { WorldBlockRead } from '@nerima-games/mc-sim'

export const SCENARIO_GROUPS = [
  'protocol',
  'transport',
  'authority',
  'visibility',
  'interpolation',
  'survival',
] as const

export type ScenarioGroup = (typeof SCENARIO_GROUPS)[number]

export const SCENARIO_ANGLES = ['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7'] as const

export type ScenarioAngle = (typeof SCENARIO_ANGLES)[number]

export type ScenarioAngleMeaning = {
  readonly title: string
  readonly meaning: string
}

export const SCENARIO_ANGLE_MEANINGS: Readonly<Record<ScenarioAngle, ScenarioAngleMeaning>> = {
  A1: {
    meaning: 'Check codec round trips and rejection of malformed input.',
    title: 'Shape',
  },
  A2: {
    meaning: 'Check whether the server applies a command or explicitly rejects it with CommandUnsupported.',
    title: 'Authority Application',
  },
  A3: {
    meaning: "Check that every client's authoritative snapshot and post-delta state are structurally equal.",
    title: 'Multi-Client Convergence',
  },
  A4: {
    meaning: 'Check that loss, duplication, reordering, and delay do not change results and AuthoritativeResyncRequest works.',
    title: 'Ordering and Loss',
  },
  A5: {
    meaning: 'Check mid-session snapshots, reconnect authentication after disconnect, and cleanup when a player leaves.',
    title: 'Join and Reconnect',
  },
  A6: {
    meaning: 'Check that elements outside the area of interest (AOI) never leak and rate limits or large connection counts do not drop updates.',
    title: 'Visibility and Load',
  },
  A7: {
    meaning: "Check that the server rejects operations using another player's ID, tampered values, and unauthorized commands.",
    title: 'Untrusted Clients',
  },
}

export const SCENARIO_SPEED_QUARTER = 0.25
export const SCENARIO_SPEED_HALF = 0.5
export const SCENARIO_SPEED_NORMAL = 1
export const SCENARIO_SPEED_DOUBLE = 2
export const SCENARIO_SPEED_QUADRUPLE = 4

export const SCENARIO_SPEEDS: readonly [
  typeof SCENARIO_SPEED_QUARTER,
  typeof SCENARIO_SPEED_HALF,
  typeof SCENARIO_SPEED_NORMAL,
  typeof SCENARIO_SPEED_DOUBLE,
  typeof SCENARIO_SPEED_QUADRUPLE,
] = [SCENARIO_SPEED_QUARTER, SCENARIO_SPEED_HALF, SCENARIO_SPEED_NORMAL, SCENARIO_SPEED_DOUBLE, SCENARIO_SPEED_QUADRUPLE]

export type ScenarioSpeed = (typeof SCENARIO_SPEEDS)[number]

const ZERO = 0
const ONE = 1
type ScenarioBinaryState = typeof ZERO | typeof ONE

export const SCENARIO_FAULT_KINDS = ['none', 'delay', 'drop', 'reorder', 'disconnect'] as const

export type ScenarioFaultKind = (typeof SCENARIO_FAULT_KINDS)[number]
export const SCENARIO_RUNTIME_FAULT_KINDS = [
  'none',
  'delay',
  'drop',
  'reorder',
  'disconnect',
  'corrupt',
  'version',
  'future',
  'duplicate',
] as const

export type ScenarioRuntimeFaultKind = (typeof SCENARIO_RUNTIME_FAULT_KINDS)[number]

export const SCENARIO_CONTROL_LABELS = ['Pause', 'Step frame', 'Play', 'Speed', 'Reset'] as const

export type ScenarioControlLabel = (typeof SCENARIO_CONTROL_LABELS)[number]

export type ScenarioId = string
export type ScenarioClientId = 'client-a' | 'client-b'
export type ScenarioRuntimeClientId = ScenarioClientId | 'client-c'

type ScenarioFaultByKind = {
  readonly none: { readonly kind: 'none' }
  readonly delay: { readonly kind: 'delay'; readonly frames: number; readonly atFrame?: number; readonly clientId?: ScenarioClientId }
  readonly drop: { readonly kind: 'drop'; readonly atFrame?: number; readonly clientId?: ScenarioClientId }
  readonly reorder: { readonly kind: 'reorder'; readonly atFrame?: number }
  readonly disconnect: { readonly kind: 'disconnect'; readonly atFrame?: number; readonly clientId?: ScenarioClientId }
  readonly corrupt: { readonly kind: 'corrupt'; readonly atFrame?: number; readonly clientId?: ScenarioClientId }
  readonly version: { readonly kind: 'version'; readonly atFrame?: number; readonly clientId?: ScenarioClientId }
  readonly future: { readonly kind: 'future'; readonly atFrame?: number; readonly clientId?: ScenarioClientId }
  readonly duplicate: { readonly kind: 'duplicate'; readonly atFrame?: number; readonly clientId?: ScenarioClientId }
}

export type ScenarioFault<Kind extends ScenarioRuntimeFaultKind = ScenarioFaultKind> = ScenarioFaultByKind[Kind]
export type ScenarioRuntimeFault = ScenarioFault<ScenarioRuntimeFaultKind>

export type ScenarioUrlState = {
  readonly scenario: ScenarioId
  readonly play: ScenarioBinaryState
  readonly speed: ScenarioSpeed
  readonly panel: ScenarioBinaryState
  readonly seed: number
  readonly fault: ScenarioFaultKind
  readonly frame: number
}

export type ScenarioAction =
  | {
      readonly clientId: ScenarioClientId
      readonly kind: 'message'
      readonly message: NetworkMessage
      readonly owners?: ReplicatedOwnerRegistry
    }
  | { readonly clientId: ScenarioClientId; readonly kind: 'raw'; readonly text: string }

export type ScenarioStepContext = {
  readonly frame: number
  readonly seed: number
  readonly clients: ReadonlyArray<{ readonly id: ScenarioClientId; readonly player: string }>
}

export type ScenarioVerdict = {
  readonly status: 'pass' | 'fail' | 'incomplete'
  readonly summary: string
}

export type ScenarioEvaluation = ScenarioVerdict | Effect.Effect<ScenarioVerdict, unknown>

export type ScenarioClientState = {
  readonly id: ScenarioClientId
  readonly player: string
  readonly connected: boolean
  readonly lastFrame: number
  readonly submitted: number
  readonly received: number
  readonly accepted: number
  readonly rejected: number
  readonly lastDecision: string
}

export type ScenarioRuntimeClientState = Omit<ScenarioClientState, 'id'> & {
  readonly id: ScenarioRuntimeClientId
}

export type ScenarioAuthorityState = {
  readonly revision: number
  readonly acceptedCommands: number
  readonly rejectedCommands: number
  readonly lastDecision: string
}

export type ScenarioProjectionBlock = Readonly<{
  readonly entityId: string
  readonly revision: number
  readonly block: WorldBlockRead
}>

export type ScenarioProjectionOwner = Readonly<{
  readonly entityId: string
  readonly revision: number
  readonly state: unknown
}>

export type ScenarioProjectionWorld = Readonly<{
  readonly world: string
  readonly revision: number
  readonly blocks: ReadonlyArray<ScenarioProjectionBlock>
  readonly owners: ReadonlyArray<ScenarioProjectionOwner>
}>

export type ScenarioClientProjection = Readonly<{
  readonly id: ScenarioRuntimeClientId
  readonly worlds: ReadonlyArray<ScenarioProjectionWorld>
}>

export type ScenarioEntityRevision = Readonly<{
  readonly clientId: ScenarioRuntimeClientId
  readonly entityId: string
  readonly frame: number
  readonly revision: number
}>

export type ScenarioClock = Readonly<{ readonly now: () => number }>

export type ScenarioWireOutcome =
  | 'queued'
  | 'delayed'
  | 'delivered'
  | 'accepted'
  | 'dropped'
  | 'disconnected'
  | 'rejected'

export type ScenarioWireLogEntry = {
  readonly sequence: number
  readonly frame: number
  readonly deliveredFrame?: number
  readonly deliverySequence?: number
  readonly from: ScenarioClientId
  readonly to: 'authority'
  readonly tag: string
  readonly text: string
  readonly outcome: ScenarioWireOutcome
  readonly result: string
  readonly faultNotApplied?: string
}

export type ScenarioEvaluationInput = {
  readonly frame: number
  readonly clients: ReadonlyArray<ScenarioClientState>
  readonly authority: ScenarioAuthorityState
  readonly wireLog: ReadonlyArray<ScenarioWireLogEntry>
}

export type ScenarioDefinition = {
  readonly id: ScenarioId
  readonly group: ScenarioGroup
  readonly angle: ScenarioAngle
  readonly title: string
  readonly description: string
  readonly actions: (context: ScenarioStepContext) => ReadonlyArray<ScenarioAction>
  readonly evaluate: (input: ScenarioEvaluationInput) => ScenarioEvaluation
}

export type ScenarioRuntimeOptions<Kind extends ScenarioRuntimeFaultKind = ScenarioFaultKind> = {
  readonly clock?: ScenarioClock
  readonly seed: number
  readonly fault?: ScenarioFault<Kind>
  readonly speed?: ScenarioSpeed
  readonly frame?: number
  readonly play?: boolean
  readonly panel?: ScenarioBinaryState
}

export type ScenarioResult = {
  readonly id: ScenarioId
  readonly group: ScenarioGroup
  readonly angle: ScenarioAngle
  readonly title: string
  readonly description: string
  readonly seed: number
  readonly frame: number
  readonly playing: boolean
  readonly speed: ScenarioSpeed
  readonly panel: ScenarioBinaryState
  readonly fault: ScenarioFault
  readonly runtimeFault: ScenarioRuntimeFault
  readonly clients: ReadonlyArray<ScenarioClientState>
  readonly runtimeClients: ReadonlyArray<ScenarioRuntimeClientState>
  readonly clientProjections: ReadonlyArray<ScenarioClientProjection>
  readonly revisionHistory: ReadonlyArray<ScenarioEntityRevision>
  readonly authority: ScenarioAuthorityState
  readonly wireLog: ReadonlyArray<ScenarioWireLogEntry>
  readonly clockNow: number
  readonly verdict: ScenarioVerdict
}

export type ScenarioRuntime = {
  readonly clock: ScenarioClock
  readonly snapshot: () => ScenarioResult
  readonly pause: () => ScenarioResult
  readonly play: () => ScenarioResult
  readonly step: () => Promise<ScenarioResult>
  readonly run: (frames: number) => Promise<ScenarioResult>
  readonly join: (clientId: ScenarioRuntimeClientId) => Promise<ScenarioResult>
  readonly setSpeed: (speed: ScenarioSpeed) => ScenarioResult
  readonly reset: (options?: ScenarioRuntimeOptions<ScenarioRuntimeFaultKind>) => Promise<ScenarioResult>
}

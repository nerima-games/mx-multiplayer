import type {
  ScenarioDefinition,
  ScenarioRuntime,
  ScenarioUrlState,
} from '../../../scenarios/types.js'
import { Effect } from 'effect'

export type DebugEffectRunner = <A, E>(effect: Effect.Effect<A, E, never>) => Promise<A>

export type DebugPanelContext = {
  readonly state: ScenarioUrlState
  readonly scenario: ScenarioDefinition | undefined
  readonly runtime: ScenarioRuntime | undefined
  readonly setState: (patch: Partial<ScenarioUrlState>) => void
  readonly setScenario: (scenario: ScenarioDefinition | undefined) => void
  readonly setRuntime: (runtime: ScenarioRuntime | undefined) => void
  readonly runEffect: DebugEffectRunner
}

export type DebugPanelHandle = {
  readonly update: (context: DebugPanelContext) => void
  readonly dispose: () => void
}

export type DebugPanel = {
  readonly id: string
  readonly title: string
  readonly mount: (target: HTMLElement, context: DebugPanelContext) => DebugPanelHandle
}

import type { ScenarioDefinition, ScenarioId } from './types.js'
import { dimensionsBossesAuthorityScenario, dimensionsBossesUnauthorizedScenario } from './dimensions-bosses.js'
import { entitiesAuthorityScenario, entitiesUnauthorizedScenario, entitiesWireScenario } from './entities.js'
import { playerStateAuthorityScenario, playerStateUnauthorizedScenario } from './player-state.js'
import { survivalScenario, survivalUnauthorizedScenario } from './survival.js'
import { AUTHORITY_SCENARIOS } from './authority.js'
import { CONTAINER_SCENARIOS } from './containers.js'
import { interpolationScenario } from './interpolation.js'
import { protocolScenarios } from './protocol.js'
import { transportScenarios } from './transport.js'
import { visibilityLoadScenario } from './visibility-load.js'
import { workbenchWireScenario } from './workbenches.js'
import { worldSyncReconnectSnapshotScenario } from './world-sync.js'

export type ScenarioModuleName =
  | 'authority'
  | 'containers'
  | 'dimensions-bosses'
  | 'entities'
  | 'interpolation'
  | 'player-state'
  | 'protocol'
  | 'survival'
  | 'transport'
  | 'visibility-load'
  | 'workbenches'
  | 'world-sync'

type ScenarioModuleRegistration = {
  readonly module: ScenarioModuleName
  readonly scenarios: ReadonlyArray<ScenarioDefinition>
}

const scenarioModules: ReadonlyArray<ScenarioModuleRegistration> = [
  { module: 'authority', scenarios: AUTHORITY_SCENARIOS },
  { module: 'containers', scenarios: CONTAINER_SCENARIOS },
  { module: 'dimensions-bosses', scenarios: [dimensionsBossesAuthorityScenario, dimensionsBossesUnauthorizedScenario] },
  { module: 'entities', scenarios: [entitiesWireScenario, entitiesAuthorityScenario, entitiesUnauthorizedScenario] },
  { module: 'interpolation', scenarios: [interpolationScenario] },
  { module: 'player-state', scenarios: [playerStateAuthorityScenario, playerStateUnauthorizedScenario] },
  { module: 'protocol', scenarios: protocolScenarios },
  { module: 'survival', scenarios: [survivalScenario, survivalUnauthorizedScenario] },
  { module: 'transport', scenarios: transportScenarios },
  { module: 'visibility-load', scenarios: [visibilityLoadScenario] },
  { module: 'workbenches', scenarios: [workbenchWireScenario] },
  { module: 'world-sync', scenarios: [worldSyncReconnectSnapshotScenario] },
]

export type ScenarioCatalogEntry = {
  readonly module: ScenarioModuleName
  readonly scenario: ScenarioDefinition
}

export const SCENARIO_CATALOG: ReadonlyArray<ScenarioCatalogEntry> = Object.freeze(
  scenarioModules.flatMap(({ module, scenarios }) => scenarios.map((scenario) => Object.freeze({ module, scenario }))),
)

const scenariosById = new Map<ScenarioId, ScenarioCatalogEntry>()
for (const entry of SCENARIO_CATALOG) {
  scenariosById.set(entry.scenario.id, entry)
}

export const getScenarioById = (id: ScenarioId): ScenarioCatalogEntry | undefined => scenariosById.get(id)

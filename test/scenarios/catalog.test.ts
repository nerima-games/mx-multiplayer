import { readdirSync } from 'node:fs'
import { describe, expect, it } from '@effect/vitest'
import { SCENARIO_CATALOG, getScenarioById, type ScenarioModuleName } from '../../scenarios/index.js'
import { createScenarioRuntime } from '../../apps/debug-ui/entrypoints/scenarios/scenario-runtime.js'
import {
  SCENARIO_ANGLES,
  SCENARIO_ANGLE_MEANINGS,
  SCENARIO_GROUPS,
  type ScenarioDefinition,
  type ScenarioRuntimeFault,
} from '../../scenarios/types.js'

const FIXED_SEED = 73
const ONE_FRAME = 1
const SCENARIO_FRAME_HORIZON = 5
const SCENARIO_MODULE_NAMES: ReadonlyArray<ScenarioModuleName> = [
  'authority',
  'containers',
  'dimensions-bosses',
  'entities',
  'interpolation',
  'player-state',
  'protocol',
  'survival',
  'transport',
  'visibility-load',
  'workbenches',
  'world-sync',
]

type ScenarioFaultCase = {
  readonly name: string
  readonly fault?: ScenarioRuntimeFault
}

const SCENARIO_FAULT_CASES: ReadonlyArray<ScenarioFaultCase> = [
  { name: 'default no fault' },
  { fault: { kind: 'none' }, name: 'explicit no fault' },
  { fault: { atFrame: ONE_FRAME, clientId: 'client-a', kind: 'drop' }, name: 'drop' },
  { fault: { atFrame: ONE_FRAME, clientId: 'client-a', frames: ONE_FRAME, kind: 'delay' }, name: 'delay' },
  { fault: { atFrame: ONE_FRAME, kind: 'reorder' }, name: 'reorder' },
  { fault: { atFrame: ONE_FRAME, clientId: 'client-a', kind: 'disconnect' }, name: 'disconnect' },
  { fault: { atFrame: ONE_FRAME, clientId: 'client-a', kind: 'corrupt' }, name: 'corrupt' },
  { fault: { atFrame: ONE_FRAME, clientId: 'client-a', kind: 'version' }, name: 'version' },
  { fault: { atFrame: ONE_FRAME, clientId: 'client-a', kind: 'future' }, name: 'future' },
  { fault: { atFrame: ONE_FRAME, clientId: 'client-a', kind: 'duplicate' }, name: 'duplicate' },
]

const hasUniqueScenarioIds = (entries: ReadonlyArray<{ readonly scenario: { readonly id: string } }>): boolean =>
  new Set(entries.map(({ scenario }) => scenario.id)).size === entries.length

const runScenario = async (
  scenario: ScenarioDefinition,
  fault: ScenarioRuntimeFault | undefined,
) => {
  const runtime = await createScenarioRuntime(scenario, {
    ...(fault === undefined ? {} : { fault }),
    seed: FIXED_SEED,
  })
  return runtime.run(SCENARIO_FRAME_HORIZON)
}

describe('shared scenario catalog', () => {
  // Fails if a scenario module file is not statically registered in the catalog.
  it('covers every scenario module on disk', () => {
    const scenarioModuleFiles = readdirSync(new URL('../../scenarios/', import.meta.url))
      .filter((file) => file.endsWith('.ts') && !['index.ts', 'types.ts'].includes(file))
      .map((file) => file.slice(0, -'.ts'.length))
      .sort()
    const registeredModules = [...new Set(SCENARIO_CATALOG.map(({ module }) => module))].sort()
    const expectedModules = [...SCENARIO_MODULE_NAMES].sort()

    expect(scenarioModuleFiles).toStrictEqual(expectedModules)
    expect(registeredModules).toStrictEqual(expectedModules)
  })

  // Fails if any source module or runtime scenario group has no catalog entry.
  it('keeps every source module and runtime group populated', () => {
    for (const module of SCENARIO_MODULE_NAMES) {
      expect(SCENARIO_CATALOG.some((entry) => entry.module === module)).toBe(true)
    }
    for (const group of SCENARIO_GROUPS) {
      expect(SCENARIO_CATALOG.some((entry) => entry.scenario.group === group)).toBe(true)
    }
  })

  // Fails if a scenario omits the stable ID used by catalog lookup and replay.
  it('requires every scenario to have a non-empty stable ID', () => {
    for (const { scenario } of SCENARIO_CATALOG) {
      expect(typeof scenario.id === 'string' && scenario.id.trim().length > 0).toBe(true)
    }
  })

  // Fails if two scenario modules register the same stable ID.
  it('requires unique IDs across the catalog', () => {
    expect(hasUniqueScenarioIds(SCENARIO_CATALOG)).toBe(true)
  })

  // Fails if the uniqueness check incorrectly accepts two catalog entries with one ID.
  it('rejects a deliberately duplicated ID in the uniqueness negative control', () => {
    const duplicateCatalog = [
      { scenario: { id: 'negative-control.duplicate' } },
      { scenario: { id: 'negative-control.duplicate' } },
    ]

    expect(hasUniqueScenarioIds(duplicateCatalog)).toBe(false)
  })

  // Fails if a scenario declares an angle without a corresponding current meaning.
  it('limits declared angles to the meanings in the scenario contract', () => {
    for (const { scenario } of SCENARIO_CATALOG) {
      expect(SCENARIO_ANGLES.includes(scenario.angle)).toBe(true)
      expect(SCENARIO_ANGLE_MEANINGS[scenario.angle].meaning.trim().length).toBeGreaterThan(0)
    }
  })

  // Fails if the exported ID lookup loses or returns a different catalog entry.
  it('looks up each catalog entry by its stable ID', () => {
    for (const entry of SCENARIO_CATALOG) {
      expect(getScenarioById(entry.scenario.id)).toBe(entry)
    }
  })

  // Fails if the strict result comparison accepts actions that change between runs.
  it('rejects a per-run counter in scenario actions', async () => {
    let actionCounter = 0
    const counterScenario: ScenarioDefinition = {
      actions: () => [{ clientId: 'client-a', kind: 'raw', text: `counter-${actionCounter++}` }],
      angle: 'A1',
      description: 'A negative control whose raw action changes on every call.',
      evaluate: () => ({ status: 'pass', summary: 'counter action emitted' }),
      group: 'protocol',
      id: 'negative-control.per-run-counter',
      title: 'Per-run counter negative control',
    }
    const firstResult = await runScenario(counterScenario, undefined)
    const secondResult = await runScenario(counterScenario, undefined)

    expect(firstResult).not.toStrictEqual(secondResult)
  })
})

describe.each(SCENARIO_MODULE_NAMES)('scenario module %s', (module) => {
  const entries = SCENARIO_CATALOG.filter((entry) => entry.module === module)

  for (const { scenario } of entries) {
    for (const faultCase of SCENARIO_FAULT_CASES) {
      // Fails if rerunning this scenario with the same seed changes its complete result, wire log, or verdict.
      it(`${scenario.id} is deterministic with ${faultCase.name}`, async () => {
        const firstResult = await runScenario(scenario, faultCase.fault)
        const secondResult = await runScenario(scenario, faultCase.fault)

        expect(firstResult).toStrictEqual(secondResult)
      })
    }
  }
})

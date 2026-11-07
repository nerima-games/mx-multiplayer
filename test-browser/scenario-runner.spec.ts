import { type Page, expect, test } from '@playwright/test'
import {
  SCENARIO_ANGLE_MEANINGS,
  type ScenarioAuthorityState,
  type ScenarioClientState,
  type ScenarioFault,
  type ScenarioGroup,
  type ScenarioResult,
} from '../scenarios/types.js'
import { SCENARIO_CATALOG } from '../scenarios/index.js'
import { createScenarioRuntime } from '../scenarios/runtime.js'

const TEST_SEED = 17
const ONE_FRAME = 1
const FIVE_FRAMES = 5
const NO_FAULT: ScenarioFault = { kind: 'none' }
const DROP_FAULT: ScenarioFault = { kind: 'drop' }

type ScenarioRunCase = {
  readonly group: ScenarioGroup
  readonly scenarioId: string
  readonly frames: number
  readonly fault: ScenarioFault
  readonly expectedStatus: ScenarioResult['verdict']['status']
}

const CLIENT_FIELDS: ReadonlyArray<keyof ScenarioClientState> = [
  'id',
  'player',
  'connected',
  'lastFrame',
  'submitted',
  'received',
  'accepted',
  'rejected',
  'lastDecision',
]

const AUTHORITY_FIELDS: ReadonlyArray<keyof ScenarioAuthorityState> = [
  'revision',
  'acceptedCommands',
  'rejectedCommands',
  'lastDecision',
]

let browserErrors: Array<string> = []

test.beforeEach(async ({ page }) => {
  browserErrors = []
  page.on('console', (message) => {
    if (message.type() === 'error') {
      browserErrors.push(message.text())
    }
  })
  page.on('pageerror', (error) => browserErrors.push(error.message))
})

test.afterEach(() => {
  expect(browserErrors).toEqual([])
})

const openScenarioRunner = async (page: Page, fault: ScenarioFault): Promise<void> => {
  await page.goto(`/?panel=1&seed=${String(TEST_SEED)}&fault=${fault.kind}`)
  await page.locator('body[data-ready="true"]').waitFor()
  await expect(page.getByTestId('scenario-runner')).toBeVisible()
}

const expectedResultFor = async (
  scenarioId: string,
  frames: number,
  fault: ScenarioFault,
): Promise<ScenarioResult> => {
  const entry = SCENARIO_CATALOG.find((candidate) => candidate.scenario.id === scenarioId)
  if (entry === undefined) {
    throw new Error(`Scenario ${scenarioId} was not found in the catalog.`)
  }
  const runtime = await createScenarioRuntime(entry.scenario, { fault, frame: 0, seed: TEST_SEED })
  return runtime.run(frames)
}

const expectScenarioMetadata = async (page: Page, expected: ScenarioResult): Promise<void> => {
  const meaning = SCENARIO_ANGLE_MEANINGS[expected.angle]
  await Promise.all([
    expect(page.getByTestId('scenario-title')).toHaveText(`${expected.title} · ${expected.id}`),
    expect(page.getByTestId('scenario-angle')).toHaveText(
      `${expected.angle} · ${meaning.title}: ${meaning.meaning}`,
    ),
    expect(page.getByTestId('scenario-verdict')).toHaveAttribute('data-status', expected.verdict.status),
    expect(page.getByTestId('scenario-verdict')).toHaveText(
      `${expected.verdict.status}: ${expected.verdict.summary}`,
    ),
    expect(page.getByTestId('scenario-error')).toBeHidden(),
  ])
}

const expectClientState = async (page: Page, client: ScenarioClientState): Promise<void> => {
  const clientPanel = page.locator(
    `[data-testid="scenario-client"][data-client-id="${client.id}"]`,
  )
  await expect(clientPanel).toBeVisible()
  await Promise.all(CLIENT_FIELDS.map((field) =>
    expect(clientPanel.locator(`[data-field="${field}"]`)).toHaveText(String(client[field]))
  ))
}

const expectClientStates = async (
  page: Page,
  clients: ReadonlyArray<ScenarioClientState>,
): Promise<void> => {
  expect(clients.map((client) => client.id).sort()).toEqual(['client-a', 'client-b'])
  await Promise.all(clients.map((client) => expectClientState(page, client)))
}

const expectAuthorityState = async (page: Page, authority: ScenarioAuthorityState): Promise<void> => {
  const authorityPanel = page.getByTestId('scenario-authority')
  await expect(authorityPanel).toBeVisible()
  await Promise.all(AUTHORITY_FIELDS.map((field) =>
    expect(authorityPanel.locator(`[data-field="${field}"]`)).toHaveText(String(authority[field]))
  ))
}

const expectScenarioFields = async (page: Page, expected: ScenarioResult): Promise<void> => {
  await Promise.all([
    expectScenarioMetadata(page, expected),
    expectClientStates(page, expected.clients),
    expectAuthorityState(page, expected.authority),
  ])
}

const selectAndRunScenario = async (page: Page, scenario: ScenarioRunCase): Promise<void> => {
  await openScenarioRunner(page, scenario.fault)
  await page.getByTestId(`scenario-select-${scenario.group}`).selectOption(scenario.scenarioId)
  await page.getByTestId(`scenario-frames-${scenario.group}`).fill(String(scenario.frames))
  await page.getByTestId(`run-scenario-${scenario.group}`).click()
}

const waitForScenarioVerdict = async (
  page: Page,
  expectedStatus: ScenarioRunCase['expectedStatus'],
): Promise<void> => {
  const verdict = page.getByTestId('scenario-verdict')
  const error = page.getByTestId('scenario-error')
  await expect.poll(async () => {
    const status = await verdict.getAttribute('data-status')
    if (status !== null) {
      return status
    }
    if (await error.isVisible()) {
      return 'error'
    }
    return 'pending'
  }).not.toBe('pending')
  await expect(verdict).toHaveAttribute('data-status', expectedStatus)
}

const runScenario = async (page: Page, scenario: ScenarioRunCase): Promise<void> => {
  await selectAndRunScenario(page, scenario)
  await waitForScenarioVerdict(page, scenario.expectedStatus)
  const expected = await expectedResultFor(scenario.scenarioId, scenario.frames, scenario.fault)
  expect(expected.verdict.status).toBe(scenario.expectedStatus)
  await expectScenarioFields(page, expected)
}

// Catches missing protocol catalog options or stale client, authority, angle, and verdict output.
test('runs a protocol scenario and renders its complete runtime result', async ({ page }) => {
  await runScenario(page, {
    expectedStatus: 'pass',
    fault: NO_FAULT,
    frames: ONE_FRAME,
    group: 'protocol',
    scenarioId: 'mx-multiplayer.s1.protocol.ping-round-trip',
  })
})

// Catches a transport run that omits either client or misreports authority counters.
test('runs a transport scenario and renders both client states', async ({ page }) => {
  await runScenario(page, {
    expectedStatus: 'pass',
    fault: NO_FAULT,
    frames: ONE_FRAME,
    group: 'transport',
    scenarioId: 'transport.connection.two-clients',
  })
})

// Catches an authority scenario that renders state without its verdict or rejection counts.
test('runs an authority scenario and renders accepted and rejected commands', async ({ page }) => {
  await runScenario(page, {
    expectedStatus: 'pass',
    fault: NO_FAULT,
    frames: ONE_FRAME,
    group: 'authority',
    scenarioId: 'containers.authority-outcomes',
  })
})

// Catches visibility scenarios bypassing the shared runtime or losing the scenario error.
test('runs a visibility scenario through the shared runtime', async ({ page }) => {
  await runScenario(page, {
    expectedStatus: 'pass',
    fault: NO_FAULT,
    frames: ONE_FRAME,
    group: 'visibility',
    scenarioId: 's4.visibility-load.aoi-rate-boundaries',
  })
})

// Catches interpolation output that does not reflect both clients and the runtime angle.
test('runs an interpolation scenario and renders its client states', async ({ page }) => {
  await runScenario(page, {
    expectedStatus: 'pass',
    fault: NO_FAULT,
    frames: ONE_FRAME,
    group: 'interpolation',
    scenarioId: 's5.interpolation.delayed-reordered-snapshots',
  })
})

// Catches a fixed one-frame run horizon that leaves the survival scenario incomplete.
test('runs a five-frame survival scenario to its verdict', async ({ page }) => {
  await runScenario(page, {
    expectedStatus: 'pass',
    fault: NO_FAULT,
    frames: FIVE_FRAMES,
    group: 'survival',
    scenarioId: 's6.survival.rejection-reasons',
  })
})

// Catches forced packet loss being reported as a passing protocol round trip.
test('shows a failed verdict when a forced drop breaks a protocol round trip', async ({ page }) => {
  await runScenario(page, {
    expectedStatus: 'fail',
    fault: DROP_FAULT,
    frames: ONE_FRAME,
    group: 'protocol',
    scenarioId: 'mx-multiplayer.s1.protocol.ping-round-trip',
  })
})

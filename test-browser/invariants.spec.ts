import { type Page, expect, test } from '@playwright/test'

const MALFORMED_SCENARIO_ID = 'mx-multiplayer.s1.protocol.malformed-ping-payload'
const CONVERGENCE_SCENARIO_ID = 'world-sync.snapshot-transfer-convergence'
const BOUNDED_FRAME_COUNT = 8

type BrowserErrors = {
  readonly console: string[]
  readonly page: string[]
}

const browserErrors = new WeakMap<Page, BrowserErrors>()

test.beforeEach(({ page }) => {
  const errors: BrowserErrors = { console: [], page: [] }
  browserErrors.set(page, errors)
  page.on('console', (message) => {
    if (message.type() === 'error') {
      errors.console.push(message.text())
    }
  })
  page.on('pageerror', (error) => errors.page.push(error.message))
})

test.afterEach(({ page }) => {
  const errors = browserErrors.get(page)
  expect(errors).toBeDefined()
  expect(errors?.console).toEqual([])
  expect(errors?.page).toEqual([])
})

const openDebugUi = async (page: Page): Promise<void> => {
  await page.goto('/')
  await page.locator('body[data-ready="true"]').waitFor()
  await expect(page.locator('[data-panel-id="invariants"]')).toBeVisible()
}

const runScenarioFromPanel = async (page: Page, scenario: string): Promise<void> => {
  await page.getByTestId('invariants-scenario-select').selectOption(scenario)
  await page.getByTestId('invariants-run-scenario').click()
  await expect(page.getByTestId('invariants-run-summary'))
    .toContainText(`${scenario}; frame limit ${String(BOUNDED_FRAME_COUNT)}, reached ${String(BOUNDED_FRAME_COUNT)}`)
}

const expectObservedMalformedReason = async (page: Page): Promise<void> => {
  const occurred = page.getByTestId('invariants-reason-protocol-error-malformed-frame')
  await expect(occurred).toHaveAttribute('data-status', 'occurred')
  await expect(occurred).toContainText(MALFORMED_SCENARIO_ID)
  await expect(occurred).toContainText('decode rejected: malformed-frame')
}

const expectUnproducedPlayerDamageReason = async (page: Page): Promise<void> => {
  const negativeControl = page.getByTestId('invariants-reason-player-damage-wrong-world')
  await expect(negativeControl).toHaveAttribute('data-status', 'not-observed')
  await expect(negativeControl).toContainText('NOT OCCURRED')
  await expect(negativeControl).not.toContainText(MALFORMED_SCENARIO_ID)
}

const expectConvergenceEvidence = async (page: Page): Promise<void> => {
  const convergence = page.getByTestId('invariants-convergence')
  await expect(convergence).toHaveAttribute('data-status', 'pass')
  await expect(convergence).toContainText('both client world projections converged')
  await expect(convergence).toContainText('runtime authority revision')
}

const expectRuntimeInvariantPasses = async (page: Page): Promise<void> => {
  const revisions = page.getByTestId('invariants-revisions')
  await expect(revisions).toHaveAttribute('data-status', 'pass')
  await expect(revisions).toContainText('per-entity revision samples did not decrease')
  const wallClock = page.getByTestId('invariants-wall-clock')
  await expect(wallClock).toHaveAttribute('data-status', 'pass')
  await expect(wallClock).toContainText(`observed clock ${String(BOUNDED_FRAME_COUNT)}, frame ${String(BOUNDED_FRAME_COUNT)}`)
}

const expectScenarioEvaluator = async (page: Page): Promise<void> => {
  const scenarioAssertions = page.getByTestId('invariants-scenario-assertions')
  await expect(scenarioAssertions).toHaveAttribute('data-status', 'pass')
  await expect(scenarioAssertions).toContainText(CONVERGENCE_SCENARIO_ID)
}

// Catches a known runtime rejection being omitted or an unproduced reason being counted as covered.
test('shows runtime rejection evidence and keeps the negative control uncovered', async ({ page }) => {
  await openDebugUi(page)
  await runScenarioFromPanel(page, MALFORMED_SCENARIO_ID)
  await expectObservedMalformedReason(page)
  await expectUnproducedPlayerDamageReason(page)
})

// Catches decreasing revisions or wall-clock time being reported as a normal scenario pass.
test('computes runtime invariants and shows a future-revision negative control', async ({ page }) => {
  await openDebugUi(page)
  await runScenarioFromPanel(page, CONVERGENCE_SCENARIO_ID)
  await expectConvergenceEvidence(page)
  await expectRuntimeInvariantPasses(page)
  await expectScenarioEvaluator(page)

  await page.getByTestId('invariants-run-future-control').click()
  const futureControl = page.getByTestId('invariants-future-control')
  await expect(futureControl).toHaveAttribute('data-status', 'fail')
  await expect(futureControl).toContainText('FAIL')
  await expect(futureControl).toContainText('authority rejected command: stale-revision')
})

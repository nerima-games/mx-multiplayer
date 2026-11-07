import { type Page, expect, test } from '@playwright/test'
import type { ScenarioRuntimeFaultKind } from '../scenarios/types.js'

const ZERO = 0
const ONE = 1
const TWO = 2
const THREE = 3
const DUPLICATE_SCENARIO_ID = 'transport.fault.duplicate'
const PING_SCENARIO_ID = 'mx-multiplayer.s1.protocol.ping-round-trip'
const MALFORMED_SCENARIO_ID = 'mx-multiplayer.s1.protocol.malformed-ping-payload'
const FUTURE_SCENARIO_ID = 'authority.unsupported-reasons'

type InjectableFault = Exclude<ScenarioRuntimeFaultKind, 'none'>
type ExpectedVerdict = 'pass' | 'incomplete' | 'fail'
type FaultComparison = {
  readonly scenarioId: string
  readonly fault: InjectableFault
  readonly resultText: string
  readonly expectedFaultVerdict?: ExpectedVerdict
}
type FaultRun = {
  readonly scenarioId: string
  readonly fault: InjectableFault
  readonly expectedVerdict?: ExpectedVerdict
}

const captureBrowserErrors = (page: Page): string[] => {
  const errors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') {
      errors.push(message.text())
    }
  })
  page.on('pageerror', (error) => errors.push(error.message))
  return errors
}

const openDebugUi = async (page: Page): Promise<void> => {
  await page.goto('/')
  await page.locator('body[data-ready="true"]').waitFor()
  await expect(page.getByTestId('communication-wire-log')).toBeVisible()
}

const chooseScenario = async (page: Page, scenarioId: string): Promise<void> => {
  await page.getByTestId('communication-scenario').selectOption(scenarioId)
}

const runWithoutFault = async (
  page: Page,
  scenarioId: string,
  expectedVerdict: ExpectedVerdict,
): Promise<string | null> => {
  await chooseScenario(page, scenarioId)
  const status = page.getByTestId('communication-status')
  const verdict = page.getByTestId('communication-verdict')
  await page.getByRole('button', { name: 'Run without fault' }).click()
  await expect(status).toContainText(`${scenarioId}; fault none;`)
  await expect(verdict).toContainText(new RegExp(`^${expectedVerdict}:`, 'iu'))
  return verdict.textContent()
}

const runWithFault = async (page: Page, run: FaultRun): Promise<void> => {
  const expectedVerdict = run.expectedVerdict ?? 'pass'
  await expect(page.getByTestId('communication-fault').locator(`option[value="${run.fault}"]`))
    .not.toHaveAttribute('disabled')
  await page.getByTestId('communication-fault').selectOption(run.fault)
  await page.getByRole('button', { name: 'Inject fault and re-run' }).click()
  await expect(page.getByTestId('communication-status')).toContainText(`${run.scenarioId}; fault ${run.fault};`)
  await expect(page.getByTestId('communication-verdict')).toContainText(new RegExp(`^${expectedVerdict}:`, 'iu'))
}

const expectClientAEntry = async (page: Page, resultText: string): Promise<void> => {
  const row = page.getByTestId('communication-wire-row').first()
  await expect(row).toContainText('client-a')
  await expect(row).toContainText('BowUseCommand')
  await expect(row.locator('[data-column="frame"]')).toHaveText(String(ONE))
  await expect(row.locator('[data-column="size"]')).not.toHaveText(String(ZERO))
  await expect(row.locator('[data-column="result"]')).toContainText(resultText)
}

const expectClientBEntry = async (page: Page): Promise<void> => {
  const row = page.getByTestId('communication-wire-row').nth(ONE)
  await expect(row).toContainText('client-b')
  await expect(row.locator('[data-column="result"]')).toContainText('accepted')
}

const expectFaultWireLog = async (page: Page, resultText: string): Promise<void> => {
  await expect(page.getByTestId('communication-wire-row')).toHaveCount(TWO)
  await expectClientAEntry(page, resultText)
  await expectClientBEntry(page)
}

const expectChangedVerdict = async (
  page: Page,
  noFaultVerdict: string | null,
  expectedFaultVerdict: ExpectedVerdict = 'pass',
): Promise<void> => {
  const verdict = page.getByTestId('communication-verdict')
  await expect(verdict).toContainText(new RegExp(`^${expectedFaultVerdict}:`, 'iu'))
  expect(await verdict.textContent()).not.toBe(noFaultVerdict)
}

const expectFaultComparison = async (
  page: Page,
  comparison: FaultComparison,
  expectedNoFaultVerdict: ExpectedVerdict,
): Promise<void> => {
  const noFaultVerdict = await runWithoutFault(page, comparison.scenarioId, expectedNoFaultVerdict)
  const expectedFaultVerdict = comparison.expectedFaultVerdict ?? 'pass'
  await runWithFault(page, {
    expectedVerdict: expectedFaultVerdict,
    fault: comparison.fault,
    scenarioId: comparison.scenarioId,
  })
  await expectFaultWireLog(page, comparison.resultText)
  await expectChangedVerdict(page, noFaultVerdict, expectedFaultVerdict)
}

const expectRejectedWireEntry = async (page: Page): Promise<void> => {
  const row = page.getByTestId('communication-wire-row').first()
  await expect(row.locator('[data-column="frame"]')).toHaveText(String(ONE))
  await expect(row.locator('[data-column="sender"]')).toHaveText('client-a')
  await expect(row.locator('[data-column="tag"]')).toHaveText('?')
  await expect(row.locator('[data-column="size"]')).not.toHaveText(String(ZERO))
  await expect(row.locator('[data-column="result"]')).toHaveText('rejected: decode rejected: malformed-frame')
}

const expectFirstWireResult = async (page: Page, result: string): Promise<void> => {
  await expect(page.getByTestId('communication-wire-row').first().locator('[data-column="result"]'))
    .toHaveText(result)
}

// Catches a drop control that changes the label but still delivers client A's frame.
test('drop fault changes the verdict and is visible on the wire log', async ({ page }) => {
  const browserErrors = captureBrowserErrors(page)
  await openDebugUi(page)
  await expectFaultComparison(page, {
    fault: 'drop',
    resultText: 'dropped',
    scenarioId: 'transport.fault.drop',
  }, 'incomplete')
  expect(browserErrors).toEqual([])
})

// Catches a reorder control that leaves wire delivery in submission order.
test('reorder fault changes the verdict and records delivery order', async ({ page }) => {
  const browserErrors = captureBrowserErrors(page)
  await openDebugUi(page)
  await expectFaultComparison(page, {
    fault: 'reorder',
    resultText: 'reordered',
    scenarioId: 'transport.fault.reorder',
  }, 'incomplete')
  expect(browserErrors).toEqual([])
})

// Catches a delay control that reports success without holding client A's frame.
test('delay fault changes the verdict and reports the delayed frame', async ({ page }) => {
  const browserErrors = captureBrowserErrors(page)
  await openDebugUi(page)
  await expectFaultComparison(page, {
    fault: 'delay',
    resultText: 'delayed',
    scenarioId: 'transport.fault.delay',
  }, 'incomplete')
  expect(browserErrors).toEqual([])
})

// Catches a disconnect control that also disconnects or drops client B.
test('disconnect fault changes the verdict while the peer frame remains accepted', async ({ page }) => {
  const browserErrors = captureBrowserErrors(page)
  await openDebugUi(page)
  await expectFaultComparison(page, {
    fault: 'disconnect',
    resultText: 'disconnected',
    scenarioId: 'transport.fault.disconnect',
  }, 'incomplete')
  expect(browserErrors).toEqual([])
})

// Catches a rejected frame being shown without its typed reason or byte size.
test('rejected wire entries show the decoder reason and encoded size', async ({ page }) => {
  const browserErrors = captureBrowserErrors(page)
  await openDebugUi(page)
  await runWithoutFault(page, MALFORMED_SCENARIO_ID, 'pass')
  await expectRejectedWireEntry(page)
  expect(browserErrors).toEqual([])
})

// Catches corrupt injection being aliased instead of rejected by the real frame decoder.
test('corrupt fault changes the verdict and shows the malformed-frame rejection', async ({ page }) => {
  const browserErrors = captureBrowserErrors(page)
  await openDebugUi(page)
  const noFaultVerdict = await runWithoutFault(page, PING_SCENARIO_ID, 'pass')
  await runWithFault(page, { expectedVerdict: 'fail', fault: 'corrupt', scenarioId: PING_SCENARIO_ID })
  await expectFirstWireResult(page, 'rejected: decode rejected: malformed-frame')
  await expectChangedVerdict(page, noFaultVerdict, 'fail')
  expect(browserErrors).toEqual([])
})

// Catches version injection being aliased instead of rejected by the real frame decoder.
test('version fault changes the verdict and shows the protocol-version rejection', async ({ page }) => {
  const browserErrors = captureBrowserErrors(page)
  await openDebugUi(page)
  const noFaultVerdict = await runWithoutFault(page, PING_SCENARIO_ID, 'pass')
  await runWithFault(page, { expectedVerdict: 'fail', fault: 'version', scenarioId: PING_SCENARIO_ID })
  await expectFirstWireResult(page, 'rejected: decode rejected: unsupported-protocol-version')
  await expectChangedVerdict(page, noFaultVerdict, 'fail')
  expect(browserErrors).toEqual([])
})

// Catches a future revision reaching authority without its typed stale-revision rejection.
test('future fault changes the verdict and shows the stale-revision rejection', async ({ page }) => {
  const browserErrors = captureBrowserErrors(page)
  await openDebugUi(page)
  const noFaultVerdict = await runWithoutFault(page, FUTURE_SCENARIO_ID, 'pass')
  await runWithFault(page, { expectedVerdict: 'fail', fault: 'future', scenarioId: FUTURE_SCENARIO_ID })
  await expectFirstWireResult(page, 'rejected: authority rejected command: stale-revision')
  await expectChangedVerdict(page, noFaultVerdict, 'fail')
  expect(browserErrors).toEqual([])
})

// Catches an inapplicable future fault hiding a successfully decoded Ping result.
test('future fault note preserves ordinary Ping delivery', async ({ page }) => {
  const browserErrors = captureBrowserErrors(page)
  await openDebugUi(page)
  const noFaultVerdict = await runWithoutFault(page, PING_SCENARIO_ID, 'pass')
  await runWithFault(page, { fault: 'future', scenarioId: PING_SCENARIO_ID })
  await expectFirstWireResult(page, "fault 'future' not applicable to Ping; delivered: decoded Ping")
  expect(await page.getByTestId('communication-verdict').textContent()).toBe(noFaultVerdict)
  expect(browserErrors).toEqual([])
})

// Catches an inapplicable version fault hiding the malformed-frame decoder rejection.
test('version fault note preserves the malformed Ping rejection', async ({ page }) => {
  const browserErrors = captureBrowserErrors(page)
  await openDebugUi(page)
  await runWithoutFault(page, MALFORMED_SCENARIO_ID, 'pass')
  await runWithFault(page, { fault: 'version', scenarioId: MALFORMED_SCENARIO_ID })
  await expectFirstWireResult(page, "fault 'version' not applicable to ?; rejected: decode rejected: malformed-frame")
  expect(browserErrors).toEqual([])
})

// Catches duplicate injection applying an accepted intent twice instead of receiving the authority's replay acknowledgment.
test('duplicate fault changes the verdict and shows the real idempotent replay', async ({ page }) => {
  const browserErrors = captureBrowserErrors(page)
  await openDebugUi(page)
  const noFaultVerdict = await runWithoutFault(page, DUPLICATE_SCENARIO_ID, 'pass')
  await runWithFault(page, { expectedVerdict: 'incomplete', fault: 'duplicate', scenarioId: DUPLICATE_SCENARIO_ID })
  await expect(page.getByTestId('communication-wire-row').filter({ hasText: /duplicated\/replay/iu }))
    .toHaveCount(THREE)
  await expectChangedVerdict(page, noFaultVerdict, 'incomplete')
  expect(browserErrors).toEqual([])
})

// Catches a duplicate replay scenario hiding repeated encoded submissions from the wire log.
test('no-fault replay scenario remains visible in the wire log', async ({ page }) => {
  const browserErrors = captureBrowserErrors(page)
  await openDebugUi(page)
  await runWithoutFault(page, DUPLICATE_SCENARIO_ID, 'pass')
  await expect(page.getByTestId('communication-wire-row').filter({ hasText: /duplicated\/replay/iu }))
    .toHaveCount(ONE)
  expect(browserErrors).toEqual([])
})

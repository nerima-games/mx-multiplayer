import { type Locator, type Page, expect, test } from '@playwright/test'
import { CONNECTION_RATE_LIMITS } from '../src/domain/rate-limit.js'

const DISCONNECT_SCENARIO_ID = 'transport.fault.disconnect'
const ZERO = 0
const ONE = 1
const INITIAL_FRAME = ZERO
const FRAME_INCREMENT = ONE
const NEXT_FRAME = INITIAL_FRAME + FRAME_INCREMENT
const INITIAL_PLAY = ZERO
const INITIAL_PANEL = ZERO
const INITIAL_SEED = ZERO
const NORMAL_SPEED = ONE
const NO_BUTTONS = ZERO
const BYTE_CAPACITY = CONNECTION_RATE_LIMITS.bytesPerSecond
  / CONNECTION_RATE_LIMITS.framesPerSecond
  * CONNECTION_RATE_LIMITS.burstFrames
const FULL_DELTA_FRAMES = Math.floor(BYTE_CAPACITY / CONNECTION_RATE_LIMITS.maxDeltaBytes)
const REMAINING_BYTE_CAPACITY = BYTE_CAPACITY - FULL_DELTA_FRAMES * CONNECTION_RATE_LIMITS.maxDeltaBytes
const ACCEPTED_BYTE_RATE_FRAMES = FULL_DELTA_FRAMES + Number(REMAINING_BYTE_CAPACITY > ZERO)

type BrowserErrors = {
  readonly console: string[]
  readonly page: string[]
}

type TelemetryBefore = {
  readonly rates: string | null
  readonly runtime: string | null
  readonly traffic: string | null
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

const openDebugUi = async (page: Page, path = '/'): Promise<void> => {
  await page.goto(path)
  await page.locator('body[data-ready="true"]').waitFor()
}

const scenarioPath = (scenario: string): string => {
  const params = new URLSearchParams({
    fault: 'none',
    frame: String(INITIAL_FRAME),
    panel: String(INITIAL_PANEL),
    play: String(INITIAL_PLAY),
    scenario,
    seed: String(INITIAL_SEED),
    speed: String(NORMAL_SPEED),
  })
  return `/?${params.toString()}`
}

const expectConfiguredCaps = async (rates: Locator): Promise<void> => {
  await Promise.all(Object.values(CONNECTION_RATE_LIMITS).map((limit) =>
    expect(rates).toContainText(String(limit))))
  await expect(rates).toContainText(/live rate unsupported/i)
}

const expectNoRuntimeState = async (page: Page): Promise<void> => {
  const panel = page.locator('[data-panel-id="connection-security"]')
  await expect(panel).toBeVisible()
  await expect(page.getByTestId('connection-security-runtime')).toContainText(/runtime telemetry unsupported/i)
  await expect(page.getByTestId('connection-security-capability'))
    .toContainText('Unsupported: no scenario runtime is mounted.')
  await expect(page.getByTestId('connection-security-security'))
    .toContainText('Unsupported: no scenario runtime is mounted.')
  await expect(page.getByTestId('connection-security-reconnect'))
    .toContainText(/auth result unsupported.*no scenario runtime is mounted/iu)
  await expect(panel.getByRole('button', { name: /reconnect/i })).toHaveCount(NO_BUTTONS)
}

const readTelemetry = async (page: Page): Promise<TelemetryBefore> => ({
  rates: await page.getByTestId('connection-security-rates').textContent(),
  runtime: await page.getByTestId('connection-security-runtime').textContent(),
  traffic: await page.getByTestId('connection-security-traffic').textContent(),
})

const clickDisconnectScenario = async (page: Page): Promise<void> => {
  await page.getByRole('button', { name: 'Run disconnect scenario' }).click()
  await expect(page.getByTestId('participants-run-summary')).toContainText(DISCONNECT_SCENARIO_ID)
}

const expectDisconnectClients = async (page: Page): Promise<void> => {
  await expect(page.getByTestId('connection-security-clients')).toContainText(/client-a.*not connected/iu)
  await expect(page.getByTestId('connection-security-clients')).toContainText(/client-b.*connected/iu)
  await expect(page.getByTestId('connection-security-capability')).toContainText('client-a: blocked')
  await expect(page.getByTestId('connection-security-capability')).toContainText('client-b: allowed')
}

const expectSelectedFrame = async (page: Page, frame: number): Promise<void> => {
  await expect(page.getByTestId('connection-security-runtime'))
    .toContainText(new RegExp(`frame\\D*${frame}`, 'i'))
}

const expectRuntimeOutcome = async (page: Page, before: TelemetryBefore): Promise<void> => {
  const runtime = page.getByTestId('connection-security-runtime')
  const traffic = page.getByTestId('connection-security-traffic')
  const security = page.getByTestId('connection-security-security')
  await expect(runtime).toContainText(DISCONNECT_SCENARIO_ID)
  await expectSelectedFrame(page, NEXT_FRAME)
  await expect(security).toContainText('scenario evaluation pass')
  expect(await runtime.textContent()).not.toBe(before.runtime)
  expect(await traffic.textContent()).not.toBe(before.traffic)
}

const expectUnchangedConfiguredCaps = async (page: Page, before: TelemetryBefore): Promise<void> => {
  const rates = page.getByTestId('connection-security-rates')
  await expectConfiguredCaps(rates)
  await expect(rates).toHaveText(before.rates ?? '')
}

const expectDisconnectTelemetry = async (page: Page, before: TelemetryBefore): Promise<void> => {
  await expectRuntimeOutcome(page, before)
  await expectUnchangedConfiguredCaps(page, before)
  await expectDisconnectClients(page)
}

const expectNoRuntimeScenario = async (page: Page): Promise<void> => {
  await expect(page.getByTestId('connection-security-runtime')).toContainText('Scenario from URL: none')
  await expectSelectedFrame(page, INITIAL_FRAME)
}

const stepSelectedFrame = async (page: Page, rates: Locator, configuredRates: string | null): Promise<void> => {
  await page.getByRole('button', { name: 'Step frame' }).click()
  await expect(page.getByTestId('url-state')).toContainText(`"frame": ${NEXT_FRAME}`)
  await expectSelectedFrame(page, NEXT_FRAME)
  await expect(rates).toHaveText(configuredRates ?? '')
}

const readRateProbeResults = async (page: Page): Promise<{ byte: string | null; frame: string | null }> => ({
  byte: await page.getByTestId('connection-security-byte-probe').textContent(),
  frame: await page.getByTestId('connection-security-frame-probe').textContent(),
})

const expectSuccessfulRateProbes = async (page: Page): Promise<void> => {
  await expect(page.getByTestId('connection-security-frame-probe'))
    .toHaveText(`Positive control accepted ${CONNECTION_RATE_LIMITS.burstFrames}/${CONNECTION_RATE_LIMITS.burstFrames}; overflow rejected (frame-rate).`)
  await expect(page.getByTestId('connection-security-byte-probe'))
    .toHaveText(`Positive control accepted ${ACCEPTED_BYTE_RATE_FRAMES} frames up to byte capacity; overflow rejected (byte-rate).`)
}

const runRateProbe = async (page: Page): Promise<void> => {
  const frameProbe = page.getByTestId('connection-security-frame-probe')
  const byteProbe = page.getByTestId('connection-security-byte-probe')
  await expect(frameProbe).toHaveText('Not run.')
  await expect(byteProbe).toHaveText('Not run.')
  const before = await readRateProbeResults(page)
  await page.getByRole('button', { name: 'Run frame and byte rate probes' }).click()
  await expectSuccessfulRateProbes(page)
  const after = await readRateProbeResults(page)
  expect(after.frame).not.toBe(before.frame)
  expect(after.byte).not.toBe(before.byte)
}

// Catches stale UI8 telemetry when the actual transport runtime disconnects only client A.
test('observes a disconnect scenario and keeps source-backed limits stable', async ({ page }, testInfo) => {
  await openDebugUi(page)
  await expectNoRuntimeState(page)
  const rates = page.getByTestId('connection-security-rates')
  await expectConfiguredCaps(rates)
  const before = await readTelemetry(page)

  await clickDisconnectScenario(page)
  await expectDisconnectTelemetry(page, before)

  await page.screenshot({
    fullPage: true,
    path: testInfo.outputPath(`${DISCONNECT_SCENARIO_ID}.png`),
  })
})

// Catches a panel that reports connection or authorization results when no scenario runtime supplied them.
test('labels missing runtime security data and reflects the selected frame', async ({ page }, testInfo) => {
  await openDebugUi(page, scenarioPath(''))
  await expectNoRuntimeState(page)
  await expectNoRuntimeScenario(page)

  const rates = page.getByTestId('connection-security-rates')
  await expectConfiguredCaps(rates)
  const configuredRates = await rates.textContent()

  await stepSelectedFrame(page, rates, configuredRates)
  await page.screenshot({
    fullPage: true,
    path: testInfo.outputPath('no-runtime.png'),
  })
})

// Catches an off-by-one rate guard and a limiter that rejects a frame still within byte capacity.
test('rate probes admit the configured capacity and reject only the overflow', async ({ page }, testInfo) => {
  await openDebugUi(page)
  await expectNoRuntimeState(page)
  await expectConfiguredCaps(page.getByTestId('connection-security-rates'))
  await runRateProbe(page)

  await page.screenshot({
    fullPage: true,
    path: testInfo.outputPath('rate-probe.png'),
  })
})

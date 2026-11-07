import { type Page, expect, test } from '@playwright/test'

const SCENARIO_ID = 'transport.connection.two-clients'
const UNKNOWN_SCENARIO_ID = 'missing.scenario'
const SEED = 17
const INITIAL_FRAME = 0
const FRAME_INCREMENT = 1
const FIRST_FRAME = INITIAL_FRAME + FRAME_INCREMENT
const TARGET_FRAME = 12
const INITIAL_SPEED = 1
const DOUBLE_SPEED = 2
const INITIAL_PANEL = 0
const PAUSED_STATE = '0'
const FRAME_NOT_RENDERED = -1
const PAUSE_OBSERVATION_WINDOW_MS = 150

const UNKNOWN_SCENARIO_JSON = `{"scenarioId":"${UNKNOWN_SCENARIO_ID}","seed":${SEED},"fault":{"kind":"none"},"frame":${INITIAL_FRAME},"speed":${INITIAL_SPEED},"panel":${INITIAL_PANEL}}`
const MALFORMED_SEED_JSON = `{"scenarioId":"${SCENARIO_ID}","seed":"invalid","fault":{"kind":"none"},"frame":${INITIAL_FRAME},"speed":${INITIAL_SPEED},"panel":${INITIAL_PANEL}}`

type RejectedImportCase = {
  readonly json: string
  readonly reason: RegExp
}

const UNKNOWN_SCENARIO_CASE: RejectedImportCase = {
  json: UNKNOWN_SCENARIO_JSON,
  reason: /unknown|not found|unregistered/iu,
}
const MALFORMED_SEED_CASE: RejectedImportCase = {
  json: MALFORMED_SEED_JSON,
  reason: /required schema|fields do not match/iu,
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

const assertNoBrowserErrors = (errors: ReadonlyArray<string>): void => {
  expect(errors).toEqual([])
}

const waitForTimelineReady = async (page: Page, expectedFrame: number): Promise<void> => {
  const timelinePanel = page.locator('[data-panel-id="timeline"]')
  await expect(timelinePanel.getByRole('button', { name: 'Step one frame' })).toBeEnabled()
  await expect(timelinePanel.getByTestId('timeline-frame')).toHaveText(String(expectedFrame))
  await expect(page.getByTestId('timeline-result')).toContainText(SCENARIO_ID)
}

const openTimeline = async (page: Page): Promise<void> => {
  const parameters = new URLSearchParams({
    fault: 'none',
    frame: String(INITIAL_FRAME),
    panel: String(INITIAL_PANEL),
    play: PAUSED_STATE,
    scenario: SCENARIO_ID,
    seed: String(SEED),
    speed: String(INITIAL_SPEED),
  })
  await page.goto(`/?${parameters.toString()}`)
  await page.locator('body[data-ready="true"]').waitFor()
  await waitForTimelineReady(page, INITIAL_FRAME)
}

const readRuntimeFrame = async (page: Page): Promise<number> => {
  const frame = await page.getByTestId('timeline-frame').textContent()
  if (frame === null) {
    return FRAME_NOT_RENDERED
  }
  return Number(frame)
}

const readUrlFrame = (page: Page): number =>
  Number(new URL(page.url()).searchParams.get('frame'))

const assertTimelineFrame = async (page: Page, expectedFrame: number): Promise<void> => {
  await expect(page.getByTestId('timeline-frame')).toHaveText(String(expectedFrame))
  await expect.poll(() => readUrlFrame(page)).toBe(expectedFrame)
}

const setTimelineSpeed = async (page: Page, speed: number): Promise<void> => {
  await page.getByLabel('Timeline speed').selectOption(String(speed))
  await expect(page.getByTestId('timeline-result')).toContainText(new RegExp(`"speed"\\s*:\\s*${speed}`, 'u'))
  await expect.poll(() => new URL(page.url()).searchParams.get('speed')).toBe(String(speed))
}

const stepOneFrame = async (page: Page): Promise<void> => {
  const timelinePanel = page.locator('[data-panel-id="timeline"]')
  await timelinePanel.getByRole('button', { name: 'Step one frame' }).click()
  await assertTimelineFrame(page, FIRST_FRAME)
}

const seekTimeline = async (page: Page, targetFrame: number): Promise<void> => {
  await page.getByLabel('Seek to frame').fill(String(targetFrame))
  await page.getByRole('button', { name: 'Seek' }).click()
  await assertTimelineFrame(page, targetFrame)
}

const resetTimeline = async (page: Page): Promise<void> => {
  const timelinePanel = page.locator('[data-panel-id="timeline"]')
  await timelinePanel.getByRole('button', { name: 'Reset' }).click()
  await assertTimelineFrame(page, INITIAL_FRAME)
  await expect.poll(() => new URL(page.url()).searchParams.get('speed')).toBe(String(INITIAL_SPEED))
}

const playAndPauseTimeline = async (page: Page): Promise<void> => {
  const timelinePanel = page.locator('[data-panel-id="timeline"]')
  await timelinePanel.getByRole('button', { name: 'Play' }).click()
  await expect.poll(() => readRuntimeFrame(page)).toBeGreaterThan(INITIAL_FRAME)
  await timelinePanel.getByRole('button', { name: 'Pause' }).click()
  await expect.poll(() => new URL(page.url()).searchParams.get('play')).toBe(PAUSED_STATE)
  await expect.poll(async () => (await readRuntimeFrame(page)) - readUrlFrame(page)).toBe(INITIAL_FRAME)

  const pausedFrame = await readRuntimeFrame(page)
  await page.waitForTimeout(PAUSE_OBSERVATION_WINDOW_MS)
  expect(await readRuntimeFrame(page)).toBe(pausedFrame)
  expect(readUrlFrame(page)).toBe(pausedFrame)
}

const readRuntimeResult = async (page: Page): Promise<string> => {
  const result = await page.getByTestId('timeline-result').textContent()
  if (result === null) {
    return ''
  }
  return result
}

const assertExportFields = (exportedJson: string): void => {
  expect(exportedJson).toMatch(new RegExp(`"scenarioId"\\s*:\\s*"${SCENARIO_ID}"`, 'u'))
  expect(exportedJson).toMatch(new RegExp(`"seed"\\s*:\\s*${SEED}`, 'u'))
  expect(exportedJson).toMatch(/"fault"\s*:\s*\{/u)
  expect(exportedJson).toMatch(new RegExp(`"frame"\\s*:\\s*${TARGET_FRAME}`, 'u'))
  expect(exportedJson).toMatch(new RegExp(`"speed"\\s*:\\s*${DOUBLE_SPEED}`, 'u'))
  expect(exportedJson).toMatch(new RegExp(`"panel"\\s*:\\s*${INITIAL_PANEL}`, 'u'))
}

const exportCurrentResult = async (page: Page): Promise<{ readonly result: string; readonly json: string }> => {
  const result = await readRuntimeResult(page)
  expect(result).not.toBe('')
  expect(result).toContain('"wireLog"')
  expect(result).toContain('"verdict"')

  await page.getByRole('button', { name: 'Export reproduction JSON' }).click()
  const json = await page.getByLabel('Reproduction JSON').inputValue()
  assertExportFields(json)
  return { json, result }
}

const importReproduction = async (page: Page, json: string): Promise<void> => {
  const timelinePanel = page.locator('[data-panel-id="timeline"]')
  await timelinePanel.getByLabel('Reproduction JSON').fill(json)
  await timelinePanel.getByRole('button', { name: 'Import reproduction JSON' }).click()
}

const restoreExportedResultAfterReload = async (
  page: Page,
  exportedJson: string,
  originalResult: string,
): Promise<void> => {
  await page.reload()
  await page.locator('body[data-ready="true"]').waitFor()
  await waitForTimelineReady(page, TARGET_FRAME)
  await resetTimeline(page)
  expect(await readRuntimeResult(page)).not.toBe(originalResult)
  await importReproduction(page, exportedJson)
  await expect.poll(() => readRuntimeResult(page)).toBe(originalResult)
}

const exportReloadImportRoundTrip = async (page: Page): Promise<void> => {
  await setTimelineSpeed(page, DOUBLE_SPEED)
  await seekTimeline(page, TARGET_FRAME)
  const exported = await exportCurrentResult(page)
  await restoreExportedResultAfterReload(page, exported.json, exported.result)
}

const expectRejectedImport = async (
  page: Page,
  rejectedCase: RejectedImportCase,
  originalResult: string,
): Promise<void> => {
  await importReproduction(page, rejectedCase.json)
  const importError = page.getByTestId('timeline-import-error')
  await expect(importError).toBeVisible()
  await expect(importError).toContainText(rejectedCase.reason)
  expect(await readRuntimeResult(page)).toBe(originalResult)
}

const rejectInvalidReproductions = async (page: Page): Promise<void> => {
  const originalResult = await readRuntimeResult(page)
  await expectRejectedImport(page, UNKNOWN_SCENARIO_CASE, originalResult)
  await expectRejectedImport(page, MALFORMED_SEED_CASE, originalResult)
}

test('step, seek, speed, and reset operate on the scenario runtime', async ({ page }) => {
  // Catches controls that update URL state without changing the live runtime.
  const browserErrors = captureBrowserErrors(page)
  await openTimeline(page)
  await stepOneFrame(page)
  await setTimelineSpeed(page, DOUBLE_SPEED)
  await seekTimeline(page, TARGET_FRAME)
  await resetTimeline(page)
  assertNoBrowserErrors(browserErrors)
})

test('play and pause keep runtime and URL frames aligned without extra steps', async ({ page }) => {
  // Catches duplicate scheduler loops and frames that advance after pause.
  const browserErrors = captureBrowserErrors(page)
  await openTimeline(page)
  await playAndPauseTimeline(page)
  assertNoBrowserErrors(browserErrors)
})

test('exported reproduction restores an identical full runtime result after reload', async ({ page }) => {
  // Catches reproduction imports that lose wire log entries or verdict details.
  const browserErrors = captureBrowserErrors(page)
  await openTimeline(page)
  await exportReloadImportRoundTrip(page)
  assertNoBrowserErrors(browserErrors)
})

test('import rejects unknown scenarios and malformed fields with a visible reason', async ({ page }) => {
  // Catches untrusted reproduction JSON bypassing schema or catalog validation.
  const browserErrors = captureBrowserErrors(page)
  await openTimeline(page)
  await rejectInvalidReproductions(page)
  assertNoBrowserErrors(browserErrors)
})

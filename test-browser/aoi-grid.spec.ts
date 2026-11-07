import { type Page, expect, test } from '@playwright/test'
import { chunkInterestKeyForBlockChange } from '../src/index.js'
import { projectVisibilityLoadFrame } from '../scenarios/visibility-load.js'

const FIRST_PROJECTED_FRAME = 1
const FIRST_BLOCK_CHANGE_INDEX = 0
const CLIENT_A_BLOCK_X = 15
const CLIENT_B_BLOCK_X = 16
const EXPECTED_CHUNK_COUNT = 2
const EXPECTED_DELIVERY_COUNT = 2
const EXPECTED_SINGLE_DELIVERY_COUNT = 1
const EXPECTED_NO_DELIVERY_COUNT = 0

type RuntimeErrors = Readonly<{
  console: Array<string>
  page: Array<string>
}>

type ExpectedChunkKeys = Readonly<{
  clientA: string
  clientB: string
}>

type ExpectedDelivery = Readonly<{
  clientId: 'client-a' | 'client-b'
  blockX: number
  chunkKey: string
}>

const captureRuntimeErrors = (page: Page): RuntimeErrors => {
  const errors: RuntimeErrors = { console: [], page: [] }
  page.on('console', (message) => {
    if (message.type() === 'error') {
      errors.console.push(message.text())
    }
  })
  page.on('pageerror', (error) => errors.page.push(error.message))
  return errors
}

const assertNoRuntimeErrors = (errors: RuntimeErrors): void => {
  expect(errors.console).toStrictEqual([])
  expect(errors.page).toStrictEqual([])
}

const openDebugUi = async (page: Page): Promise<void> => {
  await page.goto('/')
  await page.locator('body[data-ready="true"]').waitFor()
}

const expectedChunkKeys = (): ExpectedChunkKeys => {
  const projections = projectVisibilityLoadFrame(FIRST_PROJECTED_FRAME)
  const clientAChange = projections.get('client-a')?.blockChanges[FIRST_BLOCK_CHANGE_INDEX]
  const clientBChange = projections.get('client-b')?.blockChanges[FIRST_BLOCK_CHANGE_INDEX]
  if (clientAChange === undefined || clientBChange === undefined) {
    throw new Error('S4 must project one block change to each client')
  }
  expect(clientAChange.position.x).toBe(CLIENT_A_BLOCK_X)
  expect(clientBChange.position.x).toBe(CLIENT_B_BLOCK_X)
  return {
    clientA: chunkInterestKeyForBlockChange(clientAChange),
    clientB: chunkInterestKeyForBlockChange(clientBChange),
  }
}

const expectChunkCells = async (panel: ReturnType<Page['getByTestId']>, keys: ExpectedChunkKeys): Promise<void> => {
  const chunks = panel.getByTestId('aoi-chunk')
  await expect(chunks).toHaveCount(EXPECTED_CHUNK_COUNT)
  const clientAChunk = chunks.filter({ hasText: 'client-a' })
  const clientBChunk = chunks.filter({ hasText: 'client-b' })
  await expect(clientAChunk).toHaveAttribute('data-chunk', keys.clientA)
  await expect(clientAChunk).not.toContainText('client-b')
  await expect(clientBChunk).toHaveAttribute('data-chunk', keys.clientB)
  await expect(clientBChunk).not.toContainText('client-a')
}

const expectDelivery = async (
  panel: ReturnType<Page['getByTestId']>,
  expected: ExpectedDelivery,
): Promise<void> => {
  const row = panel.locator(`[data-testid="aoi-delivery"][data-client="${expected.clientId}"]`)
  await expect(row).toHaveCount(EXPECTED_SINGLE_DELIVERY_COUNT)
  await expect(row).toHaveAttribute('data-block-x', String(expected.blockX))
  await expect(row).toHaveAttribute('data-chunk', expected.chunkKey)
  await expect(row).toContainText(`block (${String(expected.blockX)},`)
  await expect(row).toContainText(/delivered/i)
}

const expectNoCrossClientDelivery = async (
  panel: ReturnType<Page['getByTestId']>,
  clientId: 'client-a' | 'client-b',
  otherBlockX: number,
): Promise<void> => {
  await expect(panel.locator(
    `[data-testid="aoi-delivery"][data-client="${clientId}"][data-block-x="${String(otherBlockX)}"]`,
  )).toHaveCount(EXPECTED_NO_DELIVERY_COUNT)
}

const runAndStepScenario = async (page: Page, status: ReturnType<Page['getByTestId']>): Promise<void> => {
  const initialStatus = await status.textContent()
  await page.getByRole('button', { name: 'Run AOI scenario' }).click()
  await expect(status).not.toHaveText(initialStatus ?? '')
  await expect(page.getByRole('button', { name: 'Step AOI frame' })).toBeEnabled()
  const runStatus = await status.textContent()
  await page.getByRole('button', { name: 'Step AOI frame' }).click()
  await expect(status).not.toHaveText(runStatus ?? '')
}

const expectScenarioProjection = async (panel: ReturnType<Page['getByTestId']>): Promise<void> => {
  const keys = expectedChunkKeys()
  await expectChunkCells(panel, keys)
  await expect(panel.getByTestId('aoi-delivery')).toHaveCount(EXPECTED_DELIVERY_COUNT)
  await expectDelivery(panel, { blockX: CLIENT_A_BLOCK_X, chunkKey: keys.clientA, clientId: 'client-a' })
  await expectDelivery(panel, { blockX: CLIENT_B_BLOCK_X, chunkKey: keys.clientB, clientId: 'client-b' })
  await expectNoCrossClientDelivery(panel, 'client-a', CLIENT_B_BLOCK_X)
  await expectNoCrossClientDelivery(panel, 'client-b', CLIENT_A_BLOCK_X)
}

test('shows per-client AOI chunks and runtime delta targets', async ({ page }, testInfo) => {
  // Fails if x=15/16 share a chunk, a client's projected delta leaks to the other, or the panel stops advancing the real runtime.
  const errors = captureRuntimeErrors(page)
  await openDebugUi(page)
  const panel = page.getByTestId('aoi-grid')
  const status = page.getByTestId('aoi-runtime-status')
  await expect(panel).toBeVisible()
  await expect(status).toBeVisible()
  await runAndStepScenario(page, status)
  await expectScenarioProjection(panel)
  await page.screenshot({
    path: testInfo.outputPath('s4.visibility-load.aoi-rate-boundaries.png'),
  })
  assertNoRuntimeErrors(errors)
})

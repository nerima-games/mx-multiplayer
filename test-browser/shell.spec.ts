import { type Page, expect, test } from '@playwright/test'
import type { ScenarioUrlState } from '../scenarios/types.js'

const INITIAL_FRAME = 23
const FRAME_INCREMENT = 1
const FRAME_AFTER_STEP = INITIAL_FRAME + FRAME_INCREMENT
const NEXT_SPEED_AFTER_FIRST_CLICK = 2

const validState: ScenarioUrlState = {
  fault: 'drop',
  frame: 9,
  panel: 1,
  play: 0,
  scenario: 'protocol-demo',
  seed: 17,
  speed: 4,
}

const validParameters: Record<keyof ScenarioUrlState, string> = {
  fault: validState.fault,
  frame: String(validState.frame),
  panel: String(validState.panel),
  play: String(validState.play),
  scenario: validState.scenario,
  seed: String(validState.seed),
  speed: String(validState.speed),
}

const invalidCases: ReadonlyArray<{
  readonly fallback: ScenarioUrlState[keyof ScenarioUrlState]
  readonly invalid: string
  readonly key: keyof ScenarioUrlState
  readonly replacement: string
}> = [
  { fallback: '', invalid: '  ', key: 'scenario', replacement: '""' },
  { fallback: 0, invalid: '2', key: 'play', replacement: '0' },
  { fallback: 1, invalid: '3', key: 'speed', replacement: '1' },
  { fallback: 0, invalid: '2', key: 'panel', replacement: '0' },
  { fallback: 0, invalid: '-1', key: 'seed', replacement: '0' },
  { fallback: 'none', invalid: 'jam', key: 'fault', replacement: '"none"' },
  { fallback: 0, invalid: '1.5', key: 'frame', replacement: '0' },
]

const openShell = async (page: Page, search: string): Promise<void> => {
  await page.goto(search)
  await page.locator('body[data-ready="true"]').waitFor()
}

const expectState = async (page: Page, expected: ScenarioUrlState): Promise<void> => {
  const stateText = await page.getByTestId('url-state').textContent()
  expect(stateText).not.toBeNull()
  expect(JSON.parse(stateText ?? 'null')).toEqual(expected)
}

const expectControlLabels = async (page: Page): Promise<void> => {
  const labels = ['Pause', 'Step frame', 'Play', 'Speed', 'Reset']
  const controls = page.getByRole('navigation', { name: 'Simulation controls' })
  await Promise.all(labels.map((name) => expect(controls.getByRole('button', { name })).toBeVisible()))
}

const clickButton = (page: Page, name: string): Promise<void> =>
  page.getByRole('navigation', { name: 'Simulation controls' }).getByRole('button', { name }).click()

for (const invalidCase of invalidCases) {
  test(`invalid ${invalidCase.key} resets only that URL value`, async ({ page }) => {
    const params = new URLSearchParams(validParameters)
    params.set(invalidCase.key, invalidCase.invalid)
    await openShell(page, `/?${params.toString()}`)

    const expected = { ...validState, [invalidCase.key]: invalidCase.fallback }
    await expectState(page, expected)
    await expect(page.getByRole('alert', { name: 'Invalid URL values' }))
      .toContainText(`${invalidCase.key}: using ${invalidCase.replacement}`)
    expect(new URL(page.url()).searchParams.get(invalidCase.key)).toBe(String(invalidCase.fallback))
  })
}

test('simulation controls use stable labels and update the URL state', async ({ page }) => {
  await openShell(
    page,
    `/?scenario=protocol-demo&play=0&speed=1&panel=0&seed=0&fault=none&frame=${INITIAL_FRAME}`,
  )
  await expectControlLabels(page)
  await clickButton(page, 'Step frame')
  await Promise.all([
    expect(page.getByTestId('url-state')).toContainText(`"frame": ${FRAME_AFTER_STEP}`),
    expect.poll(() => new URL(page.url()).searchParams.get('frame')).toBe(String(FRAME_AFTER_STEP)),
  ])
  await clickButton(page, 'Speed')
  await expect(page.getByTestId('url-state')).toContainText(`"speed": ${NEXT_SPEED_AFTER_FIRST_CLICK}`)
  await clickButton(page, 'Play')
  await clickButton(page, 'Pause')
  await clickButton(page, 'Reset')
  await Promise.all([
    expect(page.getByTestId('url-state')).toContainText('"frame": 0'),
    expect(page.getByTestId('url-state')).toContainText('"play": 0'),
    expect(page.getByTestId('url-state')).toContainText('"speed": 1'),
  ])
})

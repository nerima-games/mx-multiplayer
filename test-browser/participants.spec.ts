import { type Page, expect, test } from '@playwright/test'

const openDebugUi = async (page: Page): Promise<void> => {
  await page.goto('/')
  await page.locator('body[data-ready="true"]').waitFor()
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

const expectJoinedClientState = async (page: Page): Promise<void> => {
  await expect(page.getByTestId('participant-client-c')).toContainText('client-c')
  await expect(page.getByTestId('participant-client-c')).toContainText('scenario-player-c')
  await expect(page.getByTestId('participant-client-c')).toContainText(/connected/iu)
  await expect(page.getByTestId('participant-client-c-projection')).toContainText('overworld revision 0')
  await expect(page.getByTestId('participant-client-c-projection')).toContainText('1 block(s)')
  await expect(page.getByTestId('participant-client-c-projection')).toContainText('Block')
}

const expectJoinedSnapshotOutcome = async (page: Page, beforeSnapshot: string | null): Promise<void> => {
  const summary = page.getByTestId('participants-run-summary')
  await expect(summary).toContainText('world-sync.snapshot-transfer-convergence')
  await expect(summary).toContainText('frame 1')
  await expect(summary).toContainText(/pass/iu)
  expect(await summary.textContent()).not.toBe(beforeSnapshot)
}

const runSnapshotScenario = async (page: Page, testInfo: import('@playwright/test').TestInfo): Promise<void> => {
  const summary = page.getByTestId('participants-run-summary')
  const beforeSnapshot = await summary.textContent()
  await page.getByRole('button', { name: 'Run scenario and join client C' }).click()
  await expectJoinedSnapshotOutcome(page, beforeSnapshot)
  await expect(page.getByTestId('participants-join-frame'))
    .toContainText('client-c joined at frame 1 after frame 1 was processed')
  await expectJoinedClientState(page)
  await page.screenshot({ path: testInfo.outputPath('world-sync.snapshot-transfer-convergence.png') })
}

const expectClientsConnected = async (page: Page): Promise<void> => {
  const clientA = page.getByTestId('participant-client-a')
  const clientB = page.getByTestId('participant-client-b')
  await expect(clientA).toContainText(/connected/iu)
  await expect(clientB).toContainText(/connected/iu)
}

const expectDisconnectOutcome = async (page: Page, previousClientA: string | null): Promise<void> => {
  const summary = page.getByTestId('participants-run-summary')
  const clientA = page.getByTestId('participant-client-a')
  const clientB = page.getByTestId('participant-client-b')
  await expect(summary).toContainText('transport.fault.disconnect')
  await expect(summary).toContainText(/pass/iu)
  await expect(clientA).toContainText(/disconnected/iu)
  await expect(clientB).toContainText(/connected/iu)
  await expect(clientA).toContainText('send refused: not-connected')
  expect(await clientA.textContent()).not.toBe(previousClientA)
}

const runDisconnectScenario = async (page: Page, testInfo: import('@playwright/test').TestInfo): Promise<void> => {
  const clientA = page.getByTestId('participant-client-a')
  const beforeDisconnect = await clientA.textContent()
  await expectClientsConnected(page)
  await page.getByRole('button', { name: 'Run disconnect scenario' }).click()
  await expectDisconnectOutcome(page, beforeDisconnect)
  await page.screenshot({ path: testInfo.outputPath('transport.fault.disconnect.png') })
}

test('snapshot and disconnect controls report scenario runtime outcomes', async ({ page }, testInfo) => {
  // Catches a join control that skips the mid-run snapshot transfer or omits the joining client projection.
  const browserErrors = captureBrowserErrors(page)
  await openDebugUi(page)
  await expect(page.getByTestId('participants-join-support')).toContainText('joins client C')
  await runSnapshotScenario(page, testInfo)
  await runDisconnectScenario(page, testInfo)
  expect(browserErrors).toEqual([])
})

const issueReconnectTokens = async (page: Page): Promise<void> => {
  const authState = page.getByTestId('participants-auth-state')
  const initialState = await authState.textContent()
  await page.getByRole('button', { name: 'Issue Alice and Bob reconnect tokens' }).click()
  await expect(authState).toContainText(/alice/iu)
  await expect(authState).toContainText(/bob/iu)
  expect(await authState.textContent()).not.toBe(initialState)
}

const reconnectAlice = async (page: Page): Promise<string | null> => {
  const authState = page.getByTestId('participants-auth-state')
  const attempt = page.getByTestId('participants-auth-attempt')
  const initialAttempt = await attempt.textContent()
  await page.getByRole('button', { name: 'Reconnect Alice with current token' }).click()
  await expect(attempt).toContainText(/accepted/iu)
  expect(await attempt.textContent()).not.toBe(initialAttempt)
  return authState.textContent()
}

const rejectForgedAndMismatchedTokens = async (page: Page, acceptedState: string | null): Promise<void> => {
  const authState = page.getByTestId('participants-auth-state')
  const attempt = page.getByTestId('participants-auth-attempt')
  await page.getByRole('button', { name: 'Try forged token' }).click()
  await expect(attempt).toContainText(/rejected/iu)
  await expect(authState).toHaveText(acceptedState ?? '')

  await page.getByRole('button', { name: 'Try Alice token as Bob' }).click()
  await expect(attempt).toContainText(/rejected/iu)
  await expect(authState).toHaveText(acceptedState ?? '')
}

const expectTokensStayPrivate = async (page: Page): Promise<void> => {
  await expect(page.getByTestId('participants-expiry')).toContainText(/expiry|expiration|expire|unsupported/iu)
  const visibleText = await page.locator('body').innerText()
  expect(visibleText).not.toMatch(/[A-Za-z0-9_-]{43}/u)
  expect(visibleText).not.toMatch(/\b[a-f0-9]{64}\b/iu)
}

test('ReconnectAuth accepts a current token and rejects forged or mismatched tokens', async ({ page }) => {
  // Catches token leakage, forged-token acceptance, and a wrong-player rotation mutating Alice's auth state.
  const browserErrors = captureBrowserErrors(page)
  await openDebugUi(page)
  await issueReconnectTokens(page)
  const acceptedState = await reconnectAlice(page)
  await rejectForgedAndMismatchedTokens(page, acceptedState)
  await expectTokensStayPrivate(page)
  expect(browserErrors).toEqual([])
})

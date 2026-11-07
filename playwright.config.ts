import { isAbsolute, relative, resolve, sep } from 'node:path'
import { defineConfig, type PlaywrightTestConfig } from '@playwright/test'

const DEFAULT_PORT = 5182
const requestedPort = process.env['HARNESS_PORT']
const port = requestedPort === undefined ? DEFAULT_PORT : Number(requestedPort)
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('HARNESS_PORT must be an integer from 1 through 65535')
}

const workspaceRoot = process.cwd()
const baseURL = `http://127.0.0.1:${port}`
const outputDir = resolve(workspaceRoot, process.env['PLAYWRIGHT_OUTPUT_DIR'] || 'test-results')
const relativeOutputDir = relative(workspaceRoot, outputDir)
if (
  relativeOutputDir === '' ||
  relativeOutputDir === '..' ||
  relativeOutputDir.startsWith(`..${sep}`) ||
  isAbsolute(relativeOutputDir)
) {
  throw new Error('PLAYWRIGHT_OUTPUT_DIR must stay inside the workspace')
}

const config: PlaywrightTestConfig = defineConfig({
  testDir: './test-browser',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  workers: 1,
  reporter: 'list',
  outputDir,
  projects: [
    {
      name: 'chromium',
      use: { browserName: 'chromium', screenshot: 'only-on-failure' },
    },
  ],
  use: {
    baseURL,
  },
  webServer: {
    command: 'pnpm preview:browser',
    url: baseURL,
    env: { HARNESS_PORT: String(port) },
    reuseExistingServer: false,
    timeout: 60_000,
  },
})

export default config

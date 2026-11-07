import { defineConfig } from 'vite'

const DEFAULT_PORT = 5182
const requestedPort = process.env['HARNESS_PORT']
const port = requestedPort === undefined ? DEFAULT_PORT : Number(requestedPort)
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('HARNESS_PORT must be an integer from 1 through 65535')
}

const config: ReturnType<typeof defineConfig> = defineConfig({
  root: 'apps/debug-ui',
  server: {
    host: '127.0.0.1',
    port,
    strictPort: true,
  },
})

export default config

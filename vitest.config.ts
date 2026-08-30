import { defineConfig } from 'vitest/config'

const config: ReturnType<typeof defineConfig> = defineConfig({
  test: {
    environment: 'node',
    globals: false,
    pool: 'forks',
    maxWorkers: '50%',
    include: ['test/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/coverage/**', '**/.git/**'],
    testTimeout: 10000,
    hookTimeout: 10000,
    teardownTimeout: 5000,
    slowTestThreshold: 300,
    fileParallelism: true,
    sequence: {
      seed: 0,
      hooks: 'stack',
    },
    reporters: ['default'],
    coverage: {
      provider: 'v8',
      enabled: false,
      include: ['src/**/*.ts'],
      exclude: ['**/*.d.ts', '**/*.config.ts', '**/*.test.ts', '**/*.spec.ts'],
      reporter: ['text', 'json', 'html', 'lcov'],
      reportsDirectory: './coverage',
      thresholds: { branches: 100, functions: 100, lines: 100, statements: 100 },
    },
  },
  esbuild: {
    target: 'node24',
    format: 'esm',
    platform: 'node',
  },
})

export default config

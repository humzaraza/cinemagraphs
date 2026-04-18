import { defineConfig } from 'vitest/config'
import path from 'path'

// Dedicated config for the integration suite so that the default `vitest run`
// can exclude these tests (they need Neon credentials + create real branches)
// while `npm run test:integration` still finds them.
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/__tests__/integration/**/*.test.ts'],
    // Integration runs create a fresh branch, apply migrations, then delete
    // the branch — the default 10s vitest timeout is nowhere near enough.
    testTimeout: 120_000,
    hookTimeout: 180_000,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
})

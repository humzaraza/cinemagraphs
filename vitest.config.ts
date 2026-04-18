import { defineConfig } from 'vitest/config'
import path from 'path'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/__tests__/**/*.test.ts'],
    // Integration tests hit a real Neon branch — they need credentials and
    // take many seconds, so they're only run via `npm run test:integration`.
    exclude: ['**/node_modules/**', 'src/__tests__/integration/**'],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
})

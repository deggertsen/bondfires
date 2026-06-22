import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Pure, fast unit tests for backend decision logic. Convex bundling ignores
    // *.test.ts, so these live next to the code they cover.
    include: ['convex/**/*.test.ts'],
    environment: 'node',
  },
})

import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Pure, fast unit tests. Convex bundling ignores *.test.ts, so backend
    // tests live next to the code they cover. Mobile helper tests live under
    // apps/mobile/test/ (outside app/) so Expo Router's require.context does
    // not pull vitest/vite into the Hermes bundle.
    include: ['convex/**/*.test.ts', 'apps/mobile/test/**/*.test.ts'],
    environment: 'node',
  },
})

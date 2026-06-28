import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Pure, fast unit tests. Convex bundling ignores *.test.ts, so backend
    // tests live next to the code they cover; mobile coverage is limited to
    // extracted helper modules to avoid native component/runtime setup.
    include: ['convex/**/*.test.ts', 'apps/mobile/**/_lib/**/*.test.ts'],
    environment: 'node',
  },
})

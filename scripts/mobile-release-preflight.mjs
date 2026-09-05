#!/usr/bin/env node

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const require = createRequire(import.meta.url)
const {
  resolveAppEnvironment,
  validateConvexEnvironment,
  validateMonitoringEnvironment,
} = require('../apps/mobile/config/environment.cjs')

function parseProfile(argv) {
  const index = argv.indexOf('--profile')
  if (index < 0 || !argv[index + 1]) throw new Error('--profile is required')
  return argv[index + 1]
}

try {
  const profile = parseProfile(process.argv.slice(2))
  const eas = JSON.parse(readFileSync(resolve(root, 'apps/mobile/eas.json'), 'utf8'))
  const profileConfig = eas.build?.[profile]
  if (!profileConfig) throw new Error(`Unknown EAS build profile: ${profile}`)
  const env = {
    ...(profileConfig.env ?? {}),
    ...process.env,
    EAS_BUILD_PROFILE: profile,
  }
  const appEnvironment = resolveAppEnvironment(env)
  validateConvexEnvironment({
    appEnvironment,
    convexUrl: env.EXPO_PUBLIC_CONVEX_URL,
    requireUrl: true,
  })

  if (!env.EXPO_PUBLIC_MUX_DATA_ENV_KEY?.trim()) {
    throw new Error(`${appEnvironment} requires EXPO_PUBLIC_MUX_DATA_ENV_KEY`)
  }

  if (appEnvironment === 'production') {
    validateMonitoringEnvironment({
      appEnvironment,
      env,
      requireProduction: true,
      requireSourceMaps: true,
    })
  }

  console.info(`Mobile ${profile} preflight passed for ${appEnvironment}`)
} catch (error) {
  console.error(
    `Mobile release preflight failed: ${error instanceof Error ? error.message : error}`,
  )
  process.exit(1)
}

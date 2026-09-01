#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const read = (path) => readFileSync(resolve(root, path), 'utf8')
const eas = JSON.parse(read('apps/mobile/eas.json'))
const appPackage = JSON.parse(read('apps/mobile/package.json'))
const errors = []
const fail = (message) => errors.push(message)

for (const [profile, environment] of [
  ['development', 'development'],
  ['development-simulator', 'development'],
  ['preview', 'preview'],
  ['production', 'production'],
]) {
  const config = eas.build?.[profile]
  if (config?.environment !== environment)
    fail(`${profile} must select EAS environment ${environment}`)
  if (config?.env?.EXPO_PUBLIC_APP_ENV !== environment) {
    fail(`${profile} must bundle EXPO_PUBLIC_APP_ENV=${environment}`)
  }
}

const productionUrl = eas.build?.production?.env?.EXPO_PUBLIC_CONVEX_URL
for (const profile of ['development', 'development-simulator', 'preview']) {
  if (eas.build?.[profile]?.env?.EXPO_PUBLIC_CONVEX_URL === productionUrl) {
    fail(`${profile} must not embed the production Convex URL`)
  }
}
if (appPackage.dependencies?.['@sentry/react-native'] !== '~7.2.0') {
  fail('Expo SDK 54 must keep @sentry/react-native on the compatible ~7.2.0 line')
}

const metro = read('apps/mobile/metro.config.js')
if (!metro.includes('getSentryExpoConfig')) fail('Metro must inject Sentry source-map debug IDs')
const monitoring = read('apps/mobile/lib/monitoring.ts')
for (const guard of [
  'sendDefaultPii: false',
  'attachScreenshot: false',
  'attachViewHierarchy: false',
  'replaysSessionSampleRate: 0',
  'beforeSend:',
]) {
  if (!monitoring.includes(guard)) fail(`Monitoring privacy guard missing: ${guard}`)
}

const flowPaths = ['.maestro/00-deep-link.yaml', '.maestro/10-authenticated-smoke.yaml']
for (const path of flowPaths) {
  if (!existsSync(resolve(root, path))) fail(`Missing Maestro flow: ${path}`)
}
const flows = flowPaths
  .filter((path) => existsSync(resolve(root, path)))
  .map(read)
  .join('\n')
for (const required of [
  'appId: org.bondfires',
  'Welcome back',
  'Camps',
  'Profile',
  'Delete Account',
]) {
  if (!flows.includes(required)) fail(`Maestro smoke coverage is missing: ${required}`)
}
if (/ideal-akita/.test(flows)) {
  fail('Maestro flows must not embed the production Convex target')
}
const smokeInputs = [...flows.matchAll(/^- inputText: (.+)$/gm)].map((match) => match[1])
const maestroVariable = (name) => ['$', '{', name, '}'].join('')
if (
  smokeInputs.length !== 2 ||
  !smokeInputs.includes(maestroVariable('MAESTRO_TEST_EMAIL')) ||
  !smokeInputs.includes(maestroVariable('MAESTRO_TEST_PASSWORD'))
) {
  fail('Maestro authentication must use environment placeholders, never literal credentials')
}

for (const [path, labels] of [
  ['apps/mobile/app/(auth)/login.tsx', ['Welcome back', 'you@example.com', 'Your password']],
  [
    'apps/mobile/app/(main)/(tabs)/_layout.tsx',
    ["title: 'Home'", "title: 'Camps'", "title: 'Profile'"],
  ],
  [
    'apps/mobile/app/(main)/(tabs)/profile.tsx',
    ['accessibilityLabel="Sign Out"', 'Delete Account', 'Are you sure you want to sign out?'],
  ],
]) {
  const source = read(path)
  for (const label of labels) {
    if (!source.includes(label)) fail(`Maestro contract ${label} drifted from ${path}`)
  }
}

if (errors.length > 0) {
  console.error(`Mobile release foundation check failed:\n- ${errors.join('\n- ')}`)
  process.exit(1)
}
console.info('Mobile environment, monitoring, and smoke-test foundations are consistent.')

#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import {
  loadIntelligenceConfig,
  matchesSelector,
  repositoryRoot,
} from './lib/repository-intelligence.mjs'

const errors = []

function fail(message) {
  errors.push(message)
}

function readJson(path) {
  return JSON.parse(readFileSync(resolve(repositoryRoot, path), 'utf8'))
}

function trackedFiles() {
  return execFileSync('git', ['ls-files', '-z'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  })
    .split('\0')
    .filter(Boolean)
}

function sourceFilesUnder(path) {
  const absolutePath = resolve(repositoryRoot, path)
  const results = []

  for (const entry of readdirSync(absolutePath)) {
    if (['.expo', 'build', 'dist', 'node_modules'].includes(entry)) continue
    const child = resolve(absolutePath, entry)
    if (statSync(child).isDirectory()) {
      results.push(...sourceFilesUnder(relative(repositoryRoot, child)))
    } else if (/\.[cm]?[jt]sx?$/.test(entry)) {
      results.push(child)
    }
  }

  return results
}

function validateIntelligenceConfig(config, files) {
  if (config.version !== 1) fail('repository-intelligence.json must use version 1')

  const actionIds = new Set(Object.keys(config.actions ?? {}))
  const ruleIds = new Set()
  const boundaryIds = new Set()

  for (const rule of config.rules ?? []) {
    if (ruleIds.has(rule.id)) fail(`Duplicate intelligence rule id: ${rule.id}`)
    ruleIds.add(rule.id)
    if (!rule.patterns?.length) fail(`Intelligence rule ${rule.id} has no patterns`)
    for (const action of rule.actions ?? []) {
      if (!actionIds.has(action)) fail(`Rule ${rule.id} references unknown action ${action}`)
    }
  }

  for (const boundary of config.boundaries ?? []) {
    if (boundaryIds.has(boundary.id)) fail(`Duplicate external boundary id: ${boundary.id}`)
    boundaryIds.add(boundary.id)
    if (!boundary.owner) fail(`External boundary ${boundary.id} has no owner`)
    if (!boundary.triggerPatterns?.length) {
      fail(`External boundary ${boundary.id} has no trigger patterns`)
    }
    for (const action of boundary.actions ?? []) {
      if (!actionIds.has(action))
        fail(`Boundary ${boundary.id} references unknown action ${action}`)
    }
    for (const document of boundary.documents ?? []) {
      if (!existsSync(resolve(repositoryRoot, document))) {
        fail(`Boundary ${boundary.id} references missing document ${document}`)
      }
    }
  }

  const unclassified = files.filter(
    (file) => !config.rules.some((rule) => matchesSelector(file, rule)),
  )
  if (unclassified.length > 0) {
    fail(`Tracked files have no intelligence rule: ${unclassified.join(', ')}`)
  }
}

function validateEnvironmentRegistry(config) {
  const registeredKeys = new Set(
    config.boundaries.flatMap((boundary) => boundary.environmentKeys ?? []),
  )
  const discoveredKeys = new Set()
  const roots = ['apps', 'packages', 'convex']
  const directAccess = /process\.env\.([A-Z][A-Z0-9_]*)/g
  const castAccess = /\)\.([A-Z][A-Z0-9_]*)/g

  for (const root of roots) {
    for (const file of sourceFilesUnder(root)) {
      const source = readFileSync(file, 'utf8')
      for (const match of source.matchAll(directAccess)) discoveredKeys.add(match[1])
      for (const match of source.matchAll(castAccess)) {
        if (match[1].startsWith('EXPO_PUBLIC_')) discoveredKeys.add(match[1])
      }
    }
  }

  const missing = [...discoveredKeys].filter((key) => !registeredKeys.has(key)).sort()
  if (missing.length > 0) {
    fail(`Environment keys are missing from the external-boundary registry: ${missing.join(', ')}`)
  }
}

function validateMobileConfiguration() {
  const app = readJson('apps/mobile/app.json').expo
  const eas = readJson('apps/mobile/eas.json')
  const productionEnvironment = eas.build?.production?.env ?? {}
  const convexUrl = productionEnvironment.EXPO_PUBLIC_CONVEX_URL

  if (String(app.ios?.buildNumber) !== String(app.android?.versionCode)) {
    fail('iOS buildNumber and Android versionCode must remain equal')
  }
  if (eas.cli?.appVersionSource !== 'local') {
    fail('EAS appVersionSource must remain local because release.sh increments app.json')
  }
  if (!/^https:\/\/[a-z0-9-]+\.convex\.cloud$/.test(convexUrl ?? '')) {
    fail('Production EXPO_PUBLIC_CONVEX_URL must be a canonical https://*.convex.cloud URL')
  }
  if (!productionEnvironment.EXPO_PUBLIC_MUX_DATA_ENV_KEY) {
    fail('Production EXPO_PUBLIC_MUX_DATA_ENV_KEY is required')
  }

  const iosDomains = new Set(
    (app.ios?.associatedDomains ?? []).map((value) => value.replace('applinks:', '')),
  )
  const androidHosts = new Set(
    (app.android?.intentFilters ?? []).flatMap((filter) =>
      (filter.data ?? []).map((entry) => entry.host).filter(Boolean),
    ),
  )
  const differingDomains = [...new Set([...iosDomains, ...androidHosts])].filter(
    (domain) => !iosDomains.has(domain) || !androidHosts.has(domain),
  )
  if (differingDomains.length > 0) {
    fail(`iOS and Android deep-link hosts differ: ${differingDomains.join(', ')}`)
  }
}

function validateNavigation() {
  const files = [
    ...sourceFilesUnder('apps/mobile/app'),
    ...sourceFilesUnder('apps/mobile/components'),
    ...sourceFilesUnder('apps/mobile/lib'),
  ]
  const unsafeCast = /\bas\s+(?:RelativePathString|ExternalPathString)\b/
  const rawRouterPath = /router\.(?:push|replace)\(\s*['"`]\//
  const rawRedirectPath = /<Redirect[\s\S]*?\bhref\s*=\s*(?:['"`]\/|\{\s*`\/)/

  for (const file of files) {
    const repositoryPath = relative(repositoryRoot, file)
    const source = readFileSync(file, 'utf8')
    if (repositoryPath !== 'apps/mobile/lib/routes.ts' && unsafeCast.test(source)) {
      fail(`Unsafe Expo Router path cast in ${repositoryPath}`)
    }
    if (rawRouterPath.test(source))
      fail(`Raw router path bypasses routes registry in ${repositoryPath}`)
    if (rawRedirectPath.test(source))
      fail(`Raw Redirect path bypasses routes registry in ${repositoryPath}`)
  }
}

function validateOperationalDocumentation() {
  const staleDeployment = 'fleet-caiman-92.convex.cloud'
  const staleClaims = [
    ['apps/mobile/README.md', /Builds run on EAS Build servers/],
    ['apps/mobile/README.md', /Build numbers are auto-incremented/],
    ['README.md', /auto-increment via EAS remote versioning/],
  ]

  for (const file of trackedFiles().filter((path) => path.endsWith('.md'))) {
    if (readFileSync(resolve(repositoryRoot, file), 'utf8').includes(staleDeployment)) {
      fail(`${file} references retired Convex deployment ${staleDeployment}`)
    }
  }
  for (const [file, pattern] of staleClaims) {
    if (pattern.test(readFileSync(resolve(repositoryRoot, file), 'utf8'))) {
      fail(`${file} contains stale release behavior: ${pattern.source}`)
    }
  }
}

try {
  const config = loadIntelligenceConfig()
  const files = trackedFiles()
  validateIntelligenceConfig(config, files)
  validateEnvironmentRegistry(config)
  validateMobileConfiguration()
  validateNavigation()
  validateOperationalDocumentation()
} catch (error) {
  fail(error instanceof Error ? error.message : String(error))
}

if (errors.length > 0) {
  console.error('Repository invariant check failed:')
  for (const error of errors) console.error(`- ${error}`)
  process.exit(1)
}

console.info('Repository invariants verified.')

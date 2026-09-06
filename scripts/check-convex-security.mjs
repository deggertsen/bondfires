#!/usr/bin/env node

import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const convexRoot = resolve(root, 'convex')
const auditPath = resolve(root, 'docs/convex-public-endpoint-audit.md')
const endpointPattern = /export\s+const\s+(\w+)\s*=\s*(query|mutation|action|httpAction)\s*\(/g
const discovered = new Set()

function discoverPublicEndpoints(directory = convexRoot) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) {
      if (entry.name !== '_generated') discoverPublicEndpoints(path)
      continue
    }
    if (!entry.name.endsWith('.ts') || entry.name.endsWith('.d.ts')) continue
    const source = readFileSync(path, 'utf8')
    const relativeModule = path
      .slice(convexRoot.length + 1)
      .replace(/\.ts$/, '')
      .replaceAll('/', '.')
    for (const match of source.matchAll(endpointPattern)) {
      discovered.add(`${relativeModule}.${match[1]}`)
    }
  }
}
discoverPublicEndpoints()

const audit = readFileSync(auditPath, 'utf8')
const documentedMatches = [
  ...audit.matchAll(/`([A-Za-z][A-Za-z0-9]*\.[A-Za-z][A-Za-z0-9]*)`/g),
].map((match) => match[1])
const documented = new Set(documentedMatches)
const errors = []
if (documented.size !== documentedMatches.length) errors.push('Audit contains duplicate endpoints')
for (const endpoint of discovered) {
  if (!documented.has(endpoint)) errors.push(`Unaudited public Convex endpoint: ${endpoint}`)
}
for (const endpoint of documented) {
  if (!discovered.has(endpoint)) errors.push(`Audit references missing endpoint: ${endpoint}`)
}

const requiredSourceEvidence = [
  ['convex/camps.ts', /seedLaunchCamps[\s\S]*isAdmin\(user\)/],
  ['convex/personalBondfires.ts', /checkInvite\s*=\s*query\([\s\S]*isSecureInviteCode\(code\)/],
  ['convex/videos.ts', /getMuxUploadStatus[\s\S]*userOwnsMuxUpload/],
  ['convex/watchEvents.ts', /record[\s\S]*resolveVisibleWatchTarget[\s\S]*serverDurationMs/],
]
for (const [file, pattern] of requiredSourceEvidence) {
  if (!pattern.test(readFileSync(resolve(root, file), 'utf8'))) {
    errors.push(`Required authorization evidence is missing from ${file}`)
  }
}

const secretLoggingPatterns = [
  /telemetry\.warn\('invite:pendingRedeem'[\s\S]{0,200}code:/,
  /personal-bondfire[^\n]*\{\s*bondfireId,\s*code\s*\}/,
]
for (const file of [
  'apps/mobile/app/_layout.tsx',
  'apps/mobile/app/(main)/personal-bondfire/[bondfireId]/[code].tsx',
]) {
  const source = readFileSync(resolve(root, file), 'utf8')
  for (const pattern of secretLoggingPatterns) {
    if (pattern.test(source)) errors.push(`Raw invite secret may be logged in ${file}`)
  }
}

if (errors.length > 0) {
  process.stderr.write(`Convex security audit failed:\n- ${errors.join('\n- ')}\n`)
  process.exit(1)
}
process.stdout.write(`Convex security inventory covers ${discovered.size} public endpoints.\n`)

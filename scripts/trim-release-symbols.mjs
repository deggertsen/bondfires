#!/usr/bin/env node

// Trim local release build folders down to their crash diagnostics.
//
// Usage:
//   node scripts/trim-release-symbols.mjs                 # every eligible folder
//   node scripts/trim-release-symbols.mjs --only 1.0.109-ios
//   node scripts/trim-release-symbols.mjs --skip 1.0.109-android

import { resolve } from 'node:path'
import { trimReleaseSymbols } from './lib/release-symbols.mjs'
import { repositoryRoot } from './lib/repository-intelligence.mjs'

const only = []
const skip = []
const argv = process.argv.slice(2)
for (let index = 0; index < argv.length; index += 1) {
  const flag = argv[index]
  const value = argv[index + 1]
  if ((flag !== '--only' && flag !== '--skip') || !value) {
    process.stderr.write(
      `Unexpected argument: ${flag}. Use --only <version-platform> or --skip <version-platform>.\n`,
    )
    process.exit(1)
  }
  ;(flag === '--only' ? only : skip).push(value)
  index += 1
}

const results = trimReleaseSymbols(resolve(repositoryRoot, 'apps/mobile/build'), { only, skip })
for (const { name, action, reason } of results) {
  process.stdout.write(`🧹 ${name}: ${action}${reason ? ` (${reason})` : ''}\n`)
}
if (results.length === 0) process.stdout.write('🧹 No release build folders to trim\n')

#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { repositoryRoot } from './lib/repository-intelligence.mjs'

const generatedDirectory = resolve(repositoryRoot, 'convex/_generated')

function snapshot() {
  const files = new Map()
  for (const entry of readdirSync(generatedDirectory)) {
    const path = resolve(generatedDirectory, entry)
    if (!statSync(path).isFile()) continue
    files.set(entry, { contents: readFileSync(path), mode: statSync(path).mode })
  }
  return files
}

function restore(before, after) {
  for (const file of after.keys()) {
    if (!before.has(file)) unlinkSync(resolve(generatedDirectory, file))
  }
  for (const [file, value] of before) {
    writeFileSync(resolve(generatedDirectory, file), value.contents, { mode: value.mode })
  }
}

function changedFiles(before, after) {
  const allFiles = new Set([...before.keys(), ...after.keys()])
  return [...allFiles]
    .filter((file) => {
      const oldFile = before.get(file)
      const newFile = after.get(file)
      return !oldFile || !newFile || !oldFile.contents.equals(newFile.contents)
    })
    .sort()
}

function configuredDeployment() {
  if (process.env.CONVEX_DEPLOYMENT) return process.env.CONVEX_DEPLOYMENT

  const eas = JSON.parse(readFileSync(resolve(repositoryRoot, 'apps/mobile/eas.json'), 'utf8'))
  const url = eas.build?.production?.env?.EXPO_PUBLIC_CONVEX_URL
  const match = /^https:\/\/([a-z0-9-]+)\.convex\.cloud$/.exec(url ?? '')
  if (!match) throw new Error('Cannot derive CONVEX_DEPLOYMENT from the production EAS profile')
  return `prod:${match[1]}`
}

if (!existsSync(generatedDirectory)) {
  console.error(`Missing generated directory: ${relative(repositoryRoot, generatedDirectory)}`)
  process.exit(1)
}

const before = snapshot()
let result
let after = before
let unexpectedError

try {
  result = spawnSync('yarn', ['convex', 'codegen', '--typecheck', 'disable'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: { ...process.env, CONVEX_DEPLOYMENT: configuredDeployment() },
    maxBuffer: 10 * 1024 * 1024,
    timeout: 30_000,
  })
  after = snapshot()
} catch (error) {
  unexpectedError = error
} finally {
  restore(before, after)
}

if (unexpectedError) {
  console.error(
    `Convex generated-code check failed: ${unexpectedError instanceof Error ? unexpectedError.message : String(unexpectedError)}`,
  )
  process.exit(1)
}

if (result.error || result.status !== 0) {
  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
  console.error('Convex code generation could not complete.')
  process.exit(result.status || 1)
}

const changes = changedFiles(before, after)
if (changes.length > 0) {
  console.error(`Convex generated bindings are stale: ${changes.join(', ')}`)
  console.error('Run `yarn convex codegen --typecheck disable` and commit the generated files.')
  process.exit(1)
}

console.info('Convex generated bindings are current.')

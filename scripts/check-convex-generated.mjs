#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { repositoryRoot } from './lib/repository-intelligence.mjs'

const convexDirectory = resolve(repositoryRoot, 'convex')
const generatedDirectory = resolve(convexDirectory, '_generated')
const generatedApiPath = resolve(generatedDirectory, 'api.d.ts')

function sourceModules(directory = convexDirectory) {
  const modules = []

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) {
      if (entry.name !== '_generated') modules.push(...sourceModules(path))
      continue
    }

    if (!/\.[cm]?[jt]sx?$/.test(entry.name) || entry.name.endsWith('.d.ts')) continue
    if (/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(entry.name)) continue
    if (['auth.config.ts', 'schema.ts'].includes(entry.name)) continue

    modules.push(relative(convexDirectory, path).replace(/\.[cm]?[jt]sx?$/, ''))
  }

  return modules.sort()
}

function generatedModules() {
  const source = readFileSync(generatedApiPath, 'utf8')
  const declaration = /declare const fullApi: ApiFromModules<\{([\s\S]*?)\n\}>;/.exec(source)?.[1]
  if (!declaration) throw new Error('Could not parse fullApi from convex/_generated/api.d.ts')

  return [...declaration.matchAll(/^ {2}(?:"([^"]+)"|([A-Za-z_$][\w$]*)): typeof /gm)]
    .map((match) => match[1] ?? match[2])
    .sort()
}

function difference(left, right) {
  const rightSet = new Set(right)
  return left.filter((value) => !rightSet.has(value))
}

function verifyModuleRegistry() {
  const expected = sourceModules()
  const generated = generatedModules()
  const missing = difference(expected, generated)
  const removed = difference(generated, expected)

  if (missing.length > 0 || removed.length > 0) {
    if (missing.length > 0)
      console.error(`Modules missing from generated API: ${missing.join(', ')}`)
    if (removed.length > 0)
      console.error(`Removed modules still in generated API: ${removed.join(', ')}`)
    console.error('Run `yarn convex codegen --typecheck disable` and commit the generated files.')
    process.exit(1)
  }

  console.info('Convex generated API module registry is current.')
}

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

function verifyFullCodegen() {
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
    throw unexpectedError
  }
  if (result.error || result.status !== 0) {
    if (result.stdout) process.stdout.write(result.stdout)
    if (result.stderr) process.stderr.write(result.stderr)
    throw new Error('Convex code generation could not complete')
  }

  const changes = changedFiles(before, after)
  if (changes.length > 0) {
    throw new Error(
      `Convex generated bindings are stale: ${changes.join(', ')}. Run \`yarn convex codegen --typecheck disable\` and commit the generated files.`,
    )
  }

  console.info('Full Convex generated bindings are current.')
}

if (!existsSync(generatedApiPath)) {
  console.error('Missing convex/_generated/api.d.ts')
  process.exit(1)
}

try {
  verifyModuleRegistry()
  if (process.env.CONVEX_CODEGEN_FULL === '1') verifyFullCodegen()
} catch (error) {
  console.error(
    `Convex generated-code check failed: ${error instanceof Error ? error.message : String(error)}`,
  )
  process.exit(1)
}

#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, relative, resolve, sep } from 'node:path'
import { repositoryRoot } from './lib/repository-intelligence.mjs'

const releaseEvidenceDirectory = resolve(repositoryRoot, 'apps/mobile/build')

function parseArguments(argv) {
  const [command, ...rest] = argv
  const options = { command }

  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index]
    if (!argument.startsWith('--')) throw new Error(`Unexpected argument: ${argument}`)
    const key = argument.slice(2)
    const value = rest[index + 1]
    if (!value || value.startsWith('--')) throw new Error(`${argument} requires a value`)
    if (key === 'platform') {
      options.platforms = [...(options.platforms ?? []), value]
    } else {
      options[key] = value
    }
    index += 1
  }

  return options
}

function now() {
  return new Date().toISOString()
}

function manifestPath(path) {
  if (!path) throw new Error('--manifest is required')
  const resolvedPath = resolve(repositoryRoot, path)
  if (
    resolvedPath !== releaseEvidenceDirectory &&
    !resolvedPath.startsWith(`${releaseEvidenceDirectory}${sep}`)
  ) {
    throw new Error('Release evidence must be written under apps/mobile/build')
  }
  return resolvedPath
}

function writeManifest(path, manifest) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`)
  console.info(`Release evidence updated: ${relative(repositoryRoot, path)}`)
}

try {
  const options = parseArguments(process.argv.slice(2))
  const path = manifestPath(options.manifest)

  if (options.command === 'init') {
    const required = ['version', 'build-number', 'convex-url']
    for (const key of required) {
      if (!options[key]) throw new Error(`--${key} is required for init`)
    }

    writeManifest(path, {
      schemaVersion: 1,
      release: {
        version: options.version,
        buildNumber: options['build-number'],
        gitSha: execFileSync('git', ['rev-parse', 'HEAD'], {
          cwd: repositoryRoot,
          encoding: 'utf8',
        }).trim(),
        convexUrl: options['convex-url'],
        platforms: options.platforms ?? [],
      },
      status: 'started',
      startedAt: now(),
      events: [],
    })
  } else if (options.command === 'event') {
    if (!options.name) throw new Error('--name is required for event')
    const manifest = JSON.parse(readFileSync(path, 'utf8'))
    const event = { name: options.name, at: now() }
    if (options.platforms?.[0]) event.platform = options.platforms[0]
    if (options.artifact) event.artifact = options.artifact
    if (options.detail) event.detail = options.detail
    manifest.events.push(event)
    manifest.status =
      options.name === 'release-complete'
        ? 'complete'
        : options.name === 'release-failed'
          ? 'failed'
          : manifest.status
    if (manifest.status === 'complete') manifest.completedAt = event.at
    if (manifest.status === 'failed') manifest.failedAt = event.at
    writeManifest(path, manifest)
  } else {
    throw new Error('First argument must be `init` or `event`')
  }
} catch (error) {
  console.error(
    `Release evidence failed: ${error instanceof Error ? error.message : String(error)}`,
  )
  process.exit(1)
}

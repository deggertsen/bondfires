#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import {
  createImpactPlan,
  loadIntelligenceConfig,
  repositoryRoot,
} from './lib/repository-intelligence.mjs'

function usage() {
  console.info(`Usage: yarn repo:impact [options]

Options:
  --base <ref>           Compare from this Git revision
  --head <ref>           Compare to this Git revision (defaults to HEAD)
  --staged               Inspect staged changes only
  --format <text|json|github>
  --help

With no revision options, tracked and untracked working-tree changes are used.`)
}

function parseArguments(argv) {
  const options = { format: 'text', head: 'HEAD', staged: false }

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]

    if (argument === '--help') {
      usage()
      process.exit(0)
    }

    if (argument === '--staged') {
      options.staged = true
      continue
    }

    if (['--base', '--head', '--format'].includes(argument)) {
      const value = argv[index + 1]
      if (!value) throw new Error(`${argument} requires a value`)
      options[argument.slice(2)] = value
      index += 1
      continue
    }

    throw new Error(`Unknown argument: ${argument}`)
  }

  if (!['text', 'json', 'github'].includes(options.format)) {
    throw new Error(`Unsupported format: ${options.format}`)
  }
  if (options.staged && options.base) {
    throw new Error('--staged cannot be combined with --base')
  }

  return options
}

function runGit(args) {
  return execFileSync('git', args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
  })
}

function lines(output) {
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}

function changedFiles(options) {
  if (options.base) {
    return lines(runGit(['diff', '--name-only', '--diff-filter=ACMRD', options.base, options.head]))
  }

  if (options.staged) {
    return lines(runGit(['diff', '--cached', '--name-only', '--diff-filter=ACMRD']))
  }

  return [
    ...lines(runGit(['diff', 'HEAD', '--name-only', '--diff-filter=ACMRD'])),
    ...lines(runGit(['ls-files', '--others', '--exclude-standard'])),
  ]
}

function shortenedFiles(files, limit = 6) {
  if (files.length <= limit) return files.join(', ')
  return `${files.slice(0, limit).join(', ')} (+${files.length - limit} more)`
}

function renderText(plan) {
  if (plan.changedFiles.length === 0) return 'No changed files; no impact actions planned.'

  const output = [`Impact plan for ${plan.changedFiles.length} changed file(s)`]

  for (const action of plan.actions) {
    output.push(`\n[${action.kind}] ${action.id}\n  ${action.description}`)
    for (const reason of action.reasons) {
      output.push(`  - ${reason.source}:${reason.id} — ${shortenedFiles(reason.files)}`)
    }
  }

  if (plan.affectedBoundaries.length > 0) {
    output.push('\nAffected external boundaries')
    for (const boundary of plan.affectedBoundaries) {
      output.push(`  - ${boundary.id} (${boundary.owner}) — ${shortenedFiles(boundary.files)}`)
    }
  }

  if (plan.unknownFiles.length > 0) {
    output.push(`\nUnknown files (conservative fallback): ${plan.unknownFiles.join(', ')}`)
  }

  return output.join('\n')
}

function escapeTableCell(value) {
  return value.replaceAll('|', '\\|').replaceAll('\n', ' ')
}

function renderGitHub(plan) {
  if (plan.changedFiles.length === 0) return '## Repository impact\n\nNo changed files.'

  const output = [
    '## Repository impact',
    '',
    `${plan.changedFiles.length} changed file(s); ${plan.actions.length} planned action(s).`,
    '',
    '| Kind | Action | Why |',
    '| --- | --- | --- |',
  ]

  for (const action of plan.actions) {
    const reasons = action.reasons
      .map((reason) => `${reason.source}:${reason.id} (${shortenedFiles(reason.files, 3)})`)
      .join('<br>')
    output.push(`| ${action.kind} | ${action.id} | ${escapeTableCell(reasons)} |`)
  }

  if (plan.affectedBoundaries.length > 0) {
    output.push('', '### Affected external boundaries', '')
    for (const boundary of plan.affectedBoundaries) {
      output.push(`- **${boundary.id}** — ${boundary.description}`)
    }
  }

  if (plan.unknownFiles.length > 0) {
    output.push('', `> Unknown files broadened the plan: ${plan.unknownFiles.join(', ')}`)
  }

  return output.join('\n')
}

try {
  const options = parseArguments(process.argv.slice(2))
  const plan = createImpactPlan(changedFiles(options), loadIntelligenceConfig())

  if (options.format === 'json') {
    console.info(JSON.stringify(plan, null, 2))
  } else if (options.format === 'github') {
    console.info(renderGitHub(plan))
  } else {
    console.info(renderText(plan))
  }
} catch (error) {
  console.error(
    `Repository impact failed: ${error instanceof Error ? error.message : String(error)}`,
  )
  process.exit(1)
}

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const moduleDirectory = dirname(fileURLToPath(import.meta.url))

export const repositoryRoot = resolve(moduleDirectory, '../..')
export const intelligenceConfigPath = resolve(repositoryRoot, 'repository-intelligence.json')

export function loadIntelligenceConfig() {
  return JSON.parse(readFileSync(intelligenceConfigPath, 'utf8'))
}

export function globToRegExp(pattern) {
  let source = '^'

  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]

    if (character === '*') {
      const next = pattern[index + 1]
      if (next === '*') {
        const afterGlobstar = pattern[index + 2]
        if (afterGlobstar === '/') {
          source += '(?:.*/)?'
          index += 2
        } else {
          source += '.*'
          index += 1
        }
      } else {
        source += '[^/]*'
      }
      continue
    }

    if (character === '?') {
      source += '[^/]'
      continue
    }

    source += character.replace(/[|\\{}()[\]^$+?.]/g, '\\$&')
  }

  return new RegExp(`${source}$`)
}

export function matchesPattern(file, pattern) {
  return globToRegExp(pattern).test(file)
}

export function matchesSelector(file, selector, patternKey = 'patterns') {
  const included = selector[patternKey].some((pattern) => matchesPattern(file, pattern))
  const excluded = (selector.excludePatterns ?? []).some((pattern) => matchesPattern(file, pattern))
  return included && !excluded
}

function addReason(actionMap, config, actionId, reason) {
  const definition = config.actions[actionId]
  const existing = actionMap.get(actionId) ?? {
    id: actionId,
    kind: definition.kind,
    description: definition.description,
    evidence: 'declared',
    reasons: [],
  }

  existing.reasons.push(reason)
  actionMap.set(actionId, existing)
}

export function createImpactPlan(changedFiles, config = loadIntelligenceConfig()) {
  const files = [...new Set(changedFiles)].sort()
  const matchedFiles = new Set()
  const actionMap = new Map()
  const matchedRules = []
  const affectedBoundaries = []

  for (const rule of config.rules) {
    const matches = files.filter((file) => matchesSelector(file, rule))
    if (matches.length === 0) continue

    for (const file of matches) matchedFiles.add(file)
    matchedRules.push({ id: rule.id, description: rule.description, files: matches })

    for (const actionId of rule.actions) {
      addReason(actionMap, config, actionId, {
        source: 'rule',
        id: rule.id,
        description: rule.description,
        files: matches,
      })
    }
  }

  for (const boundary of config.boundaries) {
    const matches = files.filter((file) => matchesSelector(file, boundary, 'triggerPatterns'))
    if (matches.length === 0) continue

    affectedBoundaries.push({
      id: boundary.id,
      description: boundary.description,
      owner: boundary.owner,
      files: matches,
    })

    for (const actionId of boundary.actions) {
      addReason(actionMap, config, actionId, {
        source: 'boundary',
        id: boundary.id,
        description: boundary.description,
        files: matches,
      })
    }
  }

  const unknownFiles = files.filter((file) => !matchedFiles.has(file))
  if (unknownFiles.length > 0) {
    for (const actionId of ['validate', 'unknown-change-review']) {
      addReason(actionMap, config, actionId, {
        source: 'fallback',
        id: 'unmodeled-change',
        description: 'Unmodeled changes broaden the plan conservatively.',
        files: unknownFiles,
      })
    }
  }

  return {
    schemaVersion: 1,
    evidence: 'declared',
    changedFiles: files,
    matchedRules,
    affectedBoundaries,
    unknownFiles,
    actions: [...actionMap.values()].sort((left, right) => {
      const kindOrder = ['check', 'test', 'build', 'deploy', 'review']
      const kindDifference = kindOrder.indexOf(left.kind) - kindOrder.indexOf(right.kind)
      return kindDifference || left.id.localeCompare(right.id)
    }),
  }
}

export function gitFiles(args) {
  const output = execFileSync('git', args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
  })

  return output.split('\0').filter(Boolean)
}

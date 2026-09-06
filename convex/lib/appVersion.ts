export type UpdatePriority = 'flexible' | 'immediate'

const APP_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const MAX_VERSION_COMPONENT = 999_999

/**
 * Validate and normalize the store version used by the minimum-version gate.
 * Store builds use a strict major.minor.patch version without prerelease tags.
 */
export function normalizeAppVersion(version: string): string {
  const normalized = version.trim()
  const match = APP_VERSION_PATTERN.exec(normalized)

  if (!match) {
    throw new Error('Version must use major.minor.patch format, for example 1.2.3')
  }

  const components = match.slice(1).map(Number)
  if (components.some((component) => component > MAX_VERSION_COMPONENT)) {
    throw new Error(`Version components must not exceed ${MAX_VERSION_COMPONENT}`)
  }

  return normalized
}

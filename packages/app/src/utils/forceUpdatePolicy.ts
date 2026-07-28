export type UpdatePriority = 'flexible' | 'immediate'

type AndroidUpdateAvailability = {
  updateAvailable: boolean
  flexibleAllowed?: boolean
  immediateAllowed?: boolean
}

function parseVersion(version: string | null | undefined): number[] | null {
  if (!version) return null

  const normalized = version.trim()
  if (!/^\d+(?:\.\d+)*$/.test(normalized)) return null

  const parts = normalized.split('.').map(Number)
  return parts.every(Number.isSafeInteger) ? parts : null
}

/**
 * Determines whether the installed app must be blocked by remote config.
 *
 * A malformed required version fails open so an operator typo cannot lock out
 * every client. A missing or malformed installed version fails closed when a
 * valid minimum exists because the client cannot prove that it is compatible.
 */
export function isAppUpdateRequired(
  currentVersion: string | null | undefined,
  minRequiredVersion: string | null | undefined,
): boolean {
  if (!minRequiredVersion) return false

  const requiredParts = parseVersion(minRequiredVersion)
  if (!requiredParts) return false

  const currentParts = parseVersion(currentVersion)
  if (!currentParts) return true

  for (let i = 0; i < Math.max(currentParts.length, requiredParts.length); i++) {
    const current = currentParts[i] ?? 0
    const required = requiredParts[i] ?? 0
    if (current < required) return true
    if (current > required) return false
  }

  return false
}

/** Selects one native Android delivery mode, ordered by remote-config priority. */
export function chooseAndroidUpdateType(
  priority: UpdatePriority,
  availability: AndroidUpdateAvailability,
): UpdatePriority | null {
  if (!availability.updateAvailable) return null

  if (priority === 'flexible' && availability.flexibleAllowed) return 'flexible'
  if (availability.immediateAllowed) return 'immediate'
  if (availability.flexibleAllowed) return 'flexible'

  return null
}

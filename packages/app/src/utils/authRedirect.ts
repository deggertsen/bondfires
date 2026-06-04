// Matches a personal bondfire invite deep-link path, with or without the
// `/(main)` route-group prefix, capturing the bondfire id and invite code.
const PERSONAL_BONDFIRE_INVITE_ROUTE = /^\/(?:\(main\)\/)?personal-bondfire\/([^/?#]+)\/([^/?#]+)$/

export interface PersonalBondfireInvite {
  bondfireId: string
  code: string
}

/**
 * Parse a post-auth `redirectTo` value into a personal bondfire invite.
 *
 * This is intentionally router-agnostic: it validates untrusted input (query
 * params / deep links) and returns structured data, leaving the construction of
 * a typed navigation target to the app layer (see `apps/mobile/lib/routes.ts`).
 * Returning data instead of a path keeps this package free of `expo-router`
 * coupling and makes the validation trivially unit-testable.
 *
 * @returns the parsed invite, or `null` when the value is missing, malformed, or
 * not a personal bondfire invite path.
 */
export function parsePersonalBondfireInvite(
  redirectTo: string | string[] | undefined,
): PersonalBondfireInvite | null {
  const value = Array.isArray(redirectTo) ? redirectTo[0] : redirectTo
  if (!value) return null

  let decoded: string
  try {
    decoded = decodeURIComponent(value)
  } catch {
    return null
  }

  const match = PERSONAL_BONDFIRE_INVITE_ROUTE.exec(decoded)
  if (!match) return null

  const [, bondfireId, code] = match
  if (!bondfireId || !code) return null

  return { bondfireId, code }
}

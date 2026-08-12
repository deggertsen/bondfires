import type { Href } from 'expo-router'
import { resolveExternalRoute, routes } from './routes'

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/**
 * Resolve an untrusted notification payload to a known mobile route.
 *
 * Notifications with a concrete entity target take precedence over generic
 * screen or feed fallbacks. Invalid payload fields are ignored rather than
 * coerced into malformed route parameters.
 */
export function resolveNotificationRoute(
  data: Record<string, unknown> | null | undefined,
): Href | null {
  if (!data) return null

  const bondfireId = nonEmptyString(data.bondfireId)
  if (bondfireId) {
    const bondfireVideoId = nonEmptyString(data.bondfireVideoId) ?? undefined
    return routes.bondfire(bondfireId, bondfireVideoId)
  }

  const campId = nonEmptyString(data.campId)
  if (campId) return routes.camp(campId)

  const screen = nonEmptyString(data.screen)
  if (screen) {
    const target = resolveExternalRoute(screen)
    if (target) return target
  }

  if (data.type === 'digest' || data.type === 'nudge') return routes.feed

  return null
}

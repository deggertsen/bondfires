import type { Href } from 'expo-router'
import { campJoinGatePath, routes } from './routes'

type RouterLike = {
  replace: (href: Href) => void
}

const AUTH_SESSION_ERROR_MARKERS = [
  'not authenticated',
  'session has expired',
  'sign in again',
] as const

export function isAuthSessionErrorMessage(message: string): boolean {
  const normalized = message.trim().toLowerCase()
  return AUTH_SESSION_ERROR_MARKERS.some((marker) => normalized.includes(marker))
}

export function redirectToCampJoinLogin(
  router: RouterLike,
  campId: string,
  redirect?: string,
): void {
  router.replace(routes.login(campJoinGatePath(campId, redirect)))
}

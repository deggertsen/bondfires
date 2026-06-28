import { parsePersonalBondfireInvite } from '@bondfires/app'
import type { Href } from 'expo-router'

/**
 * Centralized, type-safe route registry for the mobile app.
 *
 * WHY THIS EXISTS
 * ---------------
 * Expo Router's `typedRoutes` experiment validates route literals against the
 * real files in `app/`. By building EVERY navigation target here, a moved or
 * renamed screen becomes a compile error in this single file (caught by
 * `yarn typecheck`) instead of a runtime crash for users — the exact class of
 * bug that motivated `docs/RELEASE_PROCESS.md`.
 *
 * RULES
 * -----
 * 1. Never pass a raw path string to `router.push` / `router.replace` / `<Redirect>`.
 * 2. Never use `as RelativePathString` (or any cast) to silence a route error —
 *    add or fix a builder here instead.
 * 3. For untrusted input (push notifications, deep links), use
 *    `resolveExternalRoute` so the target is validated against an allowlist.
 *
 * The `satisfies` clause below validates every static path and every builder's
 * return value against `Href` at definition time, while preserving precise types
 * for callers.
 */
export const routes = {
  // --- Auth ---
  onboarding: '/(auth)/onboarding',
  signup: '/(auth)/signup',
  forgotPassword: '/(auth)/forgot-password',

  login: (redirectTo?: string): Href =>
    redirectTo ? { pathname: '/(auth)/login', params: { redirectTo } } : '/(auth)/login',

  verifyEmail: (params: { email?: string; redirectTo?: string } = {}): Href => ({
    pathname: '/(auth)/verify-email',
    params: {
      ...(params.email ? { email: params.email } : {}),
      ...(params.redirectTo ? { redirectTo: params.redirectTo } : {}),
    },
  }),

  resetPassword: (email: string): Href => ({
    pathname: '/(auth)/reset-password',
    params: { email },
  }),

  // --- Main tabs ---
  feed: '/(main)/(tabs)/feed',
  camps: '/(main)/(tabs)/camps',
  myFires: '/(main)/(tabs)/my-fires',
  // The create screen is a pushed stack screen (see (main)/_layout.tsx), not a
  // tab, so it cleanly unmounts when the user navigates away.
  create: '/(main)/create',

  // Generic Spark/create entry — no camp pre-selected. Use this for the bottom
  // tab so stale search params from a prior visit cannot skip the camp picker.
  createFresh: (): Href => ({
    pathname: '/(main)/create',
    params: {},
  }),

  createRespondTo: (bondfireId: string): Href => ({
    pathname: '/(main)/create',
    params: { respondTo: bondfireId },
  }),

  createForCamp: (campId: string): Href => ({
    pathname: '/(main)/create',
    params: { campId },
  }),

  createForPersonalCamp: (newFire?: string): Href => ({
    pathname: '/(main)/create',
    params: newFire ? { personalCamp: '1', newFire } : { personalCamp: '1' },
  }),

  personalCampWithInvite: (bondfireId: string, createdAfter?: number): Href => ({
    pathname: '/(main)/personal-camp',
    params:
      createdAfter === undefined
        ? { newFire: bondfireId }
        : { newFire: bondfireId, createdAfter: String(createdAfter) },
  }),

  // --- Main stack ---
  personalCamp: '/(main)/personal-camp',

  bondfire: (id: string): Href => ({
    pathname: '/(main)/bondfire/[id]',
    params: { id },
  }),

  camp: (id: string): Href => ({
    pathname: '/(main)/camp/[id]',
    params: { id },
  }),

  campJoinGate: (campId: string, redirect?: string): Href => ({
    pathname: '/(main)/camp/[id]/join',
    params: { id: campId, ...(redirect ? { redirect } : {}) },
  }),

  personalBondfire: (bondfireId: string, code: string): Href => ({
    pathname: '/(main)/personal-bondfire/[bondfireId]/[code]',
    params: { bondfireId, code },
  }),

  // --- Invite deep links ---
  externalInvite: (code: string): Href => ({
    pathname: '/invite/[code]',
    params: { code },
  }),

  loginWithInvite: (code: string): Href => ({
    pathname: '/(auth)/login',
    params: { redirectTo: `/invite/${code}` },
  }),

  externalCampInvite: (code: string): Href => ({
    pathname: '/invite/camp/[code]',
    params: { code },
  }),

  loginWithCampInvite: (code: string): Href => ({
    pathname: '/(auth)/login',
    params: { redirectTo: `/invite/camp/${code}` },
  }),
} satisfies Record<string, Href | ((...args: never[]) => Href)>

/**
 * Canonical string form of a personal bondfire invite path.
 *
 * Used when the route must be serialized as a value (e.g. passed as a
 * `redirectTo` query param to the login screen) rather than navigated to
 * directly. Keeping the format here means the path shape lives in exactly one
 * place and round-trips with `parsePersonalBondfireInvite`.
 */
export function personalBondfirePath(bondfireId: string, code: string): string {
  return `/(main)/personal-bondfire/${bondfireId}/${code}`
}

/**
 * Resolve a post-auth `redirectTo` value into a typed navigation target.
 *
 * Falls back to the feed when the value is missing or is not a recognized,
 * safe redirect destination.
 */
export function resolveAuthRedirect(redirectTo: string | string[] | undefined): Href {
  const invite = parsePersonalBondfireInvite(redirectTo)
  if (invite) return routes.personalBondfire(invite.bondfireId, invite.code)
  if (typeof redirectTo === 'string') {
    const personalMatch = /^\/invite\/([^/?#]+)$/.exec(redirectTo)
    if (personalMatch) return routes.externalInvite(personalMatch[1])
    const campMatch = /^\/invite\/camp\/([^/?#]+)$/.exec(redirectTo)
    if (campMatch) return routes.externalCampInvite(campMatch[1])
  }
  return routes.feed
}

// Static routes that are safe to open from an untrusted payload.
const EXTERNAL_STATIC_ROUTES: Record<string, Href> = {
  '/(main)/(tabs)/feed': routes.feed,
  '/(main)/(tabs)/camps': routes.camps,
  '/(main)/(tabs)/my-fires': routes.myFires,
  // Any controlled entry into Spark/create resolves directly to the pushed stack
  // screen. The tab route component itself stays inert so it cannot redirect
  // during navigation focus churn.
  '/(main)/(tabs)/create': routes.create,
  '/(main)/(tabs)/spark': routes.create,
  '/(main)/create': routes.create,
  '/(main)/personal-camp': routes.personalCamp,
}

const EXTERNAL_BONDFIRE_ROUTE = /^\/\(main\)\/bondfire\/([^/?#]+)$/
const EXTERNAL_CAMP_ROUTE = /^\/\(main\)\/camp\/([^/?#]+)$/

const EXTERNAL_INVITE_ROUTE = /^\/invite\/([^/?#]+)$/
const EXTERNAL_CAMP_INVITE_ROUTE = /^\/invite\/camp\/([^/?#]+)$/

/**
 * Validate and resolve a route path from an UNTRUSTED source (push notification
 * `data.screen`, deep links, etc.) into a typed `Href`.
 *
 * Unlike casting an arbitrary string to a route type, this only returns a target
 * for a known, allowlisted destination — anything else yields `null` so callers
 * can decline to navigate instead of crashing on a non-existent screen.
 */
export function resolveExternalRoute(path: string | null | undefined): Href | null {
  if (!path) return null

  const bondfireMatch = EXTERNAL_BONDFIRE_ROUTE.exec(path)
  if (bondfireMatch) return routes.bondfire(bondfireMatch[1])

  const campMatch = EXTERNAL_CAMP_ROUTE.exec(path)
  if (campMatch) return routes.camp(campMatch[1])

  const inviteMatch = EXTERNAL_INVITE_ROUTE.exec(path)
  if (inviteMatch) return routes.externalInvite(inviteMatch[1])

  const campInviteMatch = EXTERNAL_CAMP_INVITE_ROUTE.exec(path)
  if (campInviteMatch) return routes.externalCampInvite(campInviteMatch[1])

  return EXTERNAL_STATIC_ROUTES[path] ?? null
}

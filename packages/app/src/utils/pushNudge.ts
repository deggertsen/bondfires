/**
 * Pure decision helpers for the push permission nudge (PushPrimerSheet).
 * Kept free of native imports so they can be unit tested in node.
 */

/** Non-prompting snapshot of the OS notification permission. */
export interface PushPermissionState {
  status: string
  granted: boolean
  canAskAgain: boolean
}

/**
 * - `request`: the OS dialog can still be shown, so the nudge may fire it.
 * - `settings`: the OS will no longer prompt; only system Settings can turn
 *   notifications on.
 */
export type PushNudgeMode = 'request' | 'settings'

/**
 * Which nudge to present, or null when permission is already granted.
 *
 * Android reports `denied` before the user has ever been asked, so status
 * alone cannot tell "never asked" from "permanently denied" — `canAskAgain`
 * does.
 */
export function pushNudgeMode(permission: PushPermissionState): PushNudgeMode | null {
  if (permission.granted) return null
  if (permission.canAskAgain || permission.status === 'undetermined') return 'request'
  return 'settings'
}

export interface PushNudgeContext {
  isPhysicalDevice: boolean
  /** In-app notifications preference — off means the user opted out; do not nag. */
  notificationsEnabled: boolean
  /** Once-per-session and decline budget (`appActions.shouldShowPushPrimer()`). */
  primerEligible: boolean
}

/** Synchronous preconditions checked before reading the OS permission. */
export function canConsiderPushNudge(context: PushNudgeContext): boolean {
  return context.isPhysicalDevice && context.notificationsEnabled && context.primerEligible
}

/**
 * Run the OS permission request and mark the primer accepted only when it
 * was actually granted. A denial (or a failed request) leaves the primer
 * un-accepted so the nudge can return in a later session.
 */
export async function requestPushFromNudge(
  request: () => Promise<boolean>,
  recordAccepted: () => void,
): Promise<boolean> {
  const granted = await request()
  if (granted) recordAccepted()
  return granted
}

/** Stop asking after this many "no"s ("Not now", or back from Settings still off). */
export const PUSH_PRIMER_MAX_DECLINES = 3

/** Persisted primer bookkeeping (`appStore$.pushPrimer`). */
export interface PushPrimerState {
  lastShownAt: number | null
  declineCount: number
  accepted: boolean
}

/**
 * The primer shows at most once per app session (see `appSessionStore$`)
 * until the user accepts or has said no `PUSH_PRIMER_MAX_DECLINES` times.
 */
export function isPushPrimerEligible(primer: PushPrimerState, sessionStartedAt: number): boolean {
  if (primer.accepted) return false
  if (primer.declineCount >= PUSH_PRIMER_MAX_DECLINES) return false
  return primer.lastShownAt === null || primer.lastShownAt < sessionStartedAt
}

/**
 * The feed nudge waits until the user has recorded a video (a Bondfire or a
 * response), so the ask comes after they have something to hear back about.
 */
export function hasRecordedVideo(
  user: { bondfireCount?: number; responseCount?: number } | null | undefined,
): boolean {
  if (!user) return false
  return (user.bondfireCount ?? 0) + (user.responseCount ?? 0) > 0
}

/**
 * The user came back from system Settings after the primer sent them there.
 * Allowed counts as accepted; still off counts as a decline, so the decline
 * cap also covers users who keep backing out of Settings.
 */
export function settlePushSettingsReturn(
  granted: boolean,
  actions: { recordAccepted: () => void; recordDeclined: () => void },
): void {
  if (granted) actions.recordAccepted()
  else actions.recordDeclined()
}

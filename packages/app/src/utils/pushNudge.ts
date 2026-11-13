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
  /** Primer cooldown/decline budget (`appActions.shouldShowPushPrimer()`). */
  primerEligible: boolean
}

/** Synchronous preconditions checked before reading the OS permission. */
export function canConsiderPushNudge(context: PushNudgeContext): boolean {
  return context.isPhysicalDevice && context.notificationsEnabled && context.primerEligible
}

/**
 * Run the OS permission request and mark the primer accepted only when it
 * was actually granted. A denial (or a failed request) leaves the primer
 * un-accepted so the nudge can return after its cooldown.
 */
export async function requestPushFromNudge(
  request: () => Promise<boolean>,
  recordAccepted: () => void,
): Promise<boolean> {
  const granted = await request()
  if (granted) recordAccepted()
  return granted
}

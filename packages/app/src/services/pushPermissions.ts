import * as Notifications from 'expo-notifications'
import { telemetry } from './telemetry'

/**
 * Imperative bridge to the push permission flow owned by the root layout's
 * `usePushNotifications` instance.
 *
 * The OS permission dialog is one-shot on iOS, so it must only ever fire
 * after the user accepts our in-app pre-prompt (see PushPrimerSheet). The
 * root layout registers its `requestPermissions` here so feature screens
 * can trigger the dialog without instantiating a second notification hook.
 */
type PermissionRequester = () => Promise<boolean>
type ChannelResetter = (category: string) => Promise<void>

let requester: PermissionRequester | null = null
let channelResetter: ChannelResetter | null = null

export function setPushPermissionRequester(fn: PermissionRequester | null) {
  requester = fn
}

export function setChannelResetter(fn: ChannelResetter | null) {
  channelResetter = fn
}

/**
 * Fire the OS permission dialog (and register the device token on grant).
 * Returns false when no requester is mounted or permission was denied.
 */
export async function requestPushPermission(): Promise<boolean> {
  if (!requester) {
    telemetry.breadcrumb('push:permissionBridge:skip', { reason: 'no_requester_mounted' })
    return false
  }
  telemetry.breadcrumb('push:permissionBridge:attempt')
  const result = await requester()
  telemetry.breadcrumb('push:permissionBridge:result', { granted: result })
  return result
}

/** Whether OS-level push permission is already granted (never prompts). */
export async function isPushPermissionGranted(): Promise<boolean> {
  try {
    const { status } = await Notifications.getPermissionsAsync()
    const granted = status === 'granted'
    telemetry.breadcrumb('push:permissionBridge:check', { status, granted })
    return granted
  } catch (e) {
    telemetry.warn('push:permissionBridge', 'Error checking push permission status', {
      error: e instanceof Error ? e.message : String(e),
    })
    return false
  }
}

/** Reset an Android notification channel for a category (delete + recreate).
 * Used when the user re-enables a category in-app after disabling it in
 * Android system settings. No-op on iOS. */
export async function resetChannelForCategory(category: string): Promise<void> {
  if (!channelResetter) return
  await channelResetter(category)
}

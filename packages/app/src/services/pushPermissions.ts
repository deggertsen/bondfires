import * as Notifications from 'expo-notifications'

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

let requester: PermissionRequester | null = null

export function setPushPermissionRequester(fn: PermissionRequester | null) {
  requester = fn
}

/**
 * Fire the OS permission dialog (and register the device token on grant).
 * Returns false when no requester is mounted or permission was denied.
 */
export async function requestPushPermission(): Promise<boolean> {
  if (!requester) return false
  return requester()
}

/** Whether OS-level push permission is already granted (never prompts). */
export async function isPushPermissionGranted(): Promise<boolean> {
  try {
    const { status } = await Notifications.getPermissionsAsync()
    return status === 'granted'
  } catch {
    return false
  }
}

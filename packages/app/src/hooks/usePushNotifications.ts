import Constants from 'expo-constants'
import * as Device from 'expo-device'
import * as Notifications from 'expo-notifications'
import { useCallback, useEffect, useRef, useState } from 'react'
import { AppState, type AppStateStatus, Platform } from 'react-native'
import { telemetry } from '../services/telemetry'

const ANDROID_DEFAULT_CHANNEL_ID = 'bondfires-default'

/**
 * Android notification channels — 1:1 with in-app notification preference
 * categories. Each channel lets the user control sound, importance, and
 * visibility per category from Android system settings.
 *
 * Importance levels (set at creation; user can override in system settings):
 * - high:    heads-up notification + sound
 * - default: shows in shade + sound
 * - low:     shows in shade, no sound
 *
 * Once a channel is created, its importance can't be changed programmatically.
 * Only the user can change it via system settings. To "reset" a channel
 * (e.g. after the user disabled it in OS settings then re-enabled in-app),
 * we delete and recreate it.
 */
interface AndroidChannelDef {
  channelId: string
  name: string
  description: string
  importance: Notifications.AndroidImportance
}

const ANDROID_CATEGORY_CHANNELS: AndroidChannelDef[] = [
  {
    channelId: 'bondfires-recording',
    name: 'Camp activity',
    description: 'New Bondfires and live streams in your camps',
    importance: Notifications.AndroidImportance.DEFAULT,
  },
  {
    channelId: 'bondfires-responses',
    name: 'Responses',
    description: 'Responses to Bondfires you\'ve participated in',
    importance: Notifications.AndroidImportance.HIGH,
  },
  {
    channelId: 'bondfires-hearth',
    name: 'Hearths',
    description: 'Your private Bondfires and who joins them',
    importance: Notifications.AndroidImportance.HIGH,
  },
  {
    channelId: 'bondfires-membership',
    name: 'Invites & membership',
    description: 'Shared Bondfires, access requests, approvals',
    importance: Notifications.AndroidImportance.DEFAULT,
  },
  {
    channelId: 'bondfires-reminders',
    name: 'Reminders',
    description: 'Daily digest of videos waiting for you',
    importance: Notifications.AndroidImportance.LOW,
  },
]

/** All channel IDs including the legacy default. */
const ALL_CHANNEL_IDS = [
  ANDROID_DEFAULT_CHANNEL_ID,
  ...ANDROID_CATEGORY_CHANNELS.map((c) => c.channelId),
]

async function ensureAndroidNotificationChannel() {
  if (Platform.OS !== 'android') return

  // Legacy default channel — kept as fallback for pushes without a category
  // (e.g. test sends) and for old-client compatibility during rollout.
  await Notifications.setNotificationChannelAsync(ANDROID_DEFAULT_CHANNEL_ID, {
    name: 'Bondfires',
    importance: Notifications.AndroidImportance.MAX,
    vibrationPattern: [0, 250, 250, 250],
    lightColor: '#FF6B35',
  })

  // Category channels — 1:1 with in-app preference categories
  for (const channel of ANDROID_CATEGORY_CHANNELS) {
    await Notifications.setNotificationChannelAsync(channel.channelId, {
      name: channel.name,
      description: channel.description,
      importance: channel.importance,
      vibrationPattern: [0, 250, 250, 250],
      lightColor: '#FF6B35',
    })
  }
}

/** Delete and recreate a channel to reset its enabled state and defaults.
 * Used when the user re-enables a category in-app after disabling it in
 * Android system settings. */
async function resetAndroidChannel(channelId: string) {
  if (Platform.OS !== 'android') return

  const def = ANDROID_CATEGORY_CHANNELS.find((c) => c.channelId === channelId)
  if (!def) return

  try {
    await Notifications.deleteNotificationChannelAsync(channelId)
    await Notifications.setNotificationChannelAsync(def.channelId, {
      name: def.name,
      description: def.description,
      importance: def.importance,
      vibrationPattern: [0, 250, 250, 250],
      lightColor: '#FF6B35',
    })
    telemetry.breadcrumb('push:channel:reset', { channelId })
  } catch (e) {
    telemetry.warn('push:channel:reset', 'Failed to reset Android channel', {
      channelId,
      error: e instanceof Error ? e.message : String(e),
    })
  }
}

// Configure how notifications are handled when app is in foreground
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
})

interface TokenRegistrationParams {
  token: string
  tokenType: string
  platform: string
  deviceId: string
  // IANA timezone (e.g. 'America/Denver') for local-time digest delivery
  timezone?: string
}

function getDeviceTimezone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone ?? undefined
  } catch {
    return undefined
  }
}

interface TokenUnregistrationParams {
  token: string
}

export interface UsePushNotificationsOptions {
  // Whether backend token registration is allowed. This should be false before auth resolves.
  isAuthenticated?: boolean
  // Convex mutation to register device token
  registerTokenMutation?: (params: TokenRegistrationParams) => Promise<void>
  // Convex mutation to unregister device token
  unregisterTokenMutation?: (params: TokenUnregistrationParams) => Promise<void>
  // Convex mutation to update notification preferences (for Android channel sync)
  updatePreferencesMutation?: (params: {
    recordingActivity?: boolean
    responses?: boolean
    reminders?: boolean
    invitesAndMembership?: boolean
    hearth?: boolean
    digestWindowHour?: number
  }) => Promise<void>
  // Convex query to get current notification preferences (for Android channel sync)
  getPreferencesQuery?: () => { recordingActivity: boolean; responses: boolean; reminders: boolean; invitesAndMembership: boolean; hearth: boolean; digestWindowHour: number } | null | undefined
  // Called when a notification is received while app is in foreground
  onNotificationReceived?: (notification: Notifications.Notification) => void
  // Called when user taps on a notification
  onNotificationResponse?: (response: Notifications.NotificationResponse) => void
  // Called when OS push permission has been revoked since last active
  onPermissionRevoked?: () => void
}

export interface UsePushNotificationsResult {
  expoPushToken: string | null
  isRegistered: boolean
  error: string | null
  /**
   * Fires the OS permission dialog if needed, then registers the token.
   * iOS only ever shows this dialog once — call it solely from explicit
   * user intent (the push pre-prompt or the settings toggle), never
   * automatically at sign-in or app start.
   */
  requestPermissions: () => Promise<boolean>
  /**
   * Registers the device token only when OS permission is already
   * granted. Never prompts — safe to call at sign-in / app start.
   */
  registerIfGranted: () => Promise<boolean>
  unregister: () => Promise<void>
  /**
   * Syncs in-app notification preferences with Android channel enabled states.
   * Call on app foreground. Reads each category channel's importance — if the
   * user disabled it in Android settings (importance === NONE), updates the
   * in-app preference to false. Returns the set of categories that changed.
   * Android only; no-op on iOS.
   */
  syncAndroidChannelPrefs: () => Promise<{ recordingActivity?: boolean; responses?: boolean; hearth?: boolean; invitesAndMembership?: boolean; reminders?: boolean }>
  /**
   * Resets an Android notification channel for a category that was disabled at
   * the OS level. Deletes and recreates the channel so it's enabled again with
   * our default importance. Call this when the in-app toggle goes off → on AND
   * the corresponding Android channel is OS-disabled. Android only; no-op on iOS.
   */
  resetChannelForCategory: (categoryKey: string) => Promise<void>
}

export function usePushNotifications(
  options: UsePushNotificationsOptions = {},
): UsePushNotificationsResult {
  const {
    isAuthenticated = true,
    registerTokenMutation,
    unregisterTokenMutation,
    onNotificationReceived,
    onNotificationResponse,
    onPermissionRevoked,
  } = options

  const [expoPushToken, setExpoPushToken] = useState<string | null>(null)
  const [isRegistered, setIsRegistered] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const notificationListener = useRef<Notifications.EventSubscription | null>(null)
  const responseListener = useRef<Notifications.EventSubscription | null>(null)
  const appStateRef = useRef(AppState.currentState)
  const isAuthenticatedRef = useRef(isAuthenticated)
  isAuthenticatedRef.current = isAuthenticated
  const expoPushTokenRef = useRef(expoPushToken)
  expoPushTokenRef.current = expoPushToken
  const onPermissionRevokedRef = useRef(onPermissionRevoked)
  onPermissionRevokedRef.current = onPermissionRevoked

  const setStoredExpoPushToken = useCallback((token: string | null) => {
    expoPushTokenRef.current = token
    setExpoPushToken(token)
  }, [])

  // Register token with backend
  const registerWithBackend = useCallback(
    async (token: string) => {
      if (!registerTokenMutation) {
        telemetry.breadcrumb('push:register:skip', {
          reason: 'no_mutation_fn',
        })
        return
      }

      // Backend registration requires an authenticated Convex session. If the
      // app is pre-login, the _layout auth observer will retry after sign-in.
      if (!isAuthenticatedRef.current) {
        telemetry.breadcrumb('push:register:skip', {
          reason: 'not_authenticated',
        })
        return
      }

      try {
        telemetry.breadcrumb('push:register:attempt', {
          tokenPrefix: token.slice(0, 16),
          platform: Platform.OS,
          deviceId: Constants.deviceId ?? 'unknown',
        })
        await registerTokenMutation({
          token,
          tokenType: 'expo',
          platform: Platform.OS,
          deviceId: Constants.deviceId ?? 'unknown',
          timezone: getDeviceTimezone(),
        })
        setIsRegistered(true)
        setError(null)
        telemetry.breadcrumb('push:register:success', {
          tokenPrefix: token.slice(0, 16),
        })
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        // Auth can still race with session establishment. Treat those failures
        // as retryable instead of surfacing them at all.
        if (message.includes('Not authenticated') || message.includes('Unauthorized')) {
          telemetry.breadcrumb('push:register:skip', {
            reason: 'auth_race',
            error: message,
          })
          return
        }
        // Backend token registration is background infrastructure that auto-
        // retries (sign-in, app foreground, app-state change). Its failures are
        // never user-actionable — most commonly a transient network blip or the
        // sign-out/sign-in auth gap whose error message slips past the filter
        // above. Log as a warn (telemetry.error fires a user toast; warn does
        // not) so we keep the breadcrumb without spamming a stream of toasts.
        telemetry.warn('push:register', 'Failed to register token with backend', {
          error: message,
          tokenPrefix: token.slice(0, 16),
        })
      }
    },
    [registerTokenMutation],
  )

  // Get the Expo push token
  const getExpoPushToken = useCallback(async (): Promise<string | null> => {
    const projectId = Constants.expoConfig?.extra?.eas?.projectId
    if (!projectId) {
      telemetry.error('push:config', 'EAS project ID not found in app config')
      return null
    }

    try {
      telemetry.breadcrumb('push:token:attempt', { projectId })
      const tokenData = await Notifications.getExpoPushTokenAsync({ projectId })
      telemetry.breadcrumb('push:token:success', {
        tokenPrefix: tokenData.data.slice(0, 16),
      })
      return tokenData.data
    } catch (e) {
      // Handle Firebase auth errors gracefully (common in dev builds)
      const errorMessage = e instanceof Error ? e.message : String(e)
      if (errorMessage.includes('FIS_AUTH_ERROR')) {
        telemetry.warn(
          'push:firebase',
          'Push notifications unavailable: Firebase auth error in dev build',
        )
        return null
      }
      // Emulators and devices without Google Play Services can't get push tokens
      if (errorMessage.includes('MISSING_INSTANCEID_SERVICE')) {
        telemetry.breadcrumb('push:token:skip', {
          reason: 'missing_instanceid_service',
        })
        return null
      }
      telemetry.error('push:token', 'Unexpected error getting Expo push token', {
        error: errorMessage,
      })
      throw e
    }
  }, [])

  // Request notification permissions
  const requestPermissions = useCallback(async (): Promise<boolean> => {
    if (!isAuthenticatedRef.current) {
      telemetry.breadcrumb('push:permissions:skip', { reason: 'not_authenticated' })
      return false
    }

    if (!Device.isDevice) {
      telemetry.breadcrumb('push:permissions:skip', { reason: 'not_physical_device' })
      setError('Push notifications only work on physical devices')
      return false
    }

    try {
      const { status: existingStatus } = await Notifications.getPermissionsAsync()
      let finalStatus = existingStatus
      telemetry.breadcrumb('push:permissions:check', { existingStatus })

      if (existingStatus !== 'granted') {
        const { status } = await Notifications.requestPermissionsAsync()
        finalStatus = status
        telemetry.breadcrumb('push:permissions:request', { requestedStatus: status })
      }

      if (finalStatus !== 'granted') {
        telemetry.breadcrumb('push:permissions:denied', { finalStatus })
        setError('Push notification permissions denied')
        return false
      }

      telemetry.breadcrumb('push:permissions:granted')
      await ensureAndroidNotificationChannel()

      // Get Expo push token
      const token = await getExpoPushToken()
      if (token) {
        setStoredExpoPushToken(token)
        await registerWithBackend(token)
      } else {
        telemetry.breadcrumb('push:permissions:skip', { reason: 'no_token_after_grant' })
        setError('Failed to get push notification token')
        return false
      }

      setError(null)
      return true
    } catch (e) {
      const errorMessage = e instanceof Error ? e.message : String(e)
      // Emulators and non-Google Play Services devices — not actionable
      if (errorMessage.includes('MISSING_INSTANCEID_SERVICE')) {
        telemetry.breadcrumb('push:permissions:skip', {
          reason: 'missing_instanceid_service',
          error: errorMessage,
        })
        return false
      }
      telemetry.error('push:permissions', 'Error requesting push notification permissions', {
        error: String(e),
      })
      setError('Failed to set up push notifications')
      return false
    }
  }, [getExpoPushToken, registerWithBackend, setStoredExpoPushToken])

  // Register the token only if OS permission is already granted — never prompts.
  const registerIfGranted = useCallback(async (): Promise<boolean> => {
    if (!isAuthenticatedRef.current) {
      telemetry.breadcrumb('push:registerIfGranted:skip', { reason: 'not_authenticated' })
      return false
    }
    if (!Device.isDevice) {
      telemetry.breadcrumb('push:registerIfGranted:skip', { reason: 'not_physical_device' })
      return false
    }

    try {
      const { status } = await Notifications.getPermissionsAsync()
      if (status !== 'granted') {
        telemetry.breadcrumb('push:registerIfGranted:skip', { reason: 'permission_not_granted', status })
        return false
      }

      await ensureAndroidNotificationChannel()

      const token = await getExpoPushToken()
      if (!token) {
        telemetry.breadcrumb('push:registerIfGranted:skip', { reason: 'no_token' })
        return false
      }

      setStoredExpoPushToken(token)
      await registerWithBackend(token)
      telemetry.breadcrumb('push:registerIfGranted:success', {
        tokenPrefix: token.slice(0, 16),
      })
      return true
    } catch (e) {
      const errorMessage = e instanceof Error ? e.message : String(e)
      telemetry.warn('push:registerIfGranted', 'Unexpected error during silent registration', {
        error: errorMessage,
      })
      return false
    }
  }, [getExpoPushToken, registerWithBackend, setStoredExpoPushToken])

  // Unregister from push notifications
  const unregister = useCallback(async () => {
    try {
      const token = expoPushTokenRef.current
      if (token && unregisterTokenMutation) {
        await unregisterTokenMutation({ token })
      }
      setStoredExpoPushToken(null)
      setIsRegistered(false)
    } catch (e) {
      telemetry.error('push:unregister', 'Error unregistering push notifications', {
        error: String(e),
      })
    }
  }, [setStoredExpoPushToken, unregisterTokenMutation])

  const handlePermissionRevoked = useCallback(async () => {
    const token = expoPushTokenRef.current
    setStoredExpoPushToken(null)
    setIsRegistered(false)

    if (token && unregisterTokenMutation) {
      try {
        await unregisterTokenMutation({ token })
      } catch (e) {
        telemetry.warn('push:unregister', 'Failed to unregister revoked push token', {
          error: String(e),
        })
      }
    }

    onPermissionRevokedRef.current?.()
  }, [setStoredExpoPushToken, unregisterTokenMutation])

  // Set up notification listeners
  useEffect(() => {
    // Foreground notification handler
    notificationListener.current = Notifications.addNotificationReceivedListener((notification) => {
      onNotificationReceived?.(notification)
    })

    // Notification response handler (when user taps notification)
    responseListener.current = Notifications.addNotificationResponseReceivedListener((response) => {
      onNotificationResponse?.(response)
    })

    // Handle app state changes (refresh token on foreground, sync OS permission)
    const handleAppStateChange = async (nextAppState: AppStateStatus) => {
      const cameToForeground =
        appStateRef.current.match(/inactive|background/) && nextAppState === 'active'
      appStateRef.current = nextAppState

      if (cameToForeground) {
        if (!isAuthenticatedRef.current) {
          telemetry.breadcrumb('push:foreground:skip', { reason: 'not_authenticated' })
          return
        }

        // App came to foreground - verify token is still valid
        try {
          const { status } = await Notifications.getPermissionsAsync()
          if (status !== 'granted') {
            // OS permission was revoked (e.g. via system settings) since last
            // foreground. Clear the local token so we don't keep sending to a
            // dead endpoint.
            telemetry.breadcrumb('push:foreground:permission_revoked', { status })
            await handlePermissionRevoked()
            return
          }

          await ensureAndroidNotificationChannel()

          const token = await getExpoPushToken()
          if (token && token !== expoPushTokenRef.current) {
            telemetry.breadcrumb('push:foreground:token_changed', {
              oldPrefix: expoPushTokenRef.current?.slice(0, 16),
              newPrefix: token.slice(0, 16),
            })
            setStoredExpoPushToken(token)
            await registerWithBackend(token)
          } else if (!token) {
            telemetry.breadcrumb('push:foreground:skip', { reason: 'no_token' })
          }
        } catch (e) {
          const errorMessage = e instanceof Error ? e.message : String(e)
          telemetry.warn('push:foreground', 'Error during foreground token refresh', {
            error: errorMessage,
          })
        }
      }
    }

    const appStateSubscription = AppState.addEventListener('change', handleAppStateChange)

    return () => {
      notificationListener.current?.remove()
      responseListener.current?.remove()
      appStateSubscription.remove()
    }
  }, [
    getExpoPushToken,
    handlePermissionRevoked,
    onNotificationReceived,
    onNotificationResponse,
    registerWithBackend,
    setStoredExpoPushToken,
  ])

  // Ensure the Android notification channel exists on every mount.
  // Channel creation is idempotent — safe to call even if it already exists.
  // This is critical: the backend always sends pushes with channelId
  // 'bondfires-default'. If the channel doesn't exist on the device, Android
  // silently drops the notification with no error or log. The channel was
  // previously only created inside requestPermissions(), which meant users
  // who registered via registerIfGranted() (sign-in, app-state change) or
  // the mount-time check below never got the channel and silently lost all
  // push notifications.
  useEffect(() => {
    ensureAndroidNotificationChannel().catch(() => {
      // setNotificationChannelAsync is best-effort; failures are non-fatal
      // and typically only occur in emulators.
    })
  }, [])

  // Check initial permission status on mount, but never prompt pre-login.
  useEffect(() => {
    const checkInitialStatus = async () => {
      if (!Device.isDevice) {
        telemetry.breadcrumb('push:mount:skip', { reason: 'not_physical_device' })
        return
      }
      if (!isAuthenticatedRef.current) {
        telemetry.breadcrumb('push:mount:skip', { reason: 'not_authenticated' })
        return
      }

      const { status } = await Notifications.getPermissionsAsync()
      telemetry.breadcrumb('push:mount:check', { permissionStatus: status })
      if (status === 'granted') {
        // Already have permission, get token
        try {
          await ensureAndroidNotificationChannel()

          const token = await getExpoPushToken()
          if (token) {
            setStoredExpoPushToken(token)
            await registerWithBackend(token)
          } else {
            telemetry.breadcrumb('push:mount:skip', { reason: 'no_token' })
          }
        } catch (e) {
          const errorMessage = e instanceof Error ? e.message : String(e)
          telemetry.warn('push:mount', 'Error during mount-time registration', {
            error: errorMessage,
          })
        }
      } else {
        telemetry.breadcrumb('push:mount:skip', { reason: 'permission_not_granted', status })
      }
    }

    checkInitialStatus()
  }, [getExpoPushToken, registerWithBackend, setStoredExpoPushToken])

  // ── Android channel ↔ in-app preference sync ──

  /** Map in-app category keys to Android channel IDs. */
  const CATEGORY_KEY_TO_CHANNEL: Record<string, string> = {
    recordingActivity: 'bondfires-recording',
    responses: 'bondfires-responses',
    hearth: 'bondfires-hearth',
    invitesAndMembership: 'bondfires-membership',
    reminders: 'bondfires-reminders',
  }


  // Sync Android channel state → in-app preferences. Reads each channel's
  // importance — if the user disabled it in Android settings (importance ===
  // NONE), updates the in-app preference to false. Returns categories that changed.
  const syncAndroidChannelPrefs = useCallback(async (): Promise<{
    recordingActivity?: boolean
    responses?: boolean
    hearth?: boolean
    invitesAndMembership?: boolean
    reminders?: boolean
  }> => {
    if (Platform.OS !== 'android') return {}

    const prefs = options.getPreferencesQuery?.()
    if (!prefs) {
      telemetry.breadcrumb('push:channel:sync:skip', { reason: 'no_prefs_query' })
      return {}
    }

    const changes: Partial<{
      recordingActivity: boolean
      responses: boolean
      hearth: boolean
      invitesAndMembership: boolean
      reminders: boolean
    }> = {}
    const updates: Partial<{
      recordingActivity: boolean
      responses: boolean
      hearth: boolean
      invitesAndMembership: boolean
      reminders: boolean
    }> = {}

    type CategoryKey = 'recordingActivity' | 'responses' | 'hearth' | 'invitesAndMembership' | 'reminders'

    for (const [categoryKey, channelId] of Object.entries(CATEGORY_KEY_TO_CHANNEL)) {
      try {
        const channel = await Notifications.getNotificationChannelAsync(channelId)
        if (!channel) {
          // Channel doesn't exist yet — nothing to sync
          continue
        }

        const osDisabled = channel.importance === Notifications.AndroidImportance.NONE
        const inAppEnabled = prefs[categoryKey as keyof typeof prefs]

        if (osDisabled && inAppEnabled) {
          // User disabled this channel in Android settings — sync in-app pref to off
          telemetry.breadcrumb('push:channel:sync:disabled', {
            channelId,
            categoryKey,
            importance: channel.importance,
          })
          changes[categoryKey as CategoryKey] = false
          updates[categoryKey as CategoryKey] = false
        }
      } catch (e) {
        telemetry.warn('push:channel:sync', 'Error checking channel state', {
          channelId,
          error: e instanceof Error ? e.message : String(e),
        })
      }
    }

    if (Object.keys(updates).length > 0 && options.updatePreferencesMutation) {
      try {
        await options.updatePreferencesMutation(updates as {
          recordingActivity?: boolean
          responses?: boolean
          reminders?: boolean
          invitesAndMembership?: boolean
          hearth?: boolean
          digestWindowHour?: number
        })
        telemetry.breadcrumb('push:channel:sync:applied', { updates })
      } catch (e) {
        telemetry.warn('push:channel:sync', 'Failed to update preferences from channel sync', {
          error: e instanceof Error ? e.message : String(e),
        })
      }
    }

    return changes
  }, [options])

  // Reset (delete + recreate) an Android channel for a category that was
  // disabled at the OS level. Used when the in-app toggle goes off → on.
  const resetChannelForCategory = useCallback(async (categoryKey: string): Promise<void> => {
    if (Platform.OS !== 'android') return

    const channelId = CATEGORY_KEY_TO_CHANNEL[categoryKey]
    if (!channelId) {
      telemetry.breadcrumb('push:channel:reset:skip', { reason: 'unknown_category', categoryKey })
      return
    }

    try {
      const channel = await Notifications.getNotificationChannelAsync(channelId)
      if (!channel) {
        // Channel doesn't exist — create it via ensureAndroidNotificationChannel
        await ensureAndroidNotificationChannel()
        return
      }

      if (channel.importance === Notifications.AndroidImportance.NONE) {
        // Channel is OS-disabled — delete and recreate to reset to enabled
        await resetAndroidChannel(channelId)
      } else {
        telemetry.breadcrumb('push:channel:reset:skip', {
          reason: 'channel_not_disabled',
          channelId,
          importance: channel.importance,
        })
      }
    } catch (e) {
      telemetry.warn('push:channel:reset', 'Error resetting channel', {
        channelId,
        error: e instanceof Error ? e.message : String(e),
      })
    }
  }, [])

  return {
    expoPushToken,
    isRegistered,
    error,
    requestPermissions,
    registerIfGranted,
    unregister,
    syncAndroidChannelPrefs,
    resetChannelForCategory,
  }
}

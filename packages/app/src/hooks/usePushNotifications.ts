import Constants from 'expo-constants'
import * as Device from 'expo-device'
import * as Notifications from 'expo-notifications'
import { useCallback, useEffect, useRef, useState } from 'react'
import { AppState, type AppStateStatus, Platform } from 'react-native'
import { telemetry } from '../services/telemetry'

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
  // Called when a notification is received while app is in foreground
  onNotificationReceived?: (notification: Notifications.Notification) => void
  // Called when user taps on a notification
  onNotificationResponse?: (response: Notifications.NotificationResponse) => void
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
  } = options

  const [expoPushToken, setExpoPushToken] = useState<string | null>(null)
  const [isRegistered, setIsRegistered] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const notificationListener = useRef<Notifications.EventSubscription | null>(null)
  const responseListener = useRef<Notifications.EventSubscription | null>(null)
  const appStateRef = useRef(AppState.currentState)
  const isAuthenticatedRef = useRef(isAuthenticated)
  isAuthenticatedRef.current = isAuthenticated

  // Register token with backend
  const registerWithBackend = useCallback(
    async (token: string) => {
      if (!registerTokenMutation) return

      // Backend registration requires an authenticated Convex session. If the
      // app is pre-login, the _layout auth observer will retry after sign-in.
      if (!isAuthenticatedRef.current) {
        return
      }

      try {
        await registerTokenMutation({
          token,
          tokenType: 'expo',
          platform: Platform.OS,
          deviceId: Constants.deviceId ?? 'unknown',
          timezone: getDeviceTimezone(),
        })
        setIsRegistered(true)
        setError(null)
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        // Auth can still race with session establishment. Treat those failures
        // as retryable instead of surfacing them at all.
        if (message.includes('Not authenticated') || message.includes('Unauthorized')) {
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
      const tokenData = await Notifications.getExpoPushTokenAsync({ projectId })
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
        return null
      }
      throw e
    }
  }, [])

  // Request notification permissions
  const requestPermissions = useCallback(async (): Promise<boolean> => {
    if (!isAuthenticatedRef.current) {
      return false
    }

    if (!Device.isDevice) {
      setError('Push notifications only work on physical devices')
      return false
    }

    try {
      const { status: existingStatus } = await Notifications.getPermissionsAsync()
      let finalStatus = existingStatus

      if (existingStatus !== 'granted') {
        const { status } = await Notifications.requestPermissionsAsync()
        finalStatus = status
      }

      if (finalStatus !== 'granted') {
        setError('Push notification permissions denied')
        return false
      }

      // Set up Android notification channel
      if (Platform.OS === 'android') {
        await Notifications.setNotificationChannelAsync('bondfires-default', {
          name: 'Bondfires',
          importance: Notifications.AndroidImportance.MAX,
          vibrationPattern: [0, 250, 250, 250],
          lightColor: '#FF6B35',
        })
      }

      // Get Expo push token
      const token = await getExpoPushToken()
      if (token) {
        setExpoPushToken(token)
        await registerWithBackend(token)
      } else {
        setError('Failed to get push notification token')
        return false
      }

      setError(null)
      return true
    } catch (e) {
      const errorMessage = e instanceof Error ? e.message : String(e)
      // Emulators and non-Google Play Services devices — not actionable
      if (errorMessage.includes('MISSING_INSTANCEID_SERVICE')) {
        return false
      }
      telemetry.error('push:permissions', 'Error requesting push notification permissions', {
        error: String(e),
      })
      setError('Failed to set up push notifications')
      return false
    }
  }, [getExpoPushToken, registerWithBackend])

  // Register the token only if OS permission is already granted — never prompts.
  const registerIfGranted = useCallback(async (): Promise<boolean> => {
    if (!isAuthenticatedRef.current) return false
    if (!Device.isDevice) return false

    try {
      const { status } = await Notifications.getPermissionsAsync()
      if (status !== 'granted') return false

      const token = await getExpoPushToken()
      if (!token) return false

      setExpoPushToken(token)
      await registerWithBackend(token)
      return true
    } catch {
      // getExpoPushToken already logs helpful messages
      return false
    }
  }, [getExpoPushToken, registerWithBackend])

  // Unregister from push notifications
  const unregister = useCallback(async () => {
    try {
      if (expoPushToken && unregisterTokenMutation) {
        await unregisterTokenMutation({ token: expoPushToken })
      }
      setExpoPushToken(null)
      setIsRegistered(false)
    } catch (e) {
      telemetry.error('push:unregister', 'Error unregistering push notifications', {
        error: String(e),
      })
    }
  }, [expoPushToken, unregisterTokenMutation])

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

    // Handle app state changes (refresh token on foreground)
    const handleAppStateChange = async (nextAppState: AppStateStatus) => {
      if (appStateRef.current.match(/inactive|background/) && nextAppState === 'active') {
        if (!isAuthenticatedRef.current) return

        // App came to foreground - verify token is still valid
        try {
          const token = await getExpoPushToken()
          if (token && token !== expoPushToken) {
            setExpoPushToken(token)
            await registerWithBackend(token)
          }
        } catch {
          // Silently handle - getExpoPushToken already logs helpful messages
        }
      }
      appStateRef.current = nextAppState
    }

    const appStateSubscription = AppState.addEventListener('change', handleAppStateChange)

    return () => {
      notificationListener.current?.remove()
      responseListener.current?.remove()
      appStateSubscription.remove()
    }
  }, [
    expoPushToken,
    getExpoPushToken,
    onNotificationReceived,
    onNotificationResponse,
    registerWithBackend,
  ])

  // Check initial permission status on mount, but never prompt pre-login.
  useEffect(() => {
    const checkInitialStatus = async () => {
      if (!Device.isDevice) return
      if (!isAuthenticatedRef.current) return

      const { status } = await Notifications.getPermissionsAsync()
      if (status === 'granted') {
        // Already have permission, get token
        try {
          const token = await getExpoPushToken()
          if (token) {
            setExpoPushToken(token)
            await registerWithBackend(token)
          }
        } catch {
          // Silently handle - getExpoPushToken already logs helpful messages
        }
      }
    }

    checkInitialStatus()
  }, [getExpoPushToken, registerWithBackend])

  return {
    expoPushToken,
    isRegistered,
    error,
    requestPermissions,
    registerIfGranted,
    unregister,
  }
}

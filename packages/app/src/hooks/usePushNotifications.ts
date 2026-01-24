import Constants from 'expo-constants'
import * as Device from 'expo-device'
import * as Notifications from 'expo-notifications'
import { useCallback, useEffect, useRef, useState } from 'react'
import { AppState, type AppStateStatus, Platform } from 'react-native'

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
}

interface TokenUnregistrationParams {
  token: string
}

export interface UsePushNotificationsOptions {
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
  requestPermissions: () => Promise<boolean>
  unregister: () => Promise<void>
}

export function usePushNotifications(
  options: UsePushNotificationsOptions = {},
): UsePushNotificationsResult {
  const {
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

  // Register token with backend
  const registerWithBackend = useCallback(
    async (token: string) => {
      if (registerTokenMutation) {
        try {
          await registerTokenMutation({
            token,
            tokenType: 'expo',
            platform: Platform.OS,
            deviceId: Constants.deviceId ?? 'unknown',
          })
          setIsRegistered(true)
        } catch (e) {
          console.error('Failed to register token with backend:', e)
          setError('Failed to register with server')
        }
      }
    },
    [registerTokenMutation],
  )

  // Get the Expo push token
  const getExpoPushToken = useCallback(async (): Promise<string | null> => {
    const projectId = Constants.expoConfig?.extra?.eas?.projectId
    if (!projectId) {
      console.error('EAS project ID not found in app config')
      return null
    }

    try {
      const tokenData = await Notifications.getExpoPushTokenAsync({ projectId })
      return tokenData.data
    } catch (e) {
      // Handle Firebase auth errors gracefully (common in dev builds)
      const errorMessage = e instanceof Error ? e.message : String(e)
      if (errorMessage.includes('FIS_AUTH_ERROR')) {
        console.warn(
          'Push notifications unavailable: Firebase auth error. ' +
            'This is normal in development. For production, ensure SHA-1 fingerprint is registered in Firebase Console.',
        )
        return null
      }
      throw e
    }
  }, [])

  // Request notification permissions
  const requestPermissions = useCallback(async (): Promise<boolean> => {
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
      console.error('Error requesting push notification permissions:', e)
      setError('Failed to set up push notifications')
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
      console.error('Error unregistering push notifications:', e)
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

  // Check initial permission status on mount
  useEffect(() => {
    const checkInitialStatus = async () => {
      if (!Device.isDevice) return

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
    unregister,
  }
}

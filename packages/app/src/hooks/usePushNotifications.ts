import messaging from '@react-native-firebase/messaging'
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
  fcmToken: string | null
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
  const [fcmToken, setFcmToken] = useState<string | null>(null)
  const [isRegistered, setIsRegistered] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const notificationListener = useRef<Notifications.EventSubscription | null>(null)
  const responseListener = useRef<Notifications.EventSubscription | null>(null)
  const appStateRef = useRef(AppState.currentState)

  // Register token with backend
  const registerWithBackend = useCallback(
    async (token: string, tokenType: 'expo' | 'fcm') => {
      if (registerTokenMutation) {
        try {
          await registerTokenMutation({
            token,
            tokenType,
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

  // Request notification permissions
  const requestPermissions = useCallback(async (): Promise<boolean> => {
    if (!Device.isDevice) {
      setError('Push notifications only work on physical devices')
      return false
    }

    try {
      // Request Firebase messaging permission (iOS)
      if (Platform.OS === 'ios') {
        const authStatus = await messaging().requestPermission()
        const enabled =
          authStatus === messaging.AuthorizationStatus.AUTHORIZED ||
          authStatus === messaging.AuthorizationStatus.PROVISIONAL

        if (!enabled) {
          setError('Push notification permissions denied')
          return false
        }
      }

      // Also request expo-notifications permission
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

      // Get FCM token
      const token = await messaging().getToken()
      setFcmToken(token)
      await registerWithBackend(token, 'fcm')

      // Also get Expo push token for compatibility
      try {
        const projectId = Constants.expoConfig?.extra?.eas?.projectId
        if (projectId) {
          const expoPushTokenData = await Notifications.getExpoPushTokenAsync({
            projectId,
          })
          setExpoPushToken(expoPushTokenData.data)
        }
      } catch {
        // Expo push token is optional, FCM is the primary
      }

      setError(null)
      return true
    } catch (e) {
      console.error('Error requesting push notification permissions:', e)
      setError('Failed to set up push notifications')
      return false
    }
  }, [registerWithBackend])

  // Unregister from push notifications
  const unregister = useCallback(async () => {
    try {
      if (fcmToken && unregisterTokenMutation) {
        await unregisterTokenMutation({ token: fcmToken })
      }
      await messaging().deleteToken()
      setFcmToken(null)
      setExpoPushToken(null)
      setIsRegistered(false)
    } catch (e) {
      console.error('Error unregistering push notifications:', e)
    }
  }, [fcmToken, unregisterTokenMutation])

  // Set up notification listeners
  useEffect(() => {
    // Foreground notification handler (expo-notifications)
    notificationListener.current = Notifications.addNotificationReceivedListener((notification) => {
      onNotificationReceived?.(notification)
    })

    // Notification response handler (when user taps notification)
    responseListener.current = Notifications.addNotificationResponseReceivedListener((response) => {
      onNotificationResponse?.(response)
    })

    // Firebase foreground message handler
    const unsubscribeOnMessage = messaging().onMessage(async (remoteMessage) => {
      // Display local notification for foreground messages
      if (remoteMessage.notification) {
        await Notifications.scheduleNotificationAsync({
          content: {
            title: remoteMessage.notification.title ?? 'New notification',
            body: remoteMessage.notification.body ?? '',
            data: remoteMessage.data,
          },
          trigger: null, // Show immediately
        })
      }
    })

    // Firebase token refresh handler
    const unsubscribeOnTokenRefresh = messaging().onTokenRefresh(async (token) => {
      setFcmToken(token)
      await registerWithBackend(token, 'fcm')
    })

    // Handle app state changes (re-register on foreground)
    const handleAppStateChange = (nextAppState: AppStateStatus) => {
      if (appStateRef.current.match(/inactive|background/) && nextAppState === 'active') {
        // App came to foreground - check token is still valid
        messaging()
          .getToken()
          .then((token) => {
            if (token !== fcmToken) {
              setFcmToken(token)
              registerWithBackend(token, 'fcm')
            }
          })
          .catch(console.error)
      }
      appStateRef.current = nextAppState
    }

    const appStateSubscription = AppState.addEventListener('change', handleAppStateChange)

    return () => {
      notificationListener.current?.remove()
      responseListener.current?.remove()
      unsubscribeOnMessage()
      unsubscribeOnTokenRefresh()
      appStateSubscription.remove()
    }
  }, [fcmToken, onNotificationReceived, onNotificationResponse, registerWithBackend])

  // Check initial permission status on mount
  useEffect(() => {
    const checkInitialStatus = async () => {
      if (!Device.isDevice) return

      const authStatus = await messaging().hasPermission()
      if (
        authStatus === messaging.AuthorizationStatus.AUTHORIZED ||
        authStatus === messaging.AuthorizationStatus.PROVISIONAL
      ) {
        // Already have permission, get token
        try {
          const token = await messaging().getToken()
          setFcmToken(token)
          await registerWithBackend(token, 'fcm')
        } catch (e) {
          console.error('Error getting initial FCM token:', e)
        }
      }
    }

    checkInitialStatus()
  }, [registerWithBackend])

  return {
    expoPushToken,
    fcmToken,
    isRegistered,
    error,
    requestPermissions,
    unregister,
  }
}

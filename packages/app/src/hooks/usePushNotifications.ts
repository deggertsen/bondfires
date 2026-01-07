import { useState, useEffect, useRef, useCallback } from 'react'
import * as Notifications from 'expo-notifications'
import * as Device from 'expo-device'
import { Platform } from 'react-native'
import Constants from 'expo-constants'
import { appStore$ } from '../store/app.store'

// Configure notification handler
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
})

export interface PushNotificationState {
  expoPushToken: string | null
  notification: Notifications.Notification | null
  error: string | null
}

export function usePushNotifications(
  onRegisterToken?: (token: string, platform: 'ios' | 'android') => Promise<void>
) {
  const [expoPushToken, setExpoPushToken] = useState<string | null>(null)
  const [notification, setNotification] = useState<Notifications.Notification | null>(null)
  const [error, setError] = useState<string | null>(null)
  
  const notificationListener = useRef<Notifications.Subscription>()
  const responseListener = useRef<Notifications.Subscription>()
  
  const registerForPushNotifications = useCallback(async () => {
    if (!Device.isDevice) {
      setError('Push notifications require a physical device')
      return null
    }
    
    // Check existing permissions
    const { status: existingStatus } = await Notifications.getPermissionsAsync()
    let finalStatus = existingStatus
    
    // Request permissions if not granted
    if (existingStatus !== 'granted') {
      const { status } = await Notifications.requestPermissionsAsync()
      finalStatus = status
    }
    
    if (finalStatus !== 'granted') {
      setError('Permission for push notifications was denied')
      return null
    }
    
    // Get Expo push token
    try {
      const projectId = Constants.expoConfig?.extra?.eas?.projectId
      const token = await Notifications.getExpoPushTokenAsync({
        projectId,
      })
      
      setExpoPushToken(token.data)
      
      // Register token with backend
      if (onRegisterToken) {
        const platform = Platform.OS as 'ios' | 'android'
        await onRegisterToken(token.data, platform)
      }
      
      return token.data
    } catch (err) {
      setError(`Failed to get push token: ${err}`)
      return null
    }
  }, [onRegisterToken])
  
  useEffect(() => {
    // Only register if notifications are enabled in preferences
    const notificationsEnabled = appStore$.preferences.notificationsEnabled.get()
    
    if (notificationsEnabled) {
      registerForPushNotifications()
    }
    
    // Listen for incoming notifications
    notificationListener.current = Notifications.addNotificationReceivedListener(
      (notification) => {
        setNotification(notification)
      }
    )
    
    // Listen for notification interactions
    responseListener.current = Notifications.addNotificationResponseReceivedListener(
      (response) => {
        // Handle notification tap
        const data = response.notification.request.content.data
        console.log('Notification tapped:', data)
        // Navigate to appropriate screen based on notification data
      }
    )
    
    // Cleanup
    return () => {
      if (notificationListener.current) {
        Notifications.removeNotificationSubscription(notificationListener.current)
      }
      if (responseListener.current) {
        Notifications.removeNotificationSubscription(responseListener.current)
      }
    }
  }, [registerForPushNotifications])
  
  // Set up Android notification channel
  useEffect(() => {
    if (Platform.OS === 'android') {
      Notifications.setNotificationChannelAsync('default', {
        name: 'Default',
        importance: Notifications.AndroidImportance.MAX,
        vibrationPattern: [0, 250, 250, 250],
        lightColor: '#FF6B35', // Orange color for Bondfires
      })
    }
  }, [])
  
  return {
    expoPushToken,
    notification,
    error,
    registerForPushNotifications,
  }
}

// Helper to schedule a local notification (for testing)
export async function scheduleLocalNotification(
  title: string,
  body: string,
  data?: Record<string, unknown>,
  seconds: number = 1
) {
  await Notifications.scheduleNotificationAsync({
    content: {
      title,
      body,
      data,
    },
    trigger: {
      seconds,
      type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL,
    },
  })
}

// Helper to send push notification via Expo's push service (for server-side use)
export interface PushMessage {
  to: string // Expo push token
  title: string
  body: string
  data?: Record<string, unknown>
  sound?: 'default' | null
  badge?: number
}

export async function sendPushNotification(message: PushMessage) {
  const response = await fetch('https://exp.host/--/api/v2/push/send', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Accept-Encoding': 'gzip, deflate',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      to: message.to,
      sound: message.sound ?? 'default',
      title: message.title,
      body: message.body,
      data: message.data,
      badge: message.badge,
    }),
  })
  
  return response.json()
}


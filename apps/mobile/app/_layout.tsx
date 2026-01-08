import { useEffect, useCallback } from 'react'
import { useColorScheme } from 'react-native'
import { useFonts } from 'expo-font'
import { Stack, useRouter } from 'expo-router'
import * as SplashScreen from 'expo-splash-screen'
import { TamaguiProvider, Theme } from 'tamagui'
import { ConvexProvider, ConvexReactClient, useMutation } from 'convex/react'
import { ConvexAuthProvider } from '@convex-dev/auth/react'
import * as Notifications from 'expo-notifications'
import 'react-native-reanimated'

import config from '../tamagui.config'
import { usePushNotifications } from '@bondfires/app'
import { api } from '../../convex/_generated/api'

export {
  // Catch any errors thrown by the Layout component.
  ErrorBoundary,
} from 'expo-router'

export const unstable_settings = {
  // Ensure that reloading keeps proper navigation state
  initialRouteName: 'index',
}

// Prevent the splash screen from auto-hiding before asset loading is complete.
SplashScreen.preventAutoHideAsync()

// Initialize Convex client
const convex = new ConvexReactClient(process.env.EXPO_PUBLIC_CONVEX_URL as string)

function AppContent() {
  const colorScheme = useColorScheme()
  const router = useRouter()
  const registerDevice = useMutation(api.notifications.registerDevice)
  const unregisterDevice = useMutation(api.notifications.unregisterDevice)
  
  // Handle notification taps
  const handleNotificationResponse = useCallback(
    (response: Notifications.NotificationResponse) => {
      const data = response.notification.request.content.data
      
      // Navigate based on notification type
      if (data?.bondfireId) {
        router.push(`/(main)/bondfire/${data.bondfireId}`)
      } else if (data?.screen) {
        router.push(data.screen as any)
      }
    },
    [router]
  )
  
  // Initialize push notifications with Firebase
  const { fcmToken, isRegistered, error: pushError, requestPermissions } = usePushNotifications({
    registerTokenMutation: async (params: { token: string; tokenType: string; platform: string }) => {
      await registerDevice({
        token: params.token,
        platform: params.platform as 'ios' | 'android',
      })
    },
    unregisterTokenMutation: async (params: { token: string }) => {
      await unregisterDevice({ token: params.token })
    },
    onNotificationResponse: handleNotificationResponse,
    onNotificationReceived: (notification) => {
      console.log('Notification received in foreground:', notification.request.content.title)
    },
  })
  
  // Request permissions on mount
  useEffect(() => {
    requestPermissions()
  }, [requestPermissions])
  
  useEffect(() => {
    if (pushError) {
      console.warn('Push notification error:', pushError)
    }
    if (fcmToken && isRegistered) {
      console.log('FCM token registered:', fcmToken.substring(0, 20) + '...')
    }
  }, [fcmToken, isRegistered, pushError])
  
  return (
    <TamaguiProvider config={config} defaultTheme={colorScheme ?? 'dark'}>
      <Theme name={colorScheme ?? 'dark'}>
        <Stack screenOptions={{ headerShown: false }}>
          <Stack.Screen name="index" />
          <Stack.Screen name="(auth)" options={{ headerShown: false }} />
          <Stack.Screen name="(main)" options={{ headerShown: false }} />
        </Stack>
      </Theme>
    </TamaguiProvider>
  )
}

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts({
    Inter: require('@tamagui/font-inter/otf/Inter-Medium.otf'),
    InterBold: require('@tamagui/font-inter/otf/Inter-Bold.otf'),
  })

  useEffect(() => {
    if (fontError) throw fontError
  }, [fontError])

  useEffect(() => {
    if (fontsLoaded) {
      SplashScreen.hideAsync()
    }
  }, [fontsLoaded])

  if (!fontsLoaded) {
    return null
  }

  return (
    <ConvexProvider client={convex}>
      <ConvexAuthProvider client={convex}>
        <AppContent />
      </ConvexAuthProvider>
    </ConvexProvider>
  )
}

// Convex React Native polyfill - MUST be imported before any Convex imports
import '../polyfills/convex-react-native'

// Import config for TamaguiProvider
import config from '../tamagui.config'

import { ConvexAuthProvider } from '@convex-dev/auth/react'
import { ConvexProvider, ConvexReactClient, useMutation } from 'convex/react'
import { useFonts } from 'expo-font'
import type * as Notifications from 'expo-notifications'
import { Stack, useRouter } from 'expo-router'
import * as SplashScreen from 'expo-splash-screen'
import { useCallback, useEffect } from 'react'
import { useColorScheme } from 'react-native'
import { TamaguiProvider, Theme } from 'tamagui'
import 'react-native-reanimated'

import { mmkvStorage, usePushNotifications } from '@bondfires/app'
import type { RelativePathString } from 'expo-router/build/types'
import { api } from '../../../convex/_generated/api'

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
const convexUrl = process.env.EXPO_PUBLIC_CONVEX_URL
if (!convexUrl) {
  throw new Error(
    'EXPO_PUBLIC_CONVEX_URL is not set. Please create a .env.local file in the project root with EXPO_PUBLIC_CONVEX_URL=your-convex-url',
  )
}

// Validate URL format - Convex deployment URLs should end with .convex.cloud
if (convexUrl.endsWith('.convex.site')) {
  throw new Error(
    `Invalid Convex URL: ${convexUrl}\nConvex deployment URLs should end with .convex.cloud, not .convex.site\n.convex.site is used for HTTP Actions only. Please update your EXPO_PUBLIC_CONVEX_URL environment variable.`,
  )
}

// React Native requires unsavedChangesWarning: false to disable browser-specific APIs
// See: https://docs.convex.dev/quickstart/react-native
const convex = new ConvexReactClient(convexUrl, {
  unsavedChangesWarning: false,
})

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
        router.push(data.screen as RelativePathString)
      }
    },
    [router],
  )

  // Initialize push notifications with Expo
  const { error: pushError, requestPermissions } = usePushNotifications({
    registerTokenMutation: async (params: {
      token: string
      tokenType: string
      platform: string
    }) => {
      await registerDevice({
        token: params.token,
        platform: params.platform as 'ios' | 'android',
      })
    },
    unregisterTokenMutation: async (params: { token: string }) => {
      await unregisterDevice({ token: params.token })
    },
    onNotificationResponse: handleNotificationResponse,
    onNotificationReceived: (_notification) => {
      // Notification received in foreground - could show in-app alert here
    },
  })

  // Request permissions on mount
  useEffect(() => {
    requestPermissions()
  }, [requestPermissions])

  useEffect(() => {
    if (pushError) {
      // Only log push notification errors in production - emulator errors are expected
      const isEmulatorError =
        typeof pushError === 'string' && pushError.includes('physical devices')
      if (!__DEV__ || !isEmulatorError) {
        console.error('Push notification error:', pushError)
      }
    }
  }, [pushError])

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
      <ConvexAuthProvider client={convex} storage={mmkvStorage}>
        <AppContent />
      </ConvexAuthProvider>
    </ConvexProvider>
  )
}

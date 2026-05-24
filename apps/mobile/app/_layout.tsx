// Convex React Native polyfill - MUST be imported before any Convex imports
import '../polyfills/convex-react-native'

import { Button, Text } from '@bondfires/ui'
import { ConvexAuthProvider } from '@convex-dev/auth/react'
import { ConvexReactClient, useMutation } from 'convex/react'
import { useFonts } from 'expo-font'
import type * as Notifications from 'expo-notifications'
import { Stack, useRouter } from 'expo-router'
import * as SplashScreen from 'expo-splash-screen'
import { Component, type ErrorInfo, type ReactNode, useCallback, useEffect, useRef } from 'react'
import { useColorScheme } from 'react-native'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { TamaguiProvider, Theme, YStack } from 'tamagui'
// Import config for TamaguiProvider
import config from '../tamagui.config'
import 'react-native-reanimated'

import { appStore$, mmkvStorage, usePushNotifications } from '@bondfires/app'
import { bondfireColors } from '@bondfires/config'
import { useObserve } from '@legendapp/state/react'
import type { RelativePathString } from 'expo-router/build/types'
import { api } from '../../../convex/_generated/api'

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

// A trailing slash causes Convex's WebSocket URL builder to produce a double-slash path
// (e.g. wss://host//api/0/sync) which fails silently and keeps all queries in undefined state forever.
if (convexUrl.endsWith('/')) {
  throw new Error(
    `Invalid Convex URL: ${convexUrl}\nThe URL must not have a trailing slash. Remove the trailing "/" from EXPO_PUBLIC_CONVEX_URL.`,
  )
}

// React Native requires unsavedChangesWarning: false to disable browser-specific APIs
// See: https://docs.convex.dev/quickstart/react-native
const convex = new ConvexReactClient(convexUrl, {
  unsavedChangesWarning: false,
})

// Props for the error fallback component
interface ErrorFallbackProps {
  error: Error
  retry: () => void
}

function ErrorFallback({ error, retry }: ErrorFallbackProps) {
  return (
    <YStack
      flex={1}
      backgroundColor={bondfireColors.obsidian}
      alignItems="center"
      justifyContent="center"
      paddingHorizontal={24}
      gap={16}
    >
      <Text fontSize={28} fontWeight="700" color={bondfireColors.whiteSmoke} textAlign="center">
        Something went wrong
      </Text>
      <Text fontSize={14} color={bondfireColors.ash} textAlign="center">
        {error.message}
      </Text>
      <Button variant="primary" onPress={retry}>
        Retry
      </Button>
    </YStack>
  )
}

// Custom ErrorBoundary that wraps AppContent.
// Catches errors from routes and renders a fallback UI.
// ErrorFallback doesn't use Convex hooks, so we only need TamaguiProvider here.
class LayoutErrorBoundary extends Component<
  { children: ReactNode },
  { hasError: boolean; error: Error | null }
> {
  constructor(props: { children: ReactNode }) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('RootLayout error boundary caught:', error, errorInfo)
  }

  handleRetry = () => {
    this.setState({ hasError: false, error: null })
  }

  render() {
    if (this.state.hasError && this.state.error) {
      return (
        <TamaguiProvider config={config} defaultTheme="dark">
          <Theme name="dark">
            <ErrorFallback error={this.state.error} retry={this.handleRetry} />
          </Theme>
        </TamaguiProvider>
      )
    }
    return this.props.children
  }
}

// Override expo-router's default ErrorBoundary.
// expo-router renders this in place of the route component when an error occurs.
// ErrorFallback doesn't use Convex hooks, so no ConvexProvider needed here.
export function ErrorBoundary(props: { error: Error; retry: () => void }) {
  return (
    <TamaguiProvider config={config} defaultTheme="dark">
      <Theme name="dark">
        <ErrorFallback error={props.error} retry={props.retry} />
      </Theme>
    </TamaguiProvider>
  )
}

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
  const {
    error: pushError,
    requestPermissions,
    unregister,
  } = usePushNotifications({
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

  // Observe notifications preference and register/unregister accordingly.
  // We use refs to avoid stale closure captures — useObserve binds callbacks
  // at mount time, so mutation functions from subsequent renders aren't seen.
  const registerDeviceRef = useRef(registerDevice)
  registerDeviceRef.current = registerDevice
  const unregisterDeviceRef = useRef(unregisterDevice)
  unregisterDeviceRef.current = unregisterDevice
  const requestPermissionsRef = useRef(requestPermissions)
  requestPermissionsRef.current = requestPermissions
  const unregisterRef = useRef(unregister)
  unregisterRef.current = unregister
  const handleNotificationResponseRef = useRef(handleNotificationResponse)
  handleNotificationResponseRef.current = handleNotificationResponse

  useObserve(appStore$.preferences.notificationsEnabled, ({ value: notificationsEnabled }) => {
    if (notificationsEnabled) {
      requestPermissionsRef.current()
    } else {
      unregisterRef.current()
    }
  })

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
    <ConvexAuthProvider client={convex} storage={mmkvStorage}>
      <SafeAreaProvider>
        <LayoutErrorBoundary>
          <AppContent />
        </LayoutErrorBoundary>
      </SafeAreaProvider>
    </ConvexAuthProvider>
  )
}

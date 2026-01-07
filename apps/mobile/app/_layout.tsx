import { useEffect, useCallback } from 'react'
import { useColorScheme } from 'react-native'
import { useFonts } from 'expo-font'
import { Stack } from 'expo-router'
import * as SplashScreen from 'expo-splash-screen'
import { TamaguiProvider, Theme } from 'tamagui'
import { ConvexProvider, ConvexReactClient, useMutation } from 'convex/react'
import { ConvexAuthProvider } from '@convex-dev/auth/react'
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
  const registerDevice = useMutation(api.notifications.registerDevice)
  
  // Handle push notification token registration
  const handleRegisterToken = useCallback(async (token: string, platform: 'ios' | 'android') => {
    try {
      await registerDevice({ token, platform })
      console.log('Device registered for push notifications')
    } catch (error) {
      console.error('Failed to register device:', error)
    }
  }, [registerDevice])
  
  // Initialize push notifications
  const { expoPushToken, error: pushError } = usePushNotifications(handleRegisterToken)
  
  useEffect(() => {
    if (pushError) {
      console.warn('Push notification error:', pushError)
    }
    if (expoPushToken) {
      console.log('Expo push token:', expoPushToken)
    }
  }, [expoPushToken, pushError])
  
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

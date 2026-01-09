import { appStore$ } from '@bondfires/app'
import { useValue } from '@legendapp/state/react'
import { Redirect } from 'expo-router'
import { Spinner, Text, YStack } from 'tamagui'

export default function SplashScreen() {
  const isAuthenticated = useValue(appStore$.isAuthenticated)
  const hasSeenOnboarding = useValue(appStore$.hasSeenOnboarding)

  // Show loading state while checking auth
  const isLoading = false // Will be replaced with actual auth check

  if (isLoading) {
    return (
      <YStack flex={1} alignItems="center" justifyContent="center" backgroundColor="$background">
        <Spinner size="large" color="$orange10" />
        <Text marginTop="$4" color="$gray11">
          Loading...
        </Text>
      </YStack>
    )
  }

  // Route based on auth state
  if (!isAuthenticated) {
    // Check if they've seen onboarding
    if (!hasSeenOnboarding) {
      return <Redirect href="/(auth)/onboarding" />
    }
    return <Redirect href="/(auth)/login" />
  }

  // User is authenticated, go to main app
  return <Redirect href="/(main)/feed" />
}

import { appActions, appStore$ } from '@bondfires/app'
import { bondfireColors } from '@bondfires/config'
import { useValue } from '@legendapp/state/react'
import { useQuery } from 'convex/react'
import { Redirect } from 'expo-router'
import { useEffect } from 'react'
import { Spinner, Text, YStack } from 'tamagui'
import { api } from '../../../convex/_generated/api'

export default function SplashScreen() {
  const hasSeenOnboarding = useValue(appStore$.hasSeenOnboarding)
  // Use Convex Auth's actual session state instead of app store
  const currentUser = useQuery(api.users.current)

  // Sync app store with Convex Auth session state
  useEffect(() => {
    if (currentUser !== undefined) {
      if (currentUser) {
        appActions.setAuth(currentUser._id)
      } else {
        appActions.logout()
      }
    }
  }, [currentUser])

  // Show loading state while checking auth (currentUser is undefined while loading)
  if (currentUser === undefined) {
    return (
      <YStack
        flex={1}
        alignItems="center"
        justifyContent="center"
        backgroundColor={bondfireColors.obsidian}
      >
        <Spinner size="large" color={bondfireColors.bondfireCopper} />
        <Text marginTop="$4" color={bondfireColors.ash}>
          Loading...
        </Text>
      </YStack>
    )
  }

  // Route based on auth state
  if (!currentUser) {
    // Check if they've seen onboarding
    if (!hasSeenOnboarding) {
      return <Redirect href="/(auth)/onboarding" />
    }
    return <Redirect href="/(auth)/login" />
  }

  // User is authenticated, go to main app
  return <Redirect href="/(main)/feed" />
}

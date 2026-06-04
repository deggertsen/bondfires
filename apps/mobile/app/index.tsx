import { appActions, appStore$, getLastLocation, telemetry } from '@bondfires/app'
import { bondfireColors } from '@bondfires/config'
import { useValue } from '@legendapp/state/react'
import { useQuery } from 'convex/react'
import { Redirect } from 'expo-router'
import { useEffect, useRef } from 'react'
import { Spinner, Text, YStack } from 'tamagui'
import { api } from '../../../convex/_generated/api'
import { routes } from '../lib/routes'

/** Threshold (ms) after which an unresolved query is considered "slow". */
const SLOW_QUERY_THRESHOLD_MS = 3000

export default function SplashScreen() {
  const hasSeenOnboarding = useValue(appStore$.hasSeenOnboarding)
  // Use Convex Auth's actual session state instead of app store
  const currentUser = useQuery(api.users.current)

  // Slow-query detection: if `currentUser` stays undefined for >3s, log a warning
  const queryStartTime = useRef(Date.now())
  const slowQueryLogged = useRef(false)

  useEffect(() => {
    if (currentUser !== undefined) {
      // Auth resolved — notify telemetry and sync user ID
      const elapsed = Date.now() - queryStartTime.current
      telemetry.breadcrumb('auth:resolved', {
        hasUser: !!currentUser,
        elapsedMs: elapsed,
      })

      if (currentUser) {
        appActions.setAuth(currentUser._id)
        telemetry.setUserId(currentUser._id)
      } else {
        appActions.logout()
        telemetry.setUserId(null)
      }
    } else if (!slowQueryLogged.current) {
      // Still loading — start a timer for slow-query warning
      const timer = setTimeout(() => {
        if (!slowQueryLogged.current) {
          slowQueryLogged.current = true
          const elapsed = Date.now() - queryStartTime.current
          telemetry.warn('query:slow', 'users.current not resolved', { elapsedMs: elapsed })
        }
      }, SLOW_QUERY_THRESHOLD_MS)
      return () => clearTimeout(timer)
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
      telemetry.breadcrumb('route:auth', { screen: 'onboarding' })
      return <Redirect href={routes.onboarding} />
    }
    telemetry.breadcrumb('route:auth', { screen: 'login' })
    return <Redirect href={routes.login()} />
  }

  // User is authenticated, go to main app
  telemetry.breadcrumb('route:main')
  const lastLocation = getLastLocation()
  if (lastLocation?.type === 'bondfire' && lastLocation.bondfireId) {
    return <Redirect href={routes.bondfire(lastLocation.bondfireId)} />
  }
  return <Redirect href={routes.feed} />
}

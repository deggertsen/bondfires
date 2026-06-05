import { appActions, appStore$, getLastLocation, telemetry } from '@bondfires/app'
import { bondfireColors } from '@bondfires/config'
import { useValue } from '@legendapp/state/react'
import { AlertTriangle, RefreshCw } from '@tamagui/lucide-icons'
import { useQuery } from 'convex/react'
import { Redirect } from 'expo-router'
import { useEffect, useRef, useState } from 'react'
import { Pressable } from 'react-native'
import { Spinner, Text, YStack } from 'tamagui'
import { api } from '../../../convex/_generated/api'
import { routes } from '../lib/routes'

/** Threshold (ms) after which an unresolved query is considered "slow". */
const SLOW_QUERY_THRESHOLD_MS = 3000

/**
 * Hard timeout (ms) after which we give up and show a retry screen.
 * This handles the case where the WebSocket dies and queries never resolve.
 */
const LOADING_TIMEOUT_MS = 15_000

export default function SplashScreen() {
  const hasSeenOnboarding = useValue(appStore$.hasSeenOnboarding)
  // Use Convex Auth's actual session state instead of app store
  const currentUser = useQuery(api.users.current)

  // Slow-query detection: if `currentUser` stays undefined for >3s, log a warning
  const queryStartTime = useRef(Date.now())
  const slowQueryLogged = useRef(false)

  // Hard timeout: if still loading after 15s, show retry UI
  const [timedOut, setTimedOut] = useState(false)

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

      // Clear timeout if resolved
      setTimedOut(false)
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

  // Hard timeout effect — separate from the slow-query timer
  useEffect(() => {
    if (currentUser !== undefined) {
      // Already resolved, no timeout needed
      return
    }

    const timer = setTimeout(() => {
      const elapsed = Date.now() - queryStartTime.current
      telemetry.error('loading:timeout', 'Loading screen timed out', { elapsedMs: elapsed })
      setTimedOut(true)
    }, LOADING_TIMEOUT_MS)

    return () => clearTimeout(timer)
  }, [currentUser])

  // Show loading state while checking auth (currentUser is undefined while loading)
  if (currentUser === undefined) {
    if (timedOut) {
      // Show retry screen instead of infinite spinner
      return (
        <YStack
          flex={1}
          alignItems="center"
          justifyContent="center"
          backgroundColor={bondfireColors.obsidian}
          padding="$6"
          gap="$4"
        >
          <AlertTriangle size={48} color={bondfireColors.bondfireCopper} />
          <Text fontSize="$6" fontWeight="700" color={bondfireColors.ash} textAlign="center">
            Connection Issue
          </Text>
          <Text fontSize="$4" color={bondfireColors.ash} opacity={0.7} textAlign="center">
            We're having trouble connecting. Check your internet connection and try again.
          </Text>
          <Pressable
            onPress={() => {
              telemetry.breadcrumb('loading:retry')
              setTimedOut(false)
              queryStartTime.current = Date.now()
              slowQueryLogged.current = false
            }}
          >
            <YStack
              flexDirection="row"
              alignItems="center"
              gap="$2"
              backgroundColor={bondfireColors.bondfireCopper}
              paddingHorizontal="$5"
              paddingVertical="$3"
              borderRadius="$4"
            >
              <RefreshCw size={18} color={bondfireColors.obsidian} />
              <Text fontSize="$4" fontWeight="600" color={bondfireColors.obsidian}>
                Try Again
              </Text>
            </YStack>
          </Pressable>
        </YStack>
      )
    }

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

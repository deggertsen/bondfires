import { appActions, appStore$, getLastLocation, telemetry } from '@bondfires/app'
import { Spinner } from '@bondfires/ui'
import { useValue } from '@legendapp/state/react'
import { AlertTriangle, RefreshCw } from '@tamagui/lucide-icons'
import { useConvex, useQuery } from 'convex/react'
import { Redirect, useLocalSearchParams } from 'expo-router'
import { useEffect, useRef, useState } from 'react'
import { Pressable } from 'react-native'
import { Text, YStack } from 'tamagui'
import { api } from '../../../convex/_generated/api'
import { resolveAuthRedirect, routes } from '../lib/routes'

/** Threshold (ms) after which an unresolved query is considered "slow". */
const SLOW_QUERY_THRESHOLD_MS = 3000

/**
 * Hard timeout (ms) after which we give up and show a retry screen.
 * This handles the case where the WebSocket dies and queries never resolve.
 */
const LOADING_TIMEOUT_MS = 15_000

type ReconnectableWebSocketManager = {
  socketState?: () => unknown
  tryReconnectImmediately?: () => void
  closeAndReconnect?: (reason: string) => void
}

type ConvexInternalSync = {
  sync?: { webSocketManager?: ReconnectableWebSocketManager }
  cachedSync?: { webSocketManager?: ReconnectableWebSocketManager }
}

/**
 * Force the Convex WebSocket to reconnect. The two internal WebSocketManager
 * methods are complementary and each no-ops outside its own socket state:
 * - "disconnected" (waiting on a backoff timer): tryReconnectImmediately()
 *   cancels the timer and dials now — closeAndReconnect() would no-op here
 * - "connecting" (DNS/TCP hanging) or "ready": closeAndReconnect() tears the
 *   socket down and reconnects — tryReconnectImmediately() would no-op here
 *
 * The TS types mark webSocketManager as private, but it's accessible at
 * runtime. This is a known workaround pattern for Convex RN apps. The
 * telemetry warns exist so the daily audit notices if a convex upgrade
 * renames these internals.
 */
function forceConvexReconnect(convex: ReturnType<typeof useConvex>) {
  try {
    const internalConvex = convex as unknown as ConvexInternalSync
    const sync = internalConvex.sync ?? internalConvex.cachedSync
    const wsm = sync?.webSocketManager
    if (!wsm) {
      telemetry.warn('loading:reconnect', 'Convex webSocketManager not found', {
        hasSync: !!sync,
      })
      return false
    }
    const socketState = typeof wsm.socketState === 'function' ? wsm.socketState() : undefined
    if (socketState === 'disconnected' && typeof wsm.tryReconnectImmediately === 'function') {
      wsm.tryReconnectImmediately()
      return true
    }
    if (typeof wsm.closeAndReconnect === 'function') {
      wsm.closeAndReconnect('client')
      return true
    }
    telemetry.warn('loading:reconnect', 'Convex reconnect methods not found', { socketState })
  } catch (e) {
    telemetry.warn('loading:reconnect', `Failed to force reconnect: ${String(e)}`)
  }
  return false
}

export default function SplashScreen() {
  const hasSeenOnboarding = useValue(appStore$.hasSeenOnboarding)
  const { redirectTo } = useLocalSearchParams<{ redirectTo?: string }>()
  // Use Convex Auth's actual session state instead of app store
  const currentUser = useQuery(api.users.current)
  const convex = useConvex()

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
        appActions.setAuthReady(true)
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
          // Read connection state imperatively at fire time — subscribing via
          // useConvexConnectionState would put an ever-changing object in this
          // effect's deps and reset the timer on every reconnect attempt.
          const connectionState = convex.connectionState()
          telemetry.warn('query:slow', 'users.current not resolved', {
            elapsedMs: elapsed,
            isWebSocketConnected: connectionState.isWebSocketConnected,
            hasEverConnected: connectionState.hasEverConnected,
          })

          // Early nudge: if the WebSocket hasn't connected yet after 3s,
          // try to force a reconnect. This catches the case where the socket
          // is stuck in "connecting" and the user would otherwise wait the
          // full 15s timeout.
          if (!connectionState.isWebSocketConnected) {
            forceConvexReconnect(convex)
          }
        }
      }, SLOW_QUERY_THRESHOLD_MS)
      return () => clearTimeout(timer)
    }
  }, [currentUser, convex])

  // Hard timeout effect — separate from the slow-query timer
  useEffect(() => {
    if (currentUser !== undefined) {
      // Already resolved, no timeout needed
      return
    }

    const timer = setTimeout(() => {
      const elapsed = Date.now() - queryStartTime.current
      // Imperative read at fire time (see slow-query timer above).
      const connectionState = convex.connectionState()
      const wsConnected = connectionState.isWebSocketConnected

      telemetry.error('loading:timeout', 'Loading screen timed out', {
        elapsedMs: elapsed,
        isWebSocketConnected: wsConnected,
        hasEverConnected: connectionState.hasEverConnected,
        connectionCount: connectionState.connectionCount,
        connectionRetries: connectionState.connectionRetries,
      })

      // Auto-attempt a reconnect before showing the retry screen.
      // If the socket is stuck in "connecting" or dead on a backoff timer,
      // this forces it to close and reconnect immediately. If the network
      // is truly down, the reconnect will fail and we fall through to the
      // retry UI — no harm done.
      if (!wsConnected) {
        forceConvexReconnect(convex)
      }

      setTimedOut(true)
    }, LOADING_TIMEOUT_MS)

    return () => clearTimeout(timer)
  }, [currentUser, convex])

  // Show loading state while checking auth (currentUser is undefined while loading)
  if (currentUser === undefined) {
    if (timedOut) {
      // Show retry screen instead of infinite spinner
      return (
        <YStack
          flex={1}
          alignItems="center"
          justifyContent="center"
          backgroundColor={'$background'}
          padding="$6"
          gap="$4"
        >
          <AlertTriangle size={48} color={'$primary'} />
          <Text fontSize="$6" fontWeight="700" color={'$placeholderColor'} textAlign="center">
            Connection Issue
          </Text>
          <Text fontSize="$4" color={'$placeholderColor'} opacity={0.7} textAlign="center">
            We're having trouble connecting. Check your internet connection and try again.
          </Text>
          <Pressable
            onPress={() => {
              const connectionState = convex.connectionState()
              telemetry.breadcrumb('loading:retry', {
                wsConnected: connectionState.isWebSocketConnected,
                hasEverConnected: connectionState.hasEverConnected,
              })
              // Force the Convex WebSocket to reconnect — without this,
              // the retry just resets timers but the underlying socket
              // is still dead, so it times out again.
              forceConvexReconnect(convex)
              setTimedOut(false)
              queryStartTime.current = Date.now()
              slowQueryLogged.current = false
            }}
          >
            <YStack
              flexDirection="row"
              alignItems="center"
              gap="$2"
              backgroundColor={'$primary'}
              paddingHorizontal="$5"
              paddingVertical="$3"
              borderRadius="$4"
            >
              <RefreshCw size={18} color={'$background'} />
              <Text fontSize="$4" fontWeight="600" color={'$background'}>
                Try Again
              </Text>
            </YStack>
          </Pressable>
        </YStack>
      )
    }

    return (
      <YStack flex={1} alignItems="center" justifyContent="center" backgroundColor={'$background'}>
        <Spinner size="large" color={'$primary'} />
        <Text marginTop="$4" color={'$placeholderColor'}>
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
    return <Redirect href={routes.login(redirectTo)} />
  }

  // User is authenticated, go to main app
  telemetry.breadcrumb('route:main')
  if (redirectTo) {
    return <Redirect href={resolveAuthRedirect(redirectTo)} />
  }

  const lastLocation = getLastLocation()
  if (lastLocation?.type === 'bondfire' && lastLocation.bondfireId) {
    return <Redirect href={routes.bondfire(lastLocation.bondfireId)} />
  }
  return <Redirect href={routes.feed} />
}

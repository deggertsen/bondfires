// Convex React Native polyfill - MUST be imported before any Convex imports
import '../polyfills/convex-react-native'

import { useForceUpdate } from '@bondfires/app'
import { Button, ForceUpdateModal, Text, ToastContainer } from '@bondfires/ui'
import { ConvexAuthProvider } from '@convex-dev/auth/react'
import { ConvexReactClient, useMutation } from 'convex/react'
import Constants from 'expo-constants'
import { useFonts } from 'expo-font'
import type * as Notifications from 'expo-notifications'
import { Stack, useRouter } from 'expo-router'
import * as SplashScreen from 'expo-splash-screen'
import {
  Component,
  type ErrorInfo,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react'
import { type AppStateStatus, AppState as RNAppState } from 'react-native'
import { KeyboardProvider } from 'react-native-keyboard-controller'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { AnimatePresence, TamaguiProvider, Theme, YStack } from 'tamagui'
// Import config for TamaguiProvider
import config from '../tamagui.config'
import 'react-native-reanimated'

import {
  type AppThemeName,
  appStore$,
  appThemeColors,
  mmkvStorage,
  setPushPermissionRequester,
  telemetry,
  toastActions,
  toastStore$,
  useAppTheme,
  usePushNotifications,
} from '@bondfires/app'
import { useObserve, useValue } from '@legendapp/state/react'
import { api } from '../../../convex/_generated/api'
import { resolveExternalRoute, routes } from '../lib/routes'

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
    'EXPO_PUBLIC_CONVEX_URL is not set. Please create apps/mobile/.env.local with EXPO_PUBLIC_CONVEX_URL=<your-convex-url> (copy CONVEX_URL from repo-root .env.local)',
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

// Monitor Convex WebSocket connection state for debugging
convex.subscribeToConnectionState((state) => {
  if (!state.isWebSocketConnected) {
    telemetry.warn('convex:connection', 'WebSocket disconnected', {
      hasInflightRequests: state.hasInflightRequests,
    })
  }
})

// ---------------------------------------------------------------------------
// Telemetry initializer — runs inside Convex context
// ---------------------------------------------------------------------------

function TelemetryInitializer() {
  const mutationCreate = useMutation(api.clientLogs.create)
  const mutationCreateBatch = useMutation(api.clientLogs.createBatch)

  useEffect(() => {
    telemetry.init({
      create: (args: unknown) => mutationCreate(args as Parameters<typeof mutationCreate>[0]),
      createBatch: (args: unknown) =>
        mutationCreateBatch(args as Parameters<typeof mutationCreateBatch>[0]),
    })

    // Wire error-level telemetry events to the toast system
    telemetry.onErrorToast((message, referenceId) => {
      toastActions.addToast('error', message, referenceId)
    })
  }, [mutationCreate, mutationCreateBatch])

  return null
}

// ---------------------------------------------------------------------------
// Error fallback
// ---------------------------------------------------------------------------

// Props for the error fallback component
interface ErrorFallbackProps {
  error: Error
  retry: () => void
}

function ErrorFallback({ error, retry }: ErrorFallbackProps) {
  return (
    <YStack
      flex={1}
      backgroundColor="$background"
      alignItems="center"
      justifyContent="center"
      paddingHorizontal={24}
      gap={16}
    >
      <Text fontSize={28} fontWeight="700" color="$color" textAlign="center">
        Something went wrong
      </Text>
      <Text fontSize={14} color="$colorPress" textAlign="center">
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
    telemetry.error('error:boundary', error.message ?? 'Unknown error boundary error', {
      stack: error.stack,
      componentStack: errorInfo.componentStack,
    })
  }

  handleRetry = () => {
    this.setState({ hasError: false, error: null })
  }

  render() {
    if (this.state.hasError && this.state.error) {
      return (
        <TamaguiProvider config={config}>
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
export function ErrorBoundary(props: { error: Error; retry: () => void }) {
  return (
    <TamaguiProvider config={config}>
      <Theme name="dark">
        <ErrorFallback error={props.error} retry={props.retry} />
      </Theme>
    </TamaguiProvider>
  )
}

// ---------------------------------------------------------------------------
// Theme transition — crossfade overlay (avoids remounting navigators)
// ---------------------------------------------------------------------------

function ThemeTransitionOverlay({ themeName }: { themeName: AppThemeName }) {
  const previousThemeRef = useRef(themeName)
  const [fadingTheme, setFadingTheme] = useState<AppThemeName | null>(null)

  useEffect(() => {
    if (previousThemeRef.current === themeName) return
    setFadingTheme(previousThemeRef.current)
    previousThemeRef.current = themeName
  }, [themeName])

  useEffect(() => {
    if (fadingTheme === null) return
    const frame = requestAnimationFrame(() => {
      setFadingTheme(null)
    })
    return () => cancelAnimationFrame(frame)
  }, [fadingTheme])

  return (
    <AnimatePresence>
      {fadingTheme !== null && (
        <YStack
          key={fadingTheme}
          position="absolute"
          top={0}
          left={0}
          right={0}
          bottom={0}
          pointerEvents="none"
          zIndex={999999}
          backgroundColor={appThemeColors[fadingTheme].background}
          animation="themeCrossfade"
          enterStyle={{ opacity: 1 }}
          exitStyle={{ opacity: 0 }}
          opacity={1}
        />
      )}
    </AnimatePresence>
  )
}

// ---------------------------------------------------------------------------
// App Content
// ---------------------------------------------------------------------------

function AppContent() {
  const { themeName } = useAppTheme()
  const router = useRouter()
  const toasts = useValue(toastStore$.toasts)
  const isAuthenticated = useValue(appStore$.isAuthenticated)
  const registerDevice = useMutation(api.notifications.registerDevice)
  const unregisterDevice = useMutation(api.notifications.unregisterDevice)
  const recordActive = useMutation(api.users.recordActive)

  // App-open heartbeat — powers the 72h nudge kill switch (convex/digest.ts).
  // Throttled so foreground flapping doesn't spam mutations.
  const lastHeartbeatRef = useRef(0)
  const recordActiveRef = useRef(recordActive)
  recordActiveRef.current = recordActive
  const sendHeartbeat = useCallback(() => {
    if (!appStore$.isAuthenticated.peek()) return
    const now = Date.now()
    if (now - lastHeartbeatRef.current < 30 * 60 * 1000) return
    lastHeartbeatRef.current = now
    recordActiveRef.current().catch(() => {
      // Best-effort: allow retry on the next foreground.
      lastHeartbeatRef.current = 0
    })
  }, [])

  useEffect(() => {
    sendHeartbeat()
    const subscription = RNAppState.addEventListener('change', (state: AppStateStatus) => {
      if (state === 'active') sendHeartbeat()
    })
    return () => subscription.remove()
  }, [sendHeartbeat])

  // Force-update check: compares current version against remote minAppVersion.
  // On Android with flexible priority, downloads in background via Play Core.
  const {
    loading: updateCheckLoading,
    updateRequired,
    downloading,
    updateReady,
    minRequiredVersion,
    updatePriority,
    startUpdate,
  } = useForceUpdate()

  // Handle notification taps
  const handleNotificationResponse = useCallback(
    (response: Notifications.NotificationResponse) => {
      const data = response.notification.request.content.data

      // Navigate based on notification type. Notification payloads are untrusted,
      // so resolve `screen` against an allowlist instead of casting it to a route.
      if (data?.bondfireId) {
        router.push(routes.bondfire(String(data.bondfireId)))
      } else if (typeof data?.screen === 'string') {
        const target = resolveExternalRoute(data.screen)
        if (target) router.push(target)
      } else if (data?.type === 'digest' || data?.type === 'nudge') {
        // Multi-item digest/nudge has no single target — land on the feed.
        router.push(routes.feed)
      }
    },
    [router],
  )

  // Initialize push notifications with Expo
  const {
    error: pushError,
    requestPermissions,
    registerIfGranted,
    unregister,
  } = usePushNotifications({
    isAuthenticated,
    registerTokenMutation: async (params: {
      token: string
      tokenType: string
      platform: string
      timezone?: string
    }) => {
      await registerDevice({
        token: params.token,
        platform: params.platform as 'ios' | 'android',
        timezone: params.timezone,
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
  const registerDeviceRef = useRef(registerDevice)
  registerDeviceRef.current = registerDevice
  const unregisterDeviceRef = useRef(unregisterDevice)
  unregisterDeviceRef.current = unregisterDevice
  const requestPermissionsRef = useRef(requestPermissions)
  requestPermissionsRef.current = requestPermissions
  const registerIfGrantedRef = useRef(registerIfGranted)
  registerIfGrantedRef.current = registerIfGranted
  const unregisterRef = useRef(unregister)
  unregisterRef.current = unregister
  const handleNotificationResponseRef = useRef(handleNotificationResponse)
  handleNotificationResponseRef.current = handleNotificationResponse

  // Expose the OS permission dialog to feature screens (push pre-prompt,
  // settings toggle). The dialog is one-shot on iOS, so it only ever fires
  // from explicit user intent — never automatically here.
  useEffect(() => {
    setPushPermissionRequester(() => requestPermissionsRef.current())
    return () => setPushPermissionRequester(null)
  }, [])

  useObserve(appStore$.preferences.notificationsEnabled, ({ value: notificationsEnabled }) => {
    if (!appStore$.isAuthenticated.peek()) return
    if (notificationsEnabled) {
      // Silent: registers only when OS permission is already granted.
      // The OS dialog is triggered contextually (PushPrimerSheet) or from
      // the settings toggle, not here.
      registerIfGrantedRef.current()
    } else {
      unregisterRef.current()
    }
  })

  // When the user signs in, register the device silently if notifications
  // are enabled and OS permission was already granted. Never prompt here.
  useObserve(appStore$.isAuthenticated, ({ value: isAuthenticated }) => {
    if (isAuthenticated && appStore$.preferences.notificationsEnabled.peek()) {
      registerIfGrantedRef.current()
    }
    if (isAuthenticated) {
      // The mount-time heartbeat may have fired pre-auth and no-opped.
      sendHeartbeat()
    }
  })

  useEffect(() => {
    if (pushError) {
      const isEmulatorError =
        typeof pushError === 'string' && pushError.includes('physical devices')
      if (!__DEV__ || !isEmulatorError) {
        telemetry.warn('push:error', String(pushError), { isEmulatorError })
      }
    }
  }, [pushError])

  return (
    <TamaguiProvider config={config} defaultTheme={themeName}>
      <Theme name={themeName}>
        <YStack flex={1}>
          <TelemetryInitializer />

          {/* Force-update gate — shown when app version is below minimum required.
              Supports flexible (background download) on Android and immediate on iOS. */}
          {updateRequired && minRequiredVersion ? (
            <ForceUpdateModal
              visible
              minRequiredVersion={minRequiredVersion}
              currentVersion={Constants.expoConfig?.version ?? '0.0.0'}
              updatePriority={updatePriority}
              downloading={downloading}
              updateReady={updateReady}
              onStartUpdate={startUpdate}
            />
          ) : updateCheckLoading ? null : null}

          <Stack screenOptions={{ headerShown: false }}>
            <Stack.Screen name="index" />
            <Stack.Screen name="(auth)" options={{ headerShown: false }} />
            <Stack.Screen name="(main)" options={{ headerShown: false }} />
          </Stack>
          <ToastContainer toasts={toasts} onDismiss={toastActions.dismiss} />
          <ThemeTransitionOverlay themeName={themeName} />
        </YStack>
      </Theme>
    </TamaguiProvider>
  )
}

// ---------------------------------------------------------------------------
// Root Layout
// ---------------------------------------------------------------------------

export default function RootLayout() {
  // Breadcrumb: app:init — fires once on mount
  useEffect(() => {
    telemetry.breadcrumb('app:init')
  }, [])

  const [fontsLoaded, fontError] = useFonts({
    Inter: require('@tamagui/font-inter/otf/Inter-Medium.otf'),
    InterBold: require('@tamagui/font-inter/otf/Inter-Bold.otf'),
  })

  // Breadcrumb: fonts:loaded — fires once on successful load
  useEffect(() => {
    if (fontsLoaded) {
      telemetry.breadcrumb('fonts:loaded', { fontError: !!fontError })
    }
  }, [fontsLoaded, fontError])

  // Breadcrumb: splash:hidden — fires once on splash hide
  useEffect(() => {
    if (fontsLoaded) {
      SplashScreen.hideAsync().then(() => {
        telemetry.breadcrumb('splash:hidden')
      })
    }
  }, [fontsLoaded])

  useEffect(() => {
    if (fontError) throw fontError
  }, [fontError])

  if (!fontsLoaded) {
    return null
  }

  return (
    <ConvexAuthProvider client={convex} storage={mmkvStorage}>
      <SafeAreaProvider>
        <KeyboardProvider>
          <LayoutErrorBoundary>
            <AppContent />
          </LayoutErrorBoundary>
        </KeyboardProvider>
      </SafeAreaProvider>
    </ConvexAuthProvider>
  )
}

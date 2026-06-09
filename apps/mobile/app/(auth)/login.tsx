import { telemetry, useSystemThemeColors } from '@bondfires/app'
import { Button, Input, Text } from '@bondfires/ui'
import { useAuthActions } from '@convex-dev/auth/react'
import { useObservable, useValue } from '@legendapp/state/react'
import { Flame } from '@tamagui/lucide-icons'
import { useQuery } from 'convex/react'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { useEffect, useRef } from 'react'
import { StatusBar } from 'react-native'
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller'
import { Spinner, YStack } from 'tamagui'
import { api } from '../../../../convex/_generated/api'
import { resolveAuthRedirect, routes } from '../../lib/routes'

export default function LoginScreen() {
  const { colors, statusBarStyle } = useSystemThemeColors()
  const router = useRouter()
  const { redirectTo } = useLocalSearchParams<{ redirectTo?: string }>()
  const { signIn } = useAuthActions()
  const currentUser = useQuery(api.users.current)

  const form$ = useObservable({
    email: '',
    password: '',
    isLoading: false,
    error: null as string | null,
    pendingNavigation: false,
  })

  const email = useValue(form$.email)
  const password = useValue(form$.password)
  const isLoading = useValue(form$.isLoading)
  const error = useValue(form$.error)

  // Use a ref to track pending navigation intent, avoiding useEffect dependency loops.
  // The effect reacts to currentUser resolving exactly once per auth outcome.
  const pendingNavRef = useRef(false)

  // React to auth completion — fires when currentUser resolves after signIn.
  useEffect(() => {
    if (!pendingNavRef.current || currentUser === undefined) return

    pendingNavRef.current = false
    form$.isLoading.set(false)

    const currentEmail = form$.email.peek()
    if (currentUser && currentUser.emailVerified === false) {
      router.replace(routes.verifyEmail({ email: currentEmail, redirectTo }))
    } else if (currentUser) {
      router.replace(resolveAuthRedirect(redirectTo))
    }
  }, [currentUser, redirectTo, router, form$])

  const handleLogin = async () => {
    const currentEmail = form$.email.get()
    const currentPassword = form$.password.get()

    if (!currentEmail || !currentPassword) {
      form$.error.set('Please enter your email and password')
      return
    }

    form$.isLoading.set(true)
    form$.error.set(null)

    // Timeout wrapper — if signIn hangs beyond 30s, reject so the user isn't stuck forever
    const SIGN_IN_TIMEOUT_MS = 30_000
    const signInPromise = signIn('password', {
      email: currentEmail,
      password: currentPassword,
      flow: 'signIn',
    })
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`Sign in timed out after ${SIGN_IN_TIMEOUT_MS / 1000}s`)),
        SIGN_IN_TIMEOUT_MS,
      ),
    )

    try {
      telemetry.breadcrumb('auth:signInStart', { email: currentEmail })

      const result = await Promise.race([signInPromise, timeoutPromise])

      telemetry.breadcrumb('auth:signInResult', {
        hasResult: !!result,
        signingIn:
          result && typeof result === 'object' && 'signingIn' in result
            ? result.signingIn
            : undefined,
      })

      // Check if verification is required (signingIn: false means email not verified)
      if (
        result &&
        typeof result === 'object' &&
        'signingIn' in result &&
        result.signingIn === false
      ) {
        // User needs to verify email - a new verification code was sent
        router.replace(routes.verifyEmail({ email: currentEmail, redirectTo }))
        form$.isLoading.set(false)
        return
      }

      // Set pending navigation — the effect above will react when currentUser resolves
      pendingNavRef.current = true
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err)
      telemetry.error('auth:signInError', 'Sign in failed', { error: errorMessage })

      // Check if error is about email verification.
      // Only redirect if we haven't already navigated above.
      if (errorMessage.includes('verify') || errorMessage.includes('verification')) {
        // Don't double-navigate — if signIn already directed us to verification, skip
        if (!pendingNavRef.current) {
          router.replace(routes.verifyEmail({ email: currentEmail, redirectTo }))
        }
      } else if (errorMessage.includes('timed out')) {
        form$.error.set('Sign in timed out. Please check your connection and try again.')
      } else {
        form$.error.set('Invalid email or password')
      }
      form$.isLoading.set(false)
    }
  }

  return (
    <YStack flex={1} backgroundColor={colors.background}>
      <StatusBar barStyle={statusBarStyle} backgroundColor={colors.background} />
      <KeyboardAwareScrollView
        contentContainerStyle={{ flexGrow: 1, justifyContent: 'center' }}
        keyboardShouldPersistTaps="handled"
        style={{ flex: 1 }}
      >
        <YStack justifyContent="center" paddingHorizontal={24} gap={32}>
          {/* Header */}
          <YStack alignItems="center" gap={16}>
            <YStack
              width={80}
              height={80}
              borderRadius={40}
              backgroundColor={'$backgroundHover'}
              alignItems="center"
              justifyContent="center"
              borderWidth={2}
              borderColor={'$primary'}
            >
              <Flame size={40} color={'$primary'} />
            </YStack>
            <YStack alignItems="center" gap={8}>
              <Text fontSize={28} fontWeight="700">
                Welcome back
              </Text>
              <Text fontSize={15} color={'$placeholderColor'}>
                Sign in to continue to Bondfires
              </Text>
            </YStack>
          </YStack>

          {/* Form */}
          <YStack gap={20}>
            <YStack gap={8}>
              <Text variant="label" color={'$gray12'}>
                Email
              </Text>
              <Input
                placeholder="you@example.com"
                value={email}
                onChangeText={(text) => form$.email.set(text)}
                keyboardType="email-address"
                autoCapitalize="none"
                autoComplete="email"
                error={!!error}
              />
            </YStack>

            <YStack gap={8}>
              <Text variant="label" color={'$gray12'}>
                Password
              </Text>
              <Input
                placeholder="Your password"
                value={password}
                onChangeText={(text) => form$.password.set(text)}
                secureTextEntry
                autoComplete="password"
                error={!!error}
              />
            </YStack>

            {error && (
              <Text color={'$error'} fontSize={14}>
                {error}
              </Text>
            )}

            <Button
              variant="ghost"
              size="$sm"
              alignSelf="flex-end"
              onPress={() => router.push(routes.forgotPassword)}
            >
              Forgot password?
            </Button>
          </YStack>

          {/* Actions */}
          <YStack gap={12}>
            <Button variant="primary" size="$lg" onPress={handleLogin} disabled={isLoading}>
              {isLoading ? <Spinner color={'$gray12'} /> : <Text color={'$gray12'}>Sign In</Text>}
            </Button>

            <Button variant="outline" size="$md" onPress={() => router.push(routes.signup)}>
              <Text>Create an account</Text>
            </Button>
          </YStack>
        </YStack>
      </KeyboardAwareScrollView>
    </YStack>
  )
}

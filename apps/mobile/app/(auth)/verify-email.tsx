import { appActions, getAuthErrorMessage, telemetry, useAppThemeColors } from '@bondfires/app'
import { Button, Input, Spinner, Text } from '@bondfires/ui'
import { useAuthActions } from '@convex-dev/auth/react'
import { CheckCircle, Mail } from '@tamagui/lucide-icons'
import { useQuery } from 'convex/react'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { useCallback, useEffect, useRef, useState } from 'react'
import { StatusBar } from 'react-native'
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller'
import { YStack } from 'tamagui'
import { api } from '../../../../convex/_generated/api'
import { resolveAuthRedirect } from '../../lib/routes'

/** Fallback timeout (ms) — if currentUser is slow to resolve after signIn,
 * navigate to the splash gate anyway and let it re-resolve auth. */
const POST_VERIFY_NAV_TIMEOUT_MS = 6_000

export default function VerifyEmailScreen() {
  const { colors, statusBarStyle } = useAppThemeColors()
  const router = useRouter()
  const { signIn } = useAuthActions()
  const params = useLocalSearchParams<{ email?: string; redirectTo?: string }>()

  // Watch Convex auth state — mirrors the pattern in login.tsx
  const currentUser = useQuery(api.users.current)

  const [code, setCode] = useState('')
  const [isVerifying, setIsVerifying] = useState(false)
  const [isResending, setIsResending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)

  // Navigation refs — same pattern as login.tsx to avoid effect dependency loops
  const pendingNavRef = useRef(false)
  const navFallbackRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clearNavFallback = useCallback(() => {
    if (navFallbackRef.current) {
      clearTimeout(navFallbackRef.current)
      navFallbackRef.current = null
    }
  }, [])

  // Clean up the fallback timer if the screen unmounts mid-verification.
  useEffect(() => clearNavFallback, [clearNavFallback])

  // React to auth completion — fires when currentUser resolves after signIn.
  useEffect(() => {
    if (!pendingNavRef.current || currentUser === undefined) return

    pendingNavRef.current = false
    clearNavFallback()

    if (currentUser) {
      // Session confirmed — sync local auth state and navigate into the app
      appActions.setAuth(currentUser._id)
      telemetry.breadcrumb('auth:verifySuccess', { hasUser: true })
      router.replace(resolveAuthRedirect(params.redirectTo))
    } else {
      // Session not reflected — go through splash gate to re-resolve
      telemetry.warn('auth:verifyNull', 'currentUser resolved null after verification')
      router.replace('/')
    }
  }, [currentUser, params.redirectTo, router, clearNavFallback])

  const handleVerify = async () => {
    if (!code || code.length < 6) {
      setError('Please enter the 6-character verification code')
      return
    }

    setIsVerifying(true)
    setError(null)

    try {
      // Verify the OTP code with email-verification flow
      await signIn('password', {
        email: params.email ?? '',
        code,
        flow: 'email-verification',
      })
      setSuccess(true)

      // Set pending navigation — the effect above will react when currentUser resolves.
      pendingNavRef.current = true

      // Fallback: if currentUser is slow to resolve over the Convex WebSocket,
      // navigate to the splash gate anyway so the user isn't stuck on a spinner.
      clearNavFallback()
      navFallbackRef.current = setTimeout(() => {
        if (!pendingNavRef.current) return
        pendingNavRef.current = false
        navFallbackRef.current = null
        telemetry.warn(
          'auth:navFallback',
          'currentUser slow to resolve after verification; navigating via splash gate',
        )
        router.replace('/')
      }, POST_VERIFY_NAV_TIMEOUT_MS)
    } catch (error) {
      setError(getAuthErrorMessage(error))
    } finally {
      setIsVerifying(false)
    }
  }

  const handleResend = async () => {
    if (!params.email) {
      setError('Email not found. Please sign up again.')
      return
    }

    setIsResending(true)
    setError(null)

    try {
      // Request a new verification code
      await signIn('password', {
        email: params.email,
        flow: 'email-verification',
      })
      setError(null)
    } catch (error) {
      setError(getAuthErrorMessage(error))
    } finally {
      setIsResending(false)
    }
  }

  return (
    <YStack flex={1} backgroundColor="$background">
      <StatusBar barStyle={statusBarStyle} backgroundColor={colors.background} />
      <KeyboardAwareScrollView
        contentContainerStyle={{
          flexGrow: 1,
          justifyContent: 'center',
          alignItems: 'center',
        }}
        keyboardShouldPersistTaps="handled"
        style={{ flex: 1 }}
      >
        <YStack paddingHorizontal={24} alignItems="center" justifyContent="center">
          <YStack alignItems="center" gap={32} maxWidth={320} width="100%">
            {/* Icon */}
            <YStack
              width={100}
              height={100}
              borderRadius={50}
              backgroundColor={'$backgroundHover'}
              alignItems="center"
              justifyContent="center"
              borderWidth={2}
              borderColor={success ? '$success' : '$secondary'}
            >
              {success ? (
                <CheckCircle size={50} color={'$success'} />
              ) : (
                <Mail size={50} color={'$secondary'} />
              )}
            </YStack>

            {/* Content */}
            <YStack alignItems="center" gap={12}>
              <Text fontSize={24} fontWeight="700" textAlign="center">
                {success ? 'Email verified!' : 'Check your email'}
              </Text>
              <Text fontSize={15} color={'$placeholderColor'} textAlign="center" lineHeight={22}>
                {success
                  ? 'Your account is now verified. Redirecting...'
                  : `We've sent a verification code to ${params.email ?? 'your email'}. Enter it below to verify your account.`}
              </Text>
            </YStack>

            {!success && (
              <>
                {/* Code Input */}
                <YStack width="100%" gap={8}>
                  <Input
                    placeholder="Enter 6-digit code"
                    value={code}
                    onChangeText={(text) => setCode(text.toUpperCase())}
                    keyboardType="default"
                    autoCapitalize="characters"
                    maxLength={32}
                    textAlign="center"
                    fontSize={20}
                    letterSpacing={4}
                    error={!!error}
                  />
                  {error && (
                    <Text color={'$error'} fontSize={14} textAlign="center">
                      {error}
                    </Text>
                  )}
                </YStack>

                {/* Actions */}
                <YStack gap={12} width="100%" marginTop={8}>
                  <Button
                    variant="primary"
                    size="$lg"
                    onPress={handleVerify}
                    disabled={isVerifying || !code}
                  >
                    {isVerifying ? (
                      <Spinner color={'$color'} />
                    ) : (
                      <>
                        <CheckCircle size={20} color={'$color'} />
                        <Text color={'$color'}>Verify Email</Text>
                      </>
                    )}
                  </Button>

                  <Button variant="ghost" size="$md" onPress={handleResend} disabled={isResending}>
                    {isResending ? (
                      <Spinner size="small" color={'$placeholderColor'} />
                    ) : (
                      <Text color={'$placeholderColor'}>Didn't receive it? Resend</Text>
                    )}
                  </Button>
                </YStack>
              </>
            )}
          </YStack>
        </YStack>
      </KeyboardAwareScrollView>
    </YStack>
  )
}

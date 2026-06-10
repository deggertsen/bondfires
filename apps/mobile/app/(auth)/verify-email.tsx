import { getAuthErrorMessage, useSystemThemeColors } from '@bondfires/app'
import { Button, Input, Spinner, Text } from '@bondfires/ui'
import { useAuthActions } from '@convex-dev/auth/react'
import { CheckCircle, Mail } from '@tamagui/lucide-icons'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { useState } from 'react'
import { StatusBar } from 'react-native'
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller'
import { YStack } from 'tamagui'
import { resolveAuthRedirect } from '../../lib/routes'

export default function VerifyEmailScreen() {
  const { colors, statusBarStyle } = useSystemThemeColors()
  const router = useRouter()
  const { signIn } = useAuthActions()
  const params = useLocalSearchParams<{ email?: string; redirectTo?: string }>()

  const [code, setCode] = useState('')
  const [isVerifying, setIsVerifying] = useState(false)
  const [isResending, setIsResending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)

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
      router.replace(resolveAuthRedirect(params.redirectTo))
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

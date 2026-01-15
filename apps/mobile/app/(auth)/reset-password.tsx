import { bondfireColors } from '@bondfires/config'
import { Button, Input, Text } from '@bondfires/ui'
import { useAuthActions } from '@convex-dev/auth/react'
import { CheckCircle, ChevronLeft, KeyRound } from '@tamagui/lucide-icons'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { useState } from 'react'
import { KeyboardAvoidingView, Platform, Pressable, StatusBar } from 'react-native'
import { Spinner, YStack } from 'tamagui'

export default function ResetPasswordScreen() {
  const router = useRouter()
  const { signIn } = useAuthActions()
  const params = useLocalSearchParams<{ email?: string }>()

  const [code, setCode] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [isResending, setIsResending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)

  const handleReset = async () => {
    if (!code || code.length < 6) {
      setError('Please enter the 6-digit code from your email')
      return
    }

    if (!newPassword) {
      setError('Please enter a new password')
      return
    }

    if (newPassword.length < 8) {
      setError('Password must be at least 8 characters')
      return
    }

    if (newPassword !== confirmPassword) {
      setError('Passwords do not match')
      return
    }

    setIsLoading(true)
    setError(null)

    try {
      // Verify the reset code and set new password
      await signIn('password', {
        email: params.email ?? '',
        code,
        newPassword,
        flow: 'reset-verification',
      })
      setSuccess(true)
      // Navigate to login after a short delay
      setTimeout(() => {
        router.replace('/(auth)/login')
      }, 2000)
    } catch {
      setError('Invalid or expired code. Please try again.')
    } finally {
      setIsLoading(false)
    }
  }

  const handleResend = async () => {
    if (!params.email) {
      setError('Email not found. Please go back and try again.')
      return
    }

    setIsResending(true)
    setError(null)

    try {
      // Request a new reset code
      await signIn('password', {
        email: params.email,
        flow: 'reset',
      })
    } catch {
      setError('Failed to resend code. Please try again.')
    } finally {
      setIsResending(false)
    }
  }

  if (success) {
    return (
      <YStack
        flex={1}
        backgroundColor={bondfireColors.obsidian}
        paddingHorizontal={24}
        alignItems="center"
        justifyContent="center"
      >
        <StatusBar barStyle="light-content" backgroundColor={bondfireColors.obsidian} />

        <YStack alignItems="center" gap={24} maxWidth={320}>
          <YStack
            width={100}
            height={100}
            borderRadius={50}
            backgroundColor={bondfireColors.gunmetal}
            alignItems="center"
            justifyContent="center"
            borderWidth={2}
            borderColor={bondfireColors.success}
          >
            <CheckCircle size={50} color={bondfireColors.success} />
          </YStack>

          <YStack alignItems="center" gap={12}>
            <Text fontSize={24} fontWeight="700" textAlign="center">
              Password reset!
            </Text>
            <Text fontSize={15} color={bondfireColors.ash} textAlign="center">
              Your password has been updated. Redirecting to sign in...
            </Text>
          </YStack>
        </YStack>
      </YStack>
    )
  }

  return (
    <YStack flex={1} backgroundColor={bondfireColors.obsidian}>
      <StatusBar barStyle="light-content" backgroundColor={bondfireColors.obsidian} />

      {/* Back button */}
      <YStack paddingTop={60} paddingHorizontal={16}>
        <Pressable onPress={() => router.back()}>
          <YStack
            width={40}
            height={40}
            borderRadius={20}
            backgroundColor={bondfireColors.gunmetal}
            alignItems="center"
            justifyContent="center"
          >
            <ChevronLeft size={24} color={bondfireColors.whiteSmoke} />
          </YStack>
        </Pressable>
      </YStack>

      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={{ flex: 1 }}
      >
        <YStack flex={1} justifyContent="center" paddingHorizontal={24} gap={32}>
          {/* Header */}
          <YStack alignItems="center" gap={16}>
            <YStack
              width={80}
              height={80}
              borderRadius={40}
              backgroundColor={bondfireColors.gunmetal}
              alignItems="center"
              justifyContent="center"
              borderWidth={2}
              borderColor={bondfireColors.bondfireCopper}
            >
              <KeyRound size={36} color={bondfireColors.bondfireCopper} />
            </YStack>
            <YStack alignItems="center" gap={8}>
              <Text fontSize={28} fontWeight="700">
                Set new password
              </Text>
              <Text fontSize={15} color={bondfireColors.ash} textAlign="center">
                Enter the code from your email and choose a new password.
              </Text>
            </YStack>
          </YStack>

          {/* Form */}
          <YStack gap={20}>
            <YStack gap={8}>
              <Text variant="label" color={bondfireColors.whiteSmoke}>
                Reset Code
              </Text>
              <Input
                placeholder="Enter 6-digit code"
                value={code}
                onChangeText={setCode}
                keyboardType="number-pad"
                maxLength={6}
                textAlign="center"
                fontSize={20}
                letterSpacing={4}
                error={!!error && error.includes('code')}
              />
            </YStack>

            <YStack gap={8}>
              <Text variant="label" color={bondfireColors.whiteSmoke}>
                New Password
              </Text>
              <Input
                placeholder="At least 8 characters"
                value={newPassword}
                onChangeText={setNewPassword}
                secureTextEntry
                autoComplete="new-password"
                error={!!error && error.includes('password')}
              />
            </YStack>

            <YStack gap={8}>
              <Text variant="label" color={bondfireColors.whiteSmoke}>
                Confirm Password
              </Text>
              <Input
                placeholder="Confirm your new password"
                value={confirmPassword}
                onChangeText={setConfirmPassword}
                secureTextEntry
                autoComplete="new-password"
                error={!!error && error.includes('match')}
              />
            </YStack>

            {error && (
              <Text color={bondfireColors.error} fontSize={14} textAlign="center">
                {error}
              </Text>
            )}
          </YStack>

          {/* Actions */}
          <YStack gap={12}>
            <Button
              variant="primary"
              size="$lg"
              onPress={handleReset}
              disabled={isLoading || !code || !newPassword || !confirmPassword}
            >
              {isLoading ? (
                <Spinner color={bondfireColors.whiteSmoke} />
              ) : (
                <Text color={bondfireColors.whiteSmoke}>Reset Password</Text>
              )}
            </Button>

            <Button variant="ghost" size="$md" onPress={handleResend} disabled={isResending}>
              {isResending ? (
                <Spinner size="small" color={bondfireColors.ash} />
              ) : (
                <Text color={bondfireColors.ash}>Didn't receive it? Resend code</Text>
              )}
            </Button>
          </YStack>
        </YStack>
      </KeyboardAvoidingView>
    </YStack>
  )
}

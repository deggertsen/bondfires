import { bondfireColors } from '@bondfires/config'
import { Button, Input, Text } from '@bondfires/ui'
import { useAuthActions } from '@convex-dev/auth/react'
import { ChevronLeft, Mail } from '@tamagui/lucide-icons'
import { useRouter } from 'expo-router'
import type { RelativePathString } from 'expo-router'
import { useState } from 'react'
import { KeyboardAvoidingView, Platform, Pressable, StatusBar } from 'react-native'
import { Spinner, YStack } from 'tamagui'

export default function ForgotPasswordScreen() {
  const router = useRouter()
  const { signIn } = useAuthActions()

  const [email, setEmail] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = async () => {
    if (!email) {
      setError('Please enter your email address')
      return
    }

    setIsLoading(true)
    setError(null)

    try {
      // Request password reset - this sends an email with a reset code
      await signIn('password', {
        email,
        flow: 'reset',
      })
      // Navigate to reset password screen to enter code and new password
      router.replace({
        pathname: '/(auth)/reset-password' as RelativePathString,
        params: { email },
      })
    } catch {
      setError('Could not send reset email. Please try again.')
    } finally {
      setIsLoading(false)
    }
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
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
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
              <Mail size={36} color={bondfireColors.bondfireCopper} />
            </YStack>
            <YStack alignItems="center" gap={8}>
              <Text fontSize={28} fontWeight="700">
                Reset password
              </Text>
              <Text fontSize={15} color={bondfireColors.ash} textAlign="center">
                Enter your email and we'll send you a link to reset your password.
              </Text>
            </YStack>
          </YStack>

          {/* Form */}
          <YStack gap={20}>
            <YStack gap={8}>
              <Text variant="label" color={bondfireColors.whiteSmoke}>
                Email
              </Text>
              <Input
                placeholder="you@example.com"
                value={email}
                onChangeText={setEmail}
                keyboardType="email-address"
                autoCapitalize="none"
                autoComplete="email"
                error={!!error}
              />
            </YStack>

            {error && (
              <Text color={bondfireColors.error} fontSize={14}>
                {error}
              </Text>
            )}
          </YStack>

          {/* Actions */}
          <YStack gap={12}>
            <Button variant="primary" size="$lg" onPress={handleSubmit} disabled={isLoading}>
              {isLoading ? <Spinner color={bondfireColors.whiteSmoke} /> : 'Send Reset Link'}
            </Button>
          </YStack>
        </YStack>
      </KeyboardAvoidingView>
    </YStack>
  )
}

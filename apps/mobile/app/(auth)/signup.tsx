import { Button, Input, Text } from '@bondfires/ui'
import { bondfireColors } from '@bondfires/config'
import { useAuthActions } from '@convex-dev/auth/react'
import { Flame, UserPlus } from '@tamagui/lucide-icons'
import { useRouter } from 'expo-router'
import { useState } from 'react'
import { KeyboardAvoidingView, Platform, ScrollView, StatusBar } from 'react-native'
import { Spinner, YStack } from 'tamagui'

export default function SignupScreen() {
  const router = useRouter()
  const { signIn } = useAuthActions()

  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSignup = async () => {
    if (!name || !email || !password) {
      setError('Please fill in all fields')
      return
    }

    if (password !== confirmPassword) {
      setError('Passwords do not match')
      return
    }

    if (password.length < 8) {
      setError('Password must be at least 8 characters')
      return
    }

    setIsLoading(true)
    setError(null)

    try {
      await signIn('password', { email, password, name, flow: 'signUp' })
      // Pass email to verify-email screen for OTP verification
      router.replace({ pathname: '/(auth)/verify-email', params: { email } })
    } catch {
      setError('Could not create account. Please try again.')
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <YStack flex={1} backgroundColor={bondfireColors.obsidian}>
      <StatusBar barStyle="light-content" backgroundColor={bondfireColors.obsidian} />
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={{ flex: 1 }}
      >
        <ScrollView
          contentContainerStyle={{ flexGrow: 1, justifyContent: 'center' }}
          keyboardShouldPersistTaps="handled"
        >
          <YStack flex={1} justifyContent="center" paddingHorizontal={24} paddingVertical={40} gap={28}>
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
                borderColor={bondfireColors.moltenGold}
              >
                <UserPlus size={36} color={bondfireColors.moltenGold} />
              </YStack>
              <YStack alignItems="center" gap={8}>
                <Text fontSize={28} fontWeight="700">
                  Create account
                </Text>
                <Text fontSize={15} color={bondfireColors.ash}>
                  Join Bondfires and start sharing
                </Text>
              </YStack>
            </YStack>

            {/* Form */}
            <YStack gap={16}>
              <YStack gap={8}>
                <Text variant="label" color={bondfireColors.whiteSmoke}>
                  Name
                </Text>
                <Input
                  placeholder="Your name"
                  value={name}
                  onChangeText={setName}
                  autoCapitalize="words"
                  autoComplete="name"
                />
              </YStack>

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
                />
              </YStack>

              <YStack gap={8}>
                <Text variant="label" color={bondfireColors.whiteSmoke}>
                  Password
                </Text>
                <Input
                  placeholder="At least 8 characters"
                  value={password}
                  onChangeText={setPassword}
                  secureTextEntry
                  autoComplete="new-password"
                />
              </YStack>

              <YStack gap={8}>
                <Text variant="label" color={bondfireColors.whiteSmoke}>
                  Confirm Password
                </Text>
                <Input
                  placeholder="Confirm your password"
                  value={confirmPassword}
                  onChangeText={setConfirmPassword}
                  secureTextEntry
                  autoComplete="new-password"
                  error={confirmPassword.length > 0 && password !== confirmPassword}
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
              <Button variant="primary" size="$lg" onPress={handleSignup} disabled={isLoading}>
                {isLoading ? (
                  <Spinner color={bondfireColors.whiteSmoke} />
                ) : (
                  <>
                    <Flame size={20} color={bondfireColors.whiteSmoke} />
                    <Text color={bondfireColors.whiteSmoke}>Create Account</Text>
                  </>
                )}
              </Button>

              <Button variant="ghost" size="$md" onPress={() => router.push('/(auth)/login')}>
                <Text>Already have an account? Sign in</Text>
              </Button>
            </YStack>
          </YStack>
        </ScrollView>
      </KeyboardAvoidingView>
    </YStack>
  )
}

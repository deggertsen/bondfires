import { bondfireColors } from '@bondfires/config'
import { Button, Input, Text } from '@bondfires/ui'
import { useObservable, useValue } from '@legendapp/state/react'
import { useAuthActions } from '@convex-dev/auth/react'
import { Flame, UserPlus } from '@tamagui/lucide-icons'
import { useRouter } from 'expo-router'
import { KeyboardAvoidingView, Platform, ScrollView, StatusBar } from 'react-native'
import { Spinner, YStack } from 'tamagui'

export default function SignupScreen() {
  const router = useRouter()
  const { signIn } = useAuthActions()

  const form$ = useObservable({
    name: '',
    email: '',
    password: '',
    confirmPassword: '',
    isLoading: false,
    error: null as string | null,
  })

  const name = useValue(form$.name)
  const email = useValue(form$.email)
  const password = useValue(form$.password)
  const confirmPassword = useValue(form$.confirmPassword)
  const isLoading = useValue(form$.isLoading)
  const error = useValue(form$.error)

  const handleSignup = async () => {
    const currentName = form$.name.get()
    const currentEmail = form$.email.get()
    const currentPassword = form$.password.get()
    const currentConfirmPassword = form$.confirmPassword.get()

    if (!currentName || !currentEmail || !currentPassword) {
      form$.error.set('Please fill in all fields')
      return
    }

    if (currentPassword !== currentConfirmPassword) {
      form$.error.set('Passwords do not match')
      return
    }

    if (currentPassword.length < 8) {
      form$.error.set('Password must be at least 8 characters')
      return
    }

    form$.isLoading.set(true)
    form$.error.set(null)

    try {
      await signIn('password', { email: currentEmail, password: currentPassword, name: currentName, flow: 'signUp' })
      // Pass email to verify-email screen for OTP verification
      router.replace({ pathname: '/(auth)/verify-email', params: { email: currentEmail } })
    } catch {
      form$.error.set('Could not create account. Please try again.')
    } finally {
      form$.isLoading.set(false)
    }
  }

  return (
    <YStack flex={1} backgroundColor={bondfireColors.obsidian}>
      <StatusBar barStyle="light-content" backgroundColor={bondfireColors.obsidian} />
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={{ flex: 1 }}
      >
        <ScrollView
          contentContainerStyle={{ flexGrow: 1, justifyContent: 'center' }}
          keyboardShouldPersistTaps="handled"
        >
          <YStack justifyContent="center" paddingHorizontal={24} paddingVertical={40} gap={28}>
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
                  onChangeText={(text) => form$.name.set(text)}
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
                  onChangeText={(text) => form$.email.set(text)}
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
                  onChangeText={(text) => form$.password.set(text)}
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
                  onChangeText={(text) => form$.confirmPassword.set(text)}
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

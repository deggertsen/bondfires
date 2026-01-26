import { bondfireColors } from '@bondfires/config'
import { Button, Input, Text } from '@bondfires/ui'
import { useObservable, useValue } from '@legendapp/state/react'
import { useAuthActions } from '@convex-dev/auth/react'
import { Flame } from '@tamagui/lucide-icons'
import { useQuery } from 'convex/react'
import { useRouter } from 'expo-router'
import { useEffect } from 'react'
import { KeyboardAvoidingView, Platform, ScrollView, StatusBar } from 'react-native'
import { Spinner, YStack } from 'tamagui'
import { api } from '../../../../convex/_generated/api'

export default function LoginScreen() {
  const router = useRouter()
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
  const pendingNavigation = useValue(form$.pendingNavigation)

  // Check email verification after successful login
  useEffect(() => {
    if (pendingNavigation && currentUser !== undefined) {
      const currentEmail = form$.email.get()
      if (currentUser && currentUser.emailVerified === false) {
        // User not verified, redirect to verification screen
        router.replace({ pathname: '/(auth)/verify-email', params: { email: currentEmail } })
      } else if (currentUser) {
        // User is verified, go to feed
        router.replace('/(main)/feed')
      }
      form$.pendingNavigation.set(false)
      form$.isLoading.set(false)
    }
  }, [currentUser, pendingNavigation, router, form$])

  const handleLogin = async () => {
    const currentEmail = form$.email.get()
    const currentPassword = form$.password.get()

    if (!currentEmail || !currentPassword) {
      form$.error.set('Please enter your email and password')
      return
    }

    form$.isLoading.set(true)
    form$.error.set(null)

    try {
      const result = await signIn('password', { email: currentEmail, password: currentPassword, flow: 'signIn' })

      // Check if verification is required (signingIn: false means email not verified)
      if (
        result &&
        typeof result === 'object' &&
        'signingIn' in result &&
        result.signingIn === false
      ) {
        // User needs to verify email - a new verification code was sent
        router.replace({ pathname: '/(auth)/verify-email', params: { email: currentEmail } })
        form$.isLoading.set(false)
        return
      }

      // Set pending navigation to wait for user data to load
      form$.pendingNavigation.set(true)
    } catch (err) {
      // Check if error is about email verification
      const errorMessage = err instanceof Error ? err.message : String(err)
      if (errorMessage.includes('verify') || errorMessage.includes('verification')) {
        // Redirect to verification screen
        router.replace({ pathname: '/(auth)/verify-email', params: { email: currentEmail } })
      } else {
        form$.error.set('Invalid email or password')
      }
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
          <YStack justifyContent="center" paddingHorizontal={24} gap={32}>
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
                <Flame size={40} color={bondfireColors.bondfireCopper} />
              </YStack>
              <YStack alignItems="center" gap={8}>
                <Text fontSize={28} fontWeight="700">
                  Welcome back
                </Text>
                <Text fontSize={15} color={bondfireColors.ash}>
                  Sign in to continue to Bondfires
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
                  onChangeText={(text) => form$.email.set(text)}
                  keyboardType="email-address"
                  autoCapitalize="none"
                  autoComplete="email"
                  error={!!error}
                />
              </YStack>

              <YStack gap={8}>
                <Text variant="label" color={bondfireColors.whiteSmoke}>
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
                <Text color={bondfireColors.error} fontSize={14}>
                  {error}
                </Text>
              )}

              <Button
                variant="ghost"
                size="$sm"
                alignSelf="flex-end"
                onPress={() => router.push('/(auth)/forgot-password')}
              >
                Forgot password?
              </Button>
            </YStack>

            {/* Actions */}
            <YStack gap={12}>
              <Button variant="primary" size="$lg" onPress={handleLogin} disabled={isLoading}>
                {isLoading ? (
                  <Spinner color={bondfireColors.whiteSmoke} />
                ) : (
                  <Text color={bondfireColors.whiteSmoke}>Sign In</Text>
                )}
              </Button>

              <Button variant="outline" size="$md" onPress={() => router.push('/(auth)/signup')}>
                <Text>Create an account</Text>
              </Button>
            </YStack>
          </YStack>
        </ScrollView>
      </KeyboardAvoidingView>
    </YStack>
  )
}

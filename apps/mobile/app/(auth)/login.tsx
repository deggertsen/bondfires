import { Button, Input, Text } from '@bondfires/ui'
import { bondfireColors } from '@bondfires/config'
import { useAuthActions } from '@convex-dev/auth/react'
import { useQuery } from 'convex/react'
import { Flame } from '@tamagui/lucide-icons'
import { useRouter } from 'expo-router'
import { useState, useEffect } from 'react'
import { KeyboardAvoidingView, Platform, ScrollView, StatusBar } from 'react-native'
import { Spinner, YStack } from 'tamagui'
import { api } from '../../../../convex/_generated/api'

export default function LoginScreen() {
  const router = useRouter()
  const { signIn } = useAuthActions()
  const currentUser = useQuery(api.users.current)

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pendingNavigation, setPendingNavigation] = useState(false)

  // Check email verification after successful login
  useEffect(() => {
    if (pendingNavigation && currentUser !== undefined) {
      if (currentUser && currentUser.emailVerified === false) {
        // User not verified, redirect to verification screen
        router.replace({ pathname: '/(auth)/verify-email', params: { email } })
      } else if (currentUser) {
        // User is verified, go to feed
        router.replace('/(main)/feed')
      }
      setPendingNavigation(false)
      setIsLoading(false)
    }
  }, [currentUser, pendingNavigation, email, router])

  const handleLogin = async () => {
    if (!email || !password) {
      setError('Please enter your email and password')
      return
    }

    setIsLoading(true)
    setError(null)

    try {
      const result = await signIn('password', { email, password, flow: 'signIn' })
      
      // Check if verification is required (signingIn: false means email not verified)
      if (result && typeof result === 'object' && 'signingIn' in result && result.signingIn === false) {
        // User needs to verify email - a new verification code was sent
        router.replace({ pathname: '/(auth)/verify-email', params: { email } })
        setIsLoading(false)
        return
      }
      
      // Set pending navigation to wait for user data to load
      setPendingNavigation(true)
    } catch (err) {
      // Check if error is about email verification
      const errorMessage = err instanceof Error ? err.message : String(err)
      if (errorMessage.includes('verify') || errorMessage.includes('verification')) {
        // Redirect to verification screen
        router.replace({ pathname: '/(auth)/verify-email', params: { email } })
      } else {
        setError('Invalid email or password')
      }
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
                  onChangeText={setEmail}
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
                  onChangeText={setPassword}
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

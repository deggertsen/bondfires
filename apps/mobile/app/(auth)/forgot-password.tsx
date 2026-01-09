import { Button, Container, Input, Text } from '@bondfires/ui'
import { useRouter } from 'expo-router'
import { useState } from 'react'
import { H1, Paragraph, Spinner, YStack } from 'tamagui'

export default function ForgotPasswordScreen() {
  const router = useRouter()

  const [email, setEmail] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [isSent, setIsSent] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = async () => {
    if (!email) {
      setError('Please enter your email address')
      return
    }

    setIsLoading(true)
    setError(null)

    try {
      // TODO: Implement password reset via Convex
      await new Promise((resolve) => setTimeout(resolve, 1000))
      setIsSent(true)
    } catch {
      setError('Could not send reset email. Please try again.')
    } finally {
      setIsLoading(false)
    }
  }

  if (isSent) {
    return (
      <Container padded safe centered>
        <YStack alignItems="center" gap="$6" maxWidth={320}>
          <YStack
            width={80}
            height={80}
            borderRadius={40}
            backgroundColor="$green5"
            alignItems="center"
            justifyContent="center"
          >
            <Text fontSize={40}>📧</Text>
          </YStack>

          <YStack alignItems="center" gap="$3">
            <H1 textAlign="center">Check your email</H1>
            <Paragraph textAlign="center" color="$gray11">
              If an account exists with that email, we've sent password reset instructions.
            </Paragraph>
          </YStack>

          <Button variant="primary" size="lg" onPress={() => router.replace('/(auth)/login')}>
            Back to Sign In
          </Button>
        </YStack>
      </Container>
    )
  }

  return (
    <Container padded safe>
      <YStack flex={1} justifyContent="center" gap="$6">
        <YStack gap="$2">
          <H1>Reset password</H1>
          <Paragraph color="$gray11">
            Enter your email and we'll send you a link to reset your password.
          </Paragraph>
        </YStack>

        <YStack gap="$4">
          <YStack gap="$2">
            <Text variant="label">Email</Text>
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
            <Text color="$red10" fontSize="$2">
              {error}
            </Text>
          )}
        </YStack>

        <YStack gap="$3">
          <Button variant="primary" size="lg" onPress={handleSubmit} disabled={isLoading}>
            {isLoading ? <Spinner color="$white" /> : 'Send Reset Link'}
          </Button>

          <Button variant="ghost" size="md" onPress={() => router.back()}>
            Back to Sign In
          </Button>
        </YStack>
      </YStack>
    </Container>
  )
}

import { Button, Container, Text } from '@bondfires/ui'
import { useRouter } from 'expo-router'
import { useState } from 'react'
import { H1, Paragraph, Spinner, YStack } from 'tamagui'

export default function VerifyEmailScreen() {
  const router = useRouter()
  const [isResending, setIsResending] = useState(false)

  const handleResend = async () => {
    setIsResending(true)
    // TODO: Implement resend verification email
    await new Promise((resolve) => setTimeout(resolve, 1000))
    setIsResending(false)
  }

  const handleContinue = () => {
    // For now, just go to the feed
    // In production, this would check if email is verified
    router.replace('/(main)/feed')
  }

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
          <Text fontSize={40}>✉️</Text>
        </YStack>

        <YStack alignItems="center" gap="$3">
          <H1 textAlign="center">Check your email</H1>
          <Paragraph textAlign="center" color="$gray11">
            We've sent a verification link to your email address. Click the link to verify your
            account.
          </Paragraph>
        </YStack>

        <YStack gap="$3" width="100%" marginTop="$4">
          <Button variant="primary" size="lg" onPress={handleContinue}>
            I've verified my email
          </Button>

          <Button variant="ghost" size="md" onPress={handleResend} disabled={isResending}>
            {isResending ? <Spinner size="small" /> : "Didn't receive it? Resend"}
          </Button>
        </YStack>
      </YStack>
    </Container>
  )
}

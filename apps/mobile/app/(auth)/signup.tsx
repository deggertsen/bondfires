import { Button, Text } from '@bondfires/ui'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { useState } from 'react'
import { YStack } from 'tamagui'
import { RegistrationForm } from '../../components/RegistrationForm'
import { SocialSignInButtons } from '../../components/SocialSignInButtons'
import { routes } from '../../lib/routes'

export default function SignupScreen() {
  const [email, setEmail] = useState(false)
  const [busy, setBusy] = useState(false)
  const { redirectTo } = useLocalSearchParams<{ redirectTo?: string }>()
  const router = useRouter()
  if (email) return <RegistrationForm />
  return (
    <YStack flex={1} justifyContent="center" backgroundColor="$background" padding={24} gap={24}>
      <Text fontSize={28} fontWeight="700">
        Join Bondfires
      </Text>
      <Text color="$placeholderColor">Choose how you’d like to create your account.</Text>
      <SocialSignInButtons redirectTo={redirectTo} onBusyChange={setBusy} />
      <Button size="$lg" variant="primary" disabled={busy} onPress={() => setEmail(true)}>
        <Text>Continue with Email</Text>
      </Button>
      <Button variant="ghost" onPress={() => router.replace(routes.login(redirectTo))}>
        <Text>Already have an account? Sign in</Text>
      </Button>
    </YStack>
  )
}

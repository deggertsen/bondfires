import { Button, Spinner, Text } from '@bondfires/ui'
import { useAuthActions } from '@convex-dev/auth/react'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { useEffect, useState } from 'react'
import { YStack } from 'tamagui'
import { routes } from '../lib/routes'
import { finishSocialSignIn } from '../lib/socialAuth'

export default function AuthCallbackScreen() {
  const { code } = useLocalSearchParams<{ code?: string }>()
  const { signIn } = useAuthActions()
  const router = useRouter()
  const [error, setError] = useState(false)
  useEffect(() => {
    if (!code) {
      setError(true)
      return
    }
    void finishSocialSignIn(code, signIn)
      .then((destination) => {
        router.replace(routes.splash(destination))
      })
      .catch(() => setError(true))
  }, [code, signIn, router])
  return (
    <YStack
      flex={1}
      justifyContent="center"
      alignItems="center"
      backgroundColor="$background"
      padding={24}
      gap={16}
    >
      {error ? (
        <>
          <Text>Unable to finish sign-in. Please try again.</Text>
          <Button onPress={() => router.replace(routes.login())}>
            <Text>Back to sign in</Text>
          </Button>
        </>
      ) : (
        <>
          <Spinner />
          <Text>Finishing sign-in…</Text>
        </>
      )}
    </YStack>
  )
}

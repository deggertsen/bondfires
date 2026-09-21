import { Button, Text } from '@bondfires/ui'
import { useAuthActions } from '@convex-dev/auth/react'
import { useQuery } from 'convex/react'
import { useRouter } from 'expo-router'
import { openAuthSessionAsync } from 'expo-web-browser'
import { useRef, useState } from 'react'
import { Platform } from 'react-native'
import { YStack } from 'tamagui'
import { api } from '../../../convex/_generated/api'
import { routes } from '../lib/routes'
import {
  AUTH_CALLBACK,
  cancelSocialSignIn,
  finishSocialSignIn,
  rememberSocialSignIn,
} from '../lib/socialAuth'

export function SocialSignInButtons({
  redirectTo,
  disabled = false,
  onBusyChange,
}: {
  redirectTo?: string
  disabled?: boolean
  onBusyChange?: (busy: boolean) => void
}) {
  const providers = useQuery(api.registration.providers)
  const { signIn } = useAuthActions()
  const router = useRouter()
  const active = useRef(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  if (Platform.OS === 'web' || !providers || (!providers.apple && !providers.google)) return null

  const start = async (provider: 'apple' | 'google') => {
    if (active.current) return
    active.current = true
    onBusyChange?.(true)
    setBusy(provider)
    setError(null)
    rememberSocialSignIn(provider, redirectTo)
    try {
      const { redirect } = await signIn(provider, { redirectTo: AUTH_CALLBACK })
      if (!redirect) throw new Error('Sign-in unavailable')
      const result = await openAuthSessionAsync(redirect.toString(), AUTH_CALLBACK)
      if (result.type !== 'success') {
        cancelSocialSignIn()
        return
      }
      const url = new URL(result.url)
      if (`${url.protocol}//${url.host}${url.pathname}` !== AUTH_CALLBACK)
        throw new Error('Invalid callback')
      const code = url.searchParams.get('code')
      if (!code) throw new Error('Missing sign-in code')
      const destination = await finishSocialSignIn(code, signIn)
      router.replace(routes.splash(destination))
    } catch {
      cancelSocialSignIn()
      setError('Unable to sign in. Please try again, or use your existing sign-in method.')
    } finally {
      active.current = false
      setBusy(null)
      onBusyChange?.(false)
    }
  }
  return (
    <YStack gap={12}>
      {providers.apple && (
        <Button
          variant="outline"
          size="$lg"
          disabled={disabled || !!busy}
          onPress={() => start('apple')}
          accessibilityLabel="Continue with Apple"
        >
          <Text>{busy === 'apple' ? 'Signing in…' : 'Continue with Apple'}</Text>
        </Button>
      )}
      {providers.google && (
        <Button
          variant="outline"
          size="$lg"
          disabled={disabled || !!busy}
          onPress={() => start('google')}
          accessibilityLabel="Continue with Google"
        >
          <Text>{busy === 'google' ? 'Signing in…' : 'Continue with Google'}</Text>
        </Button>
      )}
      {error && (
        <Text color="$error" accessibilityRole="alert">
          {error}
        </Text>
      )}
    </YStack>
  )
}

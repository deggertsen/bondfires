import { appStore$ } from '@bondfires/app'
import { bondfireColors } from '@bondfires/config'
import { Button, Text } from '@bondfires/ui'
import { ArrowLeft, Flame, LogIn } from '@tamagui/lucide-icons'
import { useValue } from '@legendapp/state/react'
import { useMutation } from 'convex/react'
import { Redirect, useLocalSearchParams, useRouter } from 'expo-router'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Pressable, StatusBar } from 'react-native'
import { Spinner, XStack, YStack } from 'tamagui'
import { api } from '../../../../convex/_generated/api'
import { routes } from '../../lib/routes'

export default function InviteScreen() {
  const router = useRouter()
  const { code } = useLocalSearchParams<{ code: string }>()
  const isAuthenticated = useValue(appStore$.isAuthenticated)
  const redeemInvite = useMutation(api.personalBondfires.redeemInvite)
  const [status, setStatus] = useState<'loading' | 'success' | 'error'>('loading')
  const [error, setError] = useState<string | null>(null)
  const didRedeem = useRef(false)

  // If not authenticated, redirect to login with the invite code as redirect target
  if (!isAuthenticated && code) {
    return <Redirect href={routes.loginWithInvite(code)} />
  }

  const handleRedeem = useCallback(async () => {
    if (didRedeem.current) return
    didRedeem.current = true

    try {
      if (!code) {
        setError('No invite code found in the link.')
        setStatus('error')
        return
      }

      const result = await redeemInvite({ code })
      setStatus('success')
      // Navigate to the bondfire after a brief delay
      setTimeout(() => {
        router.replace(routes.bondfire(result.bondfireId))
      }, 1500)
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Could not redeem this invite. It may have expired.'
      setError(message)
      setStatus('error')
    }
  }, [code, redeemInvite, router])

  useEffect(() => {
    if (!isAuthenticated) return
    // Small delay so the screen renders before attempting redeem
    const timer = setTimeout(handleRedeem, 200)
    return () => clearTimeout(timer)
  }, [handleRedeem, isAuthenticated])

  return (
    <YStack flex={1} backgroundColor={bondfireColors.charcoal}>
      <StatusBar barStyle="light-content" />

      {/* Header */}
      <YStack paddingTop={58} paddingHorizontal={16} paddingBottom={18}>
        <Pressable onPress={() => router.back()}>
          <YStack
            width={42}
            height={42}
            borderRadius={21}
            alignItems="center"
            justifyContent="center"
            backgroundColor={bondfireColors.gunmetal}
            borderWidth={1}
            borderColor={bondfireColors.iron}
          >
            <ArrowLeft size={22} color={bondfireColors.whiteSmoke} />
          </YStack>
        </Pressable>
      </YStack>

      <YStack flex={1} alignItems="center" justifyContent="center" paddingHorizontal={32} gap={20}>
        <YStack
          width={80}
          height={80}
          borderRadius={24}
          backgroundColor={bondfireColors.bondfireCopper}
          alignItems="center"
          justifyContent="center"
        >
          <Flame size={44} color={bondfireColors.whiteSmoke} />
        </YStack>

        {status === 'loading' && (
          <>
            <Spinner size="large" color={bondfireColors.bondfireCopper} />
            <Text fontSize={18} fontWeight="700" textAlign="center">
              Joining personal bondfire...
            </Text>
          </>
        )}

        {status === 'success' && (
          <>
            <Text fontSize={22} fontWeight="900" textAlign="center" color={bondfireColors.success}>
              You're in!
            </Text>
            <Text fontSize={15} color={bondfireColors.ash} textAlign="center" lineHeight={22}>
              Taking you to the conversation now.
            </Text>
          </>
        )}

        {status === 'error' && (
          <>
            <Text fontSize={22} fontWeight="900" textAlign="center" color={bondfireColors.error}>
              Couldn't join
            </Text>
            <Text fontSize={15} color={bondfireColors.ash} textAlign="center" lineHeight={22}>
              {error ?? 'Something went wrong. The invite may have expired or the fire is full.'}
            </Text>
            <Button
              variant="primary"
              marginTop={8}
              onPress={() => {
                setStatus('loading')
                setError(null)
                didRedeem.current = false
                setTimeout(handleRedeem, 200)
              }}
            >
              Retry
            </Button>
            <Pressable
              onPress={() => router.replace('/(main)/(tabs)/feed')}
              style={{ marginTop: 8 }}
            >
              <Text
                fontSize={14}
                color={bondfireColors.bondfireCopper}
                fontWeight="700"
                textDecorationLine="underline"
              >
                Go to feed
              </Text>
            </Pressable>
          </>
        )}
      </YStack>
    </YStack>
  )
}

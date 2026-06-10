import { useAppThemeColors } from '@bondfires/app'
import { Button, Spinner, Text } from '@bondfires/ui'
import { ArrowLeft, Flame } from '@tamagui/lucide-icons'
import type { Href } from 'expo-router'
import { Redirect, Stack, useNavigation, useRouter } from 'expo-router'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Pressable, StatusBar } from 'react-native'
import { YStack } from 'tamagui'
import { routes } from '../lib/routes'

type RedemptionStatus = 'loading' | 'success' | 'error'

interface InviteRedemptionScreenProps {
  code: string | string[] | undefined
  isAuthenticated: boolean
  loginHref: (code: string) => Href
  redeemInvite: (code: string) => Promise<Href>
  loadingText: string
  successText: string
  fallbackErrorText: string
}

function normalizeCode(code: string | string[] | undefined): string | null {
  if (Array.isArray(code)) return code[0] ?? null
  return code ?? null
}

export function InviteRedemptionScreen({
  code: codeParam,
  isAuthenticated,
  loginHref,
  redeemInvite,
  loadingText,
  successText,
  fallbackErrorText,
}: InviteRedemptionScreenProps) {
  const { statusBarStyle } = useAppThemeColors()
  const router = useRouter()
  const navigation = useNavigation()
  const code = normalizeCode(codeParam)
  const [status, setStatus] = useState<RedemptionStatus>('loading')
  const [error, setError] = useState<string | null>(null)
  const didRedeem = useRef(false)

  const handleRedeem = useCallback(async () => {
    if (didRedeem.current) return
    didRedeem.current = true

    try {
      if (!code) {
        setError('No invite code found in the link.')
        setStatus('error')
        return
      }

      const target = await redeemInvite(code)
      setStatus('success')
      setTimeout(() => {
        router.replace(target)
      }, 1000)
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Could not redeem this invite. It may have expired.'
      setError(message)
      setStatus('error')
    }
  }, [code, redeemInvite, router])

  useEffect(() => {
    if (!isAuthenticated) return
    const timer = setTimeout(handleRedeem, 200)
    return () => clearTimeout(timer)
  }, [handleRedeem, isAuthenticated])

  if (!isAuthenticated && code) {
    return <Redirect href={loginHref(code)} />
  }

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <YStack flex={1} backgroundColor={'$backgroundPress'}>
        <StatusBar barStyle={statusBarStyle} />

        <YStack paddingTop={58} paddingHorizontal={16} paddingBottom={18}>
          <Pressable onPress={() => { navigation.canGoBack() ? router.back() : router.replace(routes.feed) }}>
            <YStack
              width={42}
              height={42}
              borderRadius={21}
              alignItems="center"
              justifyContent="center"
              backgroundColor={'$backgroundHover'}
              borderWidth={1}
              borderColor={'$borderColor'}
            >
              <ArrowLeft size={22} color={'$color'} />
            </YStack>
          </Pressable>
        </YStack>

        <YStack
          flex={1}
          alignItems="center"
          justifyContent="center"
          paddingHorizontal={32}
          gap={20}
        >
          <YStack
            width={80}
            height={80}
            borderRadius={24}
            backgroundColor={'$primary'}
            alignItems="center"
            justifyContent="center"
          >
            <Flame size={44} color={'$color'} />
          </YStack>

          {status === 'loading' && (
            <>
              <Spinner size="large" color={'$primary'} />
              <Text fontSize={18} fontWeight="700" textAlign="center">
                {loadingText}
              </Text>
            </>
          )}

          {status === 'success' && (
            <>
              <Text fontSize={22} fontWeight="900" textAlign="center" color={'$success'}>
                You're in!
              </Text>
              <Text fontSize={15} color={'$placeholderColor'} textAlign="center" lineHeight={22}>
                {successText}
              </Text>
            </>
          )}

          {status === 'error' && (
            <>
              <Text fontSize={22} fontWeight="900" textAlign="center" color={'$error'}>
                Couldn't join
              </Text>
              <Text fontSize={15} color={'$placeholderColor'} textAlign="center" lineHeight={22}>
                {error ?? fallbackErrorText}
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
              <Pressable onPress={() => router.replace(routes.feed)} style={{ marginTop: 8 }}>
                <Text
                  fontSize={14}
                  color={'$primary'}
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
    </>
  )
}

import { appStore$, telemetry } from '@bondfires/app'
import { bondfireColors } from '@bondfires/config'
import { Text } from '@bondfires/ui'
import { useValue } from '@legendapp/state/react'
import { useQuery, useMutation } from 'convex/react'
import { Stack, useLocalSearchParams, useRouter } from 'expo-router'
import { useCallback, useEffect, useRef } from 'react'
import { Alert } from 'react-native'
import { Spinner, YStack } from 'tamagui'
import { api } from '../../../../convex/_generated/api'

export default function PersonalBondfireInviteScreen() {
  const { bondfireId, code } = useLocalSearchParams<{ bondfireId: string; code: string }>()
  const router = useRouter()
  const currentUser = useQuery(api.users.current)
  const userId = useValue(appStore$.userId)

  const processedRef = useRef(false)

  const checkInvite = useQuery(api.personalBondfires.checkInvite, code ? { code } : 'skip')
  const redeemInvite = useMutation(api.personalBondfires.redeemInvite)

  const navigateToBondfire = useCallback(
    (id: string) => {
      router.replace(`/(main)/bondfire/${id}`)
    },
    [router],
  )

  const navigateToAuth = useCallback(
    (returnUrl: string) => {
      router.replace({
        pathname: '/(auth)/login',
        params: { redirectTo: returnUrl },
      })
    },
    [router],
  )

  useEffect(() => {
    if (processedRef.current) return
    if (!bondfireId || !code) return

    // Auth is still loading
    if (currentUser === undefined) return

    // User is not authenticated — redirect to login with return link
    if (!currentUser) {
      processedRef.current = true
      const returnUrl = encodeURIComponent(`/(main)/personal-bondfire/${bondfireId}/${code}`)
      telemetry.breadcrumb('deeplink:personal-bondfire:auth-required', { bondfireId, code })
      navigateToAuth(returnUrl)
      return
    }

    processedRef.current = true
  }, [currentUser, bondfireId, code, navigateToAuth])

  // Once auth is confirmed and checkInvite has resolved, validate the invite
  useEffect(() => {
    if (!userId) return
    if (checkInvite === undefined) return // still loading
    if (!code) return

    if (!checkInvite.valid) {
      const reasonMessages: Record<string, { title: string; message: string }> = {
        not_found: {
          title: 'Invite Not Found',
          message: "This invite code doesn't exist. Ask the host to send you a new one.",
        },
        expired: {
          title: 'Invite Expired',
          message: 'This invite has expired. Ask the host to send you a fresh one.',
        },
        used: {
          title: 'Invite Used',
          message: 'This invite has already been used. Ask the host for a new invite.',
        },
        ended: {
          title: 'Fire Ended',
          message: 'This bondfire has ended.',
        },
        invalid: {
          title: 'Invalid Invite',
          message: 'This invite is not valid for a personal camp bondfire.',
        },
        frozen: {
          title: 'Camp Unavailable',
          message:
            'The personal camp is currently unavailable. The owner may have cancelled their subscription.',
        },
      }
      const err = reasonMessages[checkInvite.reason] ?? {
        title: 'Something Went Wrong',
        message: 'This invite could not be processed. Please try again.',
      }

      telemetry.warn('deeplink:personal-bondfire:invalid', {
        reason: checkInvite.reason,
        bondfireId,
        code,
      })

      Alert.alert(err.title, err.message, [
        {
          text: 'Go Home',
          onPress: () => router.replace('/(main)/(tabs)/feed'),
        },
      ])
      return
    }

    // Invite is valid — redeem it
    telemetry.breadcrumb('deeplink:personal-bondfire:redeeming', {
      bondfireId,
      code,
    })

    redeemInvite({ code })
      .then((result) => {
        telemetry.breadcrumb('deeplink:personal-bondfire:redeemed', {
          bondfireId: result.bondfireId,
          alreadyJoined: result.alreadyJoined,
        })
        navigateToBondfire(result.bondfireId)
      })
      .catch((error) => {
        const message = error?.message ?? 'Something went wrong joining this fire.'
        telemetry.error('deeplink:personal-bondfire:redeem-failed', message)

        if (message.includes('full')) {
          Alert.alert('Fire Full', 'This fire is full.', [
            {
              text: 'Go Home',
              onPress: () => router.replace('/(main)/(tabs)/feed'),
            },
          ])
        } else if (message.includes('frozen')) {
          Alert.alert('Camp Unavailable', 'The personal camp is currently unavailable.', [
            {
              text: 'Go Home',
              onPress: () => router.replace('/(main)/(tabs)/feed'),
            },
          ])
        } else {
          Alert.alert('Something Went Wrong', 'Could not join this fire. Please try again.', [
            {
              text: 'Go Home',
              onPress: () => router.replace('/(main)/(tabs)/feed'),
            },
          ])
        }
      })
  }, [userId, checkInvite, code, bondfireId, redeemInvite, navigateToBondfire, router])

  if (!bondfireId || !code) {
    return (
      <YStack
        flex={1}
        backgroundColor={bondfireColors.obsidian}
        alignItems="center"
        justifyContent="center"
        gap={12}
      >
        <Text fontSize={16} color={bondfireColors.whiteSmoke}>
          Invalid invite link.
        </Text>
      </YStack>
    )
  }

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <YStack
        flex={1}
        backgroundColor={bondfireColors.obsidian}
        alignItems="center"
        justifyContent="center"
        gap={16}
      >
        <Spinner size="large" color={bondfireColors.bondfireCopper} />
        <Text fontSize={16} color={bondfireColors.ash}>
          Joining bondfire...
        </Text>
      </YStack>
    </>
  )
}

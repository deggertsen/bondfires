import { telemetry } from '@bondfires/app'
import { Spinner, Text } from '@bondfires/ui'
import { useMutation, useQuery } from 'convex/react'
import { Stack, useLocalSearchParams, useRouter } from 'expo-router'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Alert } from 'react-native'
import { YStack } from 'tamagui'
import { api } from '../../../../../../convex/_generated/api'
import type { Id } from '../../../../../../convex/_generated/dataModel'
import { personalBondfirePath, routes } from '../../../../lib/routes'

export default function PersonalBondfireInviteScreen() {
  const { bondfireId, code } = useLocalSearchParams<{ bondfireId: string; code: string }>()
  const router = useRouter()
  const currentUser = useQuery(api.users.current)

  const authRedirectedRef = useRef(false)
  const inviteHandledRef = useRef(false)

  const checkInviteMutation = useMutation(api.personalBondfires.checkInviteSecure)
  const [checkInvite, setCheckInvite] = useState<
    { valid: true; bondfireId: Id<'bondfires'> } | { valid: false; reason: 'unavailable' }
  >()
  const inviteCheckKeyRef = useRef<string | undefined>(undefined)
  const redeemInvite = useMutation(api.personalBondfires.redeemInvite)

  useEffect(() => {
    if (!currentUser || !code || !bondfireId) return
    const requestKey = `${currentUser._id}:${bondfireId}:${code}`
    if (inviteCheckKeyRef.current === requestKey) return
    inviteCheckKeyRef.current = requestKey
    setCheckInvite(undefined)
    checkInviteMutation({ code, bondfireId: bondfireId as Id<'bondfires'> })
      .then((result) => {
        if (inviteCheckKeyRef.current === requestKey) setCheckInvite(result)
      })
      .catch(() => {
        if (inviteCheckKeyRef.current === requestKey) {
          setCheckInvite({ valid: false, reason: 'unavailable' })
        }
      })
  }, [bondfireId, checkInviteMutation, code, currentUser])

  const navigateToBondfire = useCallback(
    (id: string) => {
      router.replace(routes.bondfire(id))
    },
    [router],
  )

  const navigateToAuth = useCallback(
    (returnUrl: string) => {
      router.replace(routes.login(returnUrl))
    },
    [router],
  )

  useEffect(() => {
    if (authRedirectedRef.current) return
    if (!bondfireId || !code) return

    // Auth is still loading
    if (currentUser === undefined) return

    // User is not authenticated — redirect to login with return link
    if (!currentUser) {
      authRedirectedRef.current = true
      const returnUrl = personalBondfirePath(bondfireId, code)
      telemetry.breadcrumb('deeplink:personal-bondfire:auth-required', { bondfireId })
      navigateToAuth(returnUrl)
      return
    }
  }, [currentUser, bondfireId, code, navigateToAuth])

  // Once auth is confirmed and checkInvite has resolved, validate the invite
  useEffect(() => {
    if (!currentUser) return
    if (inviteHandledRef.current) return
    if (checkInvite === undefined) return // still loading
    if (!code) return

    if (!checkInvite.valid || checkInvite.bondfireId !== bondfireId) {
      inviteHandledRef.current = true
      const reason = checkInvite.valid ? 'invalid' : (checkInvite.reason ?? 'invalid')
      telemetry.warn('deeplink:personal-bondfire:invalid', 'Invalid personal bondfire invite', {
        reason: checkInvite.valid ? 'bondfire_mismatch' : reason,
        bondfireId,
      })

      Alert.alert('Invite Unavailable', 'Ask the sender for a new invite link.', [
        {
          text: 'Go Home',
          onPress: () => router.replace(routes.feed),
        },
      ])
      return
    }

    // Invite is valid — redeem it
    inviteHandledRef.current = true
    telemetry.breadcrumb('deeplink:personal-bondfire:redeeming', {
      bondfireId,
    })

    redeemInvite({ code })
      .then((result) => {
        if ('invalid' in result) {
          throw new Error('Invite unavailable')
        }
        telemetry.breadcrumb('deeplink:personal-bondfire:redeemed', {
          bondfireId: result.bondfireId,
          alreadyJoined: result.alreadyJoined,
        })
        navigateToBondfire(result.bondfireId)
      })
      .catch((error) => {
        const message = error?.message ?? 'Something went wrong joining this fire.'
        telemetry.error('deeplink:personal-bondfire:redeem-failed', message)

        if (message.includes('unavailable')) {
          Alert.alert('Invite Unavailable', 'Ask the sender for a new invite link.', [
            {
              text: 'Go Home',
              onPress: () => router.replace(routes.feed),
            },
          ])
        } else if (message.includes('full')) {
          Alert.alert('Fire Full', 'This fire is full.', [
            {
              text: 'Go Home',
              onPress: () => router.replace(routes.feed),
            },
          ])
        } else if (message.includes('frozen')) {
          Alert.alert('Camp Unavailable', 'The hearth is currently unavailable.', [
            {
              text: 'Go Home',
              onPress: () => router.replace(routes.feed),
            },
          ])
        } else {
          Alert.alert('Something Went Wrong', 'Could not join this fire. Please try again.', [
            {
              text: 'Go Home',
              onPress: () => router.replace(routes.feed),
            },
          ])
        }
      })
  }, [currentUser, checkInvite, code, bondfireId, redeemInvite, navigateToBondfire, router])

  if (!bondfireId || !code) {
    return (
      <YStack
        flex={1}
        backgroundColor={'$background'}
        alignItems="center"
        justifyContent="center"
        gap={12}
      >
        <Text fontSize={16} color={'$color'}>
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
        backgroundColor={'$background'}
        alignItems="center"
        justifyContent="center"
        gap={16}
      >
        <Spinner size="large" color={'$primary'} />
        <Text fontSize={16} color={'$placeholderColor'}>
          Joining bondfire...
        </Text>
      </YStack>
    </>
  )
}

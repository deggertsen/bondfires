import { subscriptionActions, useAppThemeColors } from '@bondfires/app'
import { Button, Spinner, Text } from '@bondfires/ui'
import { ArrowLeft, Flame, Lock, MessageCircle, Plus, Users } from '@tamagui/lucide-icons'
import { useQuery } from 'convex/react'
import { useLocalSearchParams, useNavigation, useRouter } from 'expo-router'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { FlatList, Pressable, StatusBar } from 'react-native'
import { Separator, XStack, YStack } from 'tamagui'
import { api } from '../../../../convex/_generated/api'
import type { Doc, Id } from '../../../../convex/_generated/dataModel'
import { PersonalInviteSheet } from '../../components/PersonalInviteSheet'
import { goBackOrReplace } from '../../lib/navigation'
import { routes } from '../../lib/routes'

type BondfireData = Doc<'bondfires'> & {
  participantCount: number
}

function getTimeAgo(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000)
  if (seconds < 60) return 'just now'
  if (seconds < 3600) return [Math.floor(seconds / 60), 'm ago'].join('')
  if (seconds < 86400) return [Math.floor(seconds / 3600), 'h ago'].join('')
  if (seconds < 604800) return [Math.floor(seconds / 86400), 'd ago'].join('')
  return [Math.floor(seconds / 604800), 'w ago'].join('')
}

function BondfireRow({ bondfire, onOpen }: { bondfire: BondfireData; onOpen: () => void }) {
  const responses = Math.max(0, bondfire.videoCount - 1)

  return (
    <Pressable onPress={onOpen}>
      <XStack paddingHorizontal={16} paddingVertical={13} gap={12} alignItems="center">
        <YStack
          width={50}
          height={50}
          borderRadius={15}
          backgroundColor={'$backgroundHover'}
          borderWidth={1}
          borderColor={'$borderColor'}
          alignItems="center"
          justifyContent="center"
        >
          <Flame size={24} color={'$primary'} />
        </YStack>

        <YStack flex={1} gap={4}>
          <Text fontSize={16} fontWeight="900" numberOfLines={1}>
            {bondfire.creatorName ?? 'Anonymous'}
          </Text>
          <Text fontSize={12} color={'$placeholderColor'}>
            {bondfire.videoStatus === 'live' ? 'Live now' : getTimeAgo(bondfire.createdAt)}
          </Text>
        </YStack>

        <XStack alignItems="center" gap={12}>
          <XStack alignItems="center" gap={4}>
            <Users size={15} color={'$placeholderColor'} />
            <Text fontSize={13} color={'$placeholderColor'}>
              {bondfire.participantCount}
            </Text>
          </XStack>
          <XStack alignItems="center" gap={4}>
            <MessageCircle size={15} color={'$placeholderColor'} />
            <Text fontSize={13} color={'$placeholderColor'}>
              {responses}
            </Text>
          </XStack>
        </XStack>
      </XStack>
    </Pressable>
  )
}

export default function PersonalCampScreen() {
  const { statusBarStyle } = useAppThemeColors()
  const router = useRouter()
  const navigation = useNavigation()
  const { newFire, createdAfter } = useLocalSearchParams<{
    newFire?: string
    createdAfter?: string
  }>()
  const [inviteFireId, setInviteFireId] = useState<Id<'bondfires'> | null>(null)
  const handledInviteRouteRef = useRef<string | null>(null)
  const personalCamp = useQuery(api.personalCamps.getMyPersonalCamp, {})
  const bondfires = useQuery(
    api.personalBondfires.listMyPersonalBondfires,
    personalCamp ? {} : 'skip',
  )

  const sortedBondfires = useMemo(() => {
    if (!bondfires) return bondfires
    return [...bondfires].sort((a, b) => b.createdAt - a.createdAt)
  }, [bondfires])

  useEffect(() => {
    if (!newFire) return
    const inviteRouteKey = [newFire, createdAfter ?? ''].join(':')
    if (handledInviteRouteRef.current === inviteRouteKey) return
    if (!sortedBondfires || sortedBondfires.length === 0) return

    if (newFire !== 'new') {
      setInviteFireId(newFire as Id<'bondfires'>)
      handledInviteRouteRef.current = inviteRouteKey
      return
    }

    const parsedCreatedAfter = Number(createdAfter)
    const createdAfterCutoff = Number.isFinite(parsedCreatedAfter)
      ? parsedCreatedAfter - 5000
      : undefined
    const newest = sortedBondfires.find(
      (bondfire) => createdAfterCutoff === undefined || bondfire.createdAt >= createdAfterCutoff,
    )
    if (newest) {
      setInviteFireId(newest._id)
      handledInviteRouteRef.current = inviteRouteKey
    }
  }, [createdAfter, newFire, sortedBondfires])

  const handleBack = useCallback(() => {
    goBackOrReplace(router, navigation, routes.feed)
  }, [navigation, router])

  const handleOpenBondfire = useCallback(
    (bondfireId: Id<'bondfires'>) => {
      router.push(routes.bondfire(bondfireId))
    },
    [router],
  )

  const handleUpgrade = useCallback(() => {
    subscriptionActions.showPaywall()
  }, [])

  const handleCreateBondfire = useCallback(() => {
    router.push(routes.createForPersonalCamp())
  }, [router])

  const handleCloseInvite = useCallback(() => {
    setInviteFireId(null)
  }, [])

  // Loading state
  if (personalCamp === undefined) {
    return (
      <YStack
        flex={1}
        backgroundColor={'$backgroundPress'}
        alignItems="center"
        justifyContent="center"
      >
        <StatusBar barStyle={statusBarStyle} />
        <Spinner size="large" color={'$primary'} />
      </YStack>
    )
  }

  // No hearth — empty state
  if (personalCamp === null) {
    return (
      <YStack
        flex={1}
        backgroundColor={'$backgroundPress'}
        paddingTop={58}
        paddingHorizontal={16}
        gap={16}
      >
        <StatusBar barStyle={statusBarStyle} />
        <Pressable onPress={handleBack}>
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
        <YStack flex={1} alignItems="center" justifyContent="center" gap={12}>
          <Flame size={48} color={'$placeholderColor'} />
          <Text fontSize={18} fontWeight="900" color={'$placeholderColor'} textAlign="center">
            No Hearth
          </Text>
          <Text fontSize={14} color={'$placeholderColor'} textAlign="center" lineHeight={20}>
            Subscribe to Plus, Premium, or Pro to unlock your Hearth.
          </Text>
          <Button marginTop={8} onPress={handleUpgrade}>
            View Plans
          </Button>
        </YStack>
      </YStack>
    )
  }

  const isFrozen = personalCamp.status === 'frozen'

  return (
    <YStack flex={1} backgroundColor={'$backgroundPress'}>
      <StatusBar barStyle={statusBarStyle} />

      {/* Header */}
      <YStack paddingTop={58} paddingHorizontal={16} paddingBottom={18} gap={14}>
        <XStack alignItems="center" justifyContent="space-between">
          <Pressable onPress={handleBack}>
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
          {bondfires && bondfires.length > 0 && !isFrozen && (
            <Pressable onPress={handleCreateBondfire}>
              <YStack
                width={42}
                height={42}
                borderRadius={21}
                alignItems="center"
                justifyContent="center"
                backgroundColor={'$primary'}
              >
                <Plus size={22} color={'$color'} />
              </YStack>
            </Pressable>
          )}
        </XStack>

        <XStack alignItems="center" gap={14}>
          <YStack
            width={72}
            height={72}
            borderRadius={20}
            backgroundColor={'$primary'}
            alignItems="center"
            justifyContent="center"
          >
            <Flame size={36} color={'$color'} />
          </YStack>

          <YStack flex={1} gap={4}>
            <Text fontSize={26} fontWeight="900" numberOfLines={2}>
              {personalCamp.name}
            </Text>
            <Text fontSize={14} color={'$placeholderColor'}>
              Your hearth
            </Text>
          </YStack>
        </XStack>

        {/* Frozen banner */}
        {isFrozen ? (
          <YStack
            backgroundColor={'rgba(245, 158, 11, 0.13)'}
            borderColor={'$warning'}
            borderWidth={1}
            borderRadius={12}
            padding={12}
          >
            <XStack alignItems="center" gap={8}>
              <Lock size={16} color={'$warning'} />
              <Text color={'$warning'} fontSize={14} fontWeight="700">
                Your Hearth is frozen
              </Text>
            </XStack>
            <Text color={'$placeholderColor'} fontSize={12} marginTop={4}>
              Re-subscribe to Plus, Premium, or Pro to reactivate your Hearth.
            </Text>
          </YStack>
        ) : null}
      </YStack>

      <Separator borderColor={'rgba(51, 53, 58, 0.25)'} />

      {/* Bondfires list */}
      {bondfires === undefined ? (
        <YStack flex={1} alignItems="center" justifyContent="center">
          <Spinner size="large" color={'$primary'} />
        </YStack>
      ) : bondfires.length === 0 ? (
        <YStack
          flex={1}
          alignItems="center"
          justifyContent="center"
          paddingHorizontal={32}
          gap={12}
        >
          <Flame size={48} color={'$placeholderColor'} />
          <Text fontSize={18} fontWeight="900" color={'$placeholderColor'} textAlign="center">
            No fires yet
          </Text>
          <Text fontSize={14} color={'$placeholderColor'} textAlign="center" lineHeight={20}>
            Your personal bondfires will appear here.
          </Text>
          {!isFrozen && (
            <Button
              variant="primary"
              marginTop={8}
              onPress={handleCreateBondfire}
              icon={<Plus size={18} color={'$color'} />}
            >
              <Text color={'$color'} fontWeight="900">
                Create Bondfire
              </Text>
            </Button>
          )}
        </YStack>
      ) : (
        <FlatList
          data={bondfires}
          keyExtractor={(item) => item._id}
          ItemSeparatorComponent={() => <Separator borderColor={'rgba(51, 53, 58, 0.25)'} />}
          contentContainerStyle={{ paddingBottom: 40 }}
          renderItem={({ item }) => (
            <BondfireRow bondfire={item} onOpen={() => handleOpenBondfire(item._id)} />
          )}
        />
      )}

      {/* Invite Sheet */}
      {inviteFireId && (
        <PersonalInviteSheet bondfireId={inviteFireId} open={true} onClose={handleCloseInvite} />
      )}
    </YStack>
  )
}

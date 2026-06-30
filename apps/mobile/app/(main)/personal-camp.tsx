import {
  subscriptionActions,
  telemetry,
  useAppThemeColors,
  useRecordingResourceLock,
} from '@bondfires/app'
import { BondfireRow, type BondfireRowProps, Button, Spinner, Text } from '@bondfires/ui'
import { useIsFocused } from '@react-navigation/native'
import { ArrowLeft, Flame, Lock, Plus } from '@tamagui/lucide-icons'
import { useAction, useMutation, useQuery } from 'convex/react'
import { useLocalSearchParams, useNavigation, useRouter } from 'expo-router'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Alert, FlatList, Pressable, StatusBar } from 'react-native'
import { Separator, XStack, YStack } from 'tamagui'
import { api } from '../../../../convex/_generated/api'
import type { Doc, Id } from '../../../../convex/_generated/dataModel'
import { EditTitleSheet, useEditTitleSheet } from '../../components/EditTitleSheet'
import { InviteSheet } from '../../components/InviteSheet'
import {
  BONDFIRE_REPORT_OPTIONS,
  getBondfireRightSwipeActions,
  getBondfireSwipeActions,
  getSwipeReportComment,
} from '../../lib/bondfireSwipeActions'
import { goBackOrReplace } from '../../lib/navigation'
import { routes } from '../../lib/routes'

type BondfireData = Doc<'bondfires'> & {
  participantCount: number
  campLabel?: string
}

export default function PersonalCampScreen() {
  const { statusBarStyle } = useAppThemeColors()
  const router = useRouter()
  const navigation = useNavigation()
  const isFocused = useIsFocused()
  const recordingResourceLocked = useRecordingResourceLock()
  const shouldRunBackgroundWork = isFocused && !recordingResourceLocked
  const { newFire, createdAfter } = useLocalSearchParams<{
    newFire?: string
    createdAfter?: string
  }>()
  const [inviteFireId, setInviteFireId] = useState<Id<'bondfires'> | null>(null)
  const handledInviteRouteRef = useRef<string | null>(null)

  const personalCamp = useQuery(
    api.personalCamps.getMyPersonalCamp,
    shouldRunBackgroundWork ? {} : 'skip',
  )
  const bondfires = useQuery(
    api.personalBondfires.listMyPersonalBondfires,
    shouldRunBackgroundWork && personalCamp ? {} : 'skip',
  )

  // Thumbnail loading (same pattern as feed)
  const getThumbnailUrl = useAction(api.videos.getThumbnailUrl)
  const [thumbnailUrls, setThumbnailUrls] = useState<Record<string, string | null>>({})
  const loadingThumbsRef = useRef<Set<string>>(new Set())

  // Auth user for pin state
  const currentUser = useQuery(api.users.current, shouldRunBackgroundWork ? {} : 'skip')
  const pinnedIds = useMemo(
    () => (currentUser?.pinnedBondfireIds ?? []) as string[],
    [currentUser?.pinnedBondfireIds],
  )

  // Mutations
  const deleteBondfire = useMutation(api.personalBondfires.deleteBondfire)
  const pinBondfire = useMutation(api.bondfires.pinBondfire)
  const unpinBondfire = useMutation(api.bondfires.unpinBondfire)
  const reportBondfire = useMutation(api.reports.submit)

  // Add camp label and sort
  const enrichedBondfires = useMemo(() => {
    if (!bondfires || !personalCamp) return undefined
    return bondfires.map((b) => ({
      ...b,
      campLabel: personalCamp.name,
    }))
  }, [bondfires, personalCamp])

  // Handle invite sheet routing from params
  useEffect(() => {
    if (!newFire || !enrichedBondfires || enrichedBondfires.length === 0) return
    const inviteRouteKey = `${newFire}:${createdAfter ?? ''}`
    if (handledInviteRouteRef.current === inviteRouteKey) return

    if (newFire !== 'new') {
      setInviteFireId(newFire as Id<'bondfires'>)
      handledInviteRouteRef.current = inviteRouteKey
      return
    }

    const parsedCreatedAfter = Number(createdAfter)
    const createdAfterCutoff = Number.isFinite(parsedCreatedAfter)
      ? parsedCreatedAfter - 5000
      : undefined
    const newest = enrichedBondfires.find(
      (b) => createdAfterCutoff === undefined || b.createdAt >= createdAfterCutoff,
    )
    if (newest) {
      setInviteFireId(newest._id)
      handledInviteRouteRef.current = inviteRouteKey
    }
  }, [createdAfter, newFire, enrichedBondfires])

  // Lazy-load thumbnails
  const ensureThumbnailUrl = useCallback(
    async (bondfire: BondfireData) => {
      if (!shouldRunBackgroundWork) return
      if (!bondfire.muxPlaybackId) return
      if (thumbnailUrls[bondfire._id] !== undefined) return
      if (loadingThumbsRef.current.has(bondfire._id)) return

      loadingThumbsRef.current.add(bondfire._id)
      try {
        const result = await getThumbnailUrl({
          muxPlaybackId: bondfire.muxPlaybackId,
          muxPlaybackPolicy: bondfire.muxPlaybackPolicy,
          bondfireId: bondfire._id,
        })
        setThumbnailUrls((prev) => ({ ...prev, [bondfire._id]: result.thumbnailUrl }))
      } catch (error) {
        setThumbnailUrls((prev) => ({ ...prev, [bondfire._id]: null }))
        telemetry.warn('personalCamp:thumbnail', 'Failed to load thumbnail URL', {
          bondfireId: bondfire._id,
          error: String(error),
        })
      } finally {
        loadingThumbsRef.current.delete(bondfire._id)
      }
    },
    [getThumbnailUrl, shouldRunBackgroundWork, thumbnailUrls],
  )

  // Preload first 10 thumbnails
  useEffect(() => {
    if (!shouldRunBackgroundWork || !enrichedBondfires) return
    for (const bondfire of enrichedBondfires.slice(0, 10)) {
      ensureThumbnailUrl(bondfire)
    }
  }, [enrichedBondfires, ensureThumbnailUrl, shouldRunBackgroundWork])

  // Preload thumbnails for visible items
  const handleViewableChanged = useCallback(
    ({ viewableItems }: { viewableItems: { index: number | null }[] }) => {
      if (!shouldRunBackgroundWork || !enrichedBondfires) return
      const indices = viewableItems
        .map((v) => v.index)
        .filter((i): i is number => typeof i === 'number' && i >= 0)
      if (indices.length === 0) return

      const minIdx = Math.max(0, Math.min(...indices) - 2)
      const maxIdx = Math.min(enrichedBondfires.length - 1, Math.max(...indices) + 8)
      for (let i = minIdx; i <= maxIdx; i++) {
        ensureThumbnailUrl(enrichedBondfires[i])
      }
    },
    [enrichedBondfires, ensureThumbnailUrl, shouldRunBackgroundWork],
  )
  const viewabilityConfig = useRef({ itemVisiblePercentThreshold: 10 }).current

  // ── Navigation ──────────────────────────────────────────────────────

  const handleBack = useCallback(() => {
    goBackOrReplace(router, navigation, routes.feed)
  }, [navigation, router])

  const handleOpenBondfire = useCallback(
    (bondfireId: string) => {
      router.push(routes.bondfire(bondfireId))
    },
    [router],
  )

  const handleRespond = useCallback(
    (bondfireId: string) => {
      router.push(routes.createRespondTo(bondfireId))
    },
    [router],
  )

  const handleCreateBondfire = useCallback(() => {
    router.push(routes.createForPersonalCamp())
  }, [router])

  const handleCloseInvite = useCallback(() => {
    setInviteFireId(null)
  }, [])

  // ── Swipe actions ───────────────────────────────────────────────────

  const handleDelete = useCallback(
    (bondfireId: string) => {
      Alert.alert(
        'Delete Bondfire',
        'This will permanently remove your bondfire and all responses. This cannot be undone.',
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Delete',
            style: 'destructive',
            onPress: async () => {
              try {
                await deleteBondfire({ bondfireId: bondfireId as Id<'bondfires'> })
              } catch (error) {
                Alert.alert('Error', 'Failed to delete bondfire. Please try again.')
                telemetry.error('personalCamp:deleteBondfire', String(error))
              }
            },
          },
        ],
      )
    },
    [deleteBondfire],
  )

  const handlePin = useCallback(
    async (bondfireId: string) => {
      try {
        await pinBondfire({ bondfireId: bondfireId as Id<'bondfires'> })
      } catch {
        Alert.alert('Error', 'Failed to pin bondfire.')
      }
    },
    [pinBondfire],
  )

  const handleUnpin = useCallback(
    async (bondfireId: string) => {
      try {
        await unpinBondfire({ bondfireId: bondfireId as Id<'bondfires'> })
      } catch {
        Alert.alert('Error', 'Failed to unpin bondfire.')
      }
    },
    [unpinBondfire],
  )

  const handleReport = useCallback(
    (bondfireId: string, videoOwnerId: string) => {
      Alert.alert('Report Content', 'What category best describes the issue?', [
        { text: 'Cancel', style: 'cancel' },
        ...BONDFIRE_REPORT_OPTIONS.map((option) => ({
          text: option.label,
          onPress: async () => {
            try {
              await reportBondfire({
                bondfireId: bondfireId as Id<'bondfires'>,
                videoOwnerId: videoOwnerId as Id<'users'>,
                category: 'community_guidelines',
                subCategory: option.subCategory,
                comments: getSwipeReportComment('personal-camp'),
              })
              Alert.alert('Reported', 'Thank you. We will review this content.')
            } catch {
              Alert.alert('Error', 'Failed to submit report.')
            }
          },
        })),
      ])
    },
    [reportBondfire],
  )

  const handleUpgrade = useCallback(() => {
    subscriptionActions.showPaywall()
  }, [])

  const { editingBondfire, openEditTitleSheet, closeEditTitleSheet } = useEditTitleSheet()

  // ── Build BondfireRow props ─────────────────────────────────────────

  const toBondfireRowProps = useCallback(
    (bondfire: BondfireData): BondfireRowProps => {
      const isOwner = bondfire.userId === currentUser?._id
      const isPinned = pinnedIds.includes(bondfire._id)

      return {
        title: bondfire.title,
        creatorName: bondfire.creatorName ?? 'Anonymous',
        timestamp: bondfire.createdAt,
        videoCount: bondfire.videoCount,
        campLabel: bondfire.campLabel,
        thumbnailUrl: thumbnailUrls[bondfire._id] ?? null,
        isLive: bondfire.videoStatus === 'live',
        statusLabel: '',
        participants: [],
        actions: getBondfireSwipeActions({
          isOwner,
          isPinned,
          onDelete: () => handleDelete(bondfire._id),
          onPin: () => handlePin(bondfire._id),
          onUnpin: () => handleUnpin(bondfire._id),
          onReport: () => handleReport(bondfire._id, bondfire.userId),
        }),
        rightActions: getBondfireRightSwipeActions({
          isOwner,
          onEdit: () =>
            openEditTitleSheet(
              bondfire._id,
              bondfire.title ?? '',
              bondfire.creatorName ?? undefined,
            ),
        }),
        onOpen: () => handleOpenBondfire(bondfire._id),
        onRespond: () => handleRespond(bondfire._id),
      }
    },
    [
      currentUser?._id,
      pinnedIds,
      thumbnailUrls,
      handleDelete,
      handlePin,
      handleUnpin,
      handleReport,
      openEditTitleSheet,
      handleOpenBondfire,
      handleRespond,
    ],
  )

  // ── Render states ───────────────────────────────────────────────────

  // Loading
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

      {/* Bondfires list using shared BondfireRow */}
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
          data={enrichedBondfires}
          keyExtractor={(item) => item._id}
          ItemSeparatorComponent={() => (
            <Separator borderColor={'$borderColor'} opacity={0.6} marginHorizontal={16} />
          )}
          contentContainerStyle={{ paddingBottom: 40 }}
          renderItem={({ item }) => <BondfireRow {...toBondfireRowProps(item)} />}
          onViewableItemsChanged={handleViewableChanged}
          viewabilityConfig={viewabilityConfig}
        />
      )}

      {/* Invite Sheet */}
      {inviteFireId && (
        <InviteSheet
          mode="personal-bondfire"
          id={inviteFireId}
          open={true}
          onClose={handleCloseInvite}
        />
      )}

      {/* Edit Title Sheet */}
      {editingBondfire && (
        <EditTitleSheet
          bondfireId={editingBondfire.id}
          currentTitle={editingBondfire.title}
          creatorName={editingBondfire.creatorName}
          open={true}
          onClose={closeEditTitleSheet}
        />
      )}
    </YStack>
  )
}

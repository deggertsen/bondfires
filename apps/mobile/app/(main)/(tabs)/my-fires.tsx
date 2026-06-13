import {
  appActions,
  getBondfireVideoIndex,
  getErrorMessage,
  setBondfireVideoIndex,
  setFeedActiveBondfireId,
  telemetry,
  useAppThemeColors,
  useCurrentUserId,
} from '@bondfires/app'
import { BondfireRow, type BondfireRowProps, Button, Spinner, Text } from '@bondfires/ui'
import { Flame, Pin } from '@tamagui/lucide-icons'
import { useAction, useMutation, useQuery } from 'convex/react'
import { useRouter } from 'expo-router'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Alert, FlatList, Pressable, RefreshControl, StatusBar } from 'react-native'
import { Separator, XStack, YStack } from 'tamagui'
import { api } from '../../../../../convex/_generated/api'
import type { Doc, Id } from '../../../../../convex/_generated/dataModel'
import {
  BONDFIRE_REPORT_OPTIONS,
  getBondfireSwipeActions,
  getSwipeReportComment,
} from '../../../lib/bondfireSwipeActions'
import { routes } from '../../../lib/routes'

type ThreadParticipant = {
  user: PublicUser
  latestAt: number
  videoCount: number
  isPinned: boolean
}

type PublicUser = {
  _id: Id<'users'>
  displayName?: string
  name?: string
  photoUrl?: string
}

type MyFire = Doc<'bondfires'> & {
  camp: Doc<'camps'> | null
  lastActivityAt: number
  unread: boolean
  participants: ThreadParticipant[]
}

function toBondfireRowProps(
  thread: MyFire,
  thumbnailUrl: string | null,
  currentUserId: string | null,
  pinnedIds: string[],
  onOpen: () => void,
  onRespond: () => void,
  onDelete: () => void,
  onPin: () => void,
  onUnpin: () => void,
  onReport: () => void,
): BondfireRowProps {
  const isOwner = currentUserId === thread.userId
  const isPinned = pinnedIds.includes(thread._id)

  return {
    creatorName: thread.creatorName ?? 'Anonymous',
    timestamp: thread.lastActivityAt,
    videoCount: thread.videoCount,
    campLabel: thread.camp?.name,
    thumbnailUrl,
    isLive: thread.videoStatus === 'live',
    statusLabel: thread.unread ? 'New' : 'Viewed',
    participants: thread.participants.map((participant) => ({
      userId: participant.user._id,
      displayName: participant.user.displayName ?? participant.user.name,
      photoUrl: participant.user.photoUrl,
    })),
    actions: getBondfireSwipeActions({
      isOwner,
      isPinned,
      onDelete,
      onPin,
      onUnpin,
      onReport,
    }),
    onOpen,
    onRespond,
  }
}

export default function MyFiresScreen() {
  const { colors, statusBarStyle } = useAppThemeColors()
  const router = useRouter()
  const [refreshKey, setRefreshKey] = useState(0)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [pinnedFirst, setPinnedFirst] = useState(false)
  const threads = useQuery(api.conversations.listMyFires, { limit: 80, pinnedFirst }) as
    | MyFire[]
    | undefined
  const getThumbnailUrl = useAction(api.videos.getThumbnailUrl)

  // Swipe action mutations
  const deleteBondfire = useMutation(api.bondfires.deleteBondfire)
  const pinBondfire = useMutation(api.bondfires.pinBondfire)
  const unpinBondfire = useMutation(api.bondfires.unpinBondfire)
  const reportBondfire = useMutation(api.reports.submit)
  const { userId: currentUserId, isLoading: isUserLoading, currentUser } = useCurrentUserId()

  const pinnedIds = useMemo(
    () => (currentUser?.pinnedBondfireIds ?? []) as string[],
    [currentUser?.pinnedBondfireIds],
  )

  useEffect(() => {
    if (!threads || isUserLoading || !currentUserId) {
      return
    }

    const ownedThreads = threads.filter((thread) => thread.userId === currentUserId)
    if (ownedThreads.length === 0) {
      return
    }

    telemetry.breadcrumb('myFires:ownership-check', {
      ownedCount: ownedThreads.length,
      currentUserId,
      threadCount: threads.length,
    })
  }, [currentUserId, isUserLoading, threads])

  const [thumbnailUrls, setThumbnailUrls] = useState<Record<string, string | null>>({})
  const loadingThumbsRef = useRef<Set<string>>(new Set())
  const listExtraData = useMemo(
    () => ({ currentUserId, pinnedIds, thumbnailUrls }),
    [currentUserId, pinnedIds, thumbnailUrls],
  )

  const ensureThumbnailUrl = useCallback(
    async (thread: MyFire) => {
      if (!thread.muxPlaybackId) return
      if (thumbnailUrls[thread._id] !== undefined) return
      if (loadingThumbsRef.current.has(thread._id)) return

      loadingThumbsRef.current.add(thread._id)
      try {
        const { thumbnailUrl } = await getThumbnailUrl({
          muxPlaybackId: thread.muxPlaybackId,
          muxPlaybackPolicy: thread.muxPlaybackPolicy,
          bondfireId: thread._id,
        })
        setThumbnailUrls((prev) =>
          prev[thread._id] === undefined ? { ...prev, [thread._id]: thumbnailUrl } : prev,
        )
      } catch {
        setThumbnailUrls((prev) =>
          prev[thread._id] === undefined ? { ...prev, [thread._id]: null } : prev,
        )
      } finally {
        loadingThumbsRef.current.delete(thread._id)
      }
    },
    [getThumbnailUrl, thumbnailUrls],
  )

  useEffect(() => {
    if (!threads) return
    for (const thread of threads.slice(0, 10)) {
      ensureThumbnailUrl(thread)
    }
  }, [ensureThumbnailUrl, threads])

  const unreadCount = useMemo(
    () => threads?.filter((thread) => thread.unread).length ?? 0,
    [threads],
  )

  const handleRefresh = useCallback(() => {
    setThumbnailUrls({})
    loadingThumbsRef.current = new Set()
    setIsRefreshing(true)
    setRefreshKey((current) => current + 1)
    setTimeout(() => setIsRefreshing(false), 800)
  }, [])

  const handleOpen = useCallback(
    (bondfireId: string) => {
      setFeedActiveBondfireId(bondfireId)
      setBondfireVideoIndex(bondfireId, getBondfireVideoIndex(bondfireId) ?? 0)
      appActions.setVideoMuted(false)
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
              } catch (_error) {
                Alert.alert('Error', 'Failed to delete bondfire. Please try again.')
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
      } catch (error) {
        Alert.alert('Error', getErrorMessage(error))
      }
    },
    [pinBondfire],
  )

  const handleUnpin = useCallback(
    async (bondfireId: string) => {
      try {
        await unpinBondfire({ bondfireId: bondfireId as Id<'bondfires'> })
      } catch (error) {
        Alert.alert('Error', getErrorMessage(error))
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
                comments: getSwipeReportComment('My Fires'),
              })
              Alert.alert('Reported', 'Thank you. We will review this content.')
            } catch (error) {
              Alert.alert('Error', getErrorMessage(error))
            }
          },
        })),
      ])
    },
    [reportBondfire],
  )

  if (threads === undefined || isUserLoading) {
    return (
      <YStack flex={1} backgroundColor={'$background'}>
        <StatusBar barStyle={statusBarStyle} backgroundColor={colors.background} />
        <YStack flex={1} alignItems="center" justifyContent="center">
          <Spinner size="large" color={'$primary'} />
        </YStack>
      </YStack>
    )
  }

  return (
    <YStack flex={1} backgroundColor={'$background'}>
      <StatusBar barStyle={statusBarStyle} backgroundColor={colors.background} />
      <FlatList
        key={refreshKey}
        data={threads}
        extraData={listExtraData}
        keyExtractor={(item) => item._id}
        refreshControl={
          <RefreshControl
            refreshing={isRefreshing}
            onRefresh={handleRefresh}
            tintColor={colors.primary}
            colors={[colors.primary]}
          />
        }
        renderItem={({ item }) => {
          const props = toBondfireRowProps(
            item,
            thumbnailUrls[item._id] ?? null,
            currentUserId,
            pinnedIds,
            () => handleOpen(item._id),
            () => handleRespond(item._id),
            () => handleDelete(item._id),
            () => handlePin(item._id),
            () => handleUnpin(item._id),
            () => handleReport(item._id, item.userId),
          )
          return <BondfireRow {...props} />
        }}
        ItemSeparatorComponent={() => (
          <Separator borderColor={'$borderColor'} opacity={0.6} marginHorizontal={16} />
        )}
        ListHeaderComponent={
          <YStack paddingTop={62} paddingHorizontal={16} paddingBottom={14} gap={10}>
            <XStack alignItems="center" justifyContent="space-between">
              <YStack gap={2}>
                <Text fontSize={28} fontWeight="900">
                  My Fires
                </Text>
                <Text fontSize={13} color={'$placeholderColor'}>
                  {unreadCount > 0
                    ? `${unreadCount} unread ${unreadCount === 1 ? 'thread' : 'threads'}`
                    : 'All caught up'}
                </Text>
              </YStack>
              <Pressable onPress={() => setPinnedFirst((prev) => !prev)} hitSlop={12}>
                <Pin
                  size={22}
                  color={pinnedFirst ? '$primary' : '$placeholderColor'}
                  fill={pinnedFirst ? '$primary' : 'transparent'}
                />
              </Pressable>
            </XStack>
          </YStack>
        }
        ListEmptyComponent={
          <YStack flex={1} alignItems="center" justifyContent="center" paddingHorizontal={40}>
            <Flame size={58} color={'$primary'} />
            <Text fontSize={22} fontWeight="900" marginTop={18} textAlign="center">
              No active fires yet
            </Text>
            <Text fontSize={15} color={'$placeholderColor'} textAlign="center" marginTop={8}>
              Respond to a fire in the feed and the conversation shows up here.
            </Text>
            <Button
              variant="primary"
              size="$lg"
              marginTop={24}
              onPress={() => router.push(routes.feed)}
            >
              <Text color={'$color'} fontWeight="900">
                Browse Feed
              </Text>
            </Button>
          </YStack>
        }
      />
    </YStack>
  )
}

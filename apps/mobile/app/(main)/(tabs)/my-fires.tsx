import {
  appActions,
  appStore$,
  getBondfireVideoIndex,
  getErrorMessage,
  setBondfireVideoIndex,
  setFeedActiveBondfireId,
  useAppThemeColors,
} from '@bondfires/app'
import { BondfireRow, type BondfireRowProps, Button, Text } from '@bondfires/ui'
import { useValue } from '@legendapp/state/react'
import { Flame, Pin } from '@tamagui/lucide-icons'
import { useAction, useMutation, useQuery } from 'convex/react'
import { useRouter } from 'expo-router'
import { useCallback, useMemo, useState } from 'react'
import { Alert, FlatList, RefreshControl, StatusBar } from 'react-native'
import { Separator, Spinner, XStack, YStack } from 'tamagui'
import { api } from '../../../../../convex/_generated/api'
import type { Id } from '../../../../../convex/_generated/dataModel'
import { BONDFIRE_REPORT_OPTIONS, getSwipeReportComment } from '../../../lib/bondfireSwipeActions'
import { routes } from '../../../lib/routes'

type ThreadParticipant = {
  userId: string
  displayName?: string
  photoUrl?: string
}

type MyFire = {
  _id: string
  creatorName?: string
  lastActivityAt: number
  videoCount: number
  campLabel?: string
  muxPlaybackId?: string
  muxPlaybackPolicy?: string
  videoStatus: string
  userId: string
}

// ── Shared adapter ──────────────────────────────────────────────

function toBondfireRowProps(
  thread: MyFire,
  participantUsers: ThreadParticipant[],
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
  return {
    id: thread._id,
    creatorName: thread.creatorName ?? 'Anonymous',
    timestamp: thread.lastActivityAt,
    videoCount: thread.videoCount,
    campLabel: thread.campLabel,
    thumbnailUrl,
    isLive: thread.videoStatus === 'live',
    ownerId: thread.userId,
    currentUserId,
    pinnedIds,
    participants: participantUsers,
    onOpen,
    onRespond,
    onDelete,
    onPin,
    onUnpin,
    onReport,
  }
}

// ── Screen component ────────────────────────────────────────────

export default function MyFiresScreen() {
  const { colors, statusBarStyle } = useAppThemeColors()
  const router = useRouter()
  const [refreshKey, setRefreshKey] = useState(0)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const threads = useQuery(api.conversations.listMyFires, { limit: 80 }) as
    | (MyFire & {
        participants?: Array<{ user: ThreadParticipant }>
      })[]
    | undefined
  const getThumbnailUrl = useAction(api.videos.getThumbnailUrl)

  // Swipe action mutations
  const deleteBondfire = useMutation(api.bondfires.deleteBondfire)
  const pinBondfire = useMutation(api.bondfires.pinBondfire)
  const unpinBondfire = useMutation(api.bondfires.unpinBondfire)
  const reportBondfire = useMutation(api.reports.submit)
  const currentUserId = useValue(appStore$.userId)

  // Pinned bondfire IDs from user doc
  const currentUser = useQuery(api.users.current, currentUserId ? {} : 'skip')
  const pinnedIds = useMemo(
    () => (currentUser?.pinnedBondfireIds ?? []) as string[],
    [currentUser?.pinnedBondfireIds],
  )

  const [thumbnailUrls, setThumbnailUrls] = useState<Record<string, string | null>>({})

  // Load thumbnails when threads arrive
  const loadThumbnails = useCallback(
    async (items: typeof threads) => {
      if (!items) return
      const toLoad = items.filter((t) => t.muxPlaybackId && thumbnailUrls[t._id] === undefined)
      if (toLoad.length === 0) return

      const updates: Record<string, string | null> = {}
      await Promise.all(
        toLoad.map(async (t) => {
          try {
            const { thumbnailUrl } = await getThumbnailUrl({
              muxPlaybackId: t.muxPlaybackId ?? '',
              muxPlaybackPolicy: t.muxPlaybackPolicy as 'public' | 'signed' | undefined,
              bondfireId: t._id as Id<'bondfires'>,
            })
            updates[t._id] = thumbnailUrl
          } catch {
            updates[t._id] = null
          }
        }),
      )
      setThumbnailUrls((prev) => ({ ...prev, ...updates }))
    },
    [getThumbnailUrl, thumbnailUrls],
  )

  // Trigger thumbnail load when threads change
  if (threads) {
    // Non-reactive trigger — loadThumbnails is idempotent
    setTimeout(() => loadThumbnails(threads), 0)
  }

  const unreadCount = useMemo(
    () =>
      threads?.filter((_thread) => {
        // MyFire doesn't have explicit unread field anymore; use a heuristic
        // or rely on the query to return only relevant threads
        return false
      }).length ?? 0,
    [threads],
  )

  const handleRefresh = useCallback(() => {
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
                setRefreshKey((current) => current + 1)
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
        setRefreshKey((current) => current + 1)
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
        setRefreshKey((current) => current + 1)
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
                comments: getSwipeReportComment('my-fires'),
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

  if (threads === undefined) {
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
        extraData={{ currentUserId, pinnedIds, thumbnailUrls }}
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
          const participants = item.participants?.map((p) => p.user).filter(Boolean) ?? []
          const props = toBondfireRowProps(
            item,
            participants,
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
              <Pin size={22} color={'$primary'} />
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
              Threads appear here once you spark or respond.
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

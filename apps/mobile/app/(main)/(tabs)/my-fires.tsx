import {
  appActions,
  getBondfireVideoIndex,
  getErrorMessage,
  setBondfireVideoIndex,
  setFeedActiveBondfireId,
  telemetry,
  useAppThemeColors,
  useCanLoadTabData,
  useCanRunRecordingBackgroundWork,
  useCurrentUserId,
  useLoadingTimeoutTelemetry,
} from '@bondfires/app'
import {
  BondfireRow,
  type BondfireRowProps,
  Button,
  closeOpenSwipeableRow,
  Spinner,
  Text,
} from '@bondfires/ui'
import { useIsFocused } from '@react-navigation/native'
import { AlertTriangle, Flame, Pin, RefreshCw } from '@tamagui/lucide-icons'
import { useAction, useMutation, useQuery } from 'convex/react'
import { useRouter } from 'expo-router'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Alert, FlatList, Pressable, RefreshControl, StatusBar } from 'react-native'
import { Separator, useTheme, variableToString, XStack, YStack } from 'tamagui'
import { api } from '../../../../../convex/_generated/api'
import type { Doc, Id } from '../../../../../convex/_generated/dataModel'
import { EditTitleSheet, useEditTitleSheet } from '../../../components/EditTitleSheet'
import {
  BONDFIRE_REPORT_OPTIONS,
  getBondfireRightSwipeActions,
  getBondfireSwipeActions,
  getSwipeReportComment,
} from '../../../lib/bondfireSwipeActions'
import {
  type BondfireThumbnailFields,
  getBondfireThumbnailPlayback,
  getCachedBondfireThumbnail,
} from '../../../lib/bondfireThumbnails'
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

type MyFire = Doc<'bondfires'> &
  BondfireThumbnailFields & {
    camp: Doc<'camps'> | null
    lastActivityAt: number
    unread: boolean
    participants: ThreadParticipant[]
    badge?: 'sparked' | 'invited' | 'kindled' | null
  }

type InviteRow = {
  claim: Doc<'inviteClaims'>
  bondfire: (Doc<'bondfires'> & BondfireThumbnailFields) | null
  camp: Doc<'camps'> | null
  sender: PublicUser | null
}

function MyFiresSubscription({
  enabled,
  pinnedFirst,
  onResolved,
}: {
  enabled: boolean
  pinnedFirst: boolean
  onResolved: (threads: MyFire[]) => void
}) {
  const threads = useQuery(
    api.conversations.listMyFires,
    enabled ? { limit: 80, pinnedFirst } : 'skip',
  ) as MyFire[] | undefined

  useEffect(() => {
    if (threads !== undefined) {
      onResolved(threads)
    }
  }, [onResolved, threads])

  return null
}

function LoadingMyFires() {
  return (
    <YStack flex={1} alignItems="center" justifyContent="center">
      <Spinner size="large" color={'$primary'} />
    </YStack>
  )
}

function MyFiresRetry({ onRetry }: { onRetry: () => void }) {
  return (
    <YStack
      flex={1}
      alignItems="center"
      justifyContent="center"
      backgroundColor={'$background'}
      padding="$6"
      gap="$4"
    >
      <AlertTriangle size={48} color={'$primary'} />
      <Text fontSize="$6" fontWeight="700" color={'$placeholderColor'} textAlign="center">
        Connection Issue
      </Text>
      <Text fontSize="$4" color={'$placeholderColor'} opacity={0.7} textAlign="center">
        We're having trouble loading your fires. Check your internet connection and try again.
      </Text>
      <Pressable onPress={onRetry}>
        <YStack
          flexDirection="row"
          alignItems="center"
          gap="$2"
          backgroundColor={'$primary'}
          paddingHorizontal="$5"
          paddingVertical="$3"
          borderRadius="$4"
        >
          <RefreshCw size={18} color={'$background'} />
          <Text fontSize="$4" fontWeight="600" color={'$background'}>
            Try Again
          </Text>
        </YStack>
      </Pressable>
    </YStack>
  )
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
  onEdit: () => void,
): BondfireRowProps {
  const isOwner = currentUserId === thread.userId
  const isPinned = pinnedIds.includes(thread._id)

  return {
    title: thread.title,
    creatorName: thread.creatorName ?? 'Anonymous',
    timestamp: thread.lastActivityAt,
    videoCount: thread.videoCount,
    campLabel: thread.camp?.name,
    thumbnailUrl,
    isLive: thread.videoStatus === 'live',
    statusLabel: thread.unread ? 'New' : 'Viewed',
    badge: thread.badge,
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
    rightActions: getBondfireRightSwipeActions({
      isOwner,
      onEdit,
    }),
    onOpen,
    onRespond,
  }
}

function toInvitedBondfireRowProps(
  thread: MyFire,
  thumbnailUrl: string | null,
  onOpen: () => void,
  onRespond: () => void,
  onDismiss: () => void,
): BondfireRowProps {
  return {
    title: thread.title,
    creatorName: thread.creatorName ?? 'Anonymous',
    timestamp: thread.lastActivityAt,
    videoCount: thread.videoCount,
    campLabel: thread.camp?.name,
    thumbnailUrl,
    isLive: thread.videoStatus === 'live',
    statusLabel: 'Invited',
    badge: 'invited',
    participants: [],
    actions: [
      {
        key: 'dismiss',
        label: 'Dismiss',
        color: '$placeholderColor',
        backgroundColor: '$backgroundHover',
        onPress: onDismiss,
      },
    ],
    rightActions: [],
    onOpen,
    onRespond,
  }
}

export default function MyFiresScreen() {
  const { colors, statusBarStyle } = useAppThemeColors()
  const theme = useTheme()
  const primaryColor = variableToString(theme.primary)
  const router = useRouter()
  const isFocused = useIsFocused()
  const canLoadTabData = useCanLoadTabData(isFocused)
  const shouldRunBackgroundWork = useCanRunRecordingBackgroundWork(isFocused)
  const { userId: currentUserId, isLoading: isUserLoading, currentUser } = useCurrentUserId()
  const [refreshKey, setRefreshKey] = useState(0)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [pinnedFirst, setPinnedFirst] = useState(false)
  const [threads, setThreads] = useState<MyFire[] | undefined>(undefined)
  const invitedRows = useQuery(api.inviteClaims.listUnseenInvites, canLoadTabData ? {} : 'skip') as
    | InviteRow[]
    | undefined
  const getThumbnailUrl = useAction(api.videos.getThumbnailUrl)

  // Swipe action mutations
  const deleteBondfire = useMutation(api.bondfires.deleteBondfire)
  const pinBondfire = useMutation(api.bondfires.pinBondfire)
  const unpinBondfire = useMutation(api.bondfires.unpinBondfire)
  const reportBondfire = useMutation(api.reports.submit)
  const dismissInvite = useMutation(api.inviteClaims.dismissInvite)

  const pinnedIds = useMemo(
    () => (currentUser?.pinnedBondfireIds ?? []) as string[],
    [currentUser?.pinnedBondfireIds],
  )
  const invitedThreads = useMemo<MyFire[]>(
    () =>
      (invitedRows ?? []).flatMap((row) => {
        if (!row.bondfire) return []
        return [
          {
            ...row.bondfire,
            camp: row.camp,
            lastActivityAt: row.claim.createdAt,
            unread: true,
            participants: [],
            badge: 'invited' as const,
          },
        ]
      }),
    [invitedRows],
  )

  const isLoading = threads === undefined || isUserLoading
  const { timedOut, resetLoadTracking } = useLoadingTimeoutTelemetry({
    eventName: 'myFires',
    label: 'My Fires',
    isLoading,
    loadedCount: threads?.length,
    context: {
      canLoadTabData,
      shouldRunBackgroundWork,
      hasCurrentUserId: !!currentUserId,
      isUserLoading,
    },
  })

  const handleThreadsResolved = useCallback((nextThreads: MyFire[]) => {
    setThreads(nextThreads)
    setIsRefreshing(false)
  }, [])

  const handleRetry = useCallback(() => {
    telemetry.breadcrumb('myFires:retry')
    resetLoadTracking()
    setThreads(undefined)
    setRefreshKey((current) => current + 1)
  }, [resetLoadTracking])

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
  const { editingBondfire, openEditTitleSheet, closeEditTitleSheet } = useEditTitleSheet()
  const listExtraData = useMemo(
    () => ({ currentUserId, pinnedIds, thumbnailUrls, editingBondfire }),
    [currentUserId, pinnedIds, thumbnailUrls, editingBondfire],
  )

  const ensureThumbnailUrl = useCallback(
    async (thread: MyFire) => {
      if (!shouldRunBackgroundWork) return
      const playback = getBondfireThumbnailPlayback(thread)
      if (!playback) return
      if (thumbnailUrls[playback.cacheKey] !== undefined) return
      if (loadingThumbsRef.current.has(playback.cacheKey)) return

      loadingThumbsRef.current.add(playback.cacheKey)
      try {
        const { thumbnailUrl } = await getThumbnailUrl({
          muxPlaybackId: playback.muxPlaybackId,
          muxPlaybackPolicy: playback.muxPlaybackPolicy,
          bondfireId: playback.bondfireVideoId ? undefined : thread._id,
          bondfireVideoId: playback.bondfireVideoId,
        })
        setThumbnailUrls((prev) =>
          prev[playback.cacheKey] === undefined
            ? { ...prev, [playback.cacheKey]: thumbnailUrl }
            : prev,
        )
      } catch {
        setThumbnailUrls((prev) =>
          prev[playback.cacheKey] === undefined ? { ...prev, [playback.cacheKey]: null } : prev,
        )
      } finally {
        loadingThumbsRef.current.delete(playback.cacheKey)
      }
    },
    [getThumbnailUrl, shouldRunBackgroundWork, thumbnailUrls],
  )

  useEffect(() => {
    if (!shouldRunBackgroundWork || !threads) return
    for (const thread of [...invitedThreads, ...threads].slice(0, 10)) {
      ensureThumbnailUrl(thread)
    }
  }, [ensureThumbnailUrl, invitedThreads, shouldRunBackgroundWork, threads])

  const unreadCount = useMemo(
    () => threads?.filter((thread) => thread.unread).length ?? 0,
    [threads],
  )

  const handleRefresh = useCallback(() => {
    resetLoadTracking()
    setThumbnailUrls({})
    loadingThumbsRef.current = new Set()
    setIsRefreshing(true)
    setRefreshKey((current) => current + 1)
    setTimeout(() => setIsRefreshing(false), 800)
  }, [resetLoadTracking])

  const handleTogglePinnedFirst = useCallback(() => {
    resetLoadTracking()
    setThreads(undefined)
    setPinnedFirst((prev) => !prev)
    setRefreshKey((current) => current + 1)
  }, [resetLoadTracking])

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

  const handleDismissInvite = useCallback(
    async (claimId: Id<'inviteClaims'>) => {
      try {
        await dismissInvite({ claimId })
      } catch (error) {
        Alert.alert('Error', getErrorMessage(error))
      }
    },
    [dismissInvite],
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

  if (isLoading) {
    return (
      <YStack flex={1} backgroundColor={'$background'}>
        <MyFiresSubscription
          key={`subscription-${refreshKey}`}
          enabled={canLoadTabData}
          pinnedFirst={pinnedFirst}
          onResolved={handleThreadsResolved}
        />
        <StatusBar barStyle={statusBarStyle} backgroundColor={colors.background} />
        {timedOut ? <MyFiresRetry onRetry={handleRetry} /> : <LoadingMyFires />}
      </YStack>
    )
  }

  return (
    <YStack flex={1} backgroundColor={'$background'}>
      <MyFiresSubscription
        key={`subscription-${refreshKey}`}
        enabled={canLoadTabData}
        pinnedFirst={pinnedFirst}
        onResolved={handleThreadsResolved}
      />
      <StatusBar barStyle={statusBarStyle} backgroundColor={colors.background} />
      <FlatList
        key={`list-${refreshKey}`}
        data={threads}
        extraData={listExtraData}
        keyExtractor={(item) => item._id}
        onScrollBeginDrag={closeOpenSwipeableRow}
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
            getCachedBondfireThumbnail(item, thumbnailUrls),
            currentUserId,
            pinnedIds,
            () => handleOpen(item._id),
            () => handleRespond(item._id),
            () => handleDelete(item._id),
            () => handlePin(item._id),
            () => handleUnpin(item._id),
            () => handleReport(item._id, item.userId),
            () => openEditTitleSheet(item._id, item.title ?? '', item.creatorName ?? undefined),
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
              <Pressable onPress={handleTogglePinnedFirst} hitSlop={12}>
                <Pin
                  size={22}
                  color={pinnedFirst ? '$primary' : '$placeholderColor'}
                  fill={pinnedFirst ? primaryColor : 'transparent'}
                />
              </Pressable>
            </XStack>
            {invitedThreads.length > 0 ? (
              <YStack gap={8} marginTop={4}>
                <Text fontSize={13} color={'$placeholderColor'} fontWeight="900">
                  Invited
                </Text>
                {invitedThreads.map((item) => {
                  const row = invitedRows?.find((invite) => invite.bondfire?._id === item._id)
                  if (!row) return null

                  const props = toInvitedBondfireRowProps(
                    item,
                    getCachedBondfireThumbnail(item, thumbnailUrls),
                    () => handleOpen(item._id),
                    () => handleRespond(item._id),
                    () => handleDismissInvite(row.claim._id),
                  )

                  return (
                    <YStack key={row.claim._id}>
                      <BondfireRow {...props} />
                      <Separator borderColor={'$borderColor'} opacity={0.6} />
                    </YStack>
                  )
                })}
              </YStack>
            ) : null}
          </YStack>
        }
        ListEmptyComponent={
          invitedThreads.length > 0 ? null : (
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
          )
        }
      />

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

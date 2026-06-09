import {
  appActions,
  appStore$,
  getBondfireVideoIndex,
  getErrorMessage,
  getFeedActiveBondfireId,
  getLastLocation,
  hasViewedToday,
  setBondfireVideoIndex,
  setFeedActiveBondfireId,
  telemetry,
  useAppThemeColors,
} from '@bondfires/app'
import { BondfireRow, type BondfireRowProps, Button, Input, Spinner, Text } from '@bondfires/ui'
import { useObservable, useValue } from '@legendapp/state/react'
import { Flame, Search } from '@tamagui/lucide-icons'
import { useAction, useMutation, useQuery } from 'convex/react'
import { useRouter } from 'expo-router'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Alert,
  FlatList,
  Pressable,
  RefreshControl,
  ScrollView,
  StatusBar,
  type ViewToken,
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Separator, XStack, YStack } from 'tamagui'
import { api } from '../../../../../convex/_generated/api'
import type { Doc, Id } from '../../../../../convex/_generated/dataModel'
import {
  BONDFIRE_REPORT_OPTIONS,
  getBondfireSwipeActions,
  getSwipeReportComment,
} from '../../../lib/bondfireSwipeActions'
import { routes } from '../../../lib/routes'

type BondfireData = Doc<'bondfires'> & {
  isLive?: boolean
  livePlaybackId?: string
  campLabel?: string
}
type JoinedCamp = Doc<'camps'> & { membership: Doc<'campMembers'> }

type ViewMode = 'discover' | 'recent' | 'active' | 'unseen'

function ModePill({
  label,
  selected,
  onPress,
}: {
  label: string
  selected: boolean
  onPress: () => void
}) {
  return (
    <Pressable onPress={onPress}>
      <YStack
        paddingHorizontal={14}
        paddingVertical={8}
        borderRadius={999}
        backgroundColor={selected ? '$primary' : '$backgroundHover'}
        borderWidth={1}
        borderColor={selected ? '$primary' : '$borderColor'}
      >
        <Text fontSize={13} fontWeight="800" color={selected ? '$background' : '$color'}>
          {label}
        </Text>
      </YStack>
    </Pressable>
  )
}

function CampPill({
  label,
  selected,
  onPress,
}: {
  label: string
  selected: boolean
  onPress: () => void
}) {
  return (
    <Pressable onPress={onPress}>
      <YStack
        minWidth={74}
        paddingHorizontal={12}
        paddingVertical={8}
        borderRadius={12}
        backgroundColor={selected ? '$primary' : '$backgroundHover'}
        borderWidth={1}
        borderColor={selected ? '$primary' : '$borderColor'}
        alignItems="center"
      >
        <Text
          fontSize={12}
          fontWeight="900"
          color={selected ? '$background' : '$color'}
          numberOfLines={1}
        >
          {label}
        </Text>
      </YStack>
    </Pressable>
  )
}

/** Map a BondfireData item to the shared BondfireRow props */
function toBondfireRowProps(
  bondfire: BondfireData,
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
  const isOwner = currentUserId === bondfire.userId
  const isPinned = pinnedIds.includes(bondfire._id)

  return {
    creatorName: bondfire.creatorName ?? 'Anonymous',
    timestamp: bondfire.createdAt,
    videoCount: bondfire.videoCount,
    campLabel: bondfire.campLabel,
    thumbnailUrl,
    isLive: bondfire.videoStatus === 'live' || !!bondfire.isLive,
    statusLabel: hasViewedToday(bondfire._id) ? 'Viewed' : 'New',
    participants: [], // Feed doesn't load participants yet — empty for now
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

function EmptyFeed() {
  const router = useRouter()

  return (
    <YStack
      flex={1}
      alignItems="center"
      justifyContent="center"
      backgroundColor={'$background'}
      paddingHorizontal={40}
    >
      <YStack
        width={120}
        height={120}
        borderRadius={60}
        backgroundColor={'$backgroundHover'}
        alignItems="center"
        justifyContent="center"
        marginBottom={32}
      >
        <Flame size={60} color={'$primary'} />
      </YStack>
      <Text fontSize={24} fontWeight="900" marginBottom={12} textAlign="center">
        Spark a Bondfire
      </Text>
      <Text fontSize={16} color={'$placeholderColor'} textAlign="center" marginBottom={32}>
        Be the first to share a video!
      </Text>
      <Button variant="primary" size="$lg" onPress={() => router.push(routes.create)}>
        <Flame size={20} color={'$color'} />
        <Text color={'$color'} fontWeight="900">
          Spark Bondfire
        </Text>
      </Button>
    </YStack>
  )
}

function LoadingFeed() {
  return (
    <YStack flex={1} alignItems="center" justifyContent="center" backgroundColor={'$background'}>
      <Spinner size="large" color={'$primary'} />
      <Text marginTop={20} color={'$placeholderColor'}>
        Loading bondfires...
      </Text>
    </YStack>
  )
}

function FeedSubscription({
  selectedCampId,
  onResolved,
}: {
  selectedCampId: Doc<'camps'>['_id'] | null
  onResolved: (bondfires: BondfireData[]) => void
}) {
  const allBondfires = useQuery(api.bondfires.listFeed, selectedCampId ? 'skip' : { limit: 50 })
  const campBondfires = useQuery(
    api.bondfires.listByCamp,
    selectedCampId ? { campId: selectedCampId, limit: 50 } : 'skip',
  )
  const bondfires = selectedCampId ? campBondfires : allBondfires

  useEffect(() => {
    if (bondfires !== undefined) {
      onResolved(bondfires)
    }
  }, [bondfires, onResolved])

  return null
}

export default function FeedScreen() {
  const { colors, statusBarStyle } = useAppThemeColors()
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const getThumbnailUrl = useAction(api.videos.getThumbnailUrl)

  const [viewMode, setViewMode] = useState<ViewMode>('discover')
  const [query, setQuery] = useState('')
  const [refreshKey, setRefreshKey] = useState(0)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [bondfires, setBondfires] = useState<BondfireData[] | undefined>(undefined)
  const currentUserId = useValue(appStore$.userId)
  const currentCampId = useValue(appStore$.currentCampId)
  const joinedCamps = useQuery(api.camps.listMine, currentUserId ? {} : 'skip') as
    | JoinedCamp[]
    | undefined
  const selectedCampId = currentCampId as Doc<'camps'>['_id'] | null
  const selectedCamp = joinedCamps?.find((camp) => camp._id === selectedCampId)

  // Authenticated user data for private pin state.
  const currentUser = useQuery(api.users.current, currentUserId ? {} : 'skip')
  const pinnedIds = useMemo(
    () => (currentUser?.pinnedBondfireIds ?? []) as string[],
    [currentUser?.pinnedBondfireIds],
  )
  const listExtraData = useMemo(() => ({ currentUserId, pinnedIds }), [currentUserId, pinnedIds])
  const pinnedOrder = useMemo(() => new Map(pinnedIds.map((id, index) => [id, index])), [pinnedIds])

  // Mutations for swipe actions
  const deleteBondfire = useMutation(api.bondfires.deleteBondfire)
  const pinBondfire = useMutation(api.bondfires.pinBondfire)
  const unpinBondfire = useMutation(api.bondfires.unpinBondfire)
  const reportBondfire = useMutation(api.reports.submit)

  const state$ = useObservable({
    thumbnailUrls: {} as Record<string, string | null>,
  })
  const thumbnailUrls = useValue(state$.thumbnailUrls)

  const listRef = useRef<FlatList<BondfireData> | null>(null)
  const filteredRef = useRef<BondfireData[]>([])
  const loadingThumbsRef = useRef<Set<string>>(new Set())
  const didRestoreScrollRef = useRef(false)
  const persistActiveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const refreshTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const stopRefreshing = useCallback(() => {
    if (refreshTimeoutRef.current) {
      clearTimeout(refreshTimeoutRef.current)
      refreshTimeoutRef.current = null
    }
    setIsRefreshing(false)
  }, [])

  const handleRefresh = useCallback(() => {
    state$.thumbnailUrls.set({})
    loadingThumbsRef.current = new Set()
    setIsRefreshing(true)
    setRefreshKey((current) => current + 1)

    if (refreshTimeoutRef.current) {
      clearTimeout(refreshTimeoutRef.current)
    }
    refreshTimeoutRef.current = setTimeout(() => {
      refreshTimeoutRef.current = null
      setIsRefreshing(false)
    }, 5000)
  }, [state$])

  const handleBondfiresResolved = useCallback(
    (nextBondfires: BondfireData[]) => {
      setBondfires(nextBondfires)
      stopRefreshing()
    },
    [stopRefreshing],
  )

  useEffect(() => {
    if (!selectedCampId || joinedCamps === undefined) {
      return
    }

    if (!joinedCamps.some((camp) => camp._id === selectedCampId)) {
      setBondfires(undefined)
      state$.thumbnailUrls.set({})
      loadingThumbsRef.current = new Set()
      appActions.setCurrentCampId(null)
    }
  }, [joinedCamps, selectedCampId, state$])

  const filtered = useMemo(() => {
    if (!bondfires) return bondfires

    const q = query.trim().toLowerCase()
    let items = bondfires

    if (viewMode === 'unseen') {
      items = items.filter((b) => b.userId !== currentUserId && !hasViewedToday(b._id))
    }

    if (q.length > 0) {
      items = items.filter((b) => {
        const name = (b.creatorName ?? '').toLowerCase()
        const camp = (b.campLabel ?? '').toLowerCase()
        const tags = (b.tags ?? []).join(' ').toLowerCase()
        return name.includes(q) || camp.includes(q) || tags.includes(q)
      })
    }

    const sorted = items.slice()
    const comparePinned = (a: BondfireData, b: BondfireData) => {
      const aIndex = pinnedOrder.get(a._id)
      const bIndex = pinnedOrder.get(b._id)

      if (aIndex === undefined && bIndex === undefined) return 0
      if (aIndex === undefined) return 1
      if (bIndex === undefined) return -1
      return aIndex - bIndex
    }

    if (viewMode === 'recent') {
      sorted.sort((a, b) => {
        const pinned = comparePinned(a, b)
        if (pinned !== 0) return pinned
        if (!!a.isLive !== !!b.isLive) return a.isLive ? -1 : 1
        return b.createdAt - a.createdAt
      })
      return sorted
    }

    if (viewMode === 'active') {
      sorted.sort((a, b) => {
        const pinned = comparePinned(a, b)
        if (pinned !== 0) return pinned
        if (!!a.isLive !== !!b.isLive) return a.isLive ? -1 : 1
        if (b.videoCount !== a.videoCount) return b.videoCount - a.videoCount
        return (b.updatedAt ?? b.createdAt) - (a.updatedAt ?? a.createdAt)
      })
      return sorted
    }

    // "discover" and "unseen": smallest convos first, but newest within each size.
    sorted.sort((a, b) => {
      const pinned = comparePinned(a, b)
      if (pinned !== 0) return pinned
      if (!!a.isLive !== !!b.isLive) return a.isLive ? -1 : 1
      if (a.videoCount !== b.videoCount) return a.videoCount - b.videoCount
      return b.createdAt - a.createdAt
    })

    return sorted
  }, [bondfires, currentUserId, pinnedOrder, query, viewMode])

  filteredRef.current = filtered ?? []

  // Restore last camp (conversation) position.
  useEffect(() => {
    const items = filtered ?? []
    if (items.length === 0) return
    if (didRestoreScrollRef.current) return
    didRestoreScrollRef.current = true

    const lastLocation = getLastLocation()
    const savedBondfireId =
      getFeedActiveBondfireId() ??
      (lastLocation?.type === 'feed' ? lastLocation.activeBondfireId : undefined) ??
      (lastLocation?.type === 'bondfire' ? lastLocation.bondfireId : undefined)

    if (!savedBondfireId) return

    const index = items.findIndex((b) => b._id === savedBondfireId)
    if (index < 0) return

    setTimeout(() => {
      listRef.current?.scrollToIndex({ index, animated: false, viewPosition: 0.2 })
    }, 0)
  }, [filtered])

  const ensureThumbnailUrl = useCallback(
    async (bondfire: BondfireData) => {
      if (!bondfire.muxPlaybackId) return
      // Already resolved (including null = previously failed)
      if (state$.thumbnailUrls[bondfire._id].get() !== undefined) return
      if (loadingThumbsRef.current.has(bondfire._id)) return

      loadingThumbsRef.current.add(bondfire._id)
      try {
        const { thumbnailUrl } = await getThumbnailUrl({
          muxPlaybackId: bondfire.muxPlaybackId,
          muxPlaybackPolicy: bondfire.muxPlaybackPolicy,
          bondfireId: bondfire._id,
        })
        state$.thumbnailUrls[bondfire._id].set(thumbnailUrl)
        telemetry.breadcrumb('feed:thumbnail:loaded', {
          bondfireId: bondfire._id,
          hasToken: thumbnailUrl.includes('token='),
        })
      } catch (error) {
        // Mark as null so we don't retry this bondfire repeatedly
        state$.thumbnailUrls[bondfire._id].set(null)
        // Use warn instead of error — thumbnails are cosmetic, and error
        // toasts to users for non-breaking failures.
        telemetry.warn('feed:thumbnail', 'Failed to load thumbnail URL', {
          bondfireId: bondfire._id,
          playbackPolicy: bondfire.muxPlaybackPolicy,
          hasCampId: !!bondfire.campId,
          hasPersonalCampId: !!bondfire.personalCampId,
          videoStatus: bondfire.videoStatus,
          error: String(error),
        })
      } finally {
        loadingThumbsRef.current.delete(bondfire._id)
      }
    },
    [getThumbnailUrl, state$],
  )

  useEffect(() => {
    if (!filtered) return
    for (const bondfire of filtered.slice(0, 10)) {
      ensureThumbnailUrl(bondfire)
    }
  }, [filtered, ensureThumbnailUrl])

  const handleBondfirePress = useCallback(
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

  const handleSpark = useCallback(() => {
    if (selectedCamp?.access === 'invite' && selectedCamp.membership.role !== 'owner') {
      Alert.alert(
        'Owner Sparks Only',
        'Only the private camp owner can start new Bondfires here. You can respond to existing fires.',
      )
      return
    }

    if (selectedCampId) {
      router.push(routes.createForCamp(selectedCampId))
      return
    }

    router.push(routes.create)
  }, [router, selectedCamp, selectedCampId])

  const handleSelectCamp = useCallback(
    (campId: string | null) => {
      setBondfires(undefined)
      state$.thumbnailUrls.set({})
      loadingThumbsRef.current = new Set()
      appActions.setCurrentCampId(campId)
      listRef.current?.scrollToOffset({ offset: 0, animated: true })
    },
    [state$],
  )

  // ── Swipe action handlers ───────────────────────────────────────

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
                // Remove from local state immediately for responsive UI
                setBondfires((prev) => prev?.filter((b) => b._id !== bondfireId))
                state$.thumbnailUrls[bondfireId]?.set(null)
              } catch (error) {
                Alert.alert('Error', 'Failed to delete bondfire. Please try again.')
                telemetry.error('feed:deleteBondfire', String(error))
              }
            },
          },
        ],
      )
    },
    [deleteBondfire, state$],
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
                comments: getSwipeReportComment('feed'),
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

  const onViewableItemsChanged = useCallback(
    ({ viewableItems }: { viewableItems: ViewToken[] }) => {
      const items = filteredRef.current
      if (items.length === 0) return

      const indices = viewableItems
        .map((v) => v.index)
        .filter((i): i is number => typeof i === 'number' && i >= 0)
      if (indices.length === 0) return

      const topIndex = Math.max(0, Math.min(...indices))
      const topBondfireId = items[topIndex]?._id
      if (topBondfireId) {
        if (persistActiveTimerRef.current) {
          clearTimeout(persistActiveTimerRef.current)
        }
        persistActiveTimerRef.current = setTimeout(() => {
          setFeedActiveBondfireId(topBondfireId)
        }, 200)
      }

      const minIndex = Math.max(0, Math.min(...indices) - 2)
      const maxIndex = Math.min(items.length - 1, Math.max(...indices) + 8)

      for (let i = minIndex; i <= maxIndex; i++) {
        ensureThumbnailUrl(items[i])
      }
    },
    [ensureThumbnailUrl],
  )

  useEffect(() => {
    return () => {
      if (persistActiveTimerRef.current) {
        clearTimeout(persistActiveTimerRef.current)
        persistActiveTimerRef.current = null
      }
      if (refreshTimeoutRef.current) {
        clearTimeout(refreshTimeoutRef.current)
        refreshTimeoutRef.current = null
      }
    }
  }, [])

  const viewabilityConfig = useRef({ itemVisiblePercentThreshold: 10 }).current

  if (bondfires === undefined) {
    return (
      <YStack flex={1}>
        <FeedSubscription
          key={`${refreshKey}-${selectedCampId ?? 'all'}`}
          selectedCampId={selectedCampId}
          onResolved={handleBondfiresResolved}
        />
        <LoadingFeed />
      </YStack>
    )
  }

  return (
    <YStack flex={1} backgroundColor={'$background'}>
      <FeedSubscription
        key={`${refreshKey}-${selectedCampId ?? 'all'}`}
        selectedCampId={selectedCampId}
        onResolved={handleBondfiresResolved}
      />
      <StatusBar barStyle={statusBarStyle} backgroundColor="transparent" translucent />

      <FlatList
        ref={(r) => {
          listRef.current = r
        }}
        data={filtered ?? []}
        extraData={listExtraData}
        keyExtractor={(item) => item._id}
        refreshControl={
          <RefreshControl
            refreshing={isRefreshing}
            onRefresh={handleRefresh}
            tintColor={colors.primary}
            colors={[colors.primary]}
            progressViewOffset={insets.top + 100}
          />
        }
        onScrollToIndexFailed={({ index, averageItemLength }) => {
          listRef.current?.scrollToOffset({
            offset: Math.max(0, index * (averageItemLength || 80)),
            animated: false,
          })
        }}
        renderItem={({ item }) => {
          const props = toBondfireRowProps(
            item,
            thumbnailUrls[item._id] ?? null,
            currentUserId,
            pinnedIds,
            () => handleBondfirePress(item._id),
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
          <YStack paddingTop={insets.top + 16} paddingBottom={12} paddingHorizontal={16} gap={12}>
            <XStack alignItems="baseline" justifyContent="space-between" gap={16}>
              <YStack gap={2} flex={1}>
                <Text fontSize={26} fontWeight="900" numberOfLines={1}>
                  Camp Feed
                </Text>
                <Text fontSize={13} color={'$placeholderColor'}>
                  Filter by joined camp or scan every fire.
                </Text>
              </YStack>

              <Button variant="secondary" size="$sm" onPress={handleSpark}>
                <Text color={'$color'} fontWeight="900">
                  Spark
                </Text>
              </Button>
            </XStack>

            <XStack
              alignItems="center"
              gap={10}
              backgroundColor={'$backgroundHover'}
              borderRadius={14}
              borderWidth={1}
              borderColor={'$borderColor'}
              paddingHorizontal={12}
              paddingVertical={10}
            >
              <Search size={18} color={'$placeholderColor'} />
              <Input
                value={query}
                onChangeText={setQuery}
                placeholder="Search creator, camp, or tags"
                backgroundColor="transparent"
                borderWidth={0}
                height={22}
                paddingHorizontal={0}
                flex={1}
              />
              {filtered ? (
                <Text fontSize={12} color={'$placeholderColor'} fontWeight="900">
                  {filtered.length}
                </Text>
              ) : null}
            </XStack>

            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={{ gap: 8, paddingRight: 8 }}
            >
              <CampPill
                label="All"
                selected={!selectedCampId}
                onPress={() => handleSelectCamp(null)}
              />
              {(joinedCamps ?? []).map((camp) => (
                <CampPill
                  key={camp._id}
                  label={camp.name.replace(/ \((Men|Women)\)$/, '')}
                  selected={selectedCampId === camp._id}
                  onPress={() => handleSelectCamp(camp._id)}
                />
              ))}
            </ScrollView>

            <XStack gap={10} flexWrap="wrap">
              <ModePill
                label="Discover"
                selected={viewMode === 'discover'}
                onPress={() => {
                  setViewMode('discover')
                  listRef.current?.scrollToOffset({ offset: 0, animated: true })
                }}
              />
              <ModePill
                label="Recent"
                selected={viewMode === 'recent'}
                onPress={() => {
                  setViewMode('recent')
                  listRef.current?.scrollToOffset({ offset: 0, animated: true })
                }}
              />
              <ModePill
                label="Active"
                selected={viewMode === 'active'}
                onPress={() => {
                  setViewMode('active')
                  listRef.current?.scrollToOffset({ offset: 0, animated: true })
                }}
              />
              <ModePill
                label="Unseen"
                selected={viewMode === 'unseen'}
                onPress={() => {
                  setViewMode('unseen')
                  listRef.current?.scrollToOffset({ offset: 0, animated: true })
                }}
              />
            </XStack>
          </YStack>
        }
        ListEmptyComponent={
          bondfires.length === 0 ? (
            <EmptyFeed />
          ) : (
            <YStack paddingVertical={80} alignItems="center" justifyContent="center" gap={12}>
              <Flame size={56} color={'$primary'} />
              <Text fontSize={18} fontWeight="900">
                No matches
              </Text>
              <Text
                fontSize={14}
                color={'$placeholderColor'}
                textAlign="center"
                paddingHorizontal={48}
              >
                Try a different search or switch filters.
              </Text>
              <Button
                variant="outline"
                size="$md"
                onPress={() => {
                  setQuery('')
                  setViewMode('discover')
                }}
              >
                <Text color={'$color'} fontWeight="900">
                  Reset
                </Text>
              </Button>
            </YStack>
          )
        }
        contentContainerStyle={{
          paddingBottom: 140,
          flexGrow: bondfires.length === 0 ? 1 : undefined,
        }}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        onViewableItemsChanged={onViewableItemsChanged}
        viewabilityConfig={viewabilityConfig}
      />
    </YStack>
  )
}

import {
  appActions,
  appStore$,
  getBondfireVideoIndex,
  getFeedActiveBondfireId,
  getLastLocation,
  hasViewedToday,
  setBondfireVideoIndex,
  setFeedActiveBondfireId,
} from '@bondfires/app'
import { bondfireColors } from '@bondfires/config'
import { Button, Input, Text } from '@bondfires/ui'
import { useObservable, useValue } from '@legendapp/state/react'
import { Eye, Flame, MessageCircle, Search } from '@tamagui/lucide-icons'
import { useAction, useQuery } from 'convex/react'
import { Image } from 'expo-image'
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
import { Separator, Spinner, XStack, YStack } from 'tamagui'
import { api } from '../../../../../convex/_generated/api'
import type { Doc } from '../../../../../convex/_generated/dataModel'

type BondfireData = Doc<'bondfires'> & {
  isLive?: boolean
  livePlaybackId?: string
}
type JoinedCamp = Doc<'camps'> & { membership: Doc<'campMembers'> }

type ViewMode = 'discover' | 'recent' | 'active' | 'unseen'

function getTimeAgo(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000)

  if (seconds < 60) return 'just now'
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`
  if (seconds < 604800) return `${Math.floor(seconds / 86400)}d ago`
  return `${Math.floor(seconds / 604800)}w ago`
}

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
        backgroundColor={selected ? bondfireColors.bondfireCopper : bondfireColors.gunmetal}
        borderWidth={1}
        borderColor={selected ? bondfireColors.bondfireCopper : bondfireColors.iron}
      >
        <Text
          fontSize={13}
          fontWeight="800"
          color={selected ? bondfireColors.obsidian : bondfireColors.whiteSmoke}
        >
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
        backgroundColor={selected ? bondfireColors.bondfireCopper : bondfireColors.gunmetal}
        borderWidth={1}
        borderColor={selected ? bondfireColors.bondfireCopper : bondfireColors.iron}
        alignItems="center"
      >
        <Text
          fontSize={12}
          fontWeight="900"
          color={selected ? bondfireColors.obsidian : bondfireColors.whiteSmoke}
          numberOfLines={1}
        >
          {label}
        </Text>
      </YStack>
    </Pressable>
  )
}

function BondfireRow({
  bondfire,
  thumbnailUrl,
  onOpen,
  onRespond,
}: {
  bondfire: BondfireData
  thumbnailUrl: string | null
  onOpen: () => void
  onRespond: () => void
}) {
  const timeAgo = getTimeAgo(bondfire.createdAt)
  const responses = Math.max(0, bondfire.videoCount - 1)
  const viewed = hasViewedToday(bondfire._id)
  const isLive = bondfire.videoStatus === 'live' || bondfire.isLive

  return (
    <Pressable onPress={onOpen}>
      <XStack paddingHorizontal={16} paddingVertical={12} gap={12} alignItems="center">
        <YStack
          width={74}
          height={74}
          borderRadius={16}
          overflow="hidden"
          backgroundColor={bondfireColors.gunmetal}
          borderWidth={1}
          borderColor={bondfireColors.iron}
          alignItems="center"
          justifyContent="center"
        >
          {thumbnailUrl ? (
            <Image
              source={{ uri: thumbnailUrl }}
              style={{ width: '100%', height: '100%' }}
              contentFit="cover"
              cachePolicy="memory-disk"
            />
          ) : (
            <Flame size={30} color={bondfireColors.bondfireCopper} />
          )}
          {isLive && (
            <YStack
              position="absolute"
              top={6}
              left={6}
              backgroundColor={bondfireColors.error}
              paddingHorizontal={7}
              paddingVertical={3}
              borderRadius={10}
            >
              <Text color={bondfireColors.whiteSmoke} fontSize={9} fontWeight="900">
                LIVE
              </Text>
            </YStack>
          )}
        </YStack>

        <YStack flex={1} gap={6}>
          <XStack alignItems="center" justifyContent="space-between" gap={10}>
            <YStack flex={1} gap={2}>
              <Text fontSize={16} fontWeight="900" numberOfLines={1}>
                {bondfire.creatorName ?? 'Anonymous'}
              </Text>
              <Text fontSize={12} color={bondfireColors.ash} numberOfLines={1}>
                {isLive ? 'Live now' : `${timeAgo} · ${viewed ? 'Viewed' : 'New'}`}
              </Text>
            </YStack>

            <Button
              variant="outline"
              size="$sm"
              onPress={onRespond}
              borderColor={bondfireColors.bondfireCopper}
            >
              <Text color={bondfireColors.whiteSmoke} fontWeight="800">
                Respond
              </Text>
            </Button>
          </XStack>

          <XStack alignItems="center" gap={14}>
            <XStack alignItems="center" gap={6}>
              <Eye size={16} color={bondfireColors.ash} />
              <Text fontSize={13} color={bondfireColors.ash}>
                {bondfire.viewCount ?? 0}
              </Text>
            </XStack>
            <XStack alignItems="center" gap={6}>
              <MessageCircle size={16} color={bondfireColors.ash} />
              <Text fontSize={13} color={bondfireColors.ash}>
                {responses} {responses === 1 ? 'response' : 'responses'}
              </Text>
            </XStack>
          </XStack>
        </YStack>
      </XStack>
    </Pressable>
  )
}

function EmptyFeed() {
  const router = useRouter()

  return (
    <YStack
      flex={1}
      alignItems="center"
      justifyContent="center"
      backgroundColor={bondfireColors.obsidian}
      paddingHorizontal={40}
    >
      <YStack
        width={120}
        height={120}
        borderRadius={60}
        backgroundColor={bondfireColors.gunmetal}
        alignItems="center"
        justifyContent="center"
        marginBottom={32}
      >
        <Flame size={60} color={bondfireColors.bondfireCopper} />
      </YStack>
      <Text fontSize={24} fontWeight="900" marginBottom={12} textAlign="center">
        Spark a Bondfire
      </Text>
      <Text fontSize={16} color={bondfireColors.ash} textAlign="center" marginBottom={32}>
        Be the first to share a video!
      </Text>
      <Button variant="primary" size="$lg" onPress={() => router.push('/(main)/(tabs)/create')}>
        <Flame size={20} color={bondfireColors.whiteSmoke} />
        <Text color={bondfireColors.whiteSmoke} fontWeight="900">
          Spark Bondfire
        </Text>
      </Button>
    </YStack>
  )
}

function LoadingFeed() {
  return (
    <YStack
      flex={1}
      alignItems="center"
      justifyContent="center"
      backgroundColor={bondfireColors.obsidian}
    >
      <Spinner size="large" color={bondfireColors.bondfireCopper} />
      <Text marginTop={20} color={bondfireColors.ash}>
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
        const tags = (b.tags ?? []).join(' ').toLowerCase()
        return name.includes(q) || tags.includes(q)
      })
    }

    const sorted = items.slice()

    if (viewMode === 'recent') {
      sorted.sort((a, b) => {
        if (!!a.isLive !== !!b.isLive) return a.isLive ? -1 : 1
        return b.createdAt - a.createdAt
      })
      return sorted
    }

    if (viewMode === 'active') {
      sorted.sort((a, b) => {
        if (!!a.isLive !== !!b.isLive) return a.isLive ? -1 : 1
        if (b.videoCount !== a.videoCount) return b.videoCount - a.videoCount
        return (b.updatedAt ?? b.createdAt) - (a.updatedAt ?? a.createdAt)
      })
      return sorted
    }

    // "discover" and "unseen": smallest convos first, but newest within each size.
    sorted.sort((a, b) => {
      if (!!a.isLive !== !!b.isLive) return a.isLive ? -1 : 1
      if (a.videoCount !== b.videoCount) return a.videoCount - b.videoCount
      return b.createdAt - a.createdAt
    })

    return sorted
  }, [bondfires, currentUserId, query, viewMode])

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
      if (state$.thumbnailUrls[bondfire._id].get()) return
      if (loadingThumbsRef.current.has(bondfire._id)) return

      loadingThumbsRef.current.add(bondfire._id)
      try {
        const { thumbnailUrl } = await getThumbnailUrl({
          muxPlaybackId: bondfire.muxPlaybackId,
          muxPlaybackPolicy: bondfire.muxPlaybackPolicy,
          bondfireId: bondfire._id,
        })
        state$.thumbnailUrls[bondfire._id].set(thumbnailUrl)
      } catch (error) {
        console.error('Failed to load thumbnail URL for bondfire:', bondfire._id, error)
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
      router.push(`/(main)/bondfire/${bondfireId}`)
    },
    [router],
  )

  const handleRespond = useCallback(
    (bondfireId: string) => {
      router.push(`/(main)/(tabs)/create?respondTo=${bondfireId}`)
    },
    [router],
  )

  const handleSpark = useCallback(() => {
    if (selectedCamp?.ownerId && !selectedCamp?.isLaunchCamp && selectedCamp.membership.role !== 'owner') {
      Alert.alert(
        'Owner Sparks Only',
        'Only the private camp owner can start new Bondfires here. You can respond to existing fires.',
      )
      return
    }

    if (selectedCampId) {
      router.push({ pathname: '/(main)/(tabs)/create', params: { campId: selectedCampId } })
      return
    }

    router.push('/(main)/(tabs)/create')
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
    <YStack flex={1} backgroundColor={bondfireColors.obsidian}>
      <FeedSubscription
        key={`${refreshKey}-${selectedCampId ?? 'all'}`}
        selectedCampId={selectedCampId}
        onResolved={handleBondfiresResolved}
      />
      <StatusBar barStyle="light-content" backgroundColor="transparent" translucent />

      <FlatList
        ref={(r) => {
          listRef.current = r
        }}
        data={filtered ?? []}
        keyExtractor={(item) => item._id}
        refreshControl={
          <RefreshControl
            refreshing={isRefreshing}
            onRefresh={handleRefresh}
            tintColor={bondfireColors.bondfireCopper}
            colors={[bondfireColors.bondfireCopper]}
            progressViewOffset={insets.top + 100}
          />
        }
        onScrollToIndexFailed={({ index, averageItemLength }) => {
          listRef.current?.scrollToOffset({
            offset: Math.max(0, index * (averageItemLength || 80)),
            animated: false,
          })
        }}
        renderItem={({ item }) => (
          <BondfireRow
            bondfire={item}
            thumbnailUrl={thumbnailUrls[item._id] ?? null}
            onOpen={() => handleBondfirePress(item._id)}
            onRespond={() => handleRespond(item._id)}
          />
        )}
        ItemSeparatorComponent={() => (
          <Separator borderColor={bondfireColors.iron} opacity={0.6} marginHorizontal={16} />
        )}
        ListHeaderComponent={
          <YStack paddingTop={insets.top + 16} paddingBottom={12} paddingHorizontal={16} gap={12}>
            <XStack alignItems="baseline" justifyContent="space-between" gap={16}>
              <YStack gap={2} flex={1}>
                <Text fontSize={26} fontWeight="900" numberOfLines={1}>
                  Camp Feed
                </Text>
                <Text fontSize={13} color={bondfireColors.ash}>
                  Filter by joined camp or scan every fire.
                </Text>
              </YStack>

              <Button variant="secondary" size="$sm" onPress={handleSpark}>
                <Text color={bondfireColors.whiteSmoke} fontWeight="900">
                  Spark
                </Text>
              </Button>
            </XStack>

            <XStack
              alignItems="center"
              gap={10}
              backgroundColor={bondfireColors.gunmetal}
              borderRadius={14}
              borderWidth={1}
              borderColor={bondfireColors.iron}
              paddingHorizontal={12}
              paddingVertical={10}
            >
              <Search size={18} color={bondfireColors.ash} />
              <Input
                value={query}
                onChangeText={setQuery}
                placeholder="Search creator or tags"
                backgroundColor="transparent"
                borderWidth={0}
                height={22}
                paddingHorizontal={0}
                flex={1}
              />
              {filtered ? (
                <Text fontSize={12} color={bondfireColors.ash} fontWeight="900">
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
              <Flame size={56} color={bondfireColors.bondfireCopper} />
              <Text fontSize={18} fontWeight="900">
                No matches
              </Text>
              <Text
                fontSize={14}
                color={bondfireColors.ash}
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
                <Text color={bondfireColors.whiteSmoke} fontWeight="900">
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

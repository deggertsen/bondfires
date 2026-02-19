import {
  appActions,
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
import { FlatList, Pressable, StatusBar, type ViewToken } from 'react-native'
import { Separator, Spinner, XStack, YStack } from 'tamagui'
import { api } from '../../../../../convex/_generated/api'
import type { Doc } from '../../../../../convex/_generated/dataModel'

type BondfireData = Doc<'bondfires'>

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
        </YStack>

        <YStack flex={1} gap={6}>
          <XStack alignItems="center" justifyContent="space-between" gap={10}>
            <YStack flex={1} gap={2}>
              <Text fontSize={16} fontWeight="900" numberOfLines={1}>
                {bondfire.creatorName ?? 'Anonymous'}
              </Text>
              <Text fontSize={12} color={bondfireColors.ash} numberOfLines={1}>
                {timeAgo} · {viewed ? 'Viewed' : 'New'}
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

export default function FeedScreen() {
  const router = useRouter()
  const bondfires = useQuery(api.bondfires.listFeed, { limit: 50 })
  const getDownloadUrl = useAction(api.videos.getDownloadUrl)

  const [viewMode, setViewMode] = useState<ViewMode>('discover')
  const [query, setQuery] = useState('')

  const state$ = useObservable({
    thumbnailUrls: {} as Record<string, string | null>,
  })
  const thumbnailUrls = useValue(state$.thumbnailUrls)

  const listRef = useRef<FlatList<BondfireData> | null>(null)
  const filteredRef = useRef<BondfireData[]>([])
  const loadingThumbsRef = useRef<Set<string>>(new Set())
  const didRestoreScrollRef = useRef(false)
  const persistActiveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const filtered = useMemo(() => {
    if (!bondfires) return bondfires

    const q = query.trim().toLowerCase()
    let items = bondfires

    if (viewMode === 'unseen') {
      items = items.filter((b) => !hasViewedToday(b._id))
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
      sorted.sort((a, b) => b.createdAt - a.createdAt)
      return sorted
    }

    if (viewMode === 'active') {
      sorted.sort((a, b) => {
        if (b.videoCount !== a.videoCount) return b.videoCount - a.videoCount
        return (b.updatedAt ?? b.createdAt) - (a.updatedAt ?? a.createdAt)
      })
      return sorted
    }

    // "discover" and "unseen": smallest convos first, but newest within each size.
    sorted.sort((a, b) => {
      if (a.videoCount !== b.videoCount) return a.videoCount - b.videoCount
      return b.createdAt - a.createdAt
    })

    return sorted
  }, [bondfires, query, viewMode])

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

    // Let FlatList mount before scrolling.
    setTimeout(() => {
      listRef.current?.scrollToIndex({ index, animated: false, viewPosition: 0.2 })
    }, 0)
  }, [filtered])

  const ensureThumbnailUrl = useCallback(
    async (bondfire: BondfireData) => {
      if (!bondfire.thumbnailKey) return
      if (state$.thumbnailUrls[bondfire._id].get()) return
      if (loadingThumbsRef.current.has(bondfire._id)) return

      loadingThumbsRef.current.add(bondfire._id)
      try {
        const { downloadUrl } = await getDownloadUrl({ key: bondfire.thumbnailKey })
        state$.thumbnailUrls[bondfire._id].set(downloadUrl)
      } catch (error) {
        console.error('Failed to load thumbnail URL for bondfire:', bondfire._id, error)
        loadingThumbsRef.current.delete(bondfire._id)
      }
    },
    [getDownloadUrl, state$],
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
      // Update last location so app relaunch returns to this conversation.
      setBondfireVideoIndex(bondfireId, getBondfireVideoIndex(bondfireId) ?? 0)
      // Unmute when navigating to detail view.
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
    }
  }, [])

  const viewabilityConfig = useRef({ itemVisiblePercentThreshold: 10 }).current

  if (bondfires === undefined) {
    return <LoadingFeed />
  }

  if (bondfires.length === 0) {
    return <EmptyFeed />
  }

  return (
    <YStack flex={1} backgroundColor={bondfireColors.obsidian}>
      <StatusBar barStyle="light-content" backgroundColor={bondfireColors.obsidian} />

      <FlatList
        ref={(r) => {
          listRef.current = r
        }}
        data={filtered ?? []}
        keyExtractor={(item) => item._id}
        onScrollToIndexFailed={({ index, averageItemLength }) => {
          // If list hasn't measured yet, fall back to a best-effort offset.
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
          <YStack paddingTop={16} paddingBottom={12} paddingHorizontal={16} gap={12}>
            <XStack alignItems="baseline" justifyContent="space-between" gap={16}>
              <YStack gap={2} flex={1}>
                <Text fontSize={26} fontWeight="900" numberOfLines={1}>
                  Campground
                </Text>
                <Text fontSize={13} color={bondfireColors.ash}>
                  Pick a camp to play.
                </Text>
              </YStack>

              <Button variant="secondary" size="$sm" onPress={() => router.push('/(main)/(tabs)/create')}>
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
          <YStack paddingVertical={80} alignItems="center" justifyContent="center" gap={12}>
            <Flame size={56} color={bondfireColors.bondfireCopper} />
            <Text fontSize={18} fontWeight="900">
              No matches
            </Text>
            <Text fontSize={14} color={bondfireColors.ash} textAlign="center" paddingHorizontal={48}>
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
        }
        contentContainerStyle={{ paddingBottom: 140 }}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        onViewableItemsChanged={onViewableItemsChanged}
        viewabilityConfig={viewabilityConfig}
      />
    </YStack>
  )
}

import {
  appActions,
  appStore$,
  freeSummaryDismissed$,
  freeUpgradeActions,
  getBondfireVideoIndex,
  getErrorMessage,
  getFeedActiveBondfireId,
  getLastLocation,
  hasViewedToday,
  setBondfireVideoIndex,
  setFeedActiveBondfireId,
  subscriptionStore$,
  telemetry,
  useAppThemeColors,
  useCanLoadTabData,
  useCanRunRecordingBackgroundWork,
  useLoadingTimeoutTelemetry,
  useSubscription,
} from '@bondfires/app'
import {
  type BondfireRowProps,
  Button,
  closeOpenSwipeableRow,
  EmberRail,
  type EmberRailItem,
  Input,
  Spinner,
  Text,
} from '@bondfires/ui'
import { useValue } from '@legendapp/state/react'
import { useIsFocused } from '@react-navigation/native'
import { AlertTriangle, Flame, RefreshCw, Search, X } from '@tamagui/lucide-icons'
import { useMutation, useQuery } from 'convex/react'
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
  BondfireThumbnailContent,
  BondfireThumbnailRow,
} from '../../../components/BondfireThumbnail'
import {
  BONDFIRE_REPORT_OPTIONS,
  getBondfireSwipeActions,
  getSwipeReportComment,
} from '../../../lib/bondfireSwipeActions'
import type { BondfireThumbnailFields } from '../../../lib/bondfireThumbnails'
import { routes } from '../../../lib/routes'
import { useBondfireThumbnails } from '../../../lib/useBondfireThumbnails'

type BondfireData = Doc<'bondfires'> &
  BondfireThumbnailFields & {
    isLive?: boolean
    livePlaybackId?: string
    campLabel?: string
    badge?: 'sparked' | 'invited' | 'kindled' | null
  }
type JoinedCamp = Doc<'camps'> & { membership: Doc<'campMembers'> }

type PublicUser = {
  _id: Id<'users'>
  displayName?: string
  name?: string
  photoUrl?: string
}

type ThreadParticipant = {
  user: PublicUser
  latestAt: number
  videoCount: number
  isPinned: boolean
}

/** Shape returned by api.conversations.listMyFires (same as the My Fires screen). */
type MyFire = Doc<'bondfires'> &
  BondfireThumbnailFields & {
    camp: Doc<'camps'> | null
    lastActivityAt: number
    unread: boolean
    participants: ThreadParticipant[]
    badge?: 'sparked' | 'invited' | 'kindled' | null
  }

type ViewMode = 'discover' | 'recent' | 'active' | 'unseen'

// Home shows at most this many unread threads as full rows before deferring to
// the "See all" overflow into My Fires, so heavy responders still reach
// Discover in one thumb-swipe.
const NEW_RESPONSES_CAP = 5
// The rail is recognition, not an archive — cap it and let the lead tile carry
// the full list.
const RAIL_MAX_ITEMS = 20

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
  currentUserId: string | null,
  pinnedIds: string[],
  onOpen: () => void,
  onRespond: () => void,
  onDelete: () => void,
  onPin: () => void,
  onUnpin: () => void,
  onReport: () => void,
): Omit<BondfireRowProps, 'thumbnailUrl'> {
  const isOwner = currentUserId === bondfire.userId
  const isPinned = pinnedIds.includes(bondfire._id)

  return {
    title: bondfire.title,
    creatorName: bondfire.creatorName ?? 'Anonymous',
    timestamp: bondfire.createdAt,
    videoCount: bondfire.videoCount,
    campLabel: bondfire.campLabel,
    isLive: bondfire.videoStatus === 'live' || !!bondfire.isLive,
    statusLabel: hasViewedToday(bondfire._id) ? 'Viewed' : 'New',
    badge: bondfire.badge,
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

/**
 * Map a MyFire thread to BondfireRow props for the "New responses" section.
 * Mirrors the My Fires screen's mapping (lastActivityAt timestamp, server-side
 * unread label, real participants) minus the owner-only edit swipe action.
 */
function toMyFireRowProps(
  thread: MyFire,
  currentUserId: string | null,
  pinnedIds: string[],
  onOpen: () => void,
  onRespond: () => void,
  onDelete: () => void,
  onPin: () => void,
  onUnpin: () => void,
  onReport: () => void,
): Omit<BondfireRowProps, 'thumbnailUrl'> {
  const isOwner = currentUserId === thread.userId
  const isPinned = pinnedIds.includes(thread._id)

  return {
    title: thread.title,
    creatorName: thread.creatorName ?? 'Anonymous',
    timestamp: thread.lastActivityAt,
    videoCount: thread.videoCount,
    campLabel: thread.camp?.name,
    isLive: thread.videoStatus === 'live',
    statusLabel:
      thread.videoStatus === 'awaiting_recovery'
        ? 'Uploading from your phone'
        : thread.unread
          ? 'New'
          : 'Viewed',
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
    onOpen,
    onRespond,
  }
}

function EmptyFeed({
  canCreate,
  onSpark,
  onBrowseCamps,
}: {
  canCreate: boolean
  onSpark: () => void
  onBrowseCamps: () => void
}) {
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
      {canCreate ? (
        <>
          <Text fontSize={24} fontWeight="900" marginBottom={12} textAlign="center">
            Spark a Bondfire
          </Text>
          <Text fontSize={16} color={'$placeholderColor'} textAlign="center" marginBottom={32}>
            Be the first to share a video!
          </Text>
          <Button variant="primary" size="$lg" onPress={onSpark}>
            <Flame size={20} color={'$color'} />
            <Text color={'$color'} fontWeight="900">
              Spark Bondfire
            </Text>
          </Button>
        </>
      ) : (
        <>
          <Text fontSize={24} fontWeight="900" marginBottom={12} textAlign="center">
            Find a fire to respond to
          </Text>
          <Text fontSize={16} color={'$placeholderColor'} textAlign="center" marginBottom={32}>
            Join a camp to see its Bondfires here, then jump in with a video response.
          </Text>
          <Button variant="primary" size="$lg" onPress={onBrowseCamps}>
            <Text color={'$color'} fontWeight="900">
              Browse Camps
            </Text>
          </Button>
        </>
      )}
    </YStack>
  )
}

/**
 * Persistent, low-friction upgrade front door for free users (M11/M12).
 * Replaces the always-visible Spark tab as the conversion surface: it states
 * the respond-first value prop proactively, links to the paywall, and can be
 * dismissed (persisted) to reclaim its vertical space.
 */
function FreeSummaryCard() {
  return (
    <XStack
      alignItems="center"
      gap={12}
      backgroundColor={'$backgroundHover'}
      borderRadius={14}
      borderWidth={1}
      borderColor={'$borderColor'}
      paddingVertical={12}
      paddingHorizontal={14}
    >
      <Flame size={20} color={'$primary'} />
      <YStack flex={1} gap={2}>
        <Text fontSize={13} color={'$color'} fontWeight="900">
          You're on the free plan
        </Text>
        <Text fontSize={12} color={'$placeholderColor'} lineHeight={17}>
          Respond to any fire, or{' '}
          <Text
            fontSize={12}
            color={'$primary'}
            fontWeight="900"
            accessibilityRole="button"
            accessibilityLabel="Upgrade to spark your own Bondfires"
            onPress={() => freeUpgradeActions.pressPaywallCta('feed_summary')}
          >
            upgrade
          </Text>{' '}
          to spark your own.
        </Text>
      </YStack>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Dismiss free plan card"
        hitSlop={10}
        onPress={() => freeUpgradeActions.dismissSummaryCard()}
      >
        <X size={18} color={'$placeholderColor'} />
      </Pressable>
    </XStack>
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

function FeedRetry({ onRetry }: { onRetry: () => void }) {
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
        We're having trouble loading the feed. Check your internet connection and try again.
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

function FeedSubscription({
  selectedCampId,
  enabled,
  onResolved,
}: {
  selectedCampId: Doc<'camps'>['_id'] | null | undefined
  enabled: boolean
  onResolved: (bondfires: BondfireData[]) => void
}) {
  const allBondfires = useQuery(
    api.bondfires.listFeed,
    enabled && selectedCampId === null ? { limit: 50 } : 'skip',
  )
  const campBondfires = useQuery(
    api.bondfires.listByCamp,
    enabled && selectedCampId ? { campId: selectedCampId, limit: 50 } : 'skip',
  )
  const bondfires =
    selectedCampId === undefined ? undefined : selectedCampId ? campBondfires : allBondfires

  useEffect(() => {
    if (bondfires !== undefined) {
      onResolved(bondfires)
    }
  }, [bondfires, onResolved])

  return null
}

export default function HomeScreen() {
  const { colors, statusBarStyle } = useAppThemeColors()
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const isFocused = useIsFocused()
  const canLoadTabData = useCanLoadTabData(isFocused)
  const shouldRunBackgroundWork = useCanRunRecordingBackgroundWork(isFocused)
  const { canCreate } = useSubscription()
  const subscriptionResolved = useValue(subscriptionStore$.subscriptionResolved)
  const summaryDismissed = useValue(freeSummaryDismissed$.dismissed)
  // Gate on `subscriptionResolved` so a returning paid user never sees the card
  // flash on cold start (currentTier defaults to free until the query lands).
  const showFreeSummaryCard = subscriptionResolved && !canCreate && !summaryDismissed

  const [viewMode, setViewMode] = useState<ViewMode>('discover')
  const [query, setQuery] = useState('')
  const [refreshKey, setRefreshKey] = useState(0)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [bondfires, setBondfires] = useState<BondfireData[] | undefined>(undefined)
  const currentUserId = useValue(appStore$.userId)
  const currentCampId = useValue(appStore$.currentCampId)
  const joinedCamps = useQuery(api.camps.listMine, canLoadTabData && currentUserId ? {} : 'skip') as
    | JoinedCamp[]
    | undefined
  const feedCamps = useMemo(
    () => (joinedCamps ?? []).filter((camp) => camp.status !== 'archived'),
    [joinedCamps],
  )
  const selectedCampId = currentCampId as Doc<'camps'>['_id'] | null
  const selectedCamp = feedCamps.find((camp) => camp._id === selectedCampId)
  const activeCampId =
    selectedCampId && joinedCamps === undefined ? undefined : (selectedCamp?._id ?? null)
  const feedSubscriptionKey = `${refreshKey}-${
    activeCampId === undefined ? 'resolving' : (activeCampId ?? 'all')
  }`

  // Authenticated user data for private pin state.
  const currentUser = useQuery(api.users.current, canLoadTabData && currentUserId ? {} : 'skip')
  const pinnedIds = useMemo(
    () => (currentUser?.pinnedBondfireIds ?? []) as string[],
    [currentUser?.pinnedBondfireIds],
  )
  const listExtraData = useMemo(() => ({ currentUserId, pinnedIds }), [currentUserId, pinnedIds])
  const pinnedOrder = useMemo(() => new Map(pinnedIds.map((id, index) => [id, index])), [pinnedIds])

  // Threads the user participates in — powers the Ember Rail and the
  // "New responses" section. Convex keeps this live, so unread state and new
  // responses appear without a manual refresh.
  const myFires = useQuery(
    api.conversations.listMyFires,
    canLoadTabData && currentUserId ? { limit: 80, pinnedFirst: false } : 'skip',
  ) as MyFire[] | undefined
  const myFireIdSet = useMemo(() => new Set((myFires ?? []).map((t) => t._id)), [myFires])

  // Rail order: unread first, quiet after, pinned hoisted within each group.
  const sortedMyFires = useMemo(() => {
    const byPinnedThenActivity = (a: MyFire, b: MyFire) => {
      const aIndex = pinnedOrder.get(a._id)
      const bIndex = pinnedOrder.get(b._id)
      if (aIndex !== undefined || bIndex !== undefined) {
        if (aIndex === undefined) return 1
        if (bIndex === undefined) return -1
        return aIndex - bIndex
      }
      return b.lastActivityAt - a.lastActivityAt
    }
    const unread = (myFires ?? []).filter((t) => t.unread).sort(byPinnedThenActivity)
    const quiet = (myFires ?? []).filter((t) => !t.unread).sort(byPinnedThenActivity)
    return { unread, quiet }
  }, [myFires, pinnedOrder])

  const newResponseThreads = useMemo(
    () => sortedMyFires.unread.slice(0, NEW_RESPONSES_CAP),
    [sortedMyFires],
  )
  const unreadCount = sortedMyFires.unread.length

  // Mutations for swipe actions
  const deleteBondfire = useMutation(api.bondfires.deleteBondfire)
  const pinBondfire = useMutation(api.bondfires.pinBondfire)
  const unpinBondfire = useMutation(api.bondfires.unpinBondfire)
  const reportBondfire = useMutation(api.reports.submit)

  const handleThumbnailBatchError = useCallback(
    (error: unknown, pending: Array<{ bondfireId: string }>) => {
      telemetry.warn('feed:thumbnail', 'Failed to load thumbnail URL batch', {
        batchSize: pending.length,
        bondfireIds: pending.map((item) => item.bondfireId),
        error: String(error),
      })
    },
    [],
  )
  const { ensureThumbnailUrls, resetThumbnailUrls, thumbnailUrls$ } = useBondfireThumbnails({
    enabled: shouldRunBackgroundWork,
    onBatchError: handleThumbnailBatchError,
  })

  const railThreads = useMemo(
    () => [...sortedMyFires.unread, ...sortedMyFires.quiet].slice(0, RAIL_MAX_ITEMS),
    [sortedMyFires],
  )
  const railItems = useMemo<EmberRailItem[]>(
    () =>
      railThreads.map((thread) => ({
        id: thread._id,
        label: thread.title?.trim() || `${thread.creatorName ?? 'Anonymous'}'s Bondfire`,
        thumbnailUrl: null,
        unread: thread.unread,
        isUnansweredSpark: thread.userId === currentUserId && thread.videoCount <= 1,
      })),
    [currentUserId, railThreads],
  )
  const railThreadsById = useMemo(
    () => new Map<string, MyFire>(railThreads.map((thread) => [thread._id, thread])),
    [railThreads],
  )
  const renderRailThumbnail = useCallback(
    (item: EmberRailItem) => {
      const thread = railThreadsById.get(item.id)
      return thread ? (
        <BondfireThumbnailContent bondfire={thread} thumbnailUrls$={thumbnailUrls$} />
      ) : null
    },
    [railThreadsById, thumbnailUrls$],
  )

  const listRef = useRef<FlatList<BondfireData> | null>(null)
  const filteredRef = useRef<BondfireData[]>([])
  const didRestoreScrollRef = useRef(false)
  const persistActiveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const refreshTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const { timedOut, resetLoadTracking } = useLoadingTimeoutTelemetry({
    eventName: 'feed',
    label: 'Feed',
    isLoading: bondfires === undefined,
    loadedCount: bondfires?.length,
    context: {
      canLoadTabData,
      shouldRunBackgroundWork,
      hasCurrentUserId: !!currentUserId,
      activeCampId: activeCampId ?? null,
      activeCampResolving: activeCampId === undefined,
    },
  })

  const stopRefreshing = useCallback(() => {
    if (refreshTimeoutRef.current) {
      clearTimeout(refreshTimeoutRef.current)
      refreshTimeoutRef.current = null
    }
    setIsRefreshing(false)
  }, [])

  const handleRefresh = useCallback(() => {
    resetLoadTracking()
    resetThumbnailUrls()
    setIsRefreshing(true)
    setRefreshKey((current) => current + 1)

    if (refreshTimeoutRef.current) {
      clearTimeout(refreshTimeoutRef.current)
    }
    refreshTimeoutRef.current = setTimeout(() => {
      refreshTimeoutRef.current = null
      setIsRefreshing(false)
    }, 5000)
  }, [resetLoadTracking, resetThumbnailUrls])

  const handleBondfiresResolved = useCallback(
    (nextBondfires: BondfireData[]) => {
      setBondfires(nextBondfires)
      stopRefreshing()
    },
    [stopRefreshing],
  )

  const handleRetry = useCallback(() => {
    telemetry.breadcrumb('feed:retry')
    resetLoadTracking()
    setBondfires(undefined)
    setRefreshKey((current) => current + 1)
  }, [resetLoadTracking])

  useEffect(() => {
    if (!selectedCampId || joinedCamps === undefined) {
      return
    }

    if (!feedCamps.some((camp) => camp._id === selectedCampId)) {
      resetLoadTracking()
      setBondfires(undefined)
      resetThumbnailUrls()
      appActions.setCurrentCampId(null)
    }
  }, [feedCamps, joinedCamps, resetLoadTracking, resetThumbnailUrls, selectedCampId])

  const filtered = useMemo(() => {
    if (!bondfires) return bondfires

    const q = query.trim().toLowerCase()
    // Discover is for fires you're NOT in yet — threads you participate in
    // already live in the rail and the "New responses" section above.
    let items = bondfires.filter((b) => !myFireIdSet.has(b._id))

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
  }, [bondfires, currentUserId, myFireIdSet, pinnedOrder, query, viewMode])

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

  useEffect(() => {
    if (!shouldRunBackgroundWork || !filtered) return
    ensureThumbnailUrls(filtered.slice(0, 10))
  }, [ensureThumbnailUrls, filtered, shouldRunBackgroundWork])

  // Rail tiles and "New responses" rows resolve their thumbnails through the
  // same cache as the Discover list.
  useEffect(() => {
    if (!shouldRunBackgroundWork || !myFires) return
    ensureThumbnailUrls([...sortedMyFires.unread, ...sortedMyFires.quiet].slice(0, 12))
  }, [ensureThumbnailUrls, myFires, shouldRunBackgroundWork, sortedMyFires])

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
    // Free users never route into the live record screen from the Feed header.
    // The Spark button becomes an invitation that opens the paywall directly
    // (M6 / dead-end vs. invitation).
    if (!canCreate) {
      freeUpgradeActions.pressPaywallCta('feed_spark')
      return
    }

    if (selectedCamp?.access === 'invite' && selectedCamp.membership.role !== 'owner') {
      Alert.alert(
        'Owner Sparks Only',
        'Only the private camp owner can start new Bondfires here. You can respond to existing fires.',
      )
      return
    }

    if (activeCampId) {
      router.push(routes.createForCamp(activeCampId))
      return
    }
    router.push(routes.createFresh())
  }, [activeCampId, canCreate, router, selectedCamp])

  const handleBrowseCamps = useCallback(() => {
    router.push(routes.camps)
  }, [router])

  const handleOpenAllFires = useCallback(() => {
    router.push(routes.myFires)
  }, [router])

  const handleSelectCamp = useCallback(
    (campId: string | null) => {
      resetLoadTracking()
      setBondfires(undefined)
      resetThumbnailUrls()
      appActions.setCurrentCampId(campId)
      listRef.current?.scrollToOffset({ offset: 0, animated: true })
    },
    [resetLoadTracking, resetThumbnailUrls],
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
              } catch (error) {
                Alert.alert('Error', 'Failed to delete bondfire. Please try again.')
                telemetry.error('feed:deleteBondfire', String(error))
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
      if (!shouldRunBackgroundWork) return
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

      ensureThumbnailUrls(items.slice(minIndex, maxIndex + 1))
    },
    [ensureThumbnailUrls, shouldRunBackgroundWork],
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
          key={feedSubscriptionKey}
          enabled={canLoadTabData}
          selectedCampId={activeCampId}
          onResolved={handleBondfiresResolved}
        />
        {timedOut ? <FeedRetry onRetry={handleRetry} /> : <LoadingFeed />}
      </YStack>
    )
  }

  return (
    <YStack flex={1} backgroundColor={'$background'}>
      <FeedSubscription
        key={feedSubscriptionKey}
        enabled={canLoadTabData}
        selectedCampId={activeCampId}
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
        onScrollBeginDrag={closeOpenSwipeableRow}
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
            currentUserId,
            pinnedIds,
            () => handleBondfirePress(item._id),
            () => handleRespond(item._id),
            () => handleDelete(item._id),
            () => handlePin(item._id),
            () => handleUnpin(item._id),
            () => handleReport(item._id, item.userId),
          )
          return <BondfireThumbnailRow {...props} bondfire={item} thumbnailUrls$={thumbnailUrls$} />
        }}
        ItemSeparatorComponent={() => (
          <Separator borderColor={'$borderColor'} opacity={0.6} marginHorizontal={16} />
        )}
        ListHeaderComponent={
          <YStack paddingTop={insets.top + 16} paddingBottom={12} gap={12}>
            <YStack paddingHorizontal={16} gap={12}>
              <XStack alignItems="baseline" justifyContent="space-between" gap={16}>
                <YStack gap={2} flex={1}>
                  <Text fontSize={26} fontWeight="900" numberOfLines={1}>
                    Home
                  </Text>
                  <Text fontSize={13} color={'$placeholderColor'}>
                    {unreadCount > 0
                      ? `${unreadCount} ${unreadCount === 1 ? 'fire has' : 'fires have'} new responses`
                      : 'All caught up — discover something new.'}
                  </Text>
                </YStack>

                <Button variant="secondary" size="$sm" onPress={handleSpark}>
                  <Text color={'$color'} fontWeight="900">
                    Spark
                  </Text>
                </Button>
              </XStack>

              {showFreeSummaryCard ? <FreeSummaryCard /> : null}
            </YStack>

            {railItems.length > 0 ? (
              <EmberRail
                items={railItems}
                totalCount={myFires?.length ?? 0}
                onOpenItem={handleBondfirePress}
                onOpenAll={handleOpenAllFires}
                renderThumbnail={renderRailThumbnail}
              />
            ) : null}

            {newResponseThreads.length > 0 ? (
              <YStack>
                <XStack
                  paddingHorizontal={16}
                  paddingBottom={4}
                  alignItems="center"
                  justifyContent="space-between"
                >
                  <Text fontSize={13} color={'$placeholderColor'} fontWeight="900">
                    New responses
                  </Text>
                  {unreadCount > NEW_RESPONSES_CAP ? (
                    <Text
                      fontSize={13}
                      color={'$primary'}
                      fontWeight="800"
                      accessibilityRole="button"
                      accessibilityLabel={`See all ${unreadCount} unread fires`}
                      onPress={handleOpenAllFires}
                    >
                      See all {unreadCount}
                    </Text>
                  ) : null}
                </XStack>
                {newResponseThreads.map((thread) => {
                  const props = toMyFireRowProps(
                    thread,
                    currentUserId,
                    pinnedIds,
                    () => handleBondfirePress(thread._id),
                    () => handleRespond(thread._id),
                    () => handleDelete(thread._id),
                    () => handlePin(thread._id),
                    () => handleUnpin(thread._id),
                    () => handleReport(thread._id, thread.userId),
                  )
                  return (
                    <YStack key={thread._id}>
                      <BondfireThumbnailRow
                        {...props}
                        bondfire={thread}
                        thumbnailUrls$={thumbnailUrls$}
                      />
                      <Separator borderColor={'$borderColor'} opacity={0.6} marginHorizontal={16} />
                    </YStack>
                  )
                })}
              </YStack>
            ) : null}

            <YStack paddingHorizontal={16} gap={12}>
              <Text fontSize={13} color={'$placeholderColor'} fontWeight="900">
                Discover
              </Text>

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
                  selected={!activeCampId}
                  onPress={() => handleSelectCamp(null)}
                />
                {feedCamps.map((camp) => (
                  <CampPill
                    key={camp._id}
                    label={camp.name.replace(/ \((Men|Women)\)$/, '')}
                    selected={activeCampId === camp._id}
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
          </YStack>
        }
        ListEmptyComponent={
          bondfires.length === 0 ? (
            <EmptyFeed
              canCreate={canCreate}
              onSpark={handleSpark}
              onBrowseCamps={handleBrowseCamps}
            />
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

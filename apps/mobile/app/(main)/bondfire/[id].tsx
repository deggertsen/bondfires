import {
  appStore$,
  getBondfireVideoIndex,
  getLastLocation,
  hasViewedToday,
  markViewed,
  setBondfireVideoIndex,
  setFeedActiveBondfireId,
  setLastLocation,
  telemetry,
  useAppThemeColors,
} from '@bondfires/app'
import { useObservable, useValue } from '@legendapp/state/react'
import { useIsFocused, useNavigation } from '@react-navigation/native'
import { useAction, useMutation, useQuery } from 'convex/react'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Animated, AppState, type FlatList, InteractionManager, type ViewToken } from 'react-native'
import { api } from '../../../../../convex/_generated/api'
import type { Id } from '../../../../../convex/_generated/dataModel'
import { goBackOrReplace } from '../../../lib/navigation'
import { routes } from '../../../lib/routes'
import { BondfirePlaybackScreen } from './_components/BondfirePlaybackScreen'
import {
  BondfireErroredScreen,
  BondfireLoadingScreen,
  BondfirePendingScreen,
  BondfireProcessingScreen,
  BondfireUnavailableScreen,
} from './_components/BondfireStatusScreens'
import {
  type BondfireDetailData,
  type BondfireVideoItem,
  buildBondfireVideoItems,
  clampVideoIndex,
  SCREEN_WIDTH,
  type ScrollToIndexFailedInfo,
  STUCK_PROCESSING_TELEMETRY_THRESHOLD_MS,
} from './_lib/bondfireDetailHelpers'
import { useBondfireVideoUrls } from './_lib/useBondfireVideoUrls'

export default function BondfireDetailScreen() {
  const { colors, statusBarStyle } = useAppThemeColors()
  const { id } = useLocalSearchParams<{ id: string }>()
  const router = useRouter()
  const navigation = useNavigation()
  const flatListRef = useRef<FlatList<BondfireVideoItem>>(null)
  const isFocused = useIsFocused()

  const screenState$ = useObservable({
    currentVideoIndex: 0,
    videoUrls: [] as (string | null)[],
    showSettings: false,
    showNotepad: false,
    isAppActive: AppState.currentState === 'active',
    isScrubbing: false,
  })
  const pendingPulse = useRef(new Animated.Value(0.55)).current

  const currentVideoIndex = useValue(screenState$.currentVideoIndex)
  const videoUrls = useValue(screenState$.videoUrls)
  const showSettings = useValue(screenState$.showSettings)
  const showNotepad = useValue(screenState$.showNotepad)
  const isAppActive = useValue(screenState$.isAppActive)
  const isScrubbing = useValue(screenState$.isScrubbing)
  const currentUserId = useValue(appStore$.userId)

  const bondfireId = id as Id<'bondfires'>
  const bondfireData = useQuery(api.bondfires.getWithVideos, { bondfireId }) as
    | BondfireDetailData
    | null
    | undefined
  const unavailableReason = useQuery(
    api.bondfires.getUnavailableReason,
    bondfireData === null ? { bondfireId } : 'skip',
  )
  const campContext = useQuery(api.bondfires.getWithCampContext, { id: bondfireId })
  const getVideoUrls = useAction(api.videos.getVideoUrls)
  const recordWatchEvent = useMutation(api.watchEvents.record)
  const incrementViews = useMutation(api.bondfires.incrementViews)
  const markThreadRead = useMutation(api.conversations.markThreadRead)
  const [isInviteSheetOpen, setIsInviteSheetOpen] = useState(false)
  const setVideoUrls = useCallback(
    (urls: (string | null)[]) => {
      screenState$.videoUrls.set(urls)
    },
    [screenState$],
  )

  const hasRedirectedToJoinGate = useRef(false)
  useEffect(() => {
    if (hasRedirectedToJoinGate.current) return
    if (!campContext || !campContext.camp) return
    if (!campContext.bondfire?.campId) return
    if (campContext.membership?.status === 'active') return

    hasRedirectedToJoinGate.current = true
    router.replace(routes.campJoinGate(campContext.bondfire.campId, bondfireId))
  }, [campContext, bondfireId, router])

  useEffect(() => {
    if (bondfireData?.videoStatus !== 'pending') {
      return
    }

    const animation = Animated.loop(
      Animated.sequence([
        Animated.timing(pendingPulse, {
          toValue: 1,
          duration: 900,
          useNativeDriver: true,
        }),
        Animated.timing(pendingPulse, {
          toValue: 0.55,
          duration: 900,
          useNativeDriver: true,
        }),
      ]),
    )
    animation.start()

    return () => animation.stop()
  }, [bondfireData?.videoStatus, pendingPulse])

  const persistPositionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const restoreScrollTaskRef = useRef<ReturnType<
    typeof InteractionManager.runAfterInteractions
  > | null>(null)
  const restoreRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const restoreTargetRef = useRef<{ bondfireId: string; savedIndex: number } | null>(null)
  const restoredPositionKeyRef = useRef<string | null>(null)

  const loggedPlaybackStateRef = useRef<string | null>(null)
  useEffect(() => {
    if (bondfireData === undefined) return

    let key: string
    let log: () => void

    if (bondfireData === null) {
      key = `${bondfireId}:unavailable:${unavailableReason?.reason ?? 'unknown'}`
      log = () =>
        telemetry.warn('video:detail:unavailable', 'Bondfire detail query returned null', {
          bondfireId,
          reason: unavailableReason?.reason,
          videoStatus: unavailableReason?.videoStatus,
        })
    } else if (bondfireData.videoStatus === 'processing') {
      const processingForMs = Date.now() - bondfireData.updatedAt
      key = `${bondfireData._id}:processing`
      const data = {
        bondfireId: bondfireData._id,
        processingForMs,
        hasMuxAssetId: !!bondfireData.muxAssetId,
        hasMuxUploadId: !!bondfireData.muxUploadId,
        hasMuxLiveStreamId: !!bondfireData.muxLiveStreamId,
        muxAssetStatus: bondfireData.muxAssetStatus,
      }
      log =
        processingForMs > STUCK_PROCESSING_TELEMETRY_THRESHOLD_MS
          ? () =>
              telemetry.warn(
                'video:detail:stuck_processing',
                'Viewer hit a bondfire stuck in processing',
                data,
              )
          : () =>
              telemetry.info('video:detail:processing', 'Viewer hit a processing bondfire', data)
    } else {
      return
    }

    if (loggedPlaybackStateRef.current === key) return
    loggedPlaybackStateRef.current = key
    log()
  }, [bondfireData, bondfireId, unavailableReason])

  useEffect(() => {
    if (bondfireData !== null) return
    const last = getLastLocation()
    if (last?.type === 'bondfire' && last.bondfireId === bondfireId) {
      setLastLocation({ type: 'feed', updatedAt: Date.now() })
    }
    if (!router.canGoBack()) {
      router.replace(routes.feed)
    }
  }, [bondfireData, bondfireId, router])

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (appState) => {
      screenState$.isAppActive.set(appState === 'active')
    })

    return () => {
      subscription.remove()
    }
  }, [screenState$])

  const clearScheduledRestoreScroll = useCallback(() => {
    restoreScrollTaskRef.current?.cancel()
    restoreScrollTaskRef.current = null

    if (restoreRetryTimerRef.current) {
      clearTimeout(restoreRetryTimerRef.current)
      restoreRetryTimerRef.current = null
    }
  }, [])

  const scrollToVideoIndex = useCallback((index: number, animated: boolean) => {
    flatListRef.current?.scrollToIndex({ index, animated })
  }, [])

  const scheduleRestoreScroll = useCallback(
    (index: number) => {
      clearScheduledRestoreScroll()

      if (index === 0) return

      restoreScrollTaskRef.current = InteractionManager.runAfterInteractions(() => {
        restoreScrollTaskRef.current = null
        scrollToVideoIndex(index, false)
      })
    },
    [clearScheduledRestoreScroll, scrollToVideoIndex],
  )

  useEffect(() => {
    return clearScheduledRestoreScroll
  }, [clearScheduledRestoreScroll])

  useBondfireVideoUrls({ bondfireData, getVideoUrls, setVideoUrls })

  useEffect(() => {
    if (!bondfireId) return
    if (!bondfireData) return
    if (bondfireData?.videoStatus === 'live') return
    if (bondfireData.userId === currentUserId) return
    if (hasViewedToday(bondfireId)) return

    let isCancelled = false

    const recordView = async () => {
      try {
        await incrementViews({ bondfireId })
        if (!isCancelled) {
          markViewed(bondfireId)
        }
      } catch (error) {
        telemetry.error('bondfire:view', 'Failed to record bondfire view', { error: String(error) })
      }
    }

    recordView()

    return () => {
      isCancelled = true
    }
  }, [bondfireId, bondfireData, currentUserId, incrementViews])

  useEffect(() => {
    if (!bondfireId || !bondfireData || !currentUserId) return
    const isParticipant = (bondfireData.participants ?? []).some(
      (participant) => participant.user._id === currentUserId,
    )
    if (!isParticipant) return

    markThreadRead({ bondfireId }).catch((error) => {
      telemetry.error('bondfire:thread', 'Failed to mark Bondfire thread read', {
        error: String(error),
      })
    })
  }, [bondfireData, bondfireId, currentUserId, markThreadRead])

  useEffect(() => {
    if (!bondfireData) return

    if (restoreTargetRef.current?.bondfireId !== bondfireId) {
      restoreTargetRef.current = {
        bondfireId,
        savedIndex: getBondfireVideoIndex(bondfireId) ?? 0,
      }
      restoredPositionKeyRef.current = null
    }

    setFeedActiveBondfireId(bondfireId)

    const total = 1 + bondfireData.videos.length
    const clamped = clampVideoIndex(restoreTargetRef.current.savedIndex, total)
    const restoredPositionKey = `${bondfireId}:${clamped}`
    if (restoredPositionKeyRef.current === restoredPositionKey) return
    restoredPositionKeyRef.current = restoredPositionKey

    screenState$.currentVideoIndex.set(clamped)
    scheduleRestoreScroll(clamped)
  }, [bondfireData, bondfireId, scheduleRestoreScroll, screenState$])

  useEffect(() => {
    if (!bondfireId) return
    const indexToPersist = currentVideoIndex

    if (persistPositionTimerRef.current) {
      clearTimeout(persistPositionTimerRef.current)
    }
    persistPositionTimerRef.current = setTimeout(() => {
      setFeedActiveBondfireId(bondfireId)
      setBondfireVideoIndex(bondfireId, indexToPersist)
    }, 200)

    return () => {
      if (persistPositionTimerRef.current) {
        clearTimeout(persistPositionTimerRef.current)
        persistPositionTimerRef.current = null
      }
    }
  }, [bondfireId, currentVideoIndex])

  const handleBackPress = useCallback(() => {
    goBackOrReplace(router, navigation, routes.feed)
  }, [navigation, router])

  const handleVideoComplete = useCallback(() => {
    if (!bondfireData) return

    recordWatchEvent({
      videoType: currentVideoIndex === 0 ? 'bondfire' : 'response',
      videoId:
        currentVideoIndex === 0 ? bondfireData._id : bondfireData.videos[currentVideoIndex - 1]._id,
      eventType: 'complete',
      positionMs: 0,
    })

    if (currentVideoIndex < videoUrls.length - 1) {
      flatListRef.current?.scrollToIndex({
        index: currentVideoIndex + 1,
        animated: true,
      })
    }
  }, [bondfireData, currentVideoIndex, videoUrls.length, recordWatchEvent])

  const handleScrubbingChange = useCallback(
    (scrubbing: boolean) => {
      screenState$.isScrubbing.set(scrubbing)
    },
    [screenState$],
  )

  const handleProgress = useCallback(
    (progress: number) => {
      if (!bondfireData) return

      const videoId =
        currentVideoIndex === 0 ? bondfireData._id : bondfireData.videos[currentVideoIndex - 1]._id
      const videoType = currentVideoIndex === 0 ? 'bondfire' : 'response'

      const milestones = [0.25, 0.5, 0.75] as const
      for (const milestone of milestones) {
        if (progress >= milestone && progress < milestone + 0.05) {
          const eventType = `milestone_${Math.round(milestone * 100)}` as
            | 'milestone_25'
            | 'milestone_50'
            | 'milestone_75'
          recordWatchEvent({
            videoType,
            videoId,
            eventType,
            positionMs: Math.round(progress * 1000),
          })
        }
      }
    },
    [bondfireData, currentVideoIndex, recordWatchEvent],
  )

  const handleRespond = useCallback(() => {
    if (bondfireData?.campStatus === 'archived') return
    router.push(routes.createRespondTo(id))
  }, [bondfireData?.campStatus, router, id])

  const onViewableItemsChanged = useCallback(
    ({ viewableItems }: { viewableItems: ViewToken[] }) => {
      if (viewableItems.length > 0 && viewableItems[0].index !== null) {
        screenState$.currentVideoIndex.set(viewableItems[0].index)
      }
    },
    [screenState$],
  )

  const viewabilityConfig = useRef({
    itemVisiblePercentThreshold: 50,
  }).current

  const handleScrollToIndexFailed = useCallback(
    ({ index, averageItemLength }: ScrollToIndexFailedInfo) => {
      if (index < 0) return

      const itemLength =
        Number.isFinite(averageItemLength) && averageItemLength > 0
          ? averageItemLength
          : SCREEN_WIDTH

      flatListRef.current?.scrollToOffset({
        offset: itemLength * index,
        animated: false,
      })

      if (restoreRetryTimerRef.current) {
        clearTimeout(restoreRetryTimerRef.current)
      }
      restoreRetryTimerRef.current = setTimeout(() => {
        restoreRetryTimerRef.current = null
        scrollToVideoIndex(index, false)
      }, 100)
    },
    [scrollToVideoIndex],
  )

  if (bondfireData === undefined) {
    return <BondfireLoadingScreen />
  }

  const statusScreenProps = {
    statusBarStyle,
    backgroundColor: colors.background,
    onBackPress: handleBackPress,
  }

  if (bondfireData === null) {
    return <BondfireUnavailableScreen {...statusScreenProps} />
  }

  if (bondfireData.videoStatus === 'pending') {
    return (
      <BondfirePendingScreen
        {...statusScreenProps}
        bondfireData={bondfireData}
        pendingPulse={pendingPulse}
      />
    )
  }

  if (bondfireData.videoStatus === 'processing') {
    return <BondfireProcessingScreen {...statusScreenProps} />
  }

  if (bondfireData.videoStatus === 'errored') {
    return <BondfireErroredScreen {...statusScreenProps} bondfireData={bondfireData} />
  }

  const totalVideos = 1 + bondfireData.videos.length
  const initialVideoIndex = clampVideoIndex(getBondfireVideoIndex(bondfireId), totalVideos)
  const processingResponseCount = bondfireData.processingResponses?.length ?? 0
  const videoItems = buildBondfireVideoItems(bondfireData, videoUrls)

  return (
    <BondfirePlaybackScreen
      statusBarStyle={statusBarStyle}
      backgroundColor={colors.background}
      bondfireId={bondfireId}
      bondfireData={bondfireData}
      campContext={campContext}
      videoItems={videoItems}
      currentVideoIndex={currentVideoIndex}
      totalVideos={totalVideos}
      processingResponseCount={processingResponseCount}
      isFocused={isFocused}
      isAppActive={isAppActive}
      isScrubbing={isScrubbing}
      showSettings={showSettings}
      showNotepad={showNotepad}
      isInviteSheetOpen={isInviteSheetOpen}
      flatListRef={flatListRef}
      onBackPress={handleBackPress}
      onToggleSettings={() => screenState$.showSettings.set(!screenState$.showSettings.get())}
      onToggleNotepad={() => screenState$.showNotepad.set(!screenState$.showNotepad.get())}
      onCloseSettings={() => screenState$.showSettings.set(false)}
      onCloseNotepad={() => screenState$.showNotepad.set(false)}
      onOpenInviteSheet={() => setIsInviteSheetOpen(true)}
      onCloseInviteSheet={() => setIsInviteSheetOpen(false)}
      onRespond={handleRespond}
      onVideoComplete={handleVideoComplete}
      onProgress={handleProgress}
      onScrubbingChange={handleScrubbingChange}
      onViewableItemsChanged={onViewableItemsChanged}
      viewabilityConfig={viewabilityConfig}
      initialVideoIndex={initialVideoIndex}
      onScrollToIndexFailed={handleScrollToIndexFailed}
    />
  )
}

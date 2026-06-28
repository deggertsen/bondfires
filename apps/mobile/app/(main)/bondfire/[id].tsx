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
import { useCallback, useEffect, useRef } from 'react'
import { Animated, AppState, type FlatList, InteractionManager } from 'react-native'
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

type WatchEventType = 'milestone_25' | 'milestone_50' | 'milestone_75' | 'complete'

type WatchTarget = {
  videoType: 'bondfire' | 'response'
  videoId: string
}

const WATCH_MILESTONES = [
  { progress: 0.25, eventType: 'milestone_25' },
  { progress: 0.5, eventType: 'milestone_50' },
  { progress: 0.75, eventType: 'milestone_75' },
] as const

function getWatchTarget(
  bondfireData: BondfireDetailData,
  currentVideoIndex: number,
): WatchTarget | null {
  if (currentVideoIndex === 0) {
    return {
      videoType: 'bondfire',
      videoId: bondfireData._id,
    }
  }

  const video = bondfireData.videos[currentVideoIndex - 1]
  if (!video) return null

  return {
    videoType: 'response',
    videoId: video._id,
  }
}

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
    isAppActive: AppState.currentState === 'active',
    isScrubbing: false,
  })
  const pendingPulse = useRef(new Animated.Value(0.55)).current

  const currentVideoIndex = useValue(screenState$.currentVideoIndex)
  const videoUrls = useValue(screenState$.videoUrls)
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
  const recordedWatchEventsRef = useRef<Set<string>>(new Set())

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
      key = `${bondfireData._id}:processing:stuck`
      const data = {
        bondfireId: bondfireData._id,
        hasMuxAssetId: !!bondfireData.muxAssetId,
        hasMuxUploadId: !!bondfireData.muxUploadId,
        hasMuxLiveStreamId: !!bondfireData.muxLiveStreamId,
        muxAssetStatus: bondfireData.muxAssetStatus,
      }

      const logStuckProcessing = () => {
        if (loggedPlaybackStateRef.current === key) return
        loggedPlaybackStateRef.current = key
        telemetry.warn(
          'video:detail:stuck_processing',
          'Viewer hit a bondfire stuck in processing',
          {
            ...data,
            processingForMs: Date.now() - bondfireData.updatedAt,
          },
        )
      }

      const processingForMs = Date.now() - bondfireData.updatedAt
      if (processingForMs >= STUCK_PROCESSING_TELEMETRY_THRESHOLD_MS) {
        logStuckProcessing()
        return
      }

      const timeout = setTimeout(
        logStuckProcessing,
        STUCK_PROCESSING_TELEMETRY_THRESHOLD_MS - processingForMs,
      )
      return () => clearTimeout(timeout)
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

  const recordWatchEventOnce = useCallback(
    (target: WatchTarget, eventType: WatchEventType, positionMs: number, durationMs?: number) => {
      const key = `${target.videoType}:${target.videoId}:${eventType}`
      if (recordedWatchEventsRef.current.has(key)) return

      recordedWatchEventsRef.current.add(key)
      recordWatchEvent({
        videoType: target.videoType,
        videoId: target.videoId,
        eventType,
        positionMs,
        ...(durationMs !== undefined ? { durationMs: Math.round(durationMs) } : {}),
      }).catch((error) => {
        telemetry.warn('watch:event', 'Failed to record watch event', {
          error: String(error),
          eventType,
          videoId: target.videoId,
          videoType: target.videoType,
        })
      })
    },
    [recordWatchEvent],
  )

  const handleVideoComplete = useCallback(
    (positionMs = 0, durationMs?: number) => {
      if (!bondfireData) return

      const target = getWatchTarget(bondfireData, currentVideoIndex)
      if (!target) return

      recordWatchEventOnce(target, 'complete', Math.round(positionMs), durationMs)

      const lastVideoIndex = bondfireData.videos.length
      if (currentVideoIndex < lastVideoIndex) {
        flatListRef.current?.scrollToIndex({
          index: currentVideoIndex + 1,
          animated: true,
        })
      }
    },
    [bondfireData, currentVideoIndex, recordWatchEventOnce],
  )

  const handleScrubbingChange = useCallback(
    (scrubbing: boolean) => {
      screenState$.isScrubbing.set(scrubbing)
    },
    [screenState$],
  )

  const handleProgress = useCallback(
    (progress: number, positionMs: number, durationMs?: number) => {
      if (!bondfireData) return

      const target = getWatchTarget(bondfireData, currentVideoIndex)
      if (!target) return

      for (const milestone of WATCH_MILESTONES) {
        if (progress >= milestone.progress) {
          recordWatchEventOnce(target, milestone.eventType, Math.round(positionMs), durationMs)
        }
      }
    },
    [bondfireData, currentVideoIndex, recordWatchEventOnce],
  )

  const handleVideoIndexChange = useCallback(
    (index: number) => {
      screenState$.currentVideoIndex.set(index)
    },
    [screenState$],
  )

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
  const videoItems = buildBondfireVideoItems(bondfireData, videoUrls)

  return (
    <BondfirePlaybackScreen
      statusBarStyle={statusBarStyle}
      backgroundColor={colors.background}
      bondfireId={bondfireId}
      bondfireData={bondfireData}
      canInvite={campContext?.canInvite ?? false}
      videoItems={videoItems}
      currentVideoIndex={currentVideoIndex}
      isFocused={isFocused}
      isAppActive={isAppActive}
      isScrubbing={isScrubbing}
      flatListRef={flatListRef}
      onBackPress={handleBackPress}
      onVideoComplete={handleVideoComplete}
      onProgress={handleProgress}
      onScrubbingChange={handleScrubbingChange}
      onVideoIndexChange={handleVideoIndexChange}
      initialVideoIndex={initialVideoIndex}
      onScrollToIndexFailed={handleScrollToIndexFailed}
    />
  )
}

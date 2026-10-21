import {
  appStore$,
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
import { useAction, useMutation, usePaginatedQuery, useQuery } from 'convex/react'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { useCallback, useEffect, useMemo, useRef } from 'react'
import { Alert, Animated, AppState, type FlatList, InteractionManager } from 'react-native'
import { api } from '../../../../../convex/_generated/api'
import type { Id } from '../../../../../convex/_generated/dataModel'
import {
  canResumeUnrecordedDraft,
  getVideoLifecycle,
} from '../../../../../convex/lib/videoLifecycle'
import { hasSavedDraftCapture, segmentMediaEnabled } from '../../../lib/media/segmentUploads'
import { goBackOrReplace } from '../../../lib/navigation'
import { routes } from '../../../lib/routes'
import { BondfirePlaybackScreen } from './_components/BondfirePlaybackScreen'
import {
  BondfireErroredScreen,
  BondfireLoadingScreen,
  BondfirePendingScreen,
  BondfireProcessingScreen,
  BondfireRecoveringScreen,
  BondfireUnavailableScreen,
} from './_components/BondfireStatusScreens'
import {
  type BondfireDetailData,
  type BondfireVideoItem,
  buildBondfireVideoItems,
  mergeBondfireResponsePages,
  SCREEN_WIDTH,
  type ScrollToIndexFailedInfo,
  STUCK_PROCESSING_TELEMETRY_THRESHOLD_MS,
} from './_lib/bondfireDetailHelpers'
import type { ThreadCatchUp } from './_lib/threadCatchUp'
import { useBondfireThreadPosition } from './_lib/useBondfireThreadPosition'
import { useBondfireVideoUrls } from './_lib/useBondfireVideoUrls'

type WatchEventType = 'start' | 'milestone_25' | 'milestone_50' | 'milestone_75' | 'complete'

type WatchTarget = {
  videoType: 'bondfire' | 'response'
  videoId: string
}

const WATCH_MILESTONES = [
  { progress: 0.25, eventType: 'milestone_25' },
  { progress: 0.5, eventType: 'milestone_50' },
  { progress: 0.75, eventType: 'milestone_75' },
  // `complete` is what marks a video watched. Recording it in the last stretch
  // (the server accepts it from 85%) means swiping away during the final
  // seconds still counts; reaching the end sends it again (handleVideoComplete).
  { progress: 0.9, eventType: 'complete' },
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
  const { id, videoId } = useLocalSearchParams<{ id: string; videoId?: string | string[] }>()
  const deepLinkVideoId = typeof videoId === 'string' ? videoId : undefined
  const router = useRouter()
  const navigation = useNavigation()
  const flatListRef = useRef<FlatList<BondfireVideoItem>>(null)
  const isFocused = useIsFocused()
  const canLoadScreenData = isFocused

  const screenState$ = useObservable({
    isAppActive: AppState.currentState === 'active',
    isScrubbing: false,
    // Per arrival (a new deep link re-arms it), not per mount: the playback
    // screen unmounts while the recorder is open, and coming back from
    // recording a response should not pop the browser open again.
    catchUp: null as ThreadCatchUp | null,
    catchUpAutoOpenPending: false,
  })
  const pendingPulse = useRef(new Animated.Value(0.55)).current

  const isAppActive = useValue(screenState$.isAppActive)
  const isScrubbing = useValue(screenState$.isScrubbing)
  const catchUp = useValue(screenState$.catchUp)
  const catchUpAutoOpenPending = useValue(screenState$.catchUpAutoOpenPending)
  const currentUserId = useValue(appStore$.userId)

  const bondfireId = id as Id<'bondfires'>
  const bondfireMetadata = useQuery(
    api.bondfires.getWithVideos,
    canLoadScreenData ? { bondfireId, metadataOnly: true } : 'skip',
  )
  const {
    results: responsePages,
    status: pageStatus,
    loadMore,
  } = usePaginatedQuery(
    api.bondfires.getResponsePage,
    canLoadScreenData && bondfireMetadata ? { bondfireId } : 'skip',
    { initialNumItems: 50 },
  )
  const hasOlder = pageStatus !== 'Exhausted'
  const loadingOlder = pageStatus === 'LoadingMore' || pageStatus === 'LoadingFirstPage'
  const bondfireData = useMemo(() => {
    if (!bondfireMetadata) return bondfireMetadata
    if (pageStatus === 'LoadingFirstPage') return undefined
    return mergeBondfireResponsePages(bondfireMetadata, responsePages)
  }, [bondfireMetadata, responsePages, pageStatus])
  const loadOlderResponses = useCallback(() => {
    if (pageStatus === 'CanLoadMore') loadMore(50)
  }, [pageStatus, loadMore])
  const unavailableReason = useQuery(
    api.bondfires.getUnavailableReason,
    canLoadScreenData && bondfireData === null ? { bondfireId } : 'skip',
  )
  const campContext = useQuery(
    api.bondfires.getWithCampContext,
    canLoadScreenData ? { id: bondfireId } : 'skip',
  )
  const getVideoUrlsBatch = useAction(api.videos.getVideoUrlsBatch)
  const recordWatchEvent = useMutation(api.watchEvents.record)
  const markThreadRead = useMutation(api.conversations.markThreadRead)
  const discardDraft = useMutation(api.personalBondfires.discardDraftBondfire)
  const markInviteSeen = useMutation(api.inviteClaims.markInviteSeen)
  const hasRedirectedToJoinGate = useRef(false)
  useEffect(() => {
    if (hasRedirectedToJoinGate.current) return
    if (!campContext || !campContext.camp) return
    if (!campContext.bondfire?.campId) return
    if (campContext.membership?.status === 'active') return
    if (campContext.hasInviteClaim) return

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

  useEffect(() => {
    if (!bondfireId || !currentUserId || !bondfireData) return

    markInviteSeen({ bondfireId }).catch((error) => {
      telemetry.warn('bondfire:inviteSeen', 'Failed to mark Bondfire invite seen', {
        error: String(error),
      })
    })
  }, [bondfireId, bondfireData, currentUserId, markInviteSeen])

  useEffect(() => {
    if (!bondfireId) return
    if (!bondfireData) return
    if (bondfireData?.videoStatus === 'live') return
    if (bondfireData.userId === currentUserId) return
    if (hasViewedToday(bondfireId)) return

    markViewed(bondfireId)
  }, [bondfireId, bondfireData, currentUserId])

  const markedThreadReadRef = useRef<string | null>(null)
  useEffect(() => {
    if (!bondfireId || !bondfireData || !currentUserId) return
    // Loaded participants are only a window: an earlier responder must still
    // clear their unread marker. The existing indexed server check decides.
    // Older-page loads and watch-flag updates do not need another write.
    const key = `${bondfireId}:${currentUserId}:${bondfireData.videos.at(-1)?._id ?? 'spark'}`
    if (markedThreadReadRef.current === key) return
    markedThreadReadRef.current = key
    markThreadRead({ bondfireId, skipNonParticipant: true }).catch((error) => {
      markedThreadReadRef.current = null
      telemetry.error('bondfire:thread', 'Failed to mark Bondfire thread read', {
        error: String(error),
      })
    })
  }, [bondfireData, bondfireId, currentUserId, markThreadRead])

  const restoreThreadPosition = useCallback(
    (index: number) => {
      setFeedActiveBondfireId(bondfireId)
      scheduleRestoreScroll(index)
    },
    [bondfireId, scheduleRestoreScroll],
  )
  const snapshotArrival = useCallback(
    (arrival: ThreadCatchUp) => {
      screenState$.catchUp.set(arrival)
      screenState$.catchUpAutoOpenPending.set(arrival.autoOpen)
    },
    [screenState$],
  )
  const {
    state: deepLinkState,
    currentVideoIndex,
    onVideoIndexChange: handleVideoIndexChange,
  } = useBondfireThreadPosition({
    data: bondfireData,
    responseId: deepLinkVideoId,
    hasOlder,
    loadOlder: loadOlderResponses,
    scrollToIndex: restoreThreadPosition,
    onArrival: snapshotArrival,
  })

  const unavailableLinkRef = useRef<string | null>(null)
  useEffect(() => {
    const key = `${bondfireId}:${deepLinkVideoId}`
    if (deepLinkState !== 'unavailable' || unavailableLinkRef.current === key) return
    unavailableLinkRef.current = key
    Alert.alert('Response unavailable', 'This response is no longer available to play.')
  }, [bondfireId, deepLinkVideoId, deepLinkState])
  const videoUrls = useBondfireVideoUrls({
    bondfireData: deepLinkState === 'loading' ? undefined : bondfireData,
    currentVideoIndex,
    getVideoUrlsBatch,
  })

  useEffect(() => {
    if (!bondfireId || deepLinkState === 'loading') return
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
  }, [bondfireId, currentVideoIndex, deepLinkState])

  const handleBackPress = useCallback(() => {
    goBackOrReplace(router, navigation, routes.feed)
  }, [navigation, router])

  const submitWatchEvent = useCallback(
    (target: WatchTarget, eventType: WatchEventType, positionMs: number, durationMs?: number) => {
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

  const recordWatchEventOnce = useCallback(
    (target: WatchTarget, eventType: WatchEventType, positionMs: number, durationMs?: number) => {
      const key = `${target.videoType}:${target.videoId}:${eventType}`
      if (recordedWatchEventsRef.current.has(key)) return

      recordedWatchEventsRef.current.add(key)
      submitWatchEvent(target, eventType, positionMs, durationMs)
    },
    [submitWatchEvent],
  )

  const handleVideoComplete = useCallback(
    (positionMs = 0, durationMs?: number) => {
      if (!bondfireData) return

      const target = getWatchTarget(bondfireData, currentVideoIndex)
      if (!target) return

      // Not deduped like the progress milestones: if the 90% `complete` was
      // rejected (the player's duration can differ from the server's), the
      // end of playback is the retry. The server drops a true duplicate.
      submitWatchEvent(target, 'complete', Math.round(positionMs), durationMs)

      const lastVideoIndex = bondfireData.videos.length
      if (currentVideoIndex < lastVideoIndex) {
        flatListRef.current?.scrollToIndex({
          index: currentVideoIndex + 1,
          animated: true,
        })
      }
    },
    [bondfireData, currentVideoIndex, submitWatchEvent],
  )

  const handleVideoStart = useCallback(() => {
    if (!bondfireData) return

    const target = getWatchTarget(bondfireData, currentVideoIndex)
    if (!target) return

    submitWatchEvent(target, 'start', 0)
  }, [bondfireData, currentVideoIndex, submitWatchEvent])

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

  const handleCatchUpAutoOpened = useCallback(() => {
    screenState$.catchUpAutoOpenPending.set(false)
  }, [screenState$])

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

  if (bondfireData === undefined || (bondfireData && deepLinkState === 'loading')) {
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

  const lifecycle = getVideoLifecycle(bondfireData)
  const isOwner = currentUserId === bondfireData.userId
  const canResume = isOwner && canResumeUnrecordedDraft(bondfireData)
  const discard = async () => {
    try {
      if (
        segmentMediaEnabled &&
        currentUserId &&
        (await hasSavedDraftCapture(currentUserId, bondfireId))
      ) {
        Alert.alert(
          'Recording saved',
          'Your recording is waiting to upload. Keep the app open to continue.',
        )
        return
      }
      await discardDraft({ bondfireId })
      handleBackPress()
    } catch (error) {
      Alert.alert(
        'Could not discard draft',
        error instanceof Error ? error.message : 'Please try again.',
      )
    }
  }
  if (lifecycle === 'expired') return <BondfireUnavailableScreen {...statusScreenProps} />
  if (
    lifecycle === 'awaiting_recording' ||
    (lifecycle === 'uploading' &&
      (bondfireData.segmentRecordingId || bondfireData.videoStatus === 'waiting_for_upload'))
  ) {
    return (
      <BondfirePendingScreen
        {...statusScreenProps}
        bondfireData={bondfireData}
        pendingPulse={pendingPulse}
        isOwner={isOwner}
        isUploading={lifecycle === 'uploading'}
        onStartRecording={canResume ? () => router.push(routes.resumeDraft(bondfireId)) : undefined}
        onDiscard={
          canResume
            ? () =>
                Alert.alert('Discard this draft?', 'Its shared links will stop working.', [
                  { text: 'Keep draft', style: 'cancel' },
                  { text: 'Discard', style: 'destructive', onPress: () => void discard() },
                ])
            : undefined
        }
      />
    )
  }

  if (bondfireData.videoStatus === 'processing') {
    return <BondfireProcessingScreen {...statusScreenProps} />
  }

  if (bondfireData.videoStatus === 'awaiting_recovery') {
    return (
      <BondfireRecoveringScreen
        {...statusScreenProps}
        bondfireData={bondfireData}
        isOwner={bondfireData.userId === currentUserId}
      />
    )
  }

  if (bondfireData.videoStatus === 'errored') {
    return <BondfireErroredScreen {...statusScreenProps} bondfireData={bondfireData} />
  }

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
      onVideoStart={handleVideoStart}
      onProgress={handleProgress}
      onScrubbingChange={handleScrubbingChange}
      onVideoIndexChange={handleVideoIndexChange}
      initialVideoIndex={currentVideoIndex}
      catchUp={catchUp}
      catchUpAutoOpenPending={catchUpAutoOpenPending}
      onCatchUpAutoOpened={handleCatchUpAutoOpened}
      linkedVideoKey={deepLinkVideoId}
      hasOlderResponses={hasOlder}
      loadingOlderResponses={loadingOlder}
      onLoadOlderResponses={loadOlderResponses}
      onScrollToIndexFailed={handleScrollToIndexFailed}
    />
  )
}

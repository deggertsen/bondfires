import {
  appActions,
  appStore$,
  type MuxDataVideoMetadata,
  tierMeetsRequirement,
  useMuxData,
  usePresence,
  useSubscription,
} from '@bondfires/app'
import { Spinner, Text } from '@bondfires/ui'
import { useObservable, useValue } from '@legendapp/state/react'
import { Flame } from '@tamagui/lucide-icons'
import { useMutation, useQuery } from 'convex/react'
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake'
import { LinearGradient } from 'expo-linear-gradient'
import { useVideoPlayer, VideoView } from 'expo-video'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import { type LayoutChangeEvent, PanResponder, Platform, Pressable, type View } from 'react-native'
import { XStack, YStack } from 'tamagui'
import { api } from '../../../../../../convex/_generated/api'
import type { Id } from '../../../../../../convex/_generated/dataModel'
import type { ActiveReaction } from '../../../../components/ViewerPresenceStack'
import { VIDEO_OVERLAY_COLORS as OVERLAY_COLORS } from '../../../../components/videoOverlayColors'
import {
  REACTION_PLAYBACK_WINDOW_MS,
  SCREEN_WIDTH,
  SCRUB_SEEK_THROTTLE_MS,
} from '../_lib/bondfireDetailHelpers'
import {
  clearActiveReactions,
  type PendingScrubSeek,
  type ProgressBarMetrics,
  resetReactionState,
  syncReactionPlaybackAfterSeek,
} from '../_lib/videoPlayerState'
import {
  LoadingOverlay,
  PausedReportButton,
  PlayPauseIndicator,
  ReactionPresenceLayer,
  ReportOverlayGate,
  RightSideControls,
  VideoProgressBar,
} from './VideoPlayerOverlays'

export interface VideoPlayerProps {
  bondfireId?: Id<'bondfires'>
  bondfireVideoId?: Id<'bondfireVideos'>
  videoUrl: string | null
  videoOwnerId: Id<'users'>
  isActive: boolean
  isScreenFocused: boolean
  isAppActive: boolean
  onComplete: (positionMs?: number, durationMs?: number) => void
  onProgress: (progress: number, positionMs: number, durationMs?: number) => void
  onScrubbingChange?: (scrubbing: boolean) => void
  creatorName: string
  isMainVideo: boolean
  responseIndex?: number
  isLive?: boolean
}

export function VideoPlayer({
  bondfireId,
  bondfireVideoId,
  videoUrl,
  videoOwnerId,
  isActive,
  isScreenFocused,
  isAppActive,
  onComplete,
  onProgress,
  onScrubbingChange,
  creatorName,
  isMainVideo,
  responseIndex,
  isLive = false,
}: VideoPlayerProps) {
  const videoId = bondfireId || bondfireVideoId || ''
  const autoplayVideos = useValue(appStore$.preferences.autoplayVideos)
  const isMuted = useValue(appStore$.preferences.videoMuted)
  const playbackSpeed = useValue(appStore$.preferences.playbackSpeed)
  const currentUserId = useValue(appStore$.userId)
  const shouldSuppressPlayback = isLive && currentUserId === videoOwnerId
  const videoReactionKey = isMainVideo
    ? `bondfire:${bondfireId ?? ''}`
    : `response:${bondfireVideoId ?? ''}`

  const { viewers } = usePresence({
    videoType: isMainVideo ? 'bondfire' : 'response',
    videoId: isMainVideo
      ? (bondfireId as string | undefined)
      : (bondfireVideoId as string | undefined),
    isActive,
    isScreenFocused,
    isAppActive,
    currentUserId: currentUserId ?? undefined,
  })

  const { currentTier } = useSubscription()
  const isPaid = tierMeetsRequirement(currentTier, 'plus')
  const shouldHandleVodReactions = !isLive && isActive && isScreenFocused && isAppActive
  const shouldTrackPlayback = isActive && isScreenFocused && isAppActive && !shouldSuppressPlayback

  const currentUser = useQuery(api.users.current, shouldHandleVodReactions ? {} : 'skip')
  const recentEmojis = useQuery(
    api.videoReactions.getRecentEmojis,
    isPaid && shouldHandleVodReactions ? {} : 'skip',
  )
  const reactionsData = useQuery(
    api.videoReactions.getReactions,
    shouldHandleVodReactions && (bondfireId || bondfireVideoId)
      ? isMainVideo
        ? { bondfireId }
        : { bondfireVideoId }
      : 'skip',
  )

  const addReactionMutation = useMutation(api.videoReactions.addReaction)
  const targetUrl = shouldSuppressPlayback ? null : videoUrl

  const state$ = useObservable({
    showReport: false,
    currentUrl: targetUrl,
    progress: 0,
    duration: 0,
    isLoading: true,
    isPlaying: false,
    userInitiatedPlay: false,
    hasEnded: false,
    emojiGridOpen: false,
    activeReactions: [] as ActiveReaction[],
    triggeredReactionIds: {} as Record<string, true>,
    lastReactionTime: 0,
    lastReactionPlaybackMs: null as number | null,
  })

  const currentUrl = useValue(state$.currentUrl)
  const isPlaying = useValue(state$.isPlaying)

  useEffect(() => {
    if (videoReactionKey) {
      resetReactionState(state$)
    }
  }, [state$, videoReactionKey])

  const progressBarViewRef = useRef<View>(null)
  const progressBarRef = useRef<ProgressBarMetrics>({ width: 0, pageX: null })
  const isScrubbingRef = useRef(false)
  const onScrubbingChangeRef = useRef(onScrubbingChange)
  onScrubbingChangeRef.current = onScrubbingChange
  const pendingScrubSeekRef = useRef<PendingScrubSeek>({
    locationX: null,
    timeout: null,
    lastSeekAt: 0,
  })

  const player = useVideoPlayer(currentUrl || '', (player) => {
    player.loop = false
    player.muted = isMuted
    player.playbackRate = playbackSpeed
    player.preservesPitch = true
  })

  const muxPlaybackId = useMemo(() => {
    if (!videoUrl) return null
    const match = videoUrl.match(/stream\.mux\.com\/([^/?#]+)\.m3u8(?:[?#]|$)/)
    return match ? match[1] : null
  }, [videoUrl])

  const muxDataVideoMetadata: MuxDataVideoMetadata | null = useMemo(() => {
    if (!muxPlaybackId) return null
    return {
      video_id: muxPlaybackId,
      video_title: creatorName
        ? isMainVideo
          ? `${creatorName}'s Spark`
          : `${creatorName}'s Response #${(responseIndex ?? 0) + 1}`
        : undefined,
      video_stream_type: isLive ? 'live' : 'on-demand',
      video_series: bondfireId,
      custom_1: creatorName,
      custom_2: isMainVideo ? 'spark' : 'response',
      custom_3: isMainVideo ? 'true' : 'false',
    }
  }, [muxPlaybackId, creatorName, isMainVideo, responseIndex, isLive, bondfireId])

  useMuxData({
    player,
    sourceUrl: currentUrl,
    videoMetadata: muxDataVideoMetadata,
    viewerMetadata: useMemo(
      () => ({ viewer_user_id: currentUserId ?? undefined }),
      [currentUserId],
    ),
    isActive: isActive && isScreenFocused && isAppActive,
  })

  useEffect(() => {
    if (player && isActive && isScreenFocused && isAppActive) {
      player.playbackRate = playbackSpeed
    }
  }, [player, isActive, isScreenFocused, isAppActive, playbackSpeed])

  useEffect(() => {
    if (player) {
      player.muted = isMuted
    }
  }, [player, isMuted])

  useEffect(() => {
    if (!player) return

    const shouldPlay = isActive && isScreenFocused && isAppActive && !shouldSuppressPlayback

    if (shouldPlay) {
      player.playbackRate = playbackSpeed
      if (autoplayVideos || state$.userInitiatedPlay.get()) {
        player.play()
      }
    } else {
      player.pause()
      state$.isPlaying.set(false)
      if (!isActive) {
        state$.userInitiatedPlay.set(false)
      }
    }
  }, [
    player,
    isActive,
    isScreenFocused,
    isAppActive,
    autoplayVideos,
    playbackSpeed,
    state$,
    shouldSuppressPlayback,
  ])

  useEffect(() => {
    if (!player) return

    const statusSubscription = player.addListener('statusChange', (status) => {
      if (status.status === 'readyToPlay') {
        state$.isLoading.set(false)
        if (player.duration) {
          state$.duration.set(player.duration * 1000)
        }
      } else if (status.status === 'loading') {
        state$.isLoading.set(true)
      }

      if (status.status === 'readyToPlay') {
        if (
          shouldTrackPlayback &&
          !isScrubbingRef.current &&
          player.currentTime !== undefined &&
          player.duration
        ) {
          const currentProgress = player.currentTime / player.duration
          const positionMs = player.currentTime * 1000
          const durationMs = player.duration * 1000
          state$.progress.set(currentProgress)
          onProgress(currentProgress, positionMs, durationMs)

          if (player.currentTime >= player.duration - 0.1) {
            onComplete(positionMs, durationMs)
          }
        }
      }
    })

    const endSubscription = player.addListener('playToEnd', () => {
      if (!shouldTrackPlayback) return

      state$.hasEnded.set(true)
      state$.progress.set(1)
      state$.isPlaying.set(false)
      state$.triggeredReactionIds.set({})
      state$.lastReactionPlaybackMs.set(null)
      clearActiveReactions(state$)
      onComplete(player.currentTime * 1000, player.duration ? player.duration * 1000 : undefined)
    })

    const progressInterval = shouldTrackPlayback
      ? setInterval(() => {
          if (
            !isScrubbingRef.current &&
            player.status === 'readyToPlay' &&
            player.currentTime !== undefined &&
            player.duration
          ) {
            const currentProgress = player.currentTime / player.duration
            const positionMs = player.currentTime * 1000
            const durationMs = player.duration * 1000
            state$.progress.set(currentProgress)
            onProgress(currentProgress, positionMs, durationMs)

            const playerPlaying = player.playing ?? false
            if (state$.isPlaying.get() !== playerPlaying) {
              state$.isPlaying.set(playerPlaying)
            }

            if (!isLive && reactionsData) {
              const currentMs = player.currentTime * 1000
              const previousMs = state$.lastReactionPlaybackMs.get()

              if (previousMs !== null && currentMs + REACTION_PLAYBACK_WINDOW_MS < previousMs) {
                syncReactionPlaybackAfterSeek({ positionMs: currentMs, reactionsData, state$ })
                return
              }

              const windowStart =
                previousMs ?? Math.max(-1, currentMs - REACTION_PLAYBACK_WINDOW_MS)
              const crossedReactions: ActiveReaction[] = []
              const triggeredReactionIds = { ...state$.triggeredReactionIds.get() }

              for (const reaction of reactionsData) {
                if (
                  !triggeredReactionIds[reaction._id] &&
                  reaction.timestampMs > windowStart &&
                  reaction.timestampMs <= currentMs
                ) {
                  triggeredReactionIds[reaction._id] = true
                  crossedReactions.push({
                    id: reaction._id,
                    userId: reaction.userId,
                    userName: reaction.userDisplayName ?? '',
                    userPhotoUrl: reaction.userPhotoUrl,
                    emoji: reaction.emoji,
                    timestampMs: reaction.timestampMs,
                    createdAt: reaction.createdAt,
                  })
                }
              }

              if (crossedReactions.length > 0) {
                state$.triggeredReactionIds.set(triggeredReactionIds)
                state$.activeReactions.set([
                  ...state$.activeReactions.get(),
                  ...crossedReactions.sort((a, b) => a.createdAt - b.createdAt),
                ])
              }

              state$.lastReactionPlaybackMs.set(currentMs)
            }
          }
        }, 100)
      : null

    return () => {
      statusSubscription.remove()
      endSubscription.remove()
      if (progressInterval) {
        clearInterval(progressInterval)
      }
    }
  }, [player, onComplete, onProgress, state$, shouldTrackPlayback, isLive, reactionsData])

  useEffect(() => {
    const currentUrlValue = state$.currentUrl.get()
    if (currentUrlValue !== targetUrl) {
      state$.currentUrl.set(targetUrl)
    }
  }, [state$, targetUrl])

  const keepAwakeTag = `video-playback-${videoId}`
  useEffect(() => {
    if (isScreenFocused && isAppActive && isActive && isPlaying) {
      activateKeepAwakeAsync(keepAwakeTag)
    } else {
      deactivateKeepAwake(keepAwakeTag)
    }

    return () => {
      deactivateKeepAwake(keepAwakeTag)
    }
  }, [isScreenFocused, isAppActive, isActive, isPlaying, keepAwakeTag])

  const togglePlayPause = useCallback(() => {
    if (!player) return

    if (state$.hasEnded.get()) {
      state$.triggeredReactionIds.set({})
      state$.lastReactionPlaybackMs.set(null)
      clearActiveReactions(state$)
      player.replay()
      state$.hasEnded.set(false)
      state$.isPlaying.set(true)
      state$.userInitiatedPlay.set(true)
    } else if (player.playing) {
      player.pause()
      state$.isPlaying.set(false)
    } else {
      state$.userInitiatedPlay.set(true)
      player.play()
      state$.isPlaying.set(true)
    }
  }, [player, state$])

  const toggleMute = useCallback(() => {
    if (!player) return
    appActions.setVideoMuted(!isMuted)
  }, [player, isMuted])

  const handleEmojiSelect = useCallback(
    (emoji: string) => {
      const now = Date.now()
      if (now - state$.lastReactionTime.get() < 5000) return false
      state$.lastReactionTime.set(now)

      const optimisticId = `optimistic-${now}-${Math.random()}`
      const currentMs = player?.currentTime ? Math.floor(player.currentTime * 1000) : 0
      const reaction: ActiveReaction = {
        id: optimisticId,
        userId: currentUserId ?? '',
        userName: currentUser?.displayName ?? currentUser?.name ?? '',
        userPhotoUrl: currentUser?.photoUrl,
        emoji,
        timestampMs: currentMs,
        createdAt: now,
      }
      state$.activeReactions.set([...state$.activeReactions.get(), reaction])

      if (bondfireId || bondfireVideoId) {
        addReactionMutation({
          bondfireId: isMainVideo ? bondfireId : undefined,
          bondfireVideoId: !isMainVideo ? bondfireVideoId : undefined,
          emoji,
          timestampMs: currentMs,
        })
          .then((savedReaction) => {
            if (savedReaction?._id) {
              state$.triggeredReactionIds.set({
                ...state$.triggeredReactionIds.get(),
                [savedReaction._id]: true,
              })
            }
          })
          .catch(() => {
            // Silent failure - no error toast, reaction just doesn't persist
          })
      }

      return true
    },
    [
      player,
      currentUserId,
      currentUser,
      bondfireId,
      bondfireVideoId,
      isMainVideo,
      addReactionMutation,
      state$,
    ],
  )

  const handleReactionExpired = useCallback(
    (id: string) => {
      state$.activeReactions.set(state$.activeReactions.get().filter((r) => r.id !== id))
    },
    [state$],
  )

  const handleProgressBarLayout = useCallback((event: LayoutChangeEvent) => {
    const { width } = event.nativeEvent.layout
    progressBarRef.current.width = width
    progressBarViewRef.current?.measure((_x, _y, measuredWidth, _height, pageX) => {
      progressBarRef.current = { width: measuredWidth || width, pageX }
    })
  }, [])

  const seekToProgressLocation = useCallback(
    (locationX: number, shouldSeek = true) => {
      if (!player) return

      const videoDuration = player.duration
      if (!Number.isFinite(videoDuration) || videoDuration <= 0) return

      const { width } = progressBarRef.current

      if (width > 0) {
        const seekProgress = Math.max(0, Math.min(1, locationX / width))
        const seekTime = seekProgress * videoDuration
        if (shouldSeek) {
          player.currentTime = seekTime
          syncReactionPlaybackAfterSeek({
            positionMs: seekTime * 1000,
            reactionsData,
            state$,
          })
        }
        state$.progress.set(seekProgress)
        state$.hasEnded.set(false)
        state$.userInitiatedPlay.set(true)
      }
    },
    [player, reactionsData, state$],
  )

  const canSeekProgress = Number.isFinite(player?.duration) && (player?.duration ?? 0) > 0
  const canSeekProgressRef = useRef(canSeekProgress)
  const seekToProgressLocationRef = useRef(seekToProgressLocation)

  canSeekProgressRef.current = canSeekProgress
  seekToProgressLocationRef.current = seekToProgressLocation

  const clearPendingScrubSeek = useCallback(() => {
    const pending = pendingScrubSeekRef.current
    if (pending.timeout) {
      clearTimeout(pending.timeout)
      pending.timeout = null
    }
    pending.locationX = null
  }, [])

  const applyScrubSeekLocation = useCallback((locationX: number) => {
    pendingScrubSeekRef.current.lastSeekAt = Date.now()
    pendingScrubSeekRef.current.locationX = null
    seekToProgressLocationRef.current(locationX, true)
  }, [])

  const getProgressLocationFromPageX = useCallback((pageX: number) => {
    const barPageX = progressBarRef.current.pageX
    if (barPageX === null) return null

    return pageX - barPageX
  }, [])

  const seekToProgressPageX = useCallback(
    (pageX: number, shouldSeek = true) => {
      const locationX = getProgressLocationFromPageX(pageX)
      if (locationX === null) return

      seekToProgressLocationRef.current(locationX, shouldSeek)
    },
    [getProgressLocationFromPageX],
  )

  const scheduleScrubSeekPageX = useCallback(
    (pageX: number) => {
      const locationX = getProgressLocationFromPageX(pageX)
      if (locationX === null) return

      seekToProgressLocationRef.current(locationX, false)

      const pending = pendingScrubSeekRef.current
      pending.locationX = locationX

      const elapsed = Date.now() - pending.lastSeekAt
      const delay = SCRUB_SEEK_THROTTLE_MS - elapsed

      if (delay <= 0) {
        if (pending.timeout) {
          clearTimeout(pending.timeout)
          pending.timeout = null
        }
        applyScrubSeekLocation(locationX)
        return
      }

      if (!pending.timeout) {
        pending.timeout = setTimeout(() => {
          pending.timeout = null
          const pendingLocationX = pending.locationX
          if (pendingLocationX !== null) {
            applyScrubSeekLocation(pendingLocationX)
          }
        }, delay)
      }
    },
    [applyScrubSeekLocation, getProgressLocationFromPageX],
  )

  const finishScrubSeekPageX = useCallback(
    (pageX: number) => {
      const locationX = getProgressLocationFromPageX(pageX)
      clearPendingScrubSeek()
      isScrubbingRef.current = false
      onScrubbingChangeRef.current?.(false)

      if (locationX !== null) {
        applyScrubSeekLocation(locationX)
      }
    },
    [applyScrubSeekLocation, clearPendingScrubSeek, getProgressLocationFromPageX],
  )

  const measureProgressBar = useCallback((onMeasured?: () => void) => {
    progressBarViewRef.current?.measure((_x, _y, width, _height, pageX) => {
      progressBarRef.current = { width: width || progressBarRef.current.width, pageX }
      onMeasured?.()
    })
  }, [])

  useLayoutEffect(() => {
    measureProgressBar()
  }, [measureProgressBar])

  useEffect(() => {
    return () => {
      clearPendingScrubSeek()
      onScrubbingChangeRef.current?.(false)
    }
  }, [clearPendingScrubSeek])

  const progressBarPanResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => canSeekProgressRef.current,
      onMoveShouldSetPanResponder: () => canSeekProgressRef.current,
      onPanResponderTerminationRequest: () => false,

      onPanResponderGrant: (evt) => {
        isScrubbingRef.current = true
        onScrubbingChangeRef.current?.(true)
        clearPendingScrubSeek()

        const touchPageX = evt.nativeEvent.pageX
        measureProgressBar(() => {
          seekToProgressPageX(touchPageX, true)
        })
      },

      onPanResponderMove: (_evt, gestureState) => {
        scheduleScrubSeekPageX(gestureState.moveX)
      },

      onPanResponderRelease: (evt, gestureState) => {
        const releasePageX = gestureState.moveX > 0 ? gestureState.moveX : evt.nativeEvent.pageX
        finishScrubSeekPageX(releasePageX)
      },

      onPanResponderTerminate: (evt, gestureState) => {
        const releasePageX = gestureState.moveX > 0 ? gestureState.moveX : evt.nativeEvent.pageX
        finishScrubSeekPageX(releasePageX)
      },
    }),
  ).current

  if (shouldSuppressPlayback) {
    return (
      <YStack
        flex={1}
        width={SCREEN_WIDTH}
        backgroundColor={'$background'}
        alignItems="center"
        justifyContent="center"
        gap={14}
      >
        <YStack
          backgroundColor={'$error'}
          paddingHorizontal={16}
          paddingVertical={8}
          borderRadius={16}
        >
          <Text color={'$color'} fontWeight="900" fontSize={13}>
            LIVE
          </Text>
        </YStack>
        <Text color={'$color'} fontSize={22} fontWeight="900">
          You are live
        </Text>
        <Text color={'$placeholderColor'} fontSize={14}>
          Your replay will appear here after Mux finishes saving it.
        </Text>
      </YStack>
    )
  }

  return (
    <YStack flex={1} width={SCREEN_WIDTH} backgroundColor={'$background'}>
      {currentUrl && player ? (
        <VideoView
          player={player}
          style={{ flex: 1 }}
          contentFit="cover"
          nativeControls={false}
          surfaceType={Platform.OS === 'android' ? 'textureView' : undefined}
        />
      ) : (
        <YStack flex={1} alignItems="center" justifyContent="center">
          <Spinner size="large" color={'$primary'} />
        </YStack>
      )}

      <Pressable
        onPress={togglePlayPause}
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          zIndex: 1,
        }}
      />

      <LoadingOverlay state$={state$} currentUrl={currentUrl} />

      <ReactionPresenceLayer
        state$={state$}
        liveViewers={viewers}
        onReactionExpired={handleReactionExpired}
      />

      <PlayPauseIndicator state$={state$} />

      <LinearGradient
        colors={OVERLAY_COLORS.gradientBottom}
        style={{
          position: 'absolute',
          bottom: 0,
          left: 0,
          right: 0,
          height: 180,
          zIndex: 2,
        }}
        pointerEvents="none"
      />

      {isLive ? (
        <YStack position="absolute" bottom={132} left={20} zIndex={3}>
          <YStack
            backgroundColor={'$error'}
            paddingHorizontal={14}
            paddingVertical={7}
            borderRadius={16}
          >
            <Text color={'$color'} fontSize={12} fontWeight="900">
              LIVE
            </Text>
          </YStack>
        </YStack>
      ) : null}

      <VideoProgressBar
        state$={state$}
        progressBarViewRef={progressBarViewRef}
        onLayout={handleProgressBarLayout}
        panHandlers={progressBarPanResponder.panHandlers}
      />

      <YStack position="absolute" bottom={148} left={20} zIndex={3} pointerEvents="box-none">
        <XStack alignItems="center" gap={12}>
          <YStack
            width={40}
            height={40}
            borderRadius={20}
            backgroundColor={'$backgroundHover'}
            alignItems="center"
            justifyContent="center"
            borderWidth={2}
            borderColor={isMainVideo ? '$primary' : '$secondary'}
          >
            <Flame size={20} color={isMainVideo ? '$primary' : '$secondary'} />
          </YStack>
          <YStack>
            <Text fontWeight="600" fontSize={15} color={OVERLAY_COLORS.textPrimary}>
              {creatorName}
            </Text>
            <Text fontSize={12} color={OVERLAY_COLORS.textSecondary}>
              {isMainVideo ? 'Spark' : `Response ${responseIndex}`}
            </Text>
          </YStack>
        </XStack>
      </YStack>

      <PausedReportButton state$={state$} />

      <RightSideControls
        state$={state$}
        isLive={isLive}
        isPaid={isPaid}
        recentEmojis={recentEmojis ?? []}
        isMuted={isMuted}
        onEmojiSelect={handleEmojiSelect}
        onToggleMute={toggleMute}
      />

      <ReportOverlayGate
        state$={state$}
        bondfireId={bondfireId}
        bondfireVideoId={bondfireVideoId}
        videoOwnerId={videoOwnerId}
      />
    </YStack>
  )
}

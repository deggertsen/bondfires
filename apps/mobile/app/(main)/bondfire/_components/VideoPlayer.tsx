import {
  appActions,
  appStore$,
  type MuxDataVideoMetadata,
  telemetry,
  tierMeetsRequirement,
  useMuxData,
  usePresence,
  useSubscription,
} from '@bondfires/app'
import { Spinner, Text } from '@bondfires/ui'
import { useObservable, useValue } from '@legendapp/state/react'
import { useMutation, useQuery } from 'convex/react'
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake'
import { LinearGradient } from 'expo-linear-gradient'
import { useVideoPlayer, VideoView } from 'expo-video'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import { type LayoutChangeEvent, PanResponder, Pressable, type View } from 'react-native'
import { YStack } from 'tamagui'
import { api } from '../../../../../../convex/_generated/api'
import type { Id } from '../../../../../../convex/_generated/dataModel'
import type { ActiveReaction } from '../../../../components/ViewerPresenceStack'
import { VIDEO_OVERLAY_COLORS as OVERLAY_COLORS } from '../../../../components/videoOverlayColors'
import {
  REACTION_PLAYBACK_WINDOW_MS,
  REACTION_THROTTLE_MS,
  SCREEN_WIDTH,
  SCRUB_SEEK_THROTTLE_MS,
} from '../_lib/bondfireDetailHelpers'
import { type CaptionCue, fetchCaptionCues, findCaptionText } from '../_lib/videoCaptions'
import {
  clearActiveReactions,
  type PendingScrubSeek,
  type ProgressBarMetrics,
  resetReactionState,
  shouldLoadVideoSource,
  syncReactionPlaybackAfterSeek,
} from '../_lib/videoPlayerState'
import {
  CaptionOverlay,
  LoadingOverlay,
  PausedReportButton,
  PlaybackErrorOverlay,
  PlayPauseIndicator,
  ReactionPresenceLayer,
  ReportOverlayGate,
  RespondCTAOverlay,
  RightSideControls,
  VideoProgressBar,
} from './VideoPlayerOverlays'

const PROGRESS_STATE_UPDATE_INTERVAL_MS = 250
const PROGRESS_TIME_UPDATE_INTERVAL_SECONDS = PROGRESS_STATE_UPDATE_INTERVAL_MS / 1000

function getFirstReactionAfter<T extends { timestampMs: number }>(
  reactions: readonly T[],
  timestampMs: number,
) {
  let low = 0
  let high = reactions.length

  while (low < high) {
    const mid = Math.floor((low + high) / 2)
    if (reactions[mid].timestampMs <= timestampMs) {
      low = mid + 1
    } else {
      high = mid
    }
  }

  return low
}

export interface VideoPlayerProps {
  bondfireId?: Id<'bondfires'>
  bondfireVideoId?: Id<'bondfireVideos'>
  videoUrl: string | null
  captionsUrl?: string
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
  onRespondAfterPlayback?: () => void
}

export function VideoPlayer({
  bondfireId,
  bondfireVideoId,
  videoUrl,
  captionsUrl,
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
  onRespondAfterPlayback,
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
  const reactionsDataRef = useRef<typeof reactionsData>(reactionsData)

  useEffect(() => {
    reactionsDataRef.current = reactionsData
  }, [reactionsData])

  const addReactionMutation = useMutation(api.videoReactions.addReaction)
  const currentUrl = shouldLoadVideoSource({
    videoUrl,
    isActive,
    isScreenFocused,
    isAppActive,
    shouldSuppressPlayback,
  })
    ? videoUrl
    : null

  const state$ = useObservable({
    showReport: false,
    progress: 0,
    duration: 0,
    captionText: '',
    isLoading: true,
    hasError: false,
    isPlaying: false,
    userInitiatedPlay: false,
    hasEnded: false,
    emojiGridOpen: false,
    activeReactions: [] as ActiveReaction[],
    triggeredReactionIds: {} as Record<string, true>,
    lastReactionTime: 0,
    lastReactionPlaybackMs: null as number | null,
  })

  const triggeredReactionIdsRef = useRef<Record<string, true>>({})
  const lastReactionPlaybackMsRef = useRef<number | null>(null)
  const lastProgressStateUpdateAtRef = useRef(0)

  const isPlaying = useValue(state$.isPlaying)

  const resetLocalReactionState = useCallback(() => {
    triggeredReactionIdsRef.current = {}
    lastReactionPlaybackMsRef.current = null
    resetReactionState(state$)
  }, [state$])

  useEffect(() => {
    if (videoReactionKey) {
      resetLocalReactionState()
    }
  }, [resetLocalReactionState, videoReactionKey])

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

  const player = useVideoPlayer(currentUrl, (player) => {
    player.loop = false
    player.muted = isMuted
    player.playbackRate = playbackSpeed
    player.preservesPitch = true
    player.timeUpdateEventInterval = PROGRESS_TIME_UPDATE_INTERVAL_SECONDS
  })

  // Fatal-error recovery: bounded automatic reloads before surfacing the
  // retry overlay. Reset whenever the source changes — a new URL is a new
  // playback attempt with a fresh budget.
  const errorRetryRef = useRef({ count: 0, timer: null as ReturnType<typeof setTimeout> | null })

  // biome-ignore lint/correctness/useExhaustiveDependencies: currentUrl is the reset trigger, not read inside
  useEffect(() => {
    errorRetryRef.current.count = 0
    userPausedRef.current = false
    state$.hasError.set(false)
    return () => {
      if (errorRetryRef.current.timer) {
        clearTimeout(errorRetryRef.current.timer)
        errorRetryRef.current.timer = null
      }
    }
  }, [currentUrl, state$])

  // replaceAsync only swaps the source — expo-video does not resume playback
  // on its own, and none of the autoplay effect's dependencies change on a
  // retry, so a recovered player would sit paused behind a vanished overlay.
  // Mirror the autoplay effect's predicate after the source lands.
  //
  // The gates are read through a per-render ref, NOT closure props: the
  // helper runs after an async replaceAsync resolves, by which time the user
  // may have backgrounded the app or swiped away — a stale closure would
  // start audio on a page that should be paused.
  const playbackGateRef = useRef({ isActive, isScreenFocused, isAppActive })
  playbackGateRef.current = { isActive, isScreenFocused, isAppActive }
  // Deliberate user pause — auto-recovery must never play over it.
  const userPausedRef = useRef(false)

  const resumePlaybackAfterRecovery = useCallback(() => {
    if (!player) return
    const gate = playbackGateRef.current
    if (
      gate.isActive &&
      gate.isScreenFocused &&
      gate.isAppActive &&
      !shouldSuppressPlayback &&
      !userPausedRef.current &&
      (appStore$.preferences.autoplayVideos.peek() || state$.userInitiatedPlay.peek())
    ) {
      player.play()
    }
  }, [player, shouldSuppressPlayback, state$])

  const retryPlayback = useCallback(() => {
    if (!player || !currentUrl) return
    telemetry.info('video:playback_retry', 'User retried video after playback failure', {
      videoId,
      isLive,
    })
    errorRetryRef.current.count = 0
    state$.hasError.set(false)
    state$.isLoading.set(true)
    // Tapping "Try Again" is explicit play intent.
    state$.userInitiatedPlay.set(true)
    userPausedRef.current = false
    player
      .replaceAsync(currentUrl)
      .then(() => resumePlaybackAfterRecovery())
      .catch(() => {
        // Failure surfaces through the statusChange 'error' path.
      })
  }, [player, currentUrl, state$, videoId, isLive, resumePlaybackAfterRecovery])

  // Caption cues, fetched lazily when captions are on and this video has a
  // caption track. Cue matching happens in the timeUpdate listener below.
  const captionsEnabled = useValue(appStore$.preferences.captionsEnabled)
  const captionCuesRef = useRef<CaptionCue[] | null>(null)

  const syncCaptionText = useCallback(
    (positionMs: number) => {
      const cues = captionCuesRef.current
      const captionText = cues?.length ? findCaptionText(cues, positionMs) : ''
      if (state$.captionText.peek() !== captionText) {
        state$.captionText.set(captionText)
      }
    },
    [state$],
  )

  useEffect(() => {
    captionCuesRef.current = null
    state$.captionText.set('')
    if (!captionsEnabled || !captionsUrl || !shouldTrackPlayback) return

    let cancelled = false
    fetchCaptionCues(captionsUrl)
      .then((cues) => {
        if (cancelled) return
        captionCuesRef.current = cues
        // A paused player will not emit another timeUpdate just because the
        // caption file finished loading or captions were toggled on.
        syncCaptionText(player.currentTime * 1000)
      })
      .catch((error: unknown) => {
        if (cancelled) return
        telemetry.warn(
          'video:captions:fetch_failed',
          error instanceof Error ? error.message : String(error),
          { videoId },
        )
      })
    return () => {
      cancelled = true
    }
  }, [captionsEnabled, captionsUrl, player, shouldTrackPlayback, state$, syncCaptionText, videoId])

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

  const updatePlaybackProgress = useCallback(
    ({
      currentTime,
      duration,
      force = false,
    }: {
      currentTime: number
      duration: number
      force?: boolean
    }) => {
      const currentProgress = currentTime / duration
      const positionMs = currentTime * 1000
      const durationMs = duration * 1000
      const now = Date.now()

      if (
        force ||
        currentProgress >= 1 ||
        now - lastProgressStateUpdateAtRef.current >= PROGRESS_STATE_UPDATE_INTERVAL_MS
      ) {
        lastProgressStateUpdateAtRef.current = now
        state$.progress.set(currentProgress)
        onProgress(currentProgress, positionMs, durationMs)
      }

      if (currentTime >= duration - 0.1) {
        onComplete(positionMs, durationMs)
      }
    },
    [onComplete, onProgress, state$],
  )

  const syncLocalReactionPlaybackAfterSeek = useCallback(
    (positionMs: number) => {
      syncReactionPlaybackAfterSeek({
        positionMs,
        reactionsData: reactionsDataRef.current,
        state$,
      })
      lastReactionPlaybackMsRef.current = Math.max(0, positionMs)
      triggeredReactionIdsRef.current = state$.triggeredReactionIds.get()
    },
    [state$],
  )

  const processTimedPlaybackUpdate = useCallback(
    (currentTime: number, duration: number) => {
      updatePlaybackProgress({ currentTime, duration })

      const playerPlaying = player?.playing ?? false
      if (state$.isPlaying.get() !== playerPlaying) {
        state$.isPlaying.set(playerPlaying)
      }

      const currentReactionsData = reactionsDataRef.current
      if (isLive || !currentReactionsData) return

      const currentMs = currentTime * 1000
      const previousMs = lastReactionPlaybackMsRef.current

      if (previousMs !== null && currentMs + REACTION_PLAYBACK_WINDOW_MS < previousMs) {
        syncLocalReactionPlaybackAfterSeek(currentMs)
        return
      }

      const windowStart = previousMs ?? Math.max(-1, currentMs - REACTION_PLAYBACK_WINDOW_MS)
      const crossedReactions: ActiveReaction[] = []
      let activeReactions: ActiveReaction[] | null = null
      let triggeredReactionIds = triggeredReactionIdsRef.current
      let shouldCommitTriggeredReactionIds = false
      const firstReactionIndex = getFirstReactionAfter(currentReactionsData, windowStart)

      for (let i = firstReactionIndex; i < currentReactionsData.length; i += 1) {
        const reaction = currentReactionsData[i]
        if (reaction.timestampMs > currentMs) break

        if (!triggeredReactionIds[reaction._id]) {
          if (!shouldCommitTriggeredReactionIds) {
            triggeredReactionIds = { ...triggeredReactionIds }
            shouldCommitTriggeredReactionIds = true
          }
          triggeredReactionIds[reaction._id] = true
          activeReactions ??= state$.activeReactions.get()
          const alreadyActive = activeReactions.some(
            (activeReaction) =>
              String(activeReaction.userId) === String(reaction.userId) &&
              activeReaction.emoji === reaction.emoji &&
              activeReaction.timestampMs === reaction.timestampMs,
          )
          if (alreadyActive) continue

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

      if (shouldCommitTriggeredReactionIds) {
        triggeredReactionIdsRef.current = triggeredReactionIds
        state$.triggeredReactionIds.set(triggeredReactionIds)
      }

      if (crossedReactions.length > 0) {
        state$.activeReactions.set([
          ...state$.activeReactions.get(),
          ...crossedReactions.sort((a, b) => a.createdAt - b.createdAt),
        ])
      }

      lastReactionPlaybackMsRef.current = currentMs
    },
    [isLive, player, state$, syncLocalReactionPlaybackAfterSeek, updatePlaybackProgress],
  )

  useEffect(() => {
    if (player && isActive && isScreenFocused && isAppActive) {
      player.playbackRate = playbackSpeed
      player.timeUpdateEventInterval = PROGRESS_TIME_UPDATE_INTERVAL_SECONDS
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
        state$.hasError.set(false)
        errorRetryRef.current.count = 0
        // The player self-recovered — a still-pending auto-retry would force
        // a pointless reload that interrupts playback mid-watch.
        if (errorRetryRef.current.timer) {
          clearTimeout(errorRetryRef.current.timer)
          errorRetryRef.current.timer = null
        }
        if (player.duration) {
          state$.duration.set(player.duration * 1000)
        }
      } else if (status.status === 'loading') {
        state$.isLoading.set(true)
      } else if (status.status === 'error') {
        // Weak-cellular HLS loads fail transiently all the time; previously
        // this status was ignored and the user stared at an infinite spinner.
        state$.isLoading.set(false)
        const errorMessage = status.error?.message ?? 'unknown'
        telemetry.error('video:playback_error', 'Video player reported a playback error', {
          videoId,
          isLive,
          error: errorMessage,
          retryCount: errorRetryRef.current.count,
          positionMs: Math.round((player.currentTime ?? 0) * 1000),
        })
        if (currentUrl && errorRetryRef.current.count < 2) {
          errorRetryRef.current.count += 1
          const delayMs = 2_000 * errorRetryRef.current.count
          // A rapid second error must not orphan the previous timer — the
          // single-slot ref is the only handle cleanup paths can clear.
          if (errorRetryRef.current.timer) {
            clearTimeout(errorRetryRef.current.timer)
          }
          errorRetryRef.current.timer = setTimeout(() => {
            state$.isLoading.set(true)
            // Preserve the pre-error play intent: a silent auto-recovery
            // mid-watch should resume, not leave the player paused.
            player
              .replaceAsync(currentUrl)
              .then(() => resumePlaybackAfterRecovery())
              .catch(() => {})
          }, delayMs)
        } else {
          state$.hasError.set(true)
        }
      }

      if (status.status === 'readyToPlay') {
        if (
          shouldTrackPlayback &&
          !isScrubbingRef.current &&
          player.currentTime !== undefined &&
          player.duration
        ) {
          updatePlaybackProgress({
            currentTime: player.currentTime,
            duration: player.duration,
            force: true,
          })
        }
      }
    })

    const endSubscription = player.addListener('playToEnd', () => {
      if (!shouldTrackPlayback) return

      state$.hasEnded.set(true)
      state$.progress.set(1)
      state$.isPlaying.set(false)
      triggeredReactionIdsRef.current = {}
      lastReactionPlaybackMsRef.current = null
      state$.triggeredReactionIds.set(triggeredReactionIdsRef.current)
      state$.lastReactionPlaybackMs.set(lastReactionPlaybackMsRef.current)
      clearActiveReactions(state$)
      onComplete(player.currentTime * 1000, player.duration ? player.duration * 1000 : undefined)
    })

    const playingSubscription = player.addListener('playingChange', ({ isPlaying }) => {
      state$.isPlaying.set(shouldTrackPlayback ? isPlaying : false)
    })

    const timeUpdateSubscription = player.addListener('timeUpdate', ({ currentTime }) => {
      if (
        !shouldTrackPlayback ||
        isScrubbingRef.current ||
        player.status !== 'readyToPlay' ||
        !player.duration
      ) {
        return
      }

      processTimedPlaybackUpdate(currentTime, player.duration)

      syncCaptionText(currentTime * 1000)
    })

    return () => {
      statusSubscription.remove()
      endSubscription.remove()
      playingSubscription.remove()
      timeUpdateSubscription.remove()
    }
  }, [
    player,
    onComplete,
    state$,
    shouldTrackPlayback,
    processTimedPlaybackUpdate,
    syncCaptionText,
    updatePlaybackProgress,
    currentUrl,
    videoId,
    isLive,
    resumePlaybackAfterRecovery,
  ])

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

  // Buffering-stall watchdog. Warn once after 15s of continuous loading so
  // stalls show up in telemetry, and give up into the retry overlay after
  // 45s instead of spinning forever.
  const isLoadingValue = useValue(state$.isLoading)
  useEffect(() => {
    if (!isActive || !isScreenFocused || !isAppActive || !currentUrl || !isLoadingValue) {
      return
    }

    const stallWarnTimer = setTimeout(() => {
      telemetry.warn('video:playback_stall', 'Video stuck buffering', {
        videoId,
        isLive,
        stalledForMs: 15_000,
        positionMs: Math.round((player?.currentTime ?? 0) * 1000),
      })
    }, 15_000)

    const giveUpTimer = setTimeout(() => {
      telemetry.error('video:playback_stall_timeout', 'Video buffering timed out', {
        videoId,
        isLive,
        stalledForMs: 45_000,
        positionMs: Math.round((player?.currentTime ?? 0) * 1000),
      })
      state$.isLoading.set(false)
      state$.hasError.set(true)
    }, 45_000)

    return () => {
      clearTimeout(stallWarnTimer)
      clearTimeout(giveUpTimer)
    }
  }, [
    isActive,
    isScreenFocused,
    isAppActive,
    currentUrl,
    isLoadingValue,
    player,
    state$,
    videoId,
    isLive,
  ])

  // Crash-survivable breadcrumb: if the app dies (OOM, native AVPlayer crash)
  // while a video is actively playing, the next launch reports
  // crash:last_breadcrumb with this context. Recording has had the same
  // protection since the camera-freeze fix; playback crashes were invisible.
  useEffect(() => {
    if (isActive && isScreenFocused && isAppActive && isPlaying) {
      telemetry.setCrashBreadcrumb('video:watching', { videoId, isLive })
      return () => {
        telemetry.clearCrashBreadcrumb()
      }
    }
    return undefined
  }, [isActive, isScreenFocused, isAppActive, isPlaying, videoId, isLive])

  const togglePlayPause = useCallback(() => {
    if (!player) return

    if (state$.hasEnded.get()) {
      triggeredReactionIdsRef.current = {}
      lastReactionPlaybackMsRef.current = null
      state$.triggeredReactionIds.set(triggeredReactionIdsRef.current)
      state$.lastReactionPlaybackMs.set(lastReactionPlaybackMsRef.current)
      clearActiveReactions(state$)
      player.replay()
      state$.hasEnded.set(false)
      state$.isPlaying.set(true)
      state$.userInitiatedPlay.set(true)
      userPausedRef.current = false
    } else if (player.playing) {
      player.pause()
      state$.isPlaying.set(false)
      // Deliberate pause — error auto-recovery must not resume over it.
      userPausedRef.current = true
    } else {
      state$.userInitiatedPlay.set(true)
      userPausedRef.current = false
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
      if (now - state$.lastReactionTime.get() < REACTION_THROTTLE_MS) return false
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
              triggeredReactionIdsRef.current = {
                ...triggeredReactionIdsRef.current,
                [savedReaction._id]: true,
              }
              state$.triggeredReactionIds.set(triggeredReactionIdsRef.current)
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
          syncLocalReactionPlaybackAfterSeek(seekTime * 1000)
          syncCaptionText(seekTime * 1000)
        }
        state$.progress.set(seekProgress)
        state$.hasEnded.set(false)
        state$.userInitiatedPlay.set(true)
      }
    },
    [player, state$, syncCaptionText, syncLocalReactionPlaybackAfterSeek],
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
          fullscreenOptions={{ enable: false }}
          allowsPictureInPicture={false}
          startsPictureInPictureAutomatically={false}
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

      <PlaybackErrorOverlay state$={state$} onRetry={retryPlayback} />

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

      <CaptionOverlay state$={state$} />

      <VideoProgressBar
        state$={state$}
        progressBarViewRef={progressBarViewRef}
        onLayout={handleProgressBarLayout}
        panHandlers={progressBarPanResponder.panHandlers}
      />

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

      {onRespondAfterPlayback ? (
        <RespondCTAOverlay state$={state$} onRespond={onRespondAfterPlayback} />
      ) : null}
    </YStack>
  )
}

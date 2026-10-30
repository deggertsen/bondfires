import type { Viewer } from '@bondfires/app'
import { Button, Spinner, Text } from '@bondfires/ui'
import { useValue } from '@legendapp/state/react'
import { Flame, Play, RotateCcw, Volume2, VolumeX } from '@tamagui/lucide-icons'
import { type RefObject, useEffect, useState } from 'react'
import type { LayoutChangeEvent, PanResponderInstance } from 'react-native'
import { Pressable, View } from 'react-native'
import Animated, {
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSequence,
  withTiming,
} from 'react-native-reanimated'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { XStack, YStack } from 'tamagui'
import type { Id } from '../../../../../../convex/_generated/dataModel'
import { EmojiReactionButton } from '../../../../components/EmojiReactionButton'
import { EmojiReactionGrid } from '../../../../components/EmojiReactionGrid'
import { ReportButton } from '../../../../components/ReportButton'
import { ReportOverlay } from '../../../../components/ReportOverlay'
import type { ActiveReaction } from '../../../../components/ViewerPresenceStack'
import { ViewerPresenceStack } from '../../../../components/ViewerPresenceStack'
import { VIDEO_OVERLAY_COLORS as OVERLAY_COLORS } from '../../../../components/videoOverlayColors'
import { formatTime } from '../_lib/bondfireDetailHelpers'
import { presenceTop } from '../_lib/liveWatch'
import type { HeatmapPeak, ReactionHeatmap } from '../_lib/reactionHeatmap'
import { shouldShowRespondCTA, type VideoPlayerState$ } from '../_lib/videoPlayerState'

export function LoadingOverlay({
  state$,
  currentUrl,
  isProcessing = false,
  isHoldingLiveEdge = false,
}: {
  state$: VideoPlayerState$
  currentUrl: string | null
  isProcessing?: boolean
  isHoldingLiveEdge?: boolean
}) {
  const isLoading = useValue(state$.isLoading)
  if (!(isLoading || isHoldingLiveEdge) || !currentUrl) return null

  return (
    <YStack
      position="absolute"
      top={0}
      left={0}
      right={0}
      bottom={0}
      alignItems="center"
      justifyContent="center"
      backgroundColor={OVERLAY_COLORS.loadingBackground}
      zIndex={2}
      pointerEvents="none"
    >
      <Spinner size="large" color={'$primary'} />
      {isProcessing && (
        <Text color={OVERLAY_COLORS.textPrimary} marginTop="$3">
          Video still processing…
        </Text>
      )}
    </YStack>
  )
}

export function PlaybackErrorOverlay({
  state$,
  onRetry,
  isProcessing = false,
}: {
  state$: VideoPlayerState$
  onRetry: () => void
  isProcessing?: boolean
}) {
  const hasError = useValue(state$.hasError)
  if (!hasError) return null

  return (
    <YStack
      position="absolute"
      top={0}
      left={0}
      right={0}
      bottom={0}
      alignItems="center"
      justifyContent="center"
      backgroundColor={OVERLAY_COLORS.loadingBackground}
      zIndex={3}
      gap="$3"
      paddingHorizontal={32}
    >
      <Text color={OVERLAY_COLORS.textPrimary} fontSize={15} textAlign="center">
        {isProcessing
          ? 'The rest of this video is still uploading. Try again in a moment.'
          : "This video couldn't be played. Check your connection and try again."}
      </Text>
      <Button size="$3" icon={RotateCcw} onPress={onRetry}>
        Try Again
      </Button>
    </YStack>
  )
}

export function ReactionPresenceLayer({
  state$,
  liveViewers,
  onReactionExpired,
}: {
  state$: VideoPlayerState$
  liveViewers: Viewer[]
  onReactionExpired: (id: string) => void
}) {
  const activeReactions = useValue(state$.activeReactions)
  const insets = useSafeAreaInsets()

  return (
    <ViewerPresenceStack
      liveViewers={liveViewers}
      activeReactions={activeReactions}
      onReactionExpired={onReactionExpired}
      style={{ top: presenceTop(insets.top), left: 16 }}
    />
  )
}

export function PlayPauseIndicator({
  state$,
  isHoldingLiveEdge = false,
}: {
  state$: VideoPlayerState$
  isHoldingLiveEdge?: boolean
}) {
  const isPlaying = useValue(state$.isPlaying)
  const isLoading = useValue(state$.isLoading)
  const hasEnded = useValue(state$.hasEnded)

  if (isPlaying || isLoading || isHoldingLiveEdge) return null

  return (
    <YStack
      position="absolute"
      top={0}
      left={0}
      right={0}
      bottom={0}
      alignItems="center"
      justifyContent="center"
      zIndex={2}
      pointerEvents="none"
    >
      <YStack
        width={80}
        height={80}
        borderRadius={40}
        backgroundColor={OVERLAY_COLORS.playPauseBackground}
        alignItems="center"
        justifyContent="center"
      >
        {hasEnded ? (
          <RotateCcw size={40} color={OVERLAY_COLORS.textPrimary} />
        ) : (
          <Play size={40} color={OVERLAY_COLORS.textPrimary} fill={OVERLAY_COLORS.textPrimary} />
        )}
      </YStack>
    </YStack>
  )
}

/**
 * Closed captions, rendered just above the scrub bar (whose container is
 * anchored at bottom:100 and grows ~48px upward, plus HEATMAP_STRIP_HEIGHT
 * when the reaction heatmap is shown; callers pass that in bottomOffset). Text comes from
 * state$.captionText, kept in sync by VideoPlayer's timeUpdate listener.
 */
export function CaptionOverlay({
  state$,
  bottomOffset = 0,
}: {
  state$: VideoPlayerState$
  bottomOffset?: number
}) {
  const captionText = useValue(state$.captionText)
  const insets = useSafeAreaInsets()
  if (!captionText) return null

  return (
    <YStack
      position="absolute"
      bottom={152 + insets.bottom + bottomOffset}
      // 76px insets keep captions clear of the round side controls (44px wide,
      // inset 16px): the mute/emoji stack on the right and the paused report
      // button on the left both sit within 60px of their edge.
      left={76}
      right={76}
      zIndex={3}
      alignItems="center"
      pointerEvents="none"
    >
      <YStack
        backgroundColor="rgba(0,0,0,0.65)"
        paddingHorizontal={10}
        paddingVertical={5}
        borderRadius={6}
      >
        <Text fontSize={14} color={OVERLAY_COLORS.textPrimary} textAlign="center">
          {captionText}
        </Text>
      </YStack>
    </YStack>
  )
}

/** Height the reaction heatmap adds above the scrub bar; overlays above it shift up by this. */
export const HEATMAP_STRIP_HEIGHT = 44
const HEATMAP_MARKER_ROW_HEIGHT = 24
const HEATMAP_BARS_HEIGHT = 16
const HEATMAP_MARKER_WIDTH = 56

function HeatmapMarker({
  state$,
  peak,
  left,
  onSeekMs,
}: {
  state$: VideoPlayerState$
  peak: HeatmapPeak
  left: number
  onSeekMs: (positionMs: number) => void
}) {
  const reduceMotion = useReducedMotion()
  // Re-renders only when the playhead crosses this marker, not on every tick.
  const passed = useValue(() => state$.progress.get() >= peak.position)
  const scale = useSharedValue(1)

  useEffect(() => {
    if (!passed || reduceMotion) return
    scale.value = withSequence(
      withTiming(1.45, { duration: 120 }),
      withTiming(1, { duration: 220 }),
    )
  }, [passed, reduceMotion, scale])

  const popStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }))

  return (
    <Pressable
      onPress={() => onSeekMs(peak.seekMs)}
      hitSlop={{ top: 12, bottom: 4, left: 4, right: 4 }}
      accessibilityRole="button"
      accessibilityLabel={`${peak.count} ${peak.emoji} reactions here. Jump to ${formatTime(peak.firstTimestampMs)}`}
      style={{
        position: 'absolute',
        top: 0,
        left,
        width: HEATMAP_MARKER_WIDTH,
        height: HEATMAP_MARKER_ROW_HEIGHT,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Animated.View style={popStyle}>
        <XStack
          height={22}
          paddingHorizontal={6}
          borderRadius={11}
          backgroundColor={OVERLAY_COLORS.pillBackground}
          borderWidth={1}
          borderColor={'$secondary'}
          alignItems="center"
          gap={3}
        >
          <Text fontSize={12}>{peak.emoji}</Text>
          <Text fontSize={10} fontWeight="800" color={OVERLAY_COLORS.textPrimary}>
            {peak.count}
          </Text>
        </XStack>
      </Animated.View>
    </Pressable>
  )
}

/**
 * Where this video's reactions cluster: a density strip with the top emoji
 * pinned over each peak. Sits above the scrub bar's pan area, so a marker tap
 * seeks instead of starting a drag.
 */
function ReactionHeatmapStrip({
  state$,
  heatmap,
  onSeekMs,
}: {
  state$: VideoPlayerState$
  heatmap: ReactionHeatmap
  onSeekMs: (positionMs: number) => void
}) {
  const [width, setWidth] = useState(0)

  return (
    <YStack
      height={HEATMAP_STRIP_HEIGHT}
      justifyContent="flex-end"
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
    >
      <View style={{ height: HEATMAP_MARKER_ROW_HEIGHT }}>
        {width > 0
          ? heatmap.peaks.map((peak) => (
              <HeatmapMarker
                key={`${peak.position}-${peak.emoji}`}
                state$={state$}
                peak={peak}
                left={Math.min(
                  Math.max(0, peak.position * width - HEATMAP_MARKER_WIDTH / 2),
                  Math.max(0, width - HEATMAP_MARKER_WIDTH),
                )}
                onSeekMs={onSeekMs}
              />
            ))
          : null}
      </View>
      <XStack
        height={HEATMAP_BARS_HEIGHT}
        marginTop={4}
        alignItems="flex-end"
        gap={2}
        pointerEvents="none"
      >
        {heatmap.bins.map((bin, index) => (
          <YStack
            // biome-ignore lint/suspicious/noArrayIndexKey: bins are fixed positions along the bar
            key={index}
            flex={1}
            height={2 + bin * (HEATMAP_BARS_HEIGHT - 2)}
            borderRadius={1}
            backgroundColor={'$secondary'}
            opacity={0.25 + bin * 0.75}
          />
        ))}
      </XStack>
    </YStack>
  )
}

export function VideoProgressBar({
  state$,
  progressBarViewRef,
  onLayout,
  panHandlers,
  heatmap,
  onSeekMs,
}: {
  state$: VideoPlayerState$
  progressBarViewRef: RefObject<View | null>
  onLayout: (event: LayoutChangeEvent) => void
  panHandlers: PanResponderInstance['panHandlers']
  heatmap?: ReactionHeatmap | null
  onSeekMs?: (positionMs: number) => void
}) {
  const progress = useValue(state$.progress)
  const duration = useValue(state$.duration)
  const elapsedMs = useValue(state$.elapsedMs)
  const progressPercent = `${Math.min(1, Math.max(0, progress)) * 100}%`
  const insets = useSafeAreaInsets()

  return (
    <YStack position="absolute" bottom={100 + insets.bottom} left={20} right={20} zIndex={3}>
      {heatmap && onSeekMs ? (
        <ReactionHeatmapStrip state$={state$} heatmap={heatmap} onSeekMs={onSeekMs} />
      ) : null}
      <View ref={progressBarViewRef} onLayout={onLayout} {...panHandlers}>
        <YStack paddingVertical={10}>
          <YStack height={4} backgroundColor={OVERLAY_COLORS.progressTrack} borderRadius={2}>
            <YStack
              height={4}
              backgroundColor={'$primary'}
              borderRadius={2}
              width={progressPercent}
            />
            <YStack
              position="absolute"
              top={-4}
              left={progressPercent}
              marginLeft={-6}
              width={12}
              height={12}
              borderRadius={6}
              backgroundColor={'$primary'}
            />
          </YStack>
        </YStack>
      </View>
      <XStack justifyContent="space-between" marginTop={4}>
        <Text fontSize={12} color={OVERLAY_COLORS.textSecondary}>
          {formatTime(elapsedMs)}
        </Text>
        <Text fontSize={12} color={OVERLAY_COLORS.textSecondary}>
          {formatTime(Math.max(duration, elapsedMs))}
        </Text>
      </XStack>
    </YStack>
  )
}

export function PausedReportButton({
  state$,
  isHoldingLiveEdge = false,
  bottomOffset = 0,
}: {
  state$: VideoPlayerState$
  isHoldingLiveEdge?: boolean
  bottomOffset?: number
}) {
  const isPlaying = useValue(state$.isPlaying)
  const isLoading = useValue(state$.isLoading)
  const insets = useSafeAreaInsets()

  if (isPlaying || isLoading || isHoldingLiveEdge) return null

  return (
    <YStack position="absolute" left={16} bottom={160 + insets.bottom + bottomOffset} zIndex={3}>
      <ReportButton onPress={() => state$.showReport.set(true)} />
    </YStack>
  )
}

const RIGHT_CONTROLS_RIGHT = 16
const RIGHT_CONTROLS_BOTTOM = 160
const RIGHT_CONTROLS_GAP = 16
const RIGHT_CONTROL_SIZE = 44

/**
 * Where floating reactions start: just above the right-side stack (react
 * button over mute), centered on it.
 */
export function getFloatingReactionsAnchor({
  bottomInset,
  bottomOffset,
}: {
  bottomInset: number
  bottomOffset: number
}) {
  const buttons = 2
  const stackHeight = buttons * RIGHT_CONTROL_SIZE + (buttons - 1) * RIGHT_CONTROLS_GAP
  return {
    right: RIGHT_CONTROLS_RIGHT,
    bottom: RIGHT_CONTROLS_BOTTOM + bottomInset + bottomOffset + stackHeight + 8,
  }
}

export function RightSideControls({
  state$,
  isPaid,
  recentEmojis,
  isMuted,
  onEmojiSelect,
  onToggleMute,
  bottomOffset = 0,
}: {
  state$: VideoPlayerState$
  isPaid: boolean
  recentEmojis: string[]
  isMuted: boolean
  onEmojiSelect: (emoji: string) => boolean
  onToggleMute: () => void
  bottomOffset?: number
}) {
  const emojiGridOpen = useValue(state$.emojiGridOpen)
  const insets = useSafeAreaInsets()

  return (
    <YStack
      position="absolute"
      right={RIGHT_CONTROLS_RIGHT}
      bottom={RIGHT_CONTROLS_BOTTOM + insets.bottom + bottomOffset}
      gap={RIGHT_CONTROLS_GAP}
      alignItems="center"
      zIndex={3}
    >
      <YStack>
        <EmojiReactionButton
          onPress={() => state$.emojiGridOpen.set(!state$.emojiGridOpen.get())}
        />
        {emojiGridOpen && (
          <EmojiReactionGrid
            isPaid={isPaid}
            recentEmojis={recentEmojis}
            onSelect={onEmojiSelect}
            onClose={() => state$.emojiGridOpen.set(false)}
          />
        )}
      </YStack>
      <Pressable onPress={onToggleMute}>
        <YStack
          width={44}
          height={44}
          borderRadius={22}
          backgroundColor={OVERLAY_COLORS.pillBackground}
          alignItems="center"
          justifyContent="center"
        >
          {isMuted ? (
            <VolumeX size={22} color={OVERLAY_COLORS.textPrimary} />
          ) : (
            <Volume2 size={22} color={OVERLAY_COLORS.textPrimary} />
          )}
        </YStack>
      </Pressable>
    </YStack>
  )
}

/**
 * Respond under the play/replay indicator whenever playback stops: a pause on
 * any video, or the end of the thread's last one (earlier videos advance).
 */
export function RespondCTAOverlay({
  state$,
  isHoldingLiveEdge = false,
  advancesOnEnd,
  onRespond,
}: {
  state$: VideoPlayerState$
  isHoldingLiveEdge?: boolean
  advancesOnEnd: boolean
  onRespond: () => void
}) {
  const hasEnded = useValue(state$.hasEnded)
  const isPlaying = useValue(state$.isPlaying)
  const isLoading = useValue(state$.isLoading)
  const hasError = useValue(state$.hasError)
  // A boolean selector so playback's 250ms clock ticks do not re-render this.
  const hasProgress = useValue(() => state$.elapsedMs.get() > 0)

  if (
    !shouldShowRespondCTA({
      hasEnded,
      isPlaying,
      isLoading,
      hasError,
      hasProgress,
      isHoldingLiveEdge,
      advancesOnEnd,
    })
  ) {
    return null
  }

  return (
    <YStack
      position="absolute"
      top="50%"
      left={0}
      right={0}
      marginTop={60}
      alignItems="center"
      zIndex={4}
      pointerEvents="box-none"
      animation="quick"
      enterStyle={{ opacity: 0, scale: 0.9 }}
    >
      <Button
        variant="primary"
        size="$lg"
        onPress={onRespond}
        accessibilityLabel="Respond to this Bondfire"
        borderRadius={28}
        shadowColor="rgba(0,0,0,0.4)"
        shadowOffset={{ width: 0, height: 4 }}
        shadowOpacity={0.5}
        shadowRadius={12}
        elevation={8}
      >
        <Flame size={22} color={OVERLAY_COLORS.textPrimary} />
        <Text fontSize={16} fontWeight="800" color={OVERLAY_COLORS.textPrimary}>
          {hasEnded ? 'Respond to this Bondfire' : 'Respond'}
        </Text>
      </Button>
    </YStack>
  )
}

/** Height of RespondNudgeCard; captions lift by this much (plus a gap) while it shows. */
export const RESPOND_NUDGE_HEIGHT = 60

/**
 * "Something to add?" over the last seconds of a video (see
 * shouldShowRespondNudge), sitting where captions usually do and left of the
 * react/mute stack. The caller decides visibility so it can lift captions too.
 */
export function RespondNudgeCard({
  nextCreatorName,
  onRespond,
  bottomOffset = 0,
}: {
  nextCreatorName?: string
  onRespond: () => void
  bottomOffset?: number
}) {
  const insets = useSafeAreaInsets()

  return (
    <XStack
      position="absolute"
      left={16}
      right={RIGHT_CONTROLS_RIGHT + RIGHT_CONTROL_SIZE + 12}
      bottom={RIGHT_CONTROLS_BOTTOM + insets.bottom + bottomOffset}
      height={RESPOND_NUDGE_HEIGHT}
      alignItems="center"
      gap={10}
      paddingLeft={14}
      paddingRight={8}
      borderRadius={18}
      borderWidth={1}
      borderColor={'$primary'}
      backgroundColor={OVERLAY_COLORS.pillBackground}
      zIndex={4}
      animation="quick"
      enterStyle={{ opacity: 0, y: 12 }}
    >
      <YStack flex={1} minWidth={0}>
        <Text fontSize={15} fontWeight="800" color={OVERLAY_COLORS.textPrimary} numberOfLines={1}>
          Something to add?
        </Text>
        <Text fontSize={12} color={OVERLAY_COLORS.textSecondary} numberOfLines={1}>
          {nextCreatorName ? `Up next: ${nextCreatorName}` : 'Last video in this thread'}
        </Text>
      </YStack>
      <Button
        variant="primary"
        size="$md"
        onPress={onRespond}
        accessibilityLabel="Respond to this Bondfire"
        borderRadius={14}
        gap={6}
      >
        <Flame size={18} color={OVERLAY_COLORS.textPrimary} />
        <Text fontSize={15} fontWeight="800" color={OVERLAY_COLORS.textPrimary}>
          Respond
        </Text>
      </Button>
    </XStack>
  )
}

export function ReportOverlayGate({
  state$,
  bondfireId,
  bondfireVideoId,
  videoOwnerId,
}: {
  state$: VideoPlayerState$
  bondfireId?: Id<'bondfires'>
  bondfireVideoId?: Id<'bondfireVideos'>
  videoOwnerId: Id<'users'>
}) {
  const showReport = useValue(state$.showReport)

  if (!showReport) return null

  return (
    <ReportOverlay
      bondfireId={bondfireId}
      bondfireVideoId={bondfireVideoId}
      videoOwnerId={videoOwnerId}
      onClose={() => state$.showReport.set(false)}
    />
  )
}

export type { ActiveReaction }

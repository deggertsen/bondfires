import type { Viewer } from '@bondfires/app'
import { Button, Spinner, Text } from '@bondfires/ui'
import { useValue } from '@legendapp/state/react'
import { Flame, Play, RotateCcw, Volume2, VolumeX } from '@tamagui/lucide-icons'
import type { RefObject } from 'react'
import type { LayoutChangeEvent, PanResponderInstance } from 'react-native'
import { Pressable, View } from 'react-native'
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
import { shouldShowRespondCTA, type VideoPlayerState$ } from '../_lib/videoPlayerState'

export function LoadingOverlay({
  state$,
  currentUrl,
}: {
  state$: VideoPlayerState$
  currentUrl: string | null
}) {
  const isLoading = useValue(state$.isLoading)
  if (!isLoading || !currentUrl) return null

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

  return (
    <ViewerPresenceStack
      liveViewers={liveViewers}
      activeReactions={activeReactions}
      onReactionExpired={onReactionExpired}
      style={{ top: 100, left: 16 }}
    />
  )
}

export function PlayPauseIndicator({ state$ }: { state$: VideoPlayerState$ }) {
  const isPlaying = useValue(state$.isPlaying)
  const isLoading = useValue(state$.isLoading)
  const hasEnded = useValue(state$.hasEnded)

  if (isPlaying || isLoading) return null

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
 * anchored at bottom:100 and grows ~48px upward). Text comes from
 * state$.captionText, kept in sync by VideoPlayer's timeUpdate listener.
 */
export function CaptionOverlay({ state$ }: { state$: VideoPlayerState$ }) {
  const captionText = useValue(state$.captionText)
  const insets = useSafeAreaInsets()
  if (!captionText) return null

  return (
    <YStack
      position="absolute"
      bottom={152 + insets.bottom}
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

export function VideoProgressBar({
  state$,
  progressBarViewRef,
  onLayout,
  panHandlers,
}: {
  state$: VideoPlayerState$
  progressBarViewRef: RefObject<View | null>
  onLayout: (event: LayoutChangeEvent) => void
  panHandlers: PanResponderInstance['panHandlers']
}) {
  const progress = useValue(state$.progress)
  const duration = useValue(state$.duration)
  const progressPercent = `${progress * 100}%`
  const insets = useSafeAreaInsets()

  return (
    <YStack position="absolute" bottom={100 + insets.bottom} left={20} right={20} zIndex={3}>
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
          {formatTime(progress * duration)}
        </Text>
        <Text fontSize={12} color={OVERLAY_COLORS.textSecondary}>
          {formatTime(duration)}
        </Text>
      </XStack>
    </YStack>
  )
}

export function PausedReportButton({ state$ }: { state$: VideoPlayerState$ }) {
  const isPlaying = useValue(state$.isPlaying)
  const isLoading = useValue(state$.isLoading)
  const insets = useSafeAreaInsets()

  if (isPlaying || isLoading) return null

  return (
    <YStack position="absolute" left={16} bottom={160 + insets.bottom} zIndex={3}>
      <ReportButton onPress={() => state$.showReport.set(true)} />
    </YStack>
  )
}

export function RightSideControls({
  state$,
  isLive,
  isPaid,
  recentEmojis,
  isMuted,
  onEmojiSelect,
  onToggleMute,
}: {
  state$: VideoPlayerState$
  isLive: boolean
  isPaid: boolean
  recentEmojis: string[]
  isMuted: boolean
  onEmojiSelect: (emoji: string) => boolean
  onToggleMute: () => void
}) {
  const emojiGridOpen = useValue(state$.emojiGridOpen)
  const insets = useSafeAreaInsets()

  return (
    <YStack position="absolute" right={16} bottom={160 + insets.bottom} gap={16} alignItems="center" zIndex={3}>
      {!isLive && (
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
      )}
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

export function RespondCTAOverlay({
  state$,
  onRespond,
}: {
  state$: VideoPlayerState$
  onRespond: () => void
}) {
  const hasEnded = useValue(state$.hasEnded)
  const isPlaying = useValue(state$.isPlaying)
  const isLoading = useValue(state$.isLoading)

  if (!shouldShowRespondCTA({ hasEnded, isPlaying, isLoading })) return null

  return (
    <YStack
      position="absolute"
      top="50%"
      left={0}
      right={0}
      marginTop={60}
      alignItems="center"
      zIndex={4}
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
          Respond to this Bondfire
        </Text>
      </Button>
    </YStack>
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

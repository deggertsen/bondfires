import type { Viewer } from '@bondfires/app'
import { Spinner, Text } from '@bondfires/ui'
import { useValue } from '@legendapp/state/react'
import { Play, RotateCcw, Volume2, VolumeX } from '@tamagui/lucide-icons'
import type { RefObject } from 'react'
import type { LayoutChangeEvent, PanResponderInstance } from 'react-native'
import { Pressable, View } from 'react-native'
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
import type { VideoPlayerState$ } from '../_lib/videoPlayerState'

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

  return (
    <YStack position="absolute" bottom={100} left={20} right={20} zIndex={3}>
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

  if (isPlaying || isLoading) return null

  return (
    <YStack position="absolute" left={16} bottom={160} zIndex={3}>
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

  return (
    <YStack position="absolute" right={16} bottom={160} gap={16} alignItems="center" zIndex={3}>
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

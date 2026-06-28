import type { Viewer } from '@bondfires/app'
import { Flame } from '@tamagui/lucide-icons'
import { useEffect, useMemo, useRef } from 'react'
import { Animated, ScrollView, type StyleProp, type ViewStyle } from 'react-native'
import { AnimatePresence, Avatar, Text, YStack } from 'tamagui'
import { VIDEO_OVERLAY_COLORS } from './videoOverlayColors'

export interface ActiveReaction {
  id: string
  userId: string
  userName: string
  userPhotoUrl?: string
  emoji: string
  timestampMs: number
  createdAt: number
}

export interface ViewerPresenceStackProps {
  liveViewers: Viewer[]
  activeReactions?: ActiveReaction[]
  onReactionExpired?: (id: string) => void
  style?: StyleProp<ViewStyle>
}

const AVATAR_SIZE = 36
const AVATAR_RADIUS = AVATAR_SIZE / 2
const AVATAR_LABEL_HEIGHT = 12
const AVATAR_CONTENT_GAP = 2
const MAX_VISIBLE = 5
const EMOJI_SCALE_DURATION = 800
const TOTAL_DURATION = 1500

/**
 * Unified avatar stack for the video player's left side.
 *
 * Renders two layers:
 * 1. Persistent/live viewers — avatars with "watching" labels
 * 2. Transient reactions — avatars with emoji overlays, no label
 *
 * Merge logic:
 * - For each active reaction, check if reaction.userId matches a live viewer's userId
 * - If match: render emoji overlay on that viewer's existing avatar (no duplicate avatar)
 * - If no match: render a transient avatar + emoji
 * - Live viewers always rendered first (on top)
 * - Transient reactions below, ordered by timestampMs/createdAt
 * - No "watching" label on transient reaction avatars
 */
export function ViewerPresenceStack({
  liveViewers,
  activeReactions = [],
  onReactionExpired,
  style,
}: ViewerPresenceStackProps) {
  const { liveViewerReactionMap, transientReactions, visibleCount } = useMemo(() => {
    const liveViewerUserIds = new Set(liveViewers.map((v) => String(v.userId)))
    const nextTransientReactions: ActiveReaction[] = []
    const nextLiveViewerReactionMap = new Map<string, ActiveReaction[]>()

    for (const reaction of activeReactions) {
      const userId = String(reaction.userId)
      if (!liveViewerUserIds.has(userId)) {
        nextTransientReactions.push(reaction)
        continue
      }

      const existing = nextLiveViewerReactionMap.get(userId) ?? []
      existing.push(reaction)
      nextLiveViewerReactionMap.set(userId, existing)
    }

    return {
      liveViewerReactionMap: nextLiveViewerReactionMap,
      transientReactions: nextTransientReactions,
      visibleCount: liveViewers.length + nextTransientReactions.length,
    }
  }, [activeReactions, liveViewers])

  if (visibleCount === 0) {
    return null
  }

  const gap = visibleCount <= 2 ? 12 : visibleCount <= 4 ? 6 : 0
  const overlapMargin = visibleCount >= 5 ? -4 : 0
  const itemHeight = AVATAR_SIZE + AVATAR_CONTENT_GAP + AVATAR_LABEL_HEIGHT
  const maxVisibleHeight =
    MAX_VISIBLE * itemHeight + (MAX_VISIBLE - 1) * gap + (MAX_VISIBLE - 1) * overlapMargin

  return (
    <ScrollView
      style={[
        {
          position: 'absolute',
          zIndex: 4,
          maxHeight: maxVisibleHeight,
        },
        style,
      ]}
      showsVerticalScrollIndicator={false}
      contentContainerStyle={{ gap }}
    >
      <AnimatePresence>
        {/* Live viewers first (on top) */}
        {liveViewers.map((viewer) => {
          const viewerReactions = liveViewerReactionMap.get(String(viewer.userId)) ?? []
          return (
            <YStack
              key={`live-${viewer._id}`}
              animation="lazy"
              enterStyle={{ opacity: 0, scale: 0.8 }}
              exitStyle={{ opacity: 0, scale: 0.8 }}
              alignItems="center"
              gap={2}
              marginBottom={overlapMargin}
            >
              <YStack position="relative" alignItems="center" justifyContent="center">
                <Avatar size={AVATAR_SIZE} borderRadius={AVATAR_RADIUS}>
                  {viewer.userPhotoUrl ? (
                    <Avatar.Image source={{ uri: viewer.userPhotoUrl }} />
                  ) : null}
                  <Avatar.Fallback backgroundColor={VIDEO_OVERLAY_COLORS.pillBackground}>
                    <Flame size={18} color={VIDEO_OVERLAY_COLORS.textPrimary} />
                  </Avatar.Fallback>
                </Avatar>
                {/* Emoji overlays for matching reactions on this live viewer */}
                {viewerReactions.map((reaction) => (
                  <AnimatedEmoji
                    key={reaction.id}
                    reactionId={reaction.id}
                    emoji={reaction.emoji}
                    onExpired={onReactionExpired}
                  />
                ))}
              </YStack>
              <Text fontSize={9} color={VIDEO_OVERLAY_COLORS.textPrimary} fontWeight="500">
                watching
              </Text>
            </YStack>
          )
        })}

        {/* Transient reactions below (no "watching" label) */}
        {transientReactions.map((reaction) => (
          <TransientReactionAvatar
            key={reaction.id}
            reaction={reaction}
            marginBottom={overlapMargin}
            onExpired={onReactionExpired}
          />
        ))}
      </AnimatePresence>
    </ScrollView>
  )
}

/**
 * Transient reaction avatar — avatar + emoji overlay, no "watching" label.
 * Uses Tamagui AnimatePresence for enter/exit.
 */
function TransientReactionAvatar({
  reaction,
  marginBottom,
  onExpired,
}: {
  reaction: ActiveReaction
  marginBottom: number
  onExpired?: (id: string) => void
}) {
  return (
    <YStack
      animation="quick"
      enterStyle={{ opacity: 0, scale: 0.8 }}
      exitStyle={{ opacity: 0, scale: 0.8 }}
      alignItems="center"
      gap={2}
      marginBottom={marginBottom}
    >
      <YStack position="relative" alignItems="center" justifyContent="center">
        <Avatar size={AVATAR_SIZE} borderRadius={AVATAR_RADIUS}>
          {reaction.userPhotoUrl ? <Avatar.Image source={{ uri: reaction.userPhotoUrl }} /> : null}
          <Avatar.Fallback backgroundColor={VIDEO_OVERLAY_COLORS.pillBackground}>
            <Flame size={18} color={VIDEO_OVERLAY_COLORS.textPrimary} />
          </Avatar.Fallback>
        </Avatar>
        <AnimatedEmoji reactionId={reaction.id} emoji={reaction.emoji} onExpired={onExpired} />
      </YStack>
    </YStack>
  )
}

/**
 * Animated emoji overlay — scales from 0.5 to 1.5 via RN Animated.timing.
 * After TOTAL_DURATION, calls onExpired to remove from active list.
 * Used on both live viewer avatars (when they react) and transient avatars.
 */
function AnimatedEmoji({
  reactionId,
  emoji,
  onExpired,
}: {
  reactionId: string
  emoji: string
  onExpired?: (id: string) => void
}) {
  const scaleRef = useRef(new Animated.Value(0.5)).current
  const onExpiredRef = useRef(onExpired)
  onExpiredRef.current = onExpired

  useEffect(() => {
    Animated.timing(scaleRef, {
      toValue: 1.5,
      duration: EMOJI_SCALE_DURATION,
      useNativeDriver: true,
    }).start()

    const timer = setTimeout(() => {
      onExpiredRef.current?.(reactionId)
    }, TOTAL_DURATION)
    return () => {
      clearTimeout(timer)
      scaleRef.stopAnimation()
    }
  }, [reactionId, scaleRef])

  return (
    <Animated.View
      pointerEvents="none"
      style={{
        position: 'absolute',
        top: -10,
        alignItems: 'center',
        justifyContent: 'center',
        transform: [{ scale: scaleRef }],
      }}
    >
      <Text fontSize={16}>{emoji}</Text>
    </Animated.View>
  )
}

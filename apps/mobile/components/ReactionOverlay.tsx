import { Flame } from '@tamagui/lucide-icons'
import { useEffect, useRef } from 'react'
import { Animated } from 'react-native'
import { AnimatePresence, Avatar, Text, YStack } from 'tamagui'
import { VIDEO_OVERLAY_COLORS } from './videoOverlayColors'
import type { ActiveReaction } from './ViewerPresenceStack'

const AVATAR_SIZE = 36
const AVATAR_RADIUS = AVATAR_SIZE / 2
const EMOJI_SCALE_DURATION = 800
const TOTAL_DURATION = 1500

interface ReactionOverlayProps {
  reaction: ActiveReaction
  onExpired: (id: string) => void
}

/**
 * Renders a single transient reaction animation:
 * - Avatar enters via Tamagui AnimatePresence (fade + scale)
 * - Emoji scales from 0.5 to 1.5 via RN Animated.timing over 800ms
 * - After ~1.5s total, the avatar + emoji exit via Tamagui AnimatePresence
 * - Then onExpired is called to remove from the active list
 */
export function ReactionOverlay({ reaction, onExpired }: ReactionOverlayProps) {
  const emojiScale = useRef(new Animated.Value(0.5)).current

  useEffect(() => {
    // Grow emoji from 0.5 to 1.5 over 800ms
    Animated.timing(emojiScale, {
      toValue: 1.5,
      duration: EMOJI_SCALE_DURATION,
      useNativeDriver: true,
    }).start()

    // After total duration, notify parent to remove this reaction
    const timer = setTimeout(() => {
      onExpired(reaction.id)
    }, TOTAL_DURATION)

    return () => {
      clearTimeout(timer)
      emojiScale.stopAnimation()
    }
  }, [emojiScale, reaction.id, onExpired])

  return (
    <YStack
      animation="quick"
      enterStyle={{ opacity: 0, scale: 0.8 }}
      exitStyle={{ opacity: 0, scale: 0.8 }}
      alignItems="center"
      gap={2}
    >
      <YStack position="relative" alignItems="center" justifyContent="center">
        <Avatar size={AVATAR_SIZE} borderRadius={AVATAR_RADIUS}>
          {reaction.userPhotoUrl ? (
            <Avatar.Image source={{ uri: reaction.userPhotoUrl }} />
          ) : null}
          <Avatar.Fallback backgroundColor={VIDEO_OVERLAY_COLORS.pillBackground}>
            <Flame size={18} color={VIDEO_OVERLAY_COLORS.textPrimary} />
          </Avatar.Fallback>
        </Avatar>
        {/* Emoji overlay — scales up from avatar center */}
        <Animated.View
          pointerEvents="none"
          style={{
            position: 'absolute',
            top: -10,
            transform: [{ scale: emojiScale }],
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Text fontSize={16}>{reaction.emoji}</Text>
        </Animated.View>
      </YStack>
    </YStack>
  )
}
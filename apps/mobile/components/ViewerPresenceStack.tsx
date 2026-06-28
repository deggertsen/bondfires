import { Flame } from '@tamagui/lucide-icons'
import { ScrollView, type ViewStyle } from 'react-native'
import { AnimatePresence, Avatar, Text, XStack, YStack } from 'tamagui'
import type { Viewer } from '@bondfires/app'
import { VIDEO_OVERLAY_COLORS } from './videoOverlayColors'

// PR 3 will add the transient reaction layer; this type is forward-compatible.
export interface ActiveReaction {
  id: string
  userId: string
  userName: string
  userPhotoUrl?: string
  emoji: string
  timestampMs: number
}

export interface ViewerPresenceStackProps {
  liveViewers: Viewer[]
  activeReactions?: ActiveReaction[]
  style?: ViewStyle
}

const AVATAR_SIZE = 36
const AVATAR_RADIUS = AVATAR_SIZE / 2
const MAX_VISIBLE = 5

/**
 * Unified avatar stack for the video player's left side.
 *
 * In PR 2, only the persistent/live viewer layer is active.
 * PR 3 will add the transient reaction layer (activeReactions).
 *
 * Rendering rules:
 * - Empty state is invisible (no UI shown when no viewers and no reactions)
 * - Avatars render vertically, top to bottom
 * - Adaptive spacing based on count
 * - Caps visible avatars at 5; scrollable beyond that
 * - Enter/exit via Tamagui AnimatePresence with "lazy" animation
 */
export function ViewerPresenceStack({
  liveViewers,
  activeReactions,
  style,
}: ViewerPresenceStackProps) {
  const hasReactions = activeReactions && activeReactions.length > 0
  const totalCount = liveViewers.length + (hasReactions ? activeReactions!.length : 0)

  // Empty state is invisible
  if (totalCount === 0) {
    return null
  }

  // Adaptive spacing
  const gap = totalCount <= 2 ? 12 : totalCount <= 4 ? 6 : 0
  const overlapMargin = totalCount >= 5 ? -4 : 0

  return (
    <ScrollView
      style={[
        {
          position: 'absolute',
          zIndex: 4,
          pointerEvents: 'box-none',
        },
        style,
      ]}
      showsVerticalScrollIndicator={false}
      contentContainerStyle={{ gap }}
    >
      <AnimatePresence>
        {liveViewers.slice(0, MAX_VISIBLE).map((viewer) => (
          <YStack
            key={`live-${viewer._id}`}
            animation="lazy"
            enterStyle={{ opacity: 0, scale: 0.8 }}
            exitStyle={{ opacity: 0, scale: 0.8 }}
            alignItems="center"
            gap={2}
            marginBottom={overlapMargin}
          >
            <Avatar size={AVATAR_SIZE} borderRadius={AVATAR_RADIUS}>
              {viewer.userPhotoUrl ? (
                <Avatar.Image source={{ uri: viewer.userPhotoUrl }} />
              ) : null}
              <Avatar.Fallback backgroundColor="$primary">
                <Flame size={18} color="$color" />
              </Avatar.Fallback>
            </Avatar>
            <Text fontSize={9} color={VIDEO_OVERLAY_COLORS.textPrimary} fontWeight="500">
              watching
            </Text>
          </YStack>
        ))}
      </AnimatePresence>

      {/* PR 3 will render activeReactions here with emoji overlay */}
      {hasReactions ? null : null}
    </ScrollView>
  )
}
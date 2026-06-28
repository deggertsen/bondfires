import type { Viewer } from '@bondfires/app'
import { Flame } from '@tamagui/lucide-icons'
import { ScrollView, type StyleProp, type ViewStyle } from 'react-native'
import { AnimatePresence, Avatar, Text, YStack } from 'tamagui'
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
  style?: StyleProp<ViewStyle>
}

const AVATAR_SIZE = 36
const AVATAR_RADIUS = AVATAR_SIZE / 2
const AVATAR_LABEL_HEIGHT = 12
const AVATAR_CONTENT_GAP = 2
const MAX_VISIBLE = 5

/**
 * Unified avatar stack for the video player's left side.
 *
 * In PR 2, only the persistent/live viewer layer is active.
 * PR 3 will add the transient reaction layer (activeReactions).
 *
 * Rendering rules:
 * - Empty state is invisible
 * - Avatars render vertically, top to bottom
 * - Adaptive spacing based on count
 * - Caps visible avatars at 5; scrollable beyond that
 * - Enter/exit via Tamagui AnimatePresence with "lazy" animation
 */
export function ViewerPresenceStack({ liveViewers, style }: ViewerPresenceStackProps) {
  if (liveViewers.length === 0) {
    return null
  }

  const gap = liveViewers.length <= 2 ? 12 : liveViewers.length <= 4 ? 6 : 0
  const overlapMargin = liveViewers.length >= 5 ? -4 : 0
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
        {liveViewers.map((viewer) => (
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
              {viewer.userPhotoUrl ? <Avatar.Image source={{ uri: viewer.userPhotoUrl }} /> : null}
              <Avatar.Fallback backgroundColor={VIDEO_OVERLAY_COLORS.pillBackground}>
                <Flame size={18} color={VIDEO_OVERLAY_COLORS.textPrimary} />
              </Avatar.Fallback>
            </Avatar>
            <Text fontSize={9} color={VIDEO_OVERLAY_COLORS.textPrimary} fontWeight="500">
              watching
            </Text>
          </YStack>
        ))}
      </AnimatePresence>
    </ScrollView>
  )
}

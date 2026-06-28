import { Smile } from '@tamagui/lucide-icons'
import { Pressable } from 'react-native'
import { YStack } from 'tamagui'
import { VIDEO_OVERLAY_COLORS } from './videoOverlayColors'

interface EmojiReactionButtonProps {
  onPress: () => void
}

export function EmojiReactionButton({ onPress }: EmojiReactionButtonProps) {
  return (
    <Pressable onPress={onPress}>
      <YStack
        width={44}
        height={44}
        borderRadius={22}
        backgroundColor={VIDEO_OVERLAY_COLORS.pillBackground}
        alignItems="center"
        justifyContent="center"
      >
        <Smile size={22} color={VIDEO_OVERLAY_COLORS.textPrimary} />
      </YStack>
    </Pressable>
  )
}
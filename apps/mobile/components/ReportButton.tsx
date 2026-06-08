import { Flag } from '@tamagui/lucide-icons'
import { Pressable, type StyleProp, type ViewStyle } from 'react-native'
import { YStack } from 'tamagui'
import { VIDEO_OVERLAY_COLORS } from './videoOverlayColors'

interface ReportButtonProps {
  onPress: () => void
  style?: StyleProp<ViewStyle>
}

export function ReportButton({ onPress, style }: ReportButtonProps) {
  return (
    <Pressable onPress={onPress} style={style}>
      <YStack
        width={44}
        height={44}
        borderRadius={22}
        backgroundColor={VIDEO_OVERLAY_COLORS.pillBackground}
        alignItems="center"
        justifyContent="center"
      >
        <Flag size={22} color={VIDEO_OVERLAY_COLORS.textPrimary} />
      </YStack>
    </Pressable>
  )
}

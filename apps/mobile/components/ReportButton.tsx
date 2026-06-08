import { Flag } from '@tamagui/lucide-icons'
import { Pressable, type StyleProp, type ViewStyle } from 'react-native'
import { YStack } from 'tamagui'

// Theme-independent overlay colors — same as the watch screen overlays
const FLAG_BG = 'rgba(31, 32, 35, 0.8)'
const FLAG_ICON = '#F3F4F6'

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
        backgroundColor={FLAG_BG}
        alignItems="center"
        justifyContent="center"
      >
        <Flag size={22} color={FLAG_ICON} />
      </YStack>
    </Pressable>
  )
}

import { bondfireColors } from '@bondfires/config'
import { Flag } from '@tamagui/lucide-icons'
import { Pressable, type StyleProp, type ViewStyle } from 'react-native'
import { YStack } from 'tamagui'

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
        backgroundColor="rgba(31, 32, 35, 0.8)"
        alignItems="center"
        justifyContent="center"
      >
        <Flag size={22} color={bondfireColors.whiteSmoke} />
      </YStack>
    </Pressable>
  )
}

import { bondfireColors } from '@bondfires/config'
import { Text, YStack } from 'tamagui'

type StatCardProps = {
  label: string
  value: number | string
  accentColor?: string
}

export function StatCard({ label, value, accentColor }: StatCardProps) {
  return (
    <YStack
      flex={1}
      backgroundColor={bondfireColors.gunmetal}
      borderRadius={14}
      borderWidth={1}
      borderColor={bondfireColors.iron}
      padding={16}
      minHeight={112}
      alignItems="center"
      justifyContent="center"
      gap={6}
    >
      <Text
        width="100%"
        fontSize={32}
        fontWeight="900"
        color={accentColor ?? bondfireColors.whiteSmoke}
        textAlign="center"
        numberOfLines={1}
        adjustsFontSizeToFit
        minimumFontScale={0.7}
      >
        {value}
      </Text>
      <Text
        width="100%"
        fontSize={12}
        color={bondfireColors.ash}
        fontWeight="700"
        textAlign="center"
        numberOfLines={2}
      >
        {label}
      </Text>
    </YStack>
  )
}

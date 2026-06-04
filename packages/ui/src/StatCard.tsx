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
      alignItems="center"
      gap={6}
    >
      <Text fontSize={32} fontWeight="900" color={accentColor ?? bondfireColors.whiteSmoke}>
        {value}
      </Text>
      <Text fontSize={12} color={bondfireColors.ash} fontWeight="700" textAlign="center">
        {label}
      </Text>
    </YStack>
  )
}

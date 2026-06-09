import { YStack } from 'tamagui'
import { Text } from './Text'

interface StatCardProps {
  value: number | string
  label: string
  color?: string
}

export function StatCard({ value, label, color }: StatCardProps) {
  return (
    <YStack
      flex={1}
      padding={14}
      borderRadius={14}
      backgroundColor={'$backgroundHover'}
      borderWidth={1}
      borderColor={'$borderColor'}
      alignItems="center"
      gap={4}
    >
      <Text fontSize={28} fontWeight="900" color={color ?? '$gray12'}>
        {typeof value === 'number' ? value.toLocaleString() : value}
      </Text>
      <Text fontSize={12} color={'$placeholderColor'} textAlign="center">
        {label}
      </Text>
    </YStack>
  )
}

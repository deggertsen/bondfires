import { useAppThemeColors } from '@bondfires/app'
import { Text } from '@bondfires/ui'
import { Globe, Lock, Tent, Users, X } from '@tamagui/lucide-icons'
import { Pressable } from 'react-native'
import { XStack, YStack } from 'tamagui'
import type { SparkMode } from './sparkComposer'

/** Shared header for both halves of the Spark composer. */
export function SparkComposerHeader({
  topInset,
  onClose,
}: {
  topInset: number
  onClose: () => void
}) {
  const { colors } = useAppThemeColors()
  return (
    <XStack
      alignItems="center"
      justifyContent="space-between"
      paddingHorizontal={16}
      paddingTop={topInset + 8}
      paddingBottom={12}
    >
      <Text fontSize={20} fontWeight="800" color={'$color'}>
        New Bondfire
      </Text>
      <Pressable
        onPress={onClose}
        hitSlop={12}
        accessibilityLabel="Close new Bondfire"
        accessibilityRole="button"
      >
        <X size={24} color={colors.color} />
      </Pressable>
    </XStack>
  )
}

const MODE_OPTIONS = [
  {
    mode: 'people',
    label: 'People',
    Icon: Users,
    CaptionIcon: Lock,
    caption: 'Private. Only the people you pick can see it.',
  },
  {
    mode: 'camp',
    label: 'Camp',
    Icon: Tent,
    CaptionIcon: Globe,
    caption: 'Everyone in the camp can see and answer it.',
  },
] as const

/**
 * People | Camp segmented control plus a one-line caption saying who will
 * see the fire, so the privacy difference is visible before recording.
 */
export function SparkModeToggle({
  mode,
  onChange,
}: {
  mode: SparkMode
  onChange: (mode: SparkMode) => void
}) {
  const active = MODE_OPTIONS.find((option) => option.mode === mode) ?? MODE_OPTIONS[0]
  return (
    <YStack paddingHorizontal={16} gap={10} marginBottom={20}>
      <XStack
        role="tablist"
        padding={4}
        gap={4}
        borderRadius={14}
        borderWidth={1}
        borderColor={'$borderColor'}
        backgroundColor={'$backgroundHover'}
      >
        {MODE_OPTIONS.map((option) => {
          const selected = option.mode === mode
          return (
            <Pressable
              key={option.mode}
              style={{ flex: 1 }}
              onPress={() => onChange(option.mode)}
              accessibilityRole="tab"
              accessibilityState={{ selected }}
              accessibilityLabel={`Spark with ${option.label.toLowerCase()}`}
            >
              <XStack
                height={40}
                borderRadius={10}
                alignItems="center"
                justifyContent="center"
                gap={8}
                backgroundColor={selected ? '$primary' : 'transparent'}
              >
                <option.Icon size={17} color={selected ? '$color' : '$placeholderColor'} />
                <Text
                  fontSize={15}
                  fontWeight={selected ? '800' : '700'}
                  color={selected ? '$color' : '$placeholderColor'}
                >
                  {option.label}
                </Text>
              </XStack>
            </Pressable>
          )
        })}
      </XStack>
      <XStack alignItems="center" gap={6} paddingHorizontal={4}>
        <active.CaptionIcon size={13} color={'$placeholderColor'} />
        <Text fontSize={12} color={'$placeholderColor'}>
          {active.caption}
        </Text>
      </XStack>
    </YStack>
  )
}

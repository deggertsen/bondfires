import { Pressable } from 'react-native'
import { XStack, YStack } from 'tamagui'

// Approved accent palette from campBranding.ts
const ACCENT_PALETTE = [
  '#FF6B35',
  '#E63946',
  '#F4A261',
  '#2A9D8F',
  '#264653',
  '#6C63FF',
  '#E9C46A',
  '#457B9D',
  '#1D3557',
  '#A8DADC',
] as const

interface ColorPickerProps {
  value: string
  onChange: (color: string) => void
  disabled?: boolean
}

function ColorCircle({
  color,
  selected,
  onSelect,
  disabled,
}: {
  color: string
  selected: boolean
  onSelect: () => void
  disabled?: boolean
}) {
  return (
    <Pressable onPress={onSelect} disabled={disabled} accessibilityRole="button">
      <YStack
        width={40}
        height={40}
        borderRadius={20}
        backgroundColor={color}
        borderWidth={selected ? 3 : 2}
        borderColor={selected ? '$gray12' : '$borderColor'}
        alignItems="center"
        justifyContent="center"
        opacity={disabled ? 0.55 : 1}
      >
        {selected ? (
          <YStack width={8} height={8} borderRadius={4} backgroundColor={'$gray12'} />
        ) : null}
      </YStack>
    </Pressable>
  )
}

export function ColorPicker({ value, onChange, disabled = false }: ColorPickerProps) {
  return (
    <XStack flexWrap="wrap" gap={10}>
      {ACCENT_PALETTE.map((color) => (
        <ColorCircle
          key={color}
          color={color}
          selected={value === color}
          onSelect={() => onChange(color)}
          disabled={disabled}
        />
      ))}
    </XStack>
  )
}

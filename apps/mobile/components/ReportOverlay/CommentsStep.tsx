import { useAppThemeColors } from '@bondfires/app'
import { Button, Text } from '@bondfires/ui'
import { ArrowLeft } from '@tamagui/lucide-icons'
import { useEffect, useRef } from 'react'
import { Pressable, StyleSheet, TextInput } from 'react-native'
import { XStack, YStack } from 'tamagui'
import { type CommentsStepProps, MIN_COMMENT_LENGTH } from './types'

export function CommentsStep({ value, onChange, onNext, onBack }: CommentsStepProps) {
  const { colors } = useAppThemeColors()
  const textInputRef = useRef<TextInput>(null)
  const charCount = value.trim().length
  const isValid = charCount >= MIN_COMMENT_LENGTH

  // Auto-focus with delay to ensure rendering
  useEffect(() => {
    const timer = setTimeout(() => textInputRef.current?.focus(), 100)
    return () => clearTimeout(timer)
  }, [])

  return (
    <YStack gap={16}>
      <XStack alignItems="center" gap={8}>
        <Pressable onPress={onBack}>
          <ArrowLeft size={24} color={'$color'} />
        </Pressable>
        <Text fontSize={18} fontWeight="600" color={'$color'}>
          Describe the Issue
        </Text>
      </XStack>
      <Text fontSize={14} color={'$placeholderColor'}>
        Please provide details about what you observed. This helps us review your report more
        effectively.
      </Text>
      <YStack>
        <TextInput
          ref={textInputRef}
          style={[
            styles.textInput,
            {
              backgroundColor: colors.backgroundHover,
              color: colors.color,
            },
          ]}
          placeholder="Describe the issue in detail..."
          placeholderTextColor={colors.placeholderColor}
          multiline
          value={value}
          onChangeText={onChange}
          textAlignVertical="top"
        />
        <XStack justifyContent="space-between" marginTop={8}>
          <Text fontSize={12} color={isValid ? '$placeholderColor' : '$error'}>
            {isValid
              ? 'Thank you for the details'
              : `Minimum ${MIN_COMMENT_LENGTH} characters required`}
          </Text>
          <Text fontSize={12} color={isValid ? '$placeholderColor' : '$error'}>
            {charCount}/{MIN_COMMENT_LENGTH}
          </Text>
        </XStack>
      </YStack>
      <Button
        variant="primary"
        size="$lg"
        onPress={onNext}
        disabled={!isValid}
        opacity={isValid ? 1 : 0.5}
      >
        <Text color={'$color'} fontWeight="600">
          Continue
        </Text>
      </Button>
    </YStack>
  )
}

const styles = StyleSheet.create({
  textInput: {
    borderRadius: 12,
    padding: 16,
    minHeight: 120,
    fontSize: 16,
  },
})

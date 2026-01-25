import { bondfireColors } from '@bondfires/config'
import { Button, Text } from '@bondfires/ui'
import { ArrowLeft } from '@tamagui/lucide-icons'
import { useRef, useEffect } from 'react'
import { Pressable, TextInput, StyleSheet } from 'react-native'
import { XStack, YStack } from 'tamagui'
import { MIN_COMMENT_LENGTH, type CommentsStepProps } from './types'

export function CommentsStep({
  value,
  onChange,
  onNext,
  onBack,
}: CommentsStepProps) {
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
          <ArrowLeft size={24} color={bondfireColors.whiteSmoke} />
        </Pressable>
        <Text fontSize={18} fontWeight="600" color={bondfireColors.whiteSmoke}>
          Describe the Issue
        </Text>
      </XStack>
      <Text fontSize={14} color={bondfireColors.ash}>
        Please provide details about what you observed. This helps us review
        your report more effectively.
      </Text>
      <YStack>
        <TextInput
          ref={textInputRef}
          style={styles.textInput}
          placeholder="Describe the issue in detail..."
          placeholderTextColor={bondfireColors.ash}
          multiline
          value={value}
          onChangeText={onChange}
          textAlignVertical="top"
        />
        <XStack justifyContent="space-between" marginTop={8}>
          <Text
            fontSize={12}
            color={isValid ? bondfireColors.ash : bondfireColors.error}
          >
            {isValid
              ? 'Thank you for the details'
              : `Minimum ${MIN_COMMENT_LENGTH} characters required`}
          </Text>
          <Text
            fontSize={12}
            color={isValid ? bondfireColors.ash : bondfireColors.error}
          >
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
        <Text color={bondfireColors.whiteSmoke} fontWeight="600">
          Continue
        </Text>
      </Button>
    </YStack>
  )
}

const styles = StyleSheet.create({
  textInput: {
    backgroundColor: bondfireColors.gunmetal,
    borderRadius: 12,
    padding: 16,
    minHeight: 120,
    color: bondfireColors.whiteSmoke,
    fontSize: 16,
  },
})

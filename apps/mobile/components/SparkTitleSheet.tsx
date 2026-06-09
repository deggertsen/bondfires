import { useAppThemeColors } from '@bondfires/app'
import { Button, Text } from '@bondfires/ui'
import { Flame, X } from '@tamagui/lucide-icons'
import { useQuery } from 'convex/react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Pressable, TextInput } from 'react-native'
import { Sheet, XStack, YStack } from 'tamagui'
import { api } from '../../../convex/_generated/api'

interface Props {
  open: boolean
  campName?: string
  onSubmit: (title: string) => void
  onCancel: () => void
}

const MAX_TITLE_LENGTH = 80

/** Truncate a string to its first two words. */
function truncateToTwoWords(name: string): string {
  const words = name.trim().split(/\s+/)
  return words.slice(0, 2).join(' ')
}

export function SparkTitleSheet({ open, campName, onSubmit, onCancel }: Props) {
  const { colors } = useAppThemeColors()
  const currentUser = useQuery(api.users.current)
  const inputRef = useRef<TextInput>(null)
  const [title, setTitle] = useState('')

  const defaultTitle = useMemo(() => {
    const firstName =
      currentUser?.displayName?.split(' ')[0] ?? currentUser?.name?.split(' ')[0] ?? ''
    const campTwoWords = campName ? truncateToTwoWords(campName) : ''
    if (firstName && campTwoWords) return `${firstName} - ${campTwoWords}`
    if (firstName) return firstName
    return ''
  }, [campName, currentUser?.displayName, currentUser?.name])

  useEffect(() => {
    if (open) {
      setTitle(defaultTitle)
      setTimeout(() => {
        inputRef.current?.focus()
      }, 300)
    }
  }, [open, defaultTitle])

  const handleSubmit = useCallback(() => {
    onSubmit((title.trim() || defaultTitle).slice(0, MAX_TITLE_LENGTH))
  }, [title, defaultTitle, onSubmit])

  return (
    <Sheet
      open={open}
      onOpenChange={(isOpen: boolean) => {
        if (!isOpen) onCancel()
      }}
      snapPoints={[42]}
      dismissOnSnapToBottom
    >
      <Sheet.Overlay backgroundColor="rgba(0,0,0,0.45)" />
      <Sheet.Frame
        backgroundColor={'$backgroundPress'}
        borderTopLeftRadius={20}
        borderTopRightRadius={20}
        padding={24}
      >
        <YStack gap={20}>
          <Sheet.Handle backgroundColor={'$borderColor'} />

          {/* Header */}
          <XStack justifyContent="space-between" alignItems="center">
            <XStack alignItems="center" gap={8}>
              <Flame size={22} color={'$primary'} />
              <Text fontSize={20} fontWeight="900">
                Spark a Bondfire
              </Text>
            </XStack>
            <Pressable onPress={onCancel}>
              <YStack
                width={32}
                height={32}
                borderRadius={16}
                backgroundColor={'$backgroundHover'}
                alignItems="center"
                justifyContent="center"
              >
                <X size={18} color={'$placeholderColor'} />
              </YStack>
            </Pressable>
          </XStack>

          {campName ? (
            <Text fontSize={13} color={'$placeholderColor'}>
              {campName}
            </Text>
          ) : null}

          {/* Title Input */}
          <YStack gap={8}>
            <Text fontSize={13} fontWeight="600" color={'$placeholderColor'}>
              Title (optional)
            </Text>
            <TextInput
              ref={inputRef}
              value={title}
              onChangeText={setTitle}
              placeholder={defaultTitle || 'Give your Bondfire a title...'}
              placeholderTextColor={colors.placeholderColor}
              style={{
                backgroundColor: colors.backgroundHover,
                color: colors.color,
                fontSize: 16,
                fontWeight: '600',
                paddingHorizontal: 16,
                paddingVertical: 14,
                borderRadius: 12,
                borderWidth: 1,
                borderColor: colors.borderColor,
              }}
              maxLength={MAX_TITLE_LENGTH}
              returnKeyType="done"
              onSubmitEditing={handleSubmit}
              autoFocus
            />
          </YStack>

          {/* Start Button */}
          <Button variant="primary" size="$lg" onPress={handleSubmit}>
            <Flame size={18} color={'$color'} />
            <Text color={'$color'} fontWeight="700">
              Start
            </Text>
          </Button>
        </YStack>
      </Sheet.Frame>
    </Sheet>
  )
}

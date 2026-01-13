import { notepadActions, notepadStore$ } from '@bondfires/app'
import { bondfireColors } from '@bondfires/config'
import { Button, Text, XStack, YStack } from '@bondfires/ui'
import { useValue } from '@legendapp/state/react'
import { Trash2 } from '@tamagui/lucide-icons'
import { useEffect, useRef } from 'react'
import { Pressable, StyleSheet, TextInput } from 'react-native'

interface NotepadOverlayProps {
  onClose: () => void
}

export function NotepadOverlay({ onClose }: NotepadOverlayProps) {
  const content = useValue(notepadStore$.content)
  const textInputRef = useRef<TextInput>(null)

  // Auto-focus on mount
  useEffect(() => {
    // Small delay to ensure overlay is rendered
    const timer = setTimeout(() => {
      textInputRef.current?.focus()
    }, 100)
    return () => clearTimeout(timer)
  }, [])

  // Legend State auto-persists, no debounce needed
  const handleTextChange = (text: string) => {
    notepadActions.setContent(text)
  }

  const handleClear = () => {
    notepadActions.clearContent()
    textInputRef.current?.focus()
  }

  return (
    <Pressable style={StyleSheet.absoluteFill} onPress={onClose}>
      <YStack
        flex={1}
        backgroundColor="rgba(20, 20, 22, 0.6)"
        padding={24}
        onPress={(e) => e.stopPropagation()}
      >
        <TextInput
          ref={textInputRef}
          style={{
            flex: 1,
            color: bondfireColors.whiteSmoke,
            fontSize: 16,
            textAlignVertical: 'top',
          }}
          placeholder="Type your notes here..."
          placeholderTextColor={bondfireColors.ash}
          multiline
          value={content}
          onChangeText={handleTextChange}
          autoFocus
        />

        {/* Clear button */}
        <XStack position="absolute" bottom={24} left={24}>
          <Button variant="ghost" size="$sm" onPress={handleClear} icon={Trash2}>
            <Text color={bondfireColors.whiteSmoke}>Clear Notepad</Text>
          </Button>
        </XStack>
      </YStack>
    </Pressable>
  )
}

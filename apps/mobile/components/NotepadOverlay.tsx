import { notepadActions, notepadStore$ } from '@bondfires/app'
import { bondfireColors } from '@bondfires/config'
import { Button, Text, XStack, YStack } from '@bondfires/ui'
import { useValue } from '@legendapp/state/react'
import { Trash2 } from '@tamagui/lucide-icons'
import { useEffect, useRef } from 'react'
import { KeyboardAvoidingView, Platform, Pressable, StyleSheet, TextInput } from 'react-native'

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
      <KeyboardAvoidingView
        style={styles.container}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        keyboardVerticalOffset={0}
      >
        <YStack
          flex={1}
          backgroundColor="rgba(20, 20, 22, 0.6)"
          paddingHorizontal={12}
          marginTop={100}
          paddingBottom={12}
          onPress={(e) => e.stopPropagation()}
        >
          <TextInput
            ref={textInputRef}
            style={styles.textInput}
            placeholder="Type your notes here..."
            placeholderTextColor={bondfireColors.ash}
            multiline
            value={content}
            onChangeText={handleTextChange}
            autoFocus
          />

          {/* Clear button */}
          <XStack paddingTop={16}>
            <Button variant="secondary" size="$sm" onPress={handleClear} icon={Trash2}>
              <Text color={bondfireColors.whiteSmoke}>Clear Notepad</Text>
            </Button>
          </XStack>
        </YStack>
      </KeyboardAvoidingView>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  textInput: {
    flex: 1,
    color: bondfireColors.whiteSmoke,
    fontSize: 16,
    textAlignVertical: 'top',
  },
})

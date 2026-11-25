import { notepadActions, notepadStore$, useAppThemeColors } from '@bondfires/app'
import { Button, Text, XStack, YStack } from '@bondfires/ui'
import { Trash2 } from '@bondfires/ui/icons'
import { useValue } from '@legendapp/state/react'
import { useEffect, useRef } from 'react'
import { Pressable, StyleSheet, TextInput, type TextInputInstance } from 'react-native'
import { KeyboardAvoidingView } from 'react-native-keyboard-controller'
import { VIDEO_OVERLAY_COLORS } from './videoOverlayColors'

interface NotepadOverlayProps {
  onClose: () => void
  autoFocus?: boolean
  /** Screen-top clearance so the sheet stays below header controls. */
  topOffset?: number
}

export function NotepadOverlay({
  onClose,
  autoFocus = true,
  topOffset = 100,
}: NotepadOverlayProps) {
  const { colors, themeName } = useAppThemeColors()
  const content = useValue(notepadStore$.content)
  const textInputRef = useRef<TextInputInstance>(null)

  const overlayBg =
    themeName === 'dark' ? VIDEO_OVERLAY_COLORS.playPauseBackground : 'rgba(250, 250, 250, 0.85)'

  // Auto-focus on mount
  useEffect(() => {
    if (!autoFocus) return

    // Small delay to ensure overlay is rendered
    const timer = setTimeout(() => {
      textInputRef.current?.focus()
    }, 100)
    return () => clearTimeout(timer)
  }, [autoFocus])

  // Legend State auto-persists, no debounce needed
  const handleTextChange = (text: string) => {
    notepadActions.setContent(text)
  }

  const handleClear = () => {
    notepadActions.clearContent()
    textInputRef.current?.focus()
  }

  return (
    <KeyboardAvoidingView
      pointerEvents="box-none"
      style={[StyleSheet.absoluteFill, { paddingTop: topOffset }]}
      behavior="padding"
      keyboardVerticalOffset={0}
    >
      <Pressable style={styles.container} onPress={onClose}>
        <YStack
          flex={1}
          backgroundColor={overlayBg}
          paddingHorizontal={12}
          paddingBottom={12}
          onPress={(e) => e.stopPropagation()}
        >
          <TextInput
            ref={textInputRef}
            style={[styles.textInput, { color: colors.color }]}
            placeholder="Type your notes here..."
            placeholderTextColor={colors.placeholderColor}
            multiline
            value={content}
            onChangeText={handleTextChange}
            autoFocus={autoFocus}
          />

          {/* Clear button */}
          <XStack paddingTop={16}>
            <Button variant="secondary" size="sm" onPress={handleClear} icon={Trash2}>
              <Text color={'color'}>Clear Notepad</Text>
            </Button>
          </XStack>
        </YStack>
      </Pressable>
    </KeyboardAvoidingView>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  textInput: {
    flex: 1,
    fontSize: 16,
    textAlignVertical: 'top',
  },
})

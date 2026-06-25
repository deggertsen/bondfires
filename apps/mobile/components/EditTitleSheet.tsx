import { getErrorMessage, telemetry, useAppThemeColors } from '@bondfires/app'
import { Button, Text } from '@bondfires/ui'
import { useMutation } from 'convex/react'
import { useCallback, useEffect, useState } from 'react'
import { Alert, StatusBar, TextInput } from 'react-native'
import { Sheet, XStack, YStack } from 'tamagui'
import { api } from '../../../convex/_generated/api'
import type { Id } from '../../../convex/_generated/dataModel'

const MAX_TITLE_LENGTH = 80

export type EditableBondfireTitle = {
  id: Id<'bondfires'>
  title: string
  creatorName?: string
}

interface EditTitleSheetProps {
  bondfireId: Id<'bondfires'>
  currentTitle: string
  creatorName?: string
  open: boolean
  onClose: () => void
}

/**
 * Bottom sheet for editing a bondfire's title.
 * Calls the existing `api.bondfires.updateTitle` mutation (owner-only).
 * Pre-fills with the current title, enforces 80-char limit, and falls
 * back to a sensible default if the user clears the field.
 */
export function EditTitleSheet({
  bondfireId,
  currentTitle,
  creatorName,
  open,
  onClose,
}: EditTitleSheetProps) {
  const { colors, statusBarStyle } = useAppThemeColors()
  const updateTitle = useMutation(api.bondfires.updateTitle)
  const [editedTitle, setEditedTitle] = useState(currentTitle)
  const [isSaving, setIsSaving] = useState(false)

  // Sync the input when the sheet opens or the bondfire changes
  useEffect(() => {
    if (open) {
      setEditedTitle(currentTitle)
    }
  }, [open, currentTitle])

  const handleSave = async () => {
    if (isSaving) return

    const trimmed = editedTitle.trim().slice(0, MAX_TITLE_LENGTH)
    // The mutation already handles empty fallback, but we can skip
    // the round-trip if nothing changed.
    if (trimmed === currentTitle) {
      onClose()
      return
    }

    setIsSaving(true)
    try {
      await updateTitle({ bondfireId, title: trimmed })
      onClose()
    } catch (error) {
      telemetry.error('editTitle:save', 'Failed to update bondfire title', {
        bondfireId,
        error: String(error),
      })
      Alert.alert('Could not update title', getErrorMessage(error))
    } finally {
      setIsSaving(false)
    }
  }

  const handleCancel = () => {
    setEditedTitle(currentTitle)
    onClose()
  }

  return (
    <Sheet
      modal
      open={open}
      onOpenChange={(isOpen: boolean) => {
        if (!isOpen && open) {
          handleCancel()
        }
      }}
      snapPointsMode="fit"
      dismissOnSnapToBottom
      moveOnKeyboardChange
    >
      <Sheet.Overlay
        animation="quick"
        enterStyle={{ opacity: 0 }}
        exitStyle={{ opacity: 0 }}
        backgroundColor="rgba(0,0,0,0.5)"
      />
      <Sheet.Frame
        backgroundColor={'$background'}
        borderTopLeftRadius={20}
        borderTopRightRadius={20}
        padding={24}
      >
          <StatusBar barStyle={statusBarStyle} />

          <Sheet.Handle backgroundColor={'$borderColor'} marginBottom={16} />

          <YStack gap={16}>
            <Text fontSize={20} fontWeight="900" textAlign="center">
              Edit Title
            </Text>

            <YStack gap={6}>
              <TextInput
                value={editedTitle}
                onChangeText={(text) => setEditedTitle(text)}
                placeholder={
                  creatorName ? `${creatorName}'s Bondfire` : 'Give your Bondfire a title...'
                }
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
                autoFocus={true}
                onSubmitEditing={() => {
                  void handleSave()
                }}
              />
              <XStack justifyContent="space-between" alignItems="center">
                <Text fontSize={11} color={'$placeholderColor'}>
                  {creatorName
                    ? `Empty resets to "${creatorName}'s Bondfire"`
                    : 'Empty resets to "My Bondfire"'}
                </Text>
                <Text fontSize={11} color={'$placeholderColor'}>
                  {editedTitle.length}/{MAX_TITLE_LENGTH}
                </Text>
              </XStack>
            </YStack>

            <XStack gap={12} marginTop={4}>
              <Button
                variant="outline"
                size="$lg"
                flex={1}
                onPress={handleCancel}
                disabled={isSaving}
              >
                <Text color={'$color'} fontWeight="700">
                  Cancel
                </Text>
              </Button>
              <Button
                variant="primary"
                size="$lg"
                flex={1}
                onPress={() => {
                  void handleSave()
                }}
                disabled={isSaving}
              >
                <Text color={'$color'} fontWeight="700">
                  {isSaving ? 'Saving...' : 'Save'}
                </Text>
              </Button>
            </XStack>
          </YStack>
      </Sheet.Frame>
    </Sheet>
  )
}

export function useEditTitleSheet() {
  const [editingBondfire, setEditingBondfire] = useState<EditableBondfireTitle | null>(null)

  const openEditTitleSheet = useCallback(
    (bondfireId: string, title: string, creatorName?: string) => {
      setEditingBondfire({
        id: bondfireId as Id<'bondfires'>,
        title,
        creatorName,
      })
    },
    [],
  )

  const closeEditTitleSheet = useCallback(() => {
    setEditingBondfire(null)
  }, [])

  return {
    editingBondfire,
    openEditTitleSheet,
    closeEditTitleSheet,
  }
}

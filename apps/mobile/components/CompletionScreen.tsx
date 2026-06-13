import {
  getRandomCompletionMessage,
  telemetry,
  useAppThemeColors,
  useDefaultBondfireTitle,
} from '@bondfires/app'
import { Button, Spinner, Text } from '@bondfires/ui'
import { Check, Share } from '@tamagui/lucide-icons'
import { useMutation } from 'convex/react'
import { useRouter } from 'expo-router'
import { useCallback, useRef, useState } from 'react'
import { KeyboardAvoidingView, Platform, StatusBar, TextInput } from 'react-native'
import { XStack, YStack } from 'tamagui'
import { api } from '../../../convex/_generated/api'
import type { Id } from '../../../convex/_generated/dataModel'
import { routes } from '../lib/routes'
import { InviteSheet } from './InviteSheet'
import { PushPrimerSheet } from './PushPrimerSheet'

const MAX_TITLE_LENGTH = 80

interface CompletionScreenProps {
  onContinue?: () => void
  detail?: string
  /**
   * The just-created bondfire, when the user owns it (live-publish camp and
   * personal flows). Enables the inline title field and the Invite button.
   * Absent for respond-to and legacy background uploads, where there is
   * nothing savable yet.
   */
  bondfireId?: Id<'bondfires'>
  /** Camp name used to build the pre-filled default title. */
  campName?: string
}

export function CompletionScreen({
  detail,
  onContinue,
  bondfireId,
  campName,
}: CompletionScreenProps) {
  const { colors, statusBarStyle } = useAppThemeColors()
  const router = useRouter()
  const [message] = useState(() => getRandomCompletionMessage())
  const [isInviteSheetOpen, setIsInviteSheetOpen] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  // null = untouched; render the (async-loading) default until the user types.
  const [editedTitle, setEditedTitle] = useState<string | null>(null)
  const defaultTitle = useDefaultBondfireTitle(campName)
  const title = editedTitle ?? defaultTitle

  const updateTitle = useMutation(api.bondfires.updateTitle)
  const savedTitleRef = useRef<string | null>(null)

  const handleContinue = useCallback(() => {
    if (onContinue) {
      onContinue()
    } else {
      router.replace(routes.feed)
    }
  }, [onContinue, router])

  /**
   * Best-effort, idempotent title save. Never blocks the user: errors are
   * logged to telemetry and the flow proceeds regardless.
   */
  const saveTitle = useCallback(async () => {
    if (!bondfireId) return
    const trimmed = title.trim().slice(0, MAX_TITLE_LENGTH)
    if (!trimmed || savedTitleRef.current === trimmed) return
    try {
      await updateTitle({ bondfireId, title: trimmed })
      savedTitleRef.current = trimmed
    } catch (error) {
      telemetry.error('create:title_save', 'Failed to save bondfire title', {
        error: String(error),
        bondfireId,
      })
    }
  }, [bondfireId, title, updateTitle])

  const handleDone = useCallback(async () => {
    if (isSaving) return
    setIsSaving(true)
    await saveTitle()
    setIsSaving(false)
    handleContinue()
  }, [handleContinue, isSaving, saveTitle])

  const handleInvite = useCallback(() => {
    // Fire-and-forget: don't gate the sheet on the network.
    saveTitle()
    setIsInviteSheetOpen(true)
  }, [saveTitle])

  const handleInviteSheetClose = useCallback(() => {
    // Dismissing the invite sheet is a natural "I'm finished here" signal —
    // close the completion screen and route per the normal continue flow.
    setIsInviteSheetOpen(false)
    handleContinue()
  }, [handleContinue])

  return (
    <>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <YStack
          flex={1}
          backgroundColor={'$background'}
          alignItems="center"
          justifyContent="center"
          padding={32}
        >
          <StatusBar barStyle={statusBarStyle} backgroundColor={colors.background} />

          {/* Large emoji */}
          <Text fontSize={120} marginBottom={32}>
            {message.emoji}
          </Text>

          {/* Congratulatory message */}
          <Text
            fontSize={24}
            fontWeight="700"
            color={'$color'}
            textAlign="center"
            marginBottom={detail ? 16 : 32}
          >
            {message.message}
          </Text>

          {detail && (
            <Text
              color={'$placeholderColor'}
              fontSize={15}
              lineHeight={22}
              textAlign="center"
              marginBottom={32}
            >
              {detail}
            </Text>
          )}

          {/* Inline title field — only when the user owns the new bondfire */}
          {bondfireId && (
            <YStack width="100%" gap={6} marginBottom={28}>
              <XStack alignItems="center" gap={10}>
                <TextInput
                  value={title}
                  onChangeText={(text) => setEditedTitle(text)}
                  placeholder="Give your Bondfire a title..."
                  placeholderTextColor={colors.placeholderColor}
                  style={{
                    flex: 1,
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
                  autoFocus={false}
                />
                {isSaving && <Spinner size="small" color={'$primary'} />}
              </XStack>
              <Text fontSize={11} color={'$placeholderColor'} alignSelf="flex-end">
                {title.length}/{MAX_TITLE_LENGTH}
              </Text>
            </YStack>
          )}

          {/* Buttons */}
          {bondfireId ? (
            <XStack gap={12}>
              <Button
                variant="outline"
                size="$lg"
                disabled={isSaving}
                onPress={handleDone}
                icon={<Check size={18} color={'$color'} />}
              >
                <Text color={'$color'} fontWeight="700">
                  Done
                </Text>
              </Button>
              <Button
                variant="primary"
                size="$lg"
                onPress={handleInvite}
                icon={<Share size={18} color={'$color'} />}
              >
                <Text color={'$color'} fontWeight="700">
                  Invite
                </Text>
              </Button>
            </XStack>
          ) : (
            <Button variant="primary" size="$lg" onPress={handleDone} icon={Check}>
              <Text color={'$color'}>Done</Text>
            </Button>
          )}
        </YStack>
      </KeyboardAvoidingView>

      {/* Invite Sheet — closing it also closes the completion screen */}
      {bondfireId && (
        <InviteSheet
          mode="bondfire"
          id={bondfireId}
          title={title.trim() || undefined}
          open={isInviteSheetOpen}
          onClose={handleInviteSheetClose}
        />
      )}

      {/* Push permission pre-prompt — the user just committed a video, the
          highest-intent moment to ask about response notifications. Defers
          to the InviteSheet while that is open. */}
      <PushPrimerSheet trigger={!isInviteSheetOpen} />
    </>
  )
}

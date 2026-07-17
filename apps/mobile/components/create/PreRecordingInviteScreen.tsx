import { telemetry, useAppThemeColors } from '@bondfires/app'
import { Button, Spinner, Text } from '@bondfires/ui'
import { observable } from '@legendapp/state'
import { Check, Link, Plus, X } from '@tamagui/lucide-icons'
import { useMutation, useQuery } from 'convex/react'
import { useCallback, useMemo, useState } from 'react'
import { Alert, Pressable, ScrollView, StatusBar, TextInput } from 'react-native'
import { KeyboardAvoidingView } from 'react-native-keyboard-controller'
import { Avatar, XStack, YStack } from 'tamagui'
import { api } from '../../../../convex/_generated/api'
import type { Id } from '../../../../convex/_generated/dataModel'

const MAX_TITLE_LENGTH = 80
const CLOSE_CIRCLE_DISPLAY_LIMIT = 8
const RECENT_CONNECTIONS_DISPLAY_LIMIT = 20

// Local Legend State for the invite screen — kept out of the global appStore$
// because it's a transient form and we don't want stale form data to bleed
// into a later create flow.
interface InviteFormState {
  selectedRecipientIds: Id<'users'>[]
  emails: string[]
  title: string
  titleTouched: boolean
  emailInput: string
}

const initialState: InviteFormState = {
  selectedRecipientIds: [],
  emails: [],
  title: '',
  titleTouched: false,
  emailInput: '',
}

const formStore$ = observable<InviteFormState>(initialState)

function isValidEmail(value: string): boolean {
  // Pragmatic regex — not RFC-perfect, but catches obvious typos and rejects
  // whitespace, missing @, missing TLD, etc. The mutation does a stricter
  // check before any DB or send work happens.
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())
}

function buildAutoTitle(
  candidates: ReadonlyArray<{
    _id: Id<'users'>
    displayName?: string
    name?: string
  }>,
  selectedIds: ReadonlyArray<Id<'users'>>,
): string {
  const names = candidates
    .filter((candidate) => selectedIds.includes(candidate._id))
    .map((candidate) => candidate.displayName?.split(' ')[0] ?? candidate.name?.split(' ')[0] ?? '')
    .filter((name) => name.length > 0)
  if (names.length === 0) return ''
  if (names.length === 1) return `Hey ${names[0] ?? ''}`
  if (names.length === 2) return `Hey ${names[0] ?? ''} & ${names[1] ?? ''}`
  return `Hey ${names[0] ?? ''} & friends`
}

export interface ExistingDraft {
  _id: string
  title?: string
}

interface PreRecordingInviteScreenProps {
  onContinue: (bondfireId: string, title: string) => void
  onCancel: () => void
  existingDraft?: ExistingDraft | null
}

/**
 * Pre-recording audience selection for Hearth bondfires. Shown *before* the
 * camera opens so the user has time to decide who this Bondfire is for:
 *
 *   1. Close Circle (pinned) + Recent Connections (interacted-with users
 *      from the last 30 days) for one-tap in-app invites.
 *   2. Email invites — emails that match an existing account become a direct
 *      invite; the rest get the code via Resend.
 *   3. Auto-generated title from the selected recipients; user can override
 *      and the auto-fill stops the moment they touch the field.
 *   4. "A share link will be generated when you continue." — the actual
 *      invite code is created on Continue, so we don't show a stale link.
 *
 * If the user already has a draft (e.g. they backed out of recording and
 * came back), we show a Continue/Discard prompt at the top so they can
 * pick up where they left off instead of orphaning the draft.
 */
export function PreRecordingInviteScreen({
  onContinue,
  onCancel,
  existingDraft,
}: PreRecordingInviteScreenProps) {
  const { colors, statusBarStyle } = useAppThemeColors()
  const [isSubmitting, setIsSubmitting] = useState(false)

  // Only fetch invite candidates for Hearth — the screen is never shown for
  // camp or respondTo flows.
  const candidates = useQuery(api.personalBondfires.getInviteCandidates, {})
  const closeCircle = useMemo(
    () => (candidates?.closeCircle ?? []).slice(0, CLOSE_CIRCLE_DISPLAY_LIMIT),
    [candidates?.closeCircle],
  )
  const recentConnections = useMemo(
    () => (candidates?.recentConnections ?? []).slice(0, RECENT_CONNECTIONS_DISPLAY_LIMIT),
    [candidates?.recentConnections],
  )

  const createDraft = useMutation(api.personalBondfires.createDraftBondfire)
  const sendInvites = useMutation(api.personalBondfires.sendDraftInvites)
  const discardDraft = useMutation(api.personalBondfires.discardDraftBondfire)

  const selectedRecipientIds = formStore$.selectedRecipientIds.get()
  const emails = formStore$.emails.get()
  const title = formStore$.title.get()
  const titleTouched = formStore$.titleTouched.get()
  const emailInput = formStore$.emailInput.get()

  // Combined candidate set used for both selection and auto-title.
  const allCandidates = useMemo(
    () => [...closeCircle, ...recentConnections],
    [closeCircle, recentConnections],
  )

  // Auto-title: only when the user hasn't touched the field AND we have
  // something useful to show.
  const autoTitle = useMemo(
    () => buildAutoTitle(allCandidates, selectedRecipientIds),
    [allCandidates, selectedRecipientIds],
  )
  const displayTitle = titleTouched ? title : autoTitle

  const canContinue =
    !isSubmitting &&
    ((displayTitle.trim().length > 0 && displayTitle.length <= MAX_TITLE_LENGTH) ||
      selectedRecipientIds.length > 0 ||
      emails.length > 0)

  const toggleRecipient = useCallback((id: Id<'users'>) => {
    const current = formStore$.selectedRecipientIds.get()
    if (current.includes(id)) {
      formStore$.selectedRecipientIds.set(current.filter((entry) => entry !== id))
    } else {
      formStore$.selectedRecipientIds.set([...current, id])
    }
  }, [])

  const addEmail = useCallback(() => {
    const candidate = emailInput.trim()
    if (!candidate) return
    if (!isValidEmail(candidate)) {
      Alert.alert('Invalid Email', 'Please enter a valid email address.')
      return
    }
    const lower = candidate.toLowerCase()
    const current = formStore$.emails.get()
    if (current.includes(lower)) {
      formStore$.emailInput.set('')
      return
    }
    formStore$.emails.set([...current, lower])
    formStore$.emailInput.set('')
  }, [emailInput])

  const removeEmail = useCallback((target: string) => {
    formStore$.emails.set(formStore$.emails.get().filter((entry) => entry !== target))
  }, [])

  const handleTitleChange = useCallback((text: string) => {
    const truncated = text.slice(0, MAX_TITLE_LENGTH)
    formStore$.title.set(truncated)
    if (!formStore$.titleTouched.get()) {
      formStore$.titleTouched.set(true)
    }
  }, [])

  const handleContinue = useCallback(async () => {
    if (!canContinue || isSubmitting) return
    setIsSubmitting(true)
    try {
      const trimmedTitle = displayTitle.trim()
      const result = await createDraft({
        ...(trimmedTitle.length > 0 ? { title: trimmedTitle } : {}),
      })
      if (selectedRecipientIds.length > 0 || emails.length > 0) {
        await sendInvites({
          bondfireId: result.bondfireId,
          recipientIds: selectedRecipientIds,
          emails,
          ...(trimmedTitle.length > 0 ? { title: trimmedTitle } : {}),
        })
      }
      // Reset form before navigating so a back→re-enter starts clean.
      formStore$.set(initialState)
      onContinue(result.bondfireId, trimmedTitle)
    } catch (error) {
      telemetry.error('create:invite_submit', 'Failed to create Hearth draft', {
        error: String(error),
      })
      Alert.alert(
        'Something went wrong',
        error instanceof Error ? error.message : 'Please try again.',
      )
    } finally {
      setIsSubmitting(false)
    }
  }, [
    canContinue,
    createDraft,
    displayTitle,
    emails,
    isSubmitting,
    onContinue,
    selectedRecipientIds,
    sendInvites,
  ])

  const handleResumeDraft = useCallback(() => {
    if (!existingDraft) return
    // We don't reset the form here — the resume uses the existing draft
    // server-side, and the parent will navigate to recording.
    onContinue(existingDraft._id, existingDraft.title ?? '')
  }, [existingDraft, onContinue])

  const handleDiscardDraft = useCallback(async () => {
    if (!existingDraft) return
    try {
      await discardDraft({ bondfireId: existingDraft._id as Id<'bondfires'> })
    } catch (error) {
      // Non-fatal: the cron will clean it up within 24h.
      telemetry.warn('create:discard_draft', 'Failed to discard existing draft', {
        error: String(error),
      })
    }
  }, [discardDraft, existingDraft])

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior="padding">
      <YStack flex={1} backgroundColor={'$background'}>
        <StatusBar barStyle={statusBarStyle} backgroundColor={colors.background} />

        {/* Header */}
        <XStack
          alignItems="center"
          justifyContent="space-between"
          paddingHorizontal={16}
          paddingVertical={12}
        >
          <Text fontSize={20} fontWeight="800" color={'$color'}>
            New Hearth Bondfire
          </Text>
          <Pressable
            onPress={onCancel}
            hitSlop={12}
            accessibilityLabel="Close invite screen"
            accessibilityRole="button"
          >
            <X size={24} color={colors.color} />
          </Pressable>
        </XStack>

        <ScrollView
          contentContainerStyle={{ paddingBottom: 140 }}
          keyboardShouldPersistTaps="handled"
        >
          {existingDraft && (
            <YStack
              marginHorizontal={16}
              marginBottom={16}
              padding={16}
              borderRadius={16}
              borderWidth={1}
              borderColor={'$primary'}
              gap={12}
            >
              <Text color={'$color'} fontWeight="700" fontSize={16}>
                Continue recording?
              </Text>
              <Text color={'$placeholderColor'} fontSize={14}>
                You already have a draft Bondfire
                {existingDraft.title ? ` (“${existingDraft.title}”)` : ''}. Pick up where you left
                off, or discard it and start fresh.
              </Text>
              <XStack gap={10}>
                <Button
                  flex={1}
                  variant="primary"
                  size="$md"
                  onPress={handleResumeDraft}
                  disabled={isSubmitting}
                >
                  <Text color={'$color'} fontWeight="700">
                    Continue
                  </Text>
                </Button>
                <Button
                  flex={1}
                  variant="outline"
                  size="$md"
                  onPress={handleDiscardDraft}
                  disabled={isSubmitting}
                >
                  <Text color={'$color'} fontWeight="700">
                    Discard
                  </Text>
                </Button>
              </XStack>
            </YStack>
          )}

          {/* Close Circle */}
          {closeCircle.length > 0 && (
            <InviteSection title="Close Circle" caption="People you've pinned for fast access.">
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={{ paddingHorizontal: 16, gap: 12 }}
              >
                {closeCircle.map((candidate) => (
                  <CandidateAvatar
                    key={candidate._id}
                    candidate={candidate}
                    selected={selectedRecipientIds.includes(candidate._id)}
                    onToggle={() => toggleRecipient(candidate._id)}
                  />
                ))}
              </ScrollView>
            </InviteSection>
          )}

          {/* Recent Connections */}
          {recentConnections.length > 0 && (
            <InviteSection
              title="Recent Connections"
              caption="People you've been in Bondfires with recently."
            >
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={{ paddingHorizontal: 16, gap: 12 }}
              >
                {recentConnections.map((candidate) => (
                  <CandidateAvatar
                    key={candidate._id}
                    candidate={candidate}
                    selected={selectedRecipientIds.includes(candidate._id)}
                    onToggle={() => toggleRecipient(candidate._id)}
                  />
                ))}
              </ScrollView>
            </InviteSection>
          )}

          {/* Email invites */}
          <InviteSection
            title="Invite by email"
            caption="Existing accounts get a push; new addresses get an email invite."
          >
            <YStack paddingHorizontal={16} gap={10}>
              <XStack gap={8} alignItems="center">
                <TextInput
                  value={emailInput}
                  onChangeText={(text) => formStore$.emailInput.set(text)}
                  onSubmitEditing={addEmail}
                  placeholder="friend@example.com"
                  placeholderTextColor={colors.placeholderColor}
                  keyboardType="email-address"
                  autoCapitalize="none"
                  autoCorrect={false}
                  returnKeyType="done"
                  style={{
                    flex: 1,
                    backgroundColor: colors.backgroundHover,
                    color: colors.color,
                    fontSize: 15,
                    paddingHorizontal: 14,
                    paddingVertical: 12,
                    borderRadius: 12,
                    borderWidth: 1,
                    borderColor: colors.borderColor,
                  }}
                />
                <Button
                  variant="primary"
                  size="$md"
                  onPress={addEmail}
                  icon={<Plus size={16} color={'$color'} />}
                >
                  <Text color={'$color'} fontWeight="700">
                    Add
                  </Text>
                </Button>
              </XStack>
              {emails.length > 0 && (
                <XStack gap={8} flexWrap="wrap">
                  {emails.map((entry) => (
                    <EmailChip key={entry} email={entry} onRemove={() => removeEmail(entry)} />
                  ))}
                </XStack>
              )}
            </YStack>
          </InviteSection>

          {/* Share link placeholder */}
          <InviteSection title="Or share with anyone" caption="">
            <YStack paddingHorizontal={16} gap={8}>
              <XStack
                alignItems="center"
                gap={10}
                padding={12}
                borderRadius={12}
                borderWidth={1}
                borderColor={'$borderColor'}
                backgroundColor={'$backgroundHover'}
              >
                <Link size={18} color={'$placeholderColor'} />
                <Text color={'$placeholderColor'} fontSize={13} flex={1}>
                  A share link will be generated when you continue.
                </Text>
              </XStack>
            </YStack>
          </InviteSection>

          {/* Title */}
          <InviteSection title="Title" caption="Auto-fills from who you invite. Edit anytime.">
            <YStack paddingHorizontal={16} gap={6}>
              <TextInput
                value={displayTitle}
                onChangeText={handleTitleChange}
                placeholder="What's this bondfire about?"
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
              />
              <Text fontSize={11} color={'$placeholderColor'} alignSelf="flex-end">
                {displayTitle.length}/{MAX_TITLE_LENGTH}
              </Text>
            </YStack>
          </InviteSection>
        </ScrollView>

        {/* Continue button — sticky at the bottom */}
        <YStack
          paddingHorizontal={16}
          paddingTop={12}
          paddingBottom={24}
          backgroundColor={'$background'}
          borderTopWidth={1}
          borderTopColor={'$borderColor'}
        >
          <Button
            variant="primary"
            size="$lg"
            disabled={!canContinue}
            onPress={handleContinue}
            icon={
              isSubmitting ? (
                <Spinner size="small" color={'$color'} />
              ) : (
                <Check size={18} color={'$color'} />
              )
            }
          >
            <Text color={'$color'} fontWeight="800">
              {isSubmitting ? 'Setting up…' : 'Continue to record'}
            </Text>
          </Button>
        </YStack>
      </YStack>
    </KeyboardAvoidingView>
  )
}

// ── Sub-components ────────────────────────────────────────────────────────

function InviteSection({
  title,
  caption,
  children,
}: {
  title: string
  caption: string
  children: React.ReactNode
}) {
  return (
    <YStack marginBottom={20}>
      <YStack paddingHorizontal={16} marginBottom={10} gap={2}>
        <Text color={'$color'} fontWeight="700" fontSize={16}>
          {title}
        </Text>
        {caption.length > 0 && (
          <Text color={'$placeholderColor'} fontSize={12}>
            {caption}
          </Text>
        )}
      </YStack>
      {children}
    </YStack>
  )
}

function CandidateAvatar({
  candidate,
  selected,
  onToggle,
}: {
  candidate: { _id: Id<'users'>; displayName?: string; name?: string; photoUrl?: string }
  selected: boolean
  onToggle: () => void
}) {
  const displayName = candidate.displayName ?? candidate.name ?? 'Friend'
  const initial = displayName.trim().charAt(0).toUpperCase() || '?'
  return (
    <Pressable onPress={onToggle} accessibilityRole="button" accessibilityLabel={displayName}>
      <YStack alignItems="center" gap={6} width={68}>
        <YStack
          width={60}
          height={60}
          borderRadius={30}
          borderWidth={selected ? 3 : 0}
          borderColor={'$primary'}
          alignItems="center"
          justifyContent="center"
          backgroundColor={'$backgroundHover'}
          overflow="hidden"
        >
          {candidate.photoUrl ? (
            <Avatar circular size={60}>
              <Avatar.Image src={candidate.photoUrl} />
            </Avatar>
          ) : (
            <Text color={'$color'} fontWeight="700" fontSize={20}>
              {initial}
            </Text>
          )}
          {selected && (
            <YStack
              position="absolute"
              bottom={-2}
              right={-2}
              width={20}
              height={20}
              borderRadius={10}
              backgroundColor={'$primary'}
              alignItems="center"
              justifyContent="center"
            >
              <Check size={12} color={'$color'} />
            </YStack>
          )}
        </YStack>
        <Text color={'$color'} fontSize={11} numberOfLines={1} textAlign="center">
          {displayName.split(' ')[0]}
        </Text>
      </YStack>
    </Pressable>
  )
}

function EmailChip({ email, onRemove }: { email: string; onRemove: () => void }) {
  return (
    <XStack
      alignItems="center"
      gap={6}
      paddingHorizontal={10}
      paddingVertical={6}
      borderRadius={16}
      backgroundColor={'$backgroundHover'}
      borderWidth={1}
      borderColor={'$borderColor'}
    >
      <Text color={'$color'} fontSize={12}>
        {email}
      </Text>
      <Pressable
        onPress={onRemove}
        hitSlop={8}
        accessibilityLabel={`Remove ${email}`}
        accessibilityRole="button"
      >
        <X size={14} color={'$placeholderColor'} />
      </Pressable>
    </XStack>
  )
}

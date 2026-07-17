import { subscriptionActions, telemetry, useAppThemeColors } from '@bondfires/app'
import { Button, Spinner, Text } from '@bondfires/ui'
import { useObservable, useValue } from '@legendapp/state/react'
import { Check, Copy, Link, Plus, Share, X } from '@tamagui/lucide-icons'
import { useMutation, useQuery } from 'convex/react'
import * as Clipboard from 'expo-clipboard'
import { useCallback, useMemo } from 'react'
import { Alert, Pressable, Share as RNShare, ScrollView, StatusBar, TextInput } from 'react-native'
import { KeyboardAvoidingView } from 'react-native-keyboard-controller'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Avatar, XStack, YStack } from 'tamagui'
import { api } from '../../../../convex/_generated/api'
import type { Id } from '../../../../convex/_generated/dataModel'
import {
  buildAutoTitle,
  isValidInviteEmail,
  MAX_EMAIL_INVITES,
  MAX_TITLE_LENGTH,
} from './preRecordingInvite'

const CLOSE_CIRCLE_DISPLAY_LIMIT = 8
const RECENT_CONNECTIONS_DISPLAY_LIMIT = 20
/** Same base URL as InviteSheet — both domains are app-linked in app.json. */
const INVITE_BASE_URL = 'https://bondfires.app/invite'

interface InviteFormState {
  selectedRecipientIds: Id<'users'>[]
  emails: string[]
  title: string
  titleTouched: boolean
  emailInput: string
  /** Set once a share link has been created — the draft now exists server-side. */
  shareInfo: { bondfireId: string; code: string } | null
  copied: boolean
  isSubmitting: boolean
  isDiscarding: boolean
  isCreatingLink: boolean
}

/** Cap errors thrown by sendDraftInvites — see getParticipantCap tiers. */
function isCapError(message: string): boolean {
  return /upgrade to premium|this fire is full/i.test(message)
}

function showUpgradeAlert() {
  Alert.alert(
    'Invite limit reached',
    'Your current membership limits how many people can join a Hearth bondfire. Upgrade to invite more.',
    [
      { text: 'Not now', style: 'cancel' },
      { text: 'Upgrade', onPress: () => subscriptionActions.showPaywall() },
    ],
  )
}

export interface ExistingDraft {
  _id: string
  title?: string
}

interface PreRecordingInviteScreenProps {
  onContinue: (bondfireId: string, title: string) => void
  onCancel: () => void
  /** Record without setting up an audience first (pre-invite behavior). */
  onSkip: () => void
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
 *   3. A share link, created on demand (creating it creates the draft, so
 *      the link people receive is the one that goes live with the recording).
 *   4. Auto-generated title from the selected recipients; user can override
 *      and the auto-fill stops the moment they touch the field.
 *
 * If the user already has a draft (e.g. they backed out of recording and
 * came back), we show a Continue/Discard prompt at the top so they can
 * pick up where they left off instead of orphaning the draft.
 */
export function PreRecordingInviteScreen({
  onContinue,
  onCancel,
  onSkip,
  existingDraft,
}: PreRecordingInviteScreenProps) {
  const { colors, statusBarStyle } = useAppThemeColors()
  const insets = useSafeAreaInsets()

  // Transient form state, scoped to this mount so a cancel-and-reopen always
  // starts clean (a module-level store would leak state across visits).
  const form$ = useObservable<InviteFormState>({
    selectedRecipientIds: [],
    emails: [],
    title: '',
    titleTouched: false,
    emailInput: '',
    shareInfo: null,
    copied: false,
    isSubmitting: false,
    isDiscarding: false,
    isCreatingLink: false,
  })

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
  const participantCap = candidates?.participantCap

  const createDraft = useMutation(api.personalBondfires.createDraftBondfire)
  const sendInvites = useMutation(api.personalBondfires.sendDraftInvites)
  const discardDraft = useMutation(api.personalBondfires.discardDraftBondfire)

  const selectedRecipientIds = useValue(form$.selectedRecipientIds)
  const emails = useValue(form$.emails)
  const title = useValue(form$.title)
  const titleTouched = useValue(form$.titleTouched)
  const emailInput = useValue(form$.emailInput)
  const shareInfo = useValue(form$.shareInfo)
  const copied = useValue(form$.copied)
  const isSubmitting = useValue(form$.isSubmitting)
  const isDiscarding = useValue(form$.isDiscarding)
  const isCreatingLink = useValue(form$.isCreatingLink)
  const isBusy = isSubmitting || isDiscarding || isCreatingLink

  // Combined candidate set used for both selection and auto-title.
  const allCandidates = useMemo(
    () => [...closeCircle, ...recentConnections],
    [closeCircle, recentConnections],
  )

  // Auto-title: only when the user hasn't touched the field AND we have
  // something useful to show.
  const autoTitle = useMemo(
    () => buildAutoTitle(allCandidates, selectedRecipientIds, emails),
    [allCandidates, emails, selectedRecipientIds],
  )
  const displayTitle = titleTouched ? title : autoTitle

  const canContinue =
    !isBusy &&
    (displayTitle.trim().length > 0 ||
      selectedRecipientIds.length > 0 ||
      emails.length > 0 ||
      shareInfo !== null)

  // Once a draft exists (share link created, or one carried over from a prior
  // visit), skipping would record into a *different* bondfire and orphan the
  // draft people may already have joined — so hide the escape hatch.
  const canSkip = !isBusy && shareInfo === null && !existingDraft

  // The resume/discard prompt is for drafts left over from a *previous* visit.
  // Creating a share link creates a draft server-side, which echoes back into
  // the reactive existingDraft query — don't prompt about our own draft.
  const showResumeBanner = Boolean(existingDraft) && shareInfo === null

  const toggleRecipient = useCallback(
    (id: Id<'users'>) => {
      const current = form$.selectedRecipientIds.get()
      if (current.includes(id)) {
        form$.selectedRecipientIds.set(current.filter((entry) => entry !== id))
        return
      }
      // The owner occupies one slot, so cap - 1 people can be invited. The cap
      // stays out of the UI until the user actually runs into it.
      if (participantCap !== undefined && current.length + 1 > participantCap - 1) {
        showUpgradeAlert()
        return
      }
      form$.selectedRecipientIds.set([...current, id])
    },
    [form$, participantCap],
  )

  const addEmail = useCallback(() => {
    const candidate = form$.emailInput.get().trim()
    if (!candidate) return
    if (!isValidInviteEmail(candidate)) {
      Alert.alert('Invalid Email', 'Please enter a valid email address.')
      return
    }
    const lower = candidate.toLowerCase()
    const current = form$.emails.get()
    if (current.includes(lower)) {
      form$.emailInput.set('')
      return
    }
    if (current.length >= MAX_EMAIL_INVITES) {
      Alert.alert(
        'Email limit reached',
        `You can invite up to ${MAX_EMAIL_INVITES} people by email per bondfire.`,
      )
      return
    }
    form$.emails.set([...current, lower])
    form$.emailInput.set('')
  }, [form$])

  const removeEmail = useCallback(
    (target: string) => {
      form$.emails.set(form$.emails.get().filter((entry) => entry !== target))
    },
    [form$],
  )

  const handleTitleChange = useCallback(
    (text: string) => {
      form$.title.set(text.slice(0, MAX_TITLE_LENGTH))
      if (!form$.titleTouched.get()) {
        form$.titleTouched.set(true)
      }
    },
    [form$],
  )

  const handleCreateShareLink = useCallback(async () => {
    if (form$.isCreatingLink.get() || form$.shareInfo.get()) return
    form$.isCreatingLink.set(true)
    try {
      const trimmedTitle = (
        form$.titleTouched.get()
          ? form$.title.get()
          : buildAutoTitle(allCandidates, form$.selectedRecipientIds.get(), form$.emails.get())
      ).trim()
      const result = await createDraft({
        ...(trimmedTitle.length > 0 ? { title: trimmedTitle } : {}),
      })
      form$.shareInfo.set({ bondfireId: result.bondfireId, code: result.inviteCode })
    } catch (error) {
      telemetry.error('create:share_link', 'Failed to create draft for share link', {
        error: String(error),
      })
      Alert.alert(
        'Something went wrong',
        error instanceof Error ? error.message : 'Please try again.',
      )
    } finally {
      form$.isCreatingLink.set(false)
    }
  }, [allCandidates, createDraft, form$])

  const handleCopyLink = useCallback(async () => {
    const info = form$.shareInfo.get()
    if (!info) return
    try {
      await Clipboard.setStringAsync(`${INVITE_BASE_URL}/${info.code}`)
      form$.copied.set(true)
      setTimeout(() => form$.copied.set(false), 2000)
    } catch (error) {
      Alert.alert('Copy Failed', error instanceof Error ? error.message : String(error))
    }
  }, [form$])

  const handleShareSheet = useCallback(async () => {
    const info = form$.shareInfo.get()
    if (!info) return
    const shareUrl = `${INVITE_BASE_URL}/${info.code}`
    try {
      await RNShare.share({
        message: `Join my Bondfire!\n\n${shareUrl}`,
        url: shareUrl,
      })
    } catch {
      // User cancelled
    }
  }, [form$])

  const handleContinue = useCallback(async () => {
    if (form$.isSubmitting.get()) return
    form$.isSubmitting.set(true)
    try {
      const recipientIds = form$.selectedRecipientIds.get()
      const emailList = form$.emails.get()
      const trimmedTitle = (
        form$.titleTouched.get()
          ? form$.title.get()
          : buildAutoTitle(allCandidates, recipientIds, emailList)
      ).trim()
      // Idempotent: returns the existing draft when one exists (e.g. the share
      // link above already created it, or the user is resuming).
      const result = await createDraft({
        ...(trimmedTitle.length > 0 ? { title: trimmedTitle } : {}),
      })
      if (recipientIds.length > 0 || emailList.length > 0) {
        await sendInvites({
          bondfireId: result.bondfireId,
          recipientIds,
          emails: emailList,
          ...(trimmedTitle.length > 0 ? { title: trimmedTitle } : {}),
        })
      }
      onContinue(result.bondfireId, trimmedTitle)
    } catch (error) {
      telemetry.error('create:invite_submit', 'Failed to create Hearth draft', {
        error: String(error),
      })
      const message = error instanceof Error ? error.message : 'Please try again.'
      if (isCapError(message)) {
        showUpgradeAlert()
      } else {
        Alert.alert('Something went wrong', message)
      }
    } finally {
      form$.isSubmitting.set(false)
    }
  }, [allCandidates, createDraft, form$, onContinue, sendInvites])

  const handleResumeDraft = useCallback(() => {
    if (!existingDraft) return
    onContinue(existingDraft._id, existingDraft.title ?? '')
  }, [existingDraft, onContinue])

  const handleDiscardDraft = useCallback(() => {
    if (!existingDraft || form$.isDiscarding.get()) return
    Alert.alert(
      'Discard this draft?',
      'Anyone you already invited will lose access, and any shared links will stop working.',
      [
        { text: 'Keep it', style: 'cancel' },
        {
          text: 'Discard',
          style: 'destructive',
          onPress: async () => {
            form$.isDiscarding.set(true)
            try {
              await discardDraft({ bondfireId: existingDraft._id as Id<'bondfires'> })
              // The draft this session's share link pointed at is gone too.
              form$.shareInfo.set(null)
            } catch (error) {
              telemetry.warn('create:discard_draft', 'Failed to discard existing draft', {
                error: String(error),
              })
              Alert.alert(
                'Discard failed',
                error instanceof Error ? error.message : 'Please try again.',
              )
            } finally {
              form$.isDiscarding.set(false)
            }
          },
        },
      ],
    )
  }, [discardDraft, existingDraft, form$])

  const shareUrl = shareInfo ? `${INVITE_BASE_URL}/${shareInfo.code}` : null

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior="padding">
      <YStack flex={1} backgroundColor={'$background'}>
        <StatusBar barStyle={statusBarStyle} backgroundColor={colors.background} />

        {/* Header */}
        <XStack
          alignItems="center"
          justifyContent="space-between"
          paddingHorizontal={16}
          paddingTop={insets.top + 8}
          paddingBottom={12}
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
          contentContainerStyle={{ paddingBottom: 180 }}
          keyboardShouldPersistTaps="handled"
        >
          {showResumeBanner && existingDraft && (
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
                  disabled={isBusy}
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
                  disabled={isBusy}
                  icon={isDiscarding ? <Spinner size="small" color={'$color'} /> : undefined}
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
                  onChangeText={(text) => form$.emailInput.set(text)}
                  onSubmitEditing={addEmail}
                  placeholder="friend@example.com"
                  placeholderTextColor={colors.placeholderColor}
                  keyboardType="email-address"
                  autoCapitalize="none"
                  autoCorrect={false}
                  maxLength={254}
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

          {/* Share link */}
          <InviteSection
            title="Or share with anyone"
            caption="Anyone with the link can join — they'll be there when you start."
          >
            <YStack paddingHorizontal={16} gap={10}>
              {shareUrl ? (
                <>
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
                    <Text color={'$color'} fontSize={13} flex={1} numberOfLines={1}>
                      {shareUrl}
                    </Text>
                  </XStack>
                  <XStack gap={10}>
                    <Button
                      flex={1}
                      variant="primary"
                      size="$md"
                      onPress={handleCopyLink}
                      icon={
                        copied ? (
                          <Check size={16} color={'$color'} />
                        ) : (
                          <Copy size={16} color={'$color'} />
                        )
                      }
                    >
                      <Text color={'$color'} fontWeight="700">
                        {copied ? 'Copied' : 'Copy'}
                      </Text>
                    </Button>
                    <Button
                      flex={1}
                      variant="outline"
                      size="$md"
                      onPress={handleShareSheet}
                      icon={<Share size={16} color={'$color'} />}
                    >
                      <Text color={'$color'} fontWeight="700">
                        Share
                      </Text>
                    </Button>
                  </XStack>
                </>
              ) : (
                <Button
                  variant="outline"
                  size="$md"
                  onPress={handleCreateShareLink}
                  disabled={isBusy}
                  icon={
                    isCreatingLink ? (
                      <Spinner size="small" color={'$color'} />
                    ) : (
                      <Link size={16} color={'$color'} />
                    )
                  }
                >
                  <Text color={'$color'} fontWeight="700">
                    {isCreatingLink ? 'Creating link…' : 'Create share link'}
                  </Text>
                </Button>
              )}
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
          paddingBottom={Math.max(insets.bottom, 12) + 8}
          backgroundColor={'$background'}
          borderTopWidth={1}
          borderTopColor={'$borderColor'}
          gap={10}
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
          {canSkip && (
            <Pressable
              onPress={onSkip}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel="Skip inviting and record now"
            >
              <Text color={'$placeholderColor'} fontSize={13} fontWeight="600" textAlign="center">
                Skip — record without inviting
              </Text>
            </Pressable>
          )}
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
    <Pressable
      onPress={onToggle}
      accessibilityRole="button"
      accessibilityLabel={displayName}
      accessibilityState={{ selected }}
    >
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
        >
          <Avatar circular size={selected ? 54 : 60}>
            {candidate.photoUrl ? <Avatar.Image source={{ uri: candidate.photoUrl }} /> : null}
            <Avatar.Fallback
              backgroundColor={'$backgroundHover'}
              alignItems="center"
              justifyContent="center"
            >
              <Text color={'$color'} fontWeight="700" fontSize={20}>
                {initial}
              </Text>
            </Avatar.Fallback>
          </Avatar>
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

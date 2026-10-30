import { appStore$, subscriptionActions, telemetry, useAppThemeColors } from '@bondfires/app'
import { Button, Spinner, Text, UserAvatar } from '@bondfires/ui'
import { useObservable, useValue } from '@legendapp/state/react'
import { Check, ChevronRight, Plus, ShieldCheck, Video } from '@tamagui/lucide-icons'
import { useMutation, useQuery } from 'convex/react'
import * as Clipboard from 'expo-clipboard'
import { type ReactNode, useCallback, useMemo } from 'react'
import { Alert, Pressable, Share as RNShare, ScrollView, StatusBar, TextInput } from 'react-native'
import { KeyboardAvoidingView } from 'react-native-keyboard-controller'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { XStack, YStack } from 'tamagui'
import { api } from '../../../../convex/_generated/api'
import type { Id } from '../../../../convex/_generated/dataModel'
import { hasSavedDraftCapture, segmentMediaEnabled } from '../../lib/media/segmentUploads'
import { InviteSomeoneSheet } from './InviteSomeoneSheet'
import type { AudienceFilterKey } from './preRecordingInvite'
import {
  buildAudienceFilters,
  buildAudienceItems,
  buildAutoTitle,
  isValidInviteEmail,
  MAX_EMAIL_INVITES,
  MAX_TITLE_LENGTH,
  resolveAudienceFilter,
  selectAudienceItems,
  summarizeAudience,
} from './preRecordingInvite'
import { SparkComposerHeader } from './SparkModeToggle'
import { buildPeopleCtaLabel } from './sparkComposer'

const CLOSE_CIRCLE_DISPLAY_LIMIT = 8
const RECENT_CONNECTIONS_DISPLAY_LIMIT = 20
/** Same base URL as InviteSheet — both domains are app-linked in app.json. */
const INVITE_BASE_URL = 'https://bondfires.app/invite'
const FAMILY_INVITE_BASE_URL = 'https://bondfires.app/invite/family'

interface InviteFormState {
  selectedRecipientIds: Id<'users'>[]
  emails: string[]
  title: string
  titleTouched: boolean
  emailInput: string
  audienceFilter: AudienceFilterKey
  /** Set once a share link has been created — the draft now exists server-side. */
  shareInfo: { bondfireId: string; code: string } | null
  familyShareInfo: { bondfireId: string; code: string } | null
  copied: boolean
  familyCopied: boolean
  isSubmitting: boolean
  isDiscarding: boolean
  isCreatingLink: boolean
  isCreatingFamilyLink: boolean
  inviteSheetOpen: boolean
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
  /** People | Camp toggle, rendered under the header. */
  modeToggle?: ReactNode
}

/**
 * Pre-recording audience selection for Hearth bondfires. Shown *before* the
 * camera opens so the user has time to decide who this Bondfire is for:
 *
 *   1. One avatar rail of people they know — family connections, Close
 *      Circle (pinned), and Recent Connections (interacted-with users from
 *      the last 30 days) — with relationship chips to filter it, for one-tap
 *      in-app invites.
 *   2. "Invite someone new", a sheet with email invites (emails that match an
 *      existing account become a direct invite; the rest get the code via
 *      Resend), a share link and a family link. Links are created on demand,
 *      and creating one creates the draft, so the link people receive is the
 *      one that goes live with the recording.
 *   3. Auto-generated title from the selected recipients; user can override
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
  modeToggle,
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
    audienceFilter: 'all',
    shareInfo: null,
    familyShareInfo: null,
    copied: false,
    familyCopied: false,
    isSubmitting: false,
    isDiscarding: false,
    isCreatingLink: false,
    isCreatingFamilyLink: false,
    inviteSheetOpen: false,
  })

  // Only fetch invite candidates for Hearth — the screen is never shown for
  // camp or respondTo flows.
  const candidates = useQuery(api.personalBondfires.getInviteCandidates, {})
  const closeCircle = useMemo(
    () => (candidates?.closeCircle ?? []).slice(0, CLOSE_CIRCLE_DISPLAY_LIMIT),
    [candidates?.closeCircle],
  )
  const familyConnections = useMemo(
    () => (candidates?.familyConnections ?? []).slice(0, CLOSE_CIRCLE_DISPLAY_LIMIT),
    [candidates?.familyConnections],
  )
  const recentConnections = useMemo(
    () => (candidates?.recentConnections ?? []).slice(0, RECENT_CONNECTIONS_DISPLAY_LIMIT),
    [candidates?.recentConnections],
  )
  const participantCap = candidates?.participantCap

  const createDraft = useMutation(api.personalBondfires.createDraftBondfire)
  const sendInvites = useMutation(api.personalBondfires.sendDraftInvites)
  const discardDraft = useMutation(api.personalBondfires.discardDraftBondfire)
  const createFamilyInvite = useMutation(api.familyConnections.createInvite)

  const selectedRecipientIds = useValue(form$.selectedRecipientIds)
  const emails = useValue(form$.emails)
  const title = useValue(form$.title)
  const titleTouched = useValue(form$.titleTouched)
  const emailInput = useValue(form$.emailInput)
  const audienceFilter = useValue(form$.audienceFilter)
  const shareInfo = useValue(form$.shareInfo)
  const familyShareInfo = useValue(form$.familyShareInfo)
  const copied = useValue(form$.copied)
  const familyCopied = useValue(form$.familyCopied)
  const isSubmitting = useValue(form$.isSubmitting)
  const isDiscarding = useValue(form$.isDiscarding)
  const isCreatingLink = useValue(form$.isCreatingLink)
  const isCreatingFamilyLink = useValue(form$.isCreatingFamilyLink)
  const inviteSheetOpen = useValue(form$.inviteSheetOpen)
  const isBusy = isSubmitting || isDiscarding || isCreatingLink || isCreatingFamilyLink

  // Combined candidate set used for both selection and auto-title.
  const allCandidates = useMemo(
    () => [...familyConnections, ...closeCircle, ...recentConnections],
    [closeCircle, familyConnections, recentConnections],
  )

  // ── Single audience rail ────────────────────────────────────────────────
  // Family / Close Circle / Recent used to be three stacked rails answering
  // the same "who?" question. They now merge into one rail plus filter chips,
  // so each person keeps their relationship label without the vertical cost.
  const audienceItems = useMemo(
    () => buildAudienceItems(familyConnections, closeCircle, recentConnections),
    [closeCircle, familyConnections, recentConnections],
  )

  const audienceFilters = useMemo(() => buildAudienceFilters(audienceItems), [audienceItems])

  const activeAudienceFilter = resolveAudienceFilter(audienceFilter, audienceFilters)

  const orderedAudienceItems = useMemo(
    () => selectAudienceItems(audienceItems, activeAudienceFilter, selectedRecipientIds),
    [activeAudienceFilter, audienceItems, selectedRecipientIds],
  )

  // Auto-title: only when the user hasn't touched the field AND we have
  // something useful to show.
  const autoTitle = useMemo(
    () => buildAutoTitle(allCandidates, selectedRecipientIds, emails),
    [allCandidates, emails, selectedRecipientIds],
  )
  const displayTitle = titleTouched ? title : autoTitle
  const ctaLabel = buildPeopleCtaLabel(
    summarizeAudience(allCandidates, selectedRecipientIds, emails),
  )

  const canContinue =
    !isBusy &&
    (displayTitle.trim().length > 0 ||
      selectedRecipientIds.length > 0 ||
      emails.length > 0 ||
      shareInfo !== null ||
      familyShareInfo !== null)

  // Once a draft exists (share link created, or one carried over from a prior
  // visit), skipping would record into a *different* bondfire and orphan the
  // draft people may already have joined — so hide the escape hatch.
  const canSkip = !isBusy && shareInfo === null && familyShareInfo === null && !existingDraft

  // The resume/discard prompt is for drafts left over from a *previous* visit.
  // Creating a share link creates a draft server-side, which echoes back into
  // the reactive existingDraft query — don't prompt about our own draft.
  const showResumeBanner = Boolean(existingDraft) && shareInfo === null && familyShareInfo === null

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

  const handleCreateFamilyLink = useCallback(() => {
    if (form$.isCreatingFamilyLink.get() || form$.familyShareInfo.get()) return
    Alert.alert(
      'Create a family invitation?',
      'This one-time link can create private Hearth access across teen and adult age groups. Share it only with someone you know and trust offline.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Create link',
          onPress: async () => {
            form$.isCreatingFamilyLink.set(true)
            try {
              const trimmedTitle = (
                form$.titleTouched.get()
                  ? form$.title.get()
                  : buildAutoTitle(
                      allCandidates,
                      form$.selectedRecipientIds.get(),
                      form$.emails.get(),
                    )
              ).trim()
              const draft = await createDraft({
                ...(trimmedTitle.length > 0 ? { title: trimmedTitle } : {}),
              })
              const result = await createFamilyInvite({ bondfireId: draft.bondfireId })
              form$.familyShareInfo.set({ bondfireId: draft.bondfireId, code: result.code })
            } catch (error) {
              telemetry.error('create:family_link', 'Failed to create family invitation', {
                error: String(error),
              })
              Alert.alert(
                'Could not create family link',
                error instanceof Error ? error.message : 'Please try again.',
              )
            } finally {
              form$.isCreatingFamilyLink.set(false)
            }
          },
        },
      ],
    )
  }, [allCandidates, createDraft, createFamilyInvite, form$])

  const handleCopyFamilyLink = useCallback(async () => {
    const info = form$.familyShareInfo.get()
    if (!info) return
    try {
      await Clipboard.setStringAsync(`${FAMILY_INVITE_BASE_URL}/${info.code}`)
      form$.familyCopied.set(true)
      setTimeout(() => form$.familyCopied.set(false), 2000)
    } catch (error) {
      Alert.alert('Copy Failed', error instanceof Error ? error.message : String(error))
    }
  }, [form$])

  const handleShareFamilyLink = useCallback(async () => {
    const info = form$.familyShareInfo.get()
    if (!info) return
    const familyShareUrl = `${FAMILY_INVITE_BASE_URL}/${info.code}`
    try {
      await RNShare.share({
        message: `Connect with me for a private family Hearth on Bondfires. Only accept if you know me offline.\n\n${familyShareUrl}`,
        url: familyShareUrl,
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
              const userId = appStore$.userId.get()
              if (
                segmentMediaEnabled &&
                userId &&
                (await hasSavedDraftCapture(userId, existingDraft._id))
              ) {
                Alert.alert(
                  'Recording saved',
                  'Your recording is waiting to upload. Keep the app open to continue.',
                )
                return
              }
              await discardDraft({ bondfireId: existingDraft._id as Id<'bondfires'> })
              // The draft this session's share link pointed at is gone too.
              form$.shareInfo.set(null)
              form$.familyShareInfo.set(null)
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
  const familyShareUrl = familyShareInfo
    ? `${FAMILY_INVITE_BASE_URL}/${familyShareInfo.code}`
    : null
  const inviteSummary =
    [
      emails.length > 0 ? `${emails.length} email${emails.length === 1 ? '' : 's'}` : null,
      shareUrl ? 'share link ready' : null,
      familyShareUrl ? 'family link ready' : null,
    ]
      .filter(Boolean)
      .join(' · ') || 'Email, share link or family link'

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior="padding">
      <YStack flex={1} backgroundColor={'$background'}>
        <StatusBar barStyle={statusBarStyle} backgroundColor={colors.background} />

        <SparkComposerHeader topInset={insets.top} onClose={onCancel} />
        {modeToggle}

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

          {/* Audience — one rail, filtered. Family / Close Circle / Recent used
              to be three stacked rails; the chips keep each relationship
              visible without the vertical cost. */}
          {audienceItems.length > 0 && (
            <InviteSection
              title="Who's this for?"
              caption={
                selectedRecipientIds.length > 0
                  ? `${selectedRecipientIds.length} selected`
                  : 'Tap to invite people you know.'
              }
            >
              {audienceFilters.length > 0 && (
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={{ paddingHorizontal: 16, gap: 8 }}
                  style={{ marginBottom: 14 }}
                >
                  {audienceFilters.map((definition) => (
                    <AudienceFilterChip
                      key={definition.key}
                      label={definition.label}
                      count={definition.count}
                      active={definition.key === activeAudienceFilter}
                      onPress={() => form$.audienceFilter.set(definition.key)}
                    />
                  ))}
                </ScrollView>
              )}
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={{ paddingHorizontal: 16, gap: 12 }}
              >
                {orderedAudienceItems.map((item) => (
                  <CandidateAvatar
                    key={item.candidate._id}
                    candidate={item.candidate}
                    hint={item.hint}
                    familyConnection={item.group === 'family'}
                    selected={selectedRecipientIds.includes(item.candidate._id)}
                    onToggle={() => toggleRecipient(item.candidate._id)}
                  />
                ))}
              </ScrollView>
            </InviteSection>
          )}

          {/* Email, share link and family link live in a sheet so the people
              you already know stay the focus of the screen. */}
          <YStack paddingHorizontal={16} marginBottom={24}>
            <Pressable
              onPress={() => form$.inviteSheetOpen.set(true)}
              accessibilityRole="button"
              accessibilityLabel="Invite someone new"
              accessibilityHint="Opens email, share link and family link options"
            >
              <XStack
                alignItems="center"
                gap={12}
                paddingVertical={12}
                paddingHorizontal={14}
                borderRadius={12}
                borderWidth={1}
                borderColor={'$borderColor'}
                backgroundColor={'$backgroundHover'}
              >
                <YStack
                  width={32}
                  height={32}
                  borderRadius={16}
                  borderWidth={1.5}
                  borderStyle="dashed"
                  borderColor={'$primary'}
                  alignItems="center"
                  justifyContent="center"
                >
                  <Plus size={16} color={'$primary'} />
                </YStack>
                <YStack flex={1} gap={2}>
                  <Text color={'$color'} fontSize={15} fontWeight="700">
                    Invite someone new
                  </Text>
                  <Text color={'$placeholderColor'} fontSize={12} numberOfLines={1}>
                    {inviteSummary}
                  </Text>
                </YStack>
                <ChevronRight size={18} color={'$placeholderColor'} />
              </XStack>
            </Pressable>
          </YStack>

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
                <Video size={18} color={'$color'} />
              )
            }
          >
            <Text color={'$color'} fontWeight="800" numberOfLines={1}>
              {isSubmitting ? 'Setting up…' : ctaLabel}
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

      <InviteSomeoneSheet
        open={inviteSheetOpen}
        onClose={() => form$.inviteSheetOpen.set(false)}
        isBusy={isBusy}
        emailInput={emailInput}
        onEmailInputChange={(text) => form$.emailInput.set(text)}
        onAddEmail={addEmail}
        emails={emails}
        onRemoveEmail={removeEmail}
        shareUrl={shareUrl}
        copied={copied}
        isCreatingLink={isCreatingLink}
        onCreateShareLink={handleCreateShareLink}
        onCopyLink={handleCopyLink}
        onShareLink={handleShareSheet}
        familyShareUrl={familyShareUrl}
        familyCopied={familyCopied}
        isCreatingFamilyLink={isCreatingFamilyLink}
        onCreateFamilyLink={handleCreateFamilyLink}
        onCopyFamilyLink={handleCopyFamilyLink}
        onShareFamilyLink={handleShareFamilyLink}
      />
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

/** Relationship filter pill — same shape as the feed's mode pills. */
function AudienceFilterChip({
  label,
  count,
  active,
  onPress,
}: {
  label: string
  count: number
  active: boolean
  onPress: () => void
}) {
  return (
    <Pressable
      onPress={onPress}
      hitSlop={{ top: 6, bottom: 6 }}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      accessibilityLabel={`Show ${label}, ${count} ${count === 1 ? 'person' : 'people'}`}
    >
      <XStack
        alignItems="center"
        gap={6}
        paddingHorizontal={14}
        paddingVertical={8}
        borderRadius={999}
        borderWidth={1}
        backgroundColor={active ? '$primary' : '$backgroundHover'}
        borderColor={active ? '$primary' : '$borderColor'}
      >
        <Text fontSize={13} fontWeight="700" color={'$color'}>
          {label}
        </Text>
        <Text fontSize={12} fontWeight="600" color={'$color'} opacity={active ? 0.85 : 0.55}>
          {count}
        </Text>
      </XStack>
    </Pressable>
  )
}

function CandidateAvatar({
  candidate,
  hint,
  familyConnection,
  selected,
  onToggle,
}: {
  candidate: { _id: Id<'users'>; displayName?: string; name?: string; photoUrl?: string }
  hint: string
  familyConnection: boolean
  selected: boolean
  onToggle: () => void
}) {
  const displayName = candidate.displayName ?? candidate.name ?? 'Friend'
  return (
    <Pressable
      onPress={onToggle}
      accessibilityRole="button"
      accessibilityLabel={`${displayName}, ${hint}${selected ? ', selected' : ''}`}
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
          <UserAvatar name={displayName} photoUrl={candidate.photoUrl} size={selected ? 54 : 60} />
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
          {familyConnection && (
            <YStack
              position="absolute"
              top={-2}
              left={-2}
              width={20}
              height={20}
              borderRadius={10}
              backgroundColor={'$background'}
              borderWidth={1}
              borderColor={'$primary'}
              alignItems="center"
              justifyContent="center"
            >
              <ShieldCheck size={12} color={'$primary'} />
            </YStack>
          )}
        </YStack>
        <YStack alignItems="center" gap={1}>
          <Text color={'$color'} fontSize={11} fontWeight="600" numberOfLines={1}>
            {displayName.split(' ')[0]}
          </Text>
          <Text color={'$placeholderColor'} fontSize={10} numberOfLines={1}>
            {hint}
          </Text>
        </YStack>
      </YStack>
    </Pressable>
  )
}

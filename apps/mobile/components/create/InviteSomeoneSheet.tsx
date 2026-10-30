import { useAppThemeColors } from '@bondfires/app'
import { Button, Spinner, Text } from '@bondfires/ui'
import { Check, Copy, Link, Plus, Share, X } from '@tamagui/lucide-icons'
import type { ReactNode } from 'react'
import { Pressable, TextInput } from 'react-native'
import { Sheet, XStack, YStack } from 'tamagui'

interface InviteSomeoneSheetProps {
  open: boolean
  onClose: () => void
  isBusy: boolean
  // Email
  emailInput: string
  onEmailInputChange: (text: string) => void
  onAddEmail: () => void
  emails: string[]
  onRemoveEmail: (email: string) => void
  // Regular share link (creates the draft on demand)
  shareUrl: string | null
  copied: boolean
  isCreatingLink: boolean
  onCreateShareLink: () => void
  onCopyLink: () => void
  onShareLink: () => void
  // Cross-age family link
  familyShareUrl: string | null
  familyCopied: boolean
  isCreatingFamilyLink: boolean
  onCreateFamilyLink: () => void
  onCopyFamilyLink: () => void
  onShareFamilyLink: () => void
}

/**
 * Ways to bring in someone who isn't in the audience rail yet. The state and
 * handlers stay in PreRecordingInviteScreen — links create the draft, which
 * the screen's Skip/Continue rules depend on — so this only renders them.
 */
export function InviteSomeoneSheet(props: InviteSomeoneSheetProps) {
  const { colors } = useAppThemeColors()
  const { open, onClose, isBusy } = props

  return (
    <Sheet
      modal
      open={open}
      onOpenChange={(isOpen: boolean) => {
        if (!isOpen) onClose()
      }}
      snapPoints={[85]}
      dismissOnSnapToBottom
      moveOnKeyboardChange
    >
      <Sheet.Overlay backgroundColor="rgba(0,0,0,0.45)" />
      <Sheet.Frame
        backgroundColor={'$backgroundPress'}
        borderTopLeftRadius={20}
        borderTopRightRadius={20}
        paddingTop={12}
        paddingBottom={32}
      >
        <Sheet.Handle backgroundColor={'$borderColor'} />
        <XStack
          justifyContent="space-between"
          alignItems="center"
          paddingHorizontal={20}
          paddingTop={12}
          paddingBottom={16}
        >
          <YStack gap={2} flex={1}>
            <Text fontSize={20} fontWeight="800">
              Invite someone new
            </Text>
            <Text fontSize={13} color={'$placeholderColor'}>
              They'll join this Bondfire when you post it.
            </Text>
          </YStack>
          <Pressable
            onPress={onClose}
            hitSlop={8}
            accessibilityLabel="Done"
            accessibilityRole="button"
          >
            <Text fontSize={16} fontWeight="800" color={'$primary'}>
              Done
            </Text>
          </Pressable>
        </XStack>

        <Sheet.ScrollView keyboardShouldPersistTaps="handled">
          <SheetSection
            title="By email"
            caption="Existing accounts get a push; new addresses get an email invite."
          >
            <XStack gap={8} alignItems="center">
              <TextInput
                value={props.emailInput}
                onChangeText={props.onEmailInputChange}
                onSubmitEditing={props.onAddEmail}
                placeholder="friend@example.com"
                placeholderTextColor={colors.placeholderColor}
                accessibilityLabel="Email address to invite"
                keyboardType="email-address"
                autoCapitalize="none"
                autoCorrect={false}
                maxLength={254}
                returnKeyType="done"
                style={{
                  flex: 1,
                  backgroundColor: colors.background,
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
                onPress={props.onAddEmail}
                icon={<Plus size={16} color={'$color'} />}
              >
                <Text color={'$color'} fontWeight="700">
                  Add
                </Text>
              </Button>
            </XStack>
            {props.emails.length > 0 && (
              <XStack gap={8} flexWrap="wrap">
                {props.emails.map((entry) => (
                  <EmailChip
                    key={entry}
                    email={entry}
                    onRemove={() => props.onRemoveEmail(entry)}
                  />
                ))}
              </XStack>
            )}
          </SheetSection>

          <SheetSection
            title="Share a regular invite"
            caption="For people in your age group or an existing family connection."
          >
            <LinkControls
              url={props.shareUrl}
              copied={props.copied}
              isCreating={props.isCreatingLink}
              isBusy={isBusy}
              createLabel="Create share link"
              creatingLabel="Creating link…"
              onCreate={props.onCreateShareLink}
              onCopy={props.onCopyLink}
              onShare={props.onShareLink}
            />
          </SheetSection>

          <SheetSection
            title="Invite family across age groups"
            caption="Creates a 24-hour, one-time link with an explicit acceptance step."
          >
            <Text color="$placeholderColor" fontSize={12} lineHeight={18}>
              Share only with someone you know and trust offline. Bondfires does not verify legal or
              biological relationships, and either person can revoke access later.
            </Text>
            <LinkControls
              url={props.familyShareUrl}
              copied={props.familyCopied}
              isCreating={props.isCreatingFamilyLink}
              isBusy={isBusy}
              createLabel="Create family link"
              creatingLabel="Creating…"
              onCreate={props.onCreateFamilyLink}
              onCopy={props.onCopyFamilyLink}
              onShare={props.onShareFamilyLink}
            />
          </SheetSection>
        </Sheet.ScrollView>
      </Sheet.Frame>
    </Sheet>
  )
}

function SheetSection({
  title,
  caption,
  children,
}: {
  title: string
  caption: string
  children: ReactNode
}) {
  return (
    <YStack paddingHorizontal={20} marginBottom={24} gap={10}>
      <YStack gap={2}>
        <Text color={'$color'} fontWeight="700" fontSize={16}>
          {title}
        </Text>
        <Text color={'$placeholderColor'} fontSize={12}>
          {caption}
        </Text>
      </YStack>
      {children}
    </YStack>
  )
}

function LinkControls({
  url,
  copied,
  isCreating,
  isBusy,
  createLabel,
  creatingLabel,
  onCreate,
  onCopy,
  onShare,
}: {
  url: string | null
  copied: boolean
  isCreating: boolean
  isBusy: boolean
  createLabel: string
  creatingLabel: string
  onCreate: () => void
  onCopy: () => void
  onShare: () => void
}) {
  if (!url) {
    return (
      <Button
        variant="outline"
        size="$md"
        onPress={onCreate}
        disabled={isBusy}
        icon={
          isCreating ? (
            <Spinner size="small" color={'$color'} />
          ) : (
            <Link size={16} color={'$color'} />
          )
        }
      >
        <Text color={'$color'} fontWeight="700">
          {isCreating ? creatingLabel : createLabel}
        </Text>
      </Button>
    )
  }
  return (
    <>
      <XStack
        alignItems="center"
        gap={10}
        padding={12}
        borderRadius={12}
        borderWidth={1}
        borderColor={'$borderColor'}
        backgroundColor={'$background'}
      >
        <Link size={18} color={'$placeholderColor'} />
        <Text color={'$color'} fontSize={13} flex={1} numberOfLines={1}>
          {url}
        </Text>
      </XStack>
      <XStack gap={10}>
        <Button
          flex={1}
          variant="primary"
          size="$md"
          onPress={onCopy}
          icon={copied ? <Check size={16} color={'$color'} /> : <Copy size={16} color={'$color'} />}
        >
          <Text color={'$color'} fontWeight="700">
            {copied ? 'Copied' : 'Copy'}
          </Text>
        </Button>
        <Button
          flex={1}
          variant="outline"
          size="$md"
          onPress={onShare}
          icon={<Share size={16} color={'$color'} />}
        >
          <Text color={'$color'} fontWeight="700">
            Share
          </Text>
        </Button>
      </XStack>
    </>
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

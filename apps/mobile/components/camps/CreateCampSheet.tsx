import { parseError } from '@bondfires/app'
import { Button, Input, Spinner, Text } from '@bondfires/ui'
import { useObservable, useValue } from '@legendapp/state/react'
import { useMutation } from 'convex/react'
import { Alert } from 'react-native'
import { Sheet, XStack, YStack } from 'tamagui'
import { api } from '../../../../convex/_generated/api'
import type { Id } from '../../../../convex/_generated/dataModel'
import type { CampVisibilityChoice } from '../../lib/campSettings'
import { SectionLabel, VisibilityPicker } from './CampSettingsControls'

/** createPublicCamp requires a purpose of at least this many characters. */
const PUBLIC_PURPOSE_MIN = 10

const EMPTY_FORM = {
  name: '',
  purpose: '',
  visibility: 'public' as CampVisibilityChoice['visibility'],
  join: 'approval' as CampVisibilityChoice['join'],
  isSubmitting: false,
}

/**
 * Pro's Create Camp sheet: choose Public or Private first, then name it.
 * Public camps go through createPublicCamp (Pro + kindling), private ones
 * through createPrivateCamp. Both use one kindling a month.
 */
export function CreateCampSheet({
  open,
  onOpenChange,
  canChoosePublic,
  kindlingBalance,
  onCreated,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  canChoosePublic: boolean
  /** Undefined while loading or for tiers that don't use kindling. */
  kindlingBalance: number | undefined
  onCreated: (campId: Id<'camps'>) => void
}) {
  const createPublicCamp = useMutation(api.camps.createPublicCamp)
  const createPrivateCamp = useMutation(api.camps.createPrivateCamp)
  const form$ = useObservable({
    ...EMPTY_FORM,
    visibility: canChoosePublic ? EMPTY_FORM.visibility : ('private' as const),
  })
  const name = useValue(form$.name)
  const purpose = useValue(form$.purpose)
  const visibility = useValue(form$.visibility)
  const join = useValue(form$.join)
  const isSubmitting = useValue(form$.isSubmitting)
  const isPublic = visibility === 'public'
  const outOfKindling = kindlingBalance !== undefined && kindlingBalance < 1

  const handleCreate = async () => {
    const trimmedName = form$.name.get().trim()
    const trimmedPurpose = form$.purpose.get().trim()
    const wantsPublic = form$.visibility.get() === 'public'
    if (trimmedName.length < 3) {
      Alert.alert('Name Required', 'Give your camp a name of at least 3 characters.')
      return
    }
    if (wantsPublic && trimmedPurpose.length < PUBLIC_PURPOSE_MIN) {
      Alert.alert(
        'Purpose Required',
        'Public camps need a purpose of at least 10 characters so people know what they’re joining.',
      )
      return
    }
    if (outOfKindling) {
      Alert.alert('Camp Kindling Required', 'Buy a kindling pack to create more camps.')
      return
    }

    form$.isSubmitting.set(true)
    try {
      const campId = wantsPublic
        ? await createPublicCamp({
            name: trimmedName,
            purpose: trimmedPurpose,
            access: form$.join.get(),
          })
        : await createPrivateCamp({
            name: trimmedName,
            purpose: trimmedPurpose || undefined,
          })
      form$.set({ ...EMPTY_FORM, visibility: form$.visibility.get() })
      onOpenChange(false)
      onCreated(campId)
    } catch (error) {
      Alert.alert('Camp Unavailable', parseError(error).message)
    } finally {
      form$.isSubmitting.set(false)
    }
  }

  return (
    <Sheet
      modal
      open={open}
      onOpenChange={onOpenChange}
      snapPointsMode="fit"
      dismissOnSnapToBottom
      moveOnKeyboardChange
    >
      <Sheet.Overlay backgroundColor="rgba(0,0,0,0.45)" />
      <Sheet.Frame padding={20} backgroundColor={'$backgroundPress'} gap={16}>
        <Sheet.Handle backgroundColor={'$borderColor'} />
        <YStack gap={6}>
          <Text fontSize={22} fontWeight="900">
            Create Camp
          </Text>
          <Text fontSize={14} color={'$placeholderColor'} lineHeight={20}>
            You lead it. Choose who can find it.
          </Text>
        </YStack>

        <VisibilityPicker
          compact
          canChoosePublic={canChoosePublic}
          value={{ visibility, join }}
          onChange={(choice) => {
            form$.visibility.set(choice.visibility)
            form$.join.set(choice.join)
          }}
        />

        <YStack gap={10}>
          <YStack gap={6}>
            <SectionLabel>NAME</SectionLabel>
            <Input
              value={name}
              onChangeText={(text) => form$.name.set(text)}
              placeholder="Camp name"
              accessibilityLabel="Camp name"
            />
          </YStack>
          <YStack gap={6}>
            <SectionLabel>{isPublic ? 'PURPOSE' : 'PURPOSE (OPTIONAL)'}</SectionLabel>
            <Input
              value={purpose}
              onChangeText={(text) => form$.purpose.set(text)}
              placeholder="Purpose, theme, or focus"
              accessibilityLabel="Camp purpose"
            />
          </YStack>
        </YStack>

        {kindlingBalance !== undefined ? (
          <XStack
            alignItems="center"
            justifyContent="space-between"
            gap={10}
            borderRadius={10}
            backgroundColor={'$backgroundHover'}
            borderWidth={1}
            borderColor={'$borderColor'}
            padding={10}
          >
            <YStack gap={2}>
              <Text fontSize={11} color={'$placeholderColor'} fontWeight="900">
                CAMP KINDLING
              </Text>
              <Text fontSize={15} fontWeight="900" color={outOfKindling ? '$error' : '$success'}>
                {kindlingBalance} kindling remaining
              </Text>
            </YStack>
            <Text fontSize={12} color={'$placeholderColor'}>
              {outOfKindling ? 'Buy a pack to create more' : 'Uses 1 a month'}
            </Text>
          </XStack>
        ) : null}

        <Button
          variant="primary"
          size="$lg"
          disabled={isSubmitting || outOfKindling}
          onPress={handleCreate}
        >
          {isSubmitting ? (
            <Spinner color={'$color'} />
          ) : (
            <Text color={'$color'} fontWeight="900">
              {isPublic ? 'Create public camp' : 'Create private camp'}
            </Text>
          )}
        </Button>
      </Sheet.Frame>
    </Sheet>
  )
}

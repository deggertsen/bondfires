import { parseError } from '@bondfires/app'
import { Button, Input, Spinner, Text } from '@bondfires/ui'
import { useObservable, useValue } from '@legendapp/state/react'
import { useMutation } from 'convex/react'
import { useRouter } from 'expo-router'
import { Alert } from 'react-native'
import { YStack } from 'tamagui'
import { api } from '../../../../../../../convex/_generated/api'
import { CAMP_SETTINGS_LIMITS } from '../../../../../../../convex/lib/campSettingsPolicy'
import { SectionLabel } from '../../../../../components/camps/CampSettingsControls'
import {
  CampSettingsScaffold,
  type OwnedCamp,
  useOwnedCamp,
} from '../../../../../components/camps/CampSettingsScaffold'

function DetailsForm({ camp }: { camp: OwnedCamp }) {
  const router = useRouter()
  const updateDetails = useMutation(api.camps.updateCampDetails)
  const form$ = useObservable({
    name: camp.name,
    purpose: camp.purpose,
    defaultPrompt: camp.defaultPrompt ?? '',
    isSaving: false,
  })
  const name = useValue(form$.name)
  const purpose = useValue(form$.purpose)
  const prompt = useValue(form$.defaultPrompt)
  const isSaving = useValue(form$.isSaving)

  const handleSave = async () => {
    const next = {
      name: form$.name.get().trim(),
      purpose: form$.purpose.get().trim(),
      defaultPrompt: form$.defaultPrompt.get().trim(),
    }
    // Send only what changed so an untouched field can't fail validation.
    const changes = {
      name: next.name !== camp.name ? next.name : undefined,
      purpose: next.purpose !== camp.purpose ? next.purpose : undefined,
      defaultPrompt:
        next.defaultPrompt !== (camp.defaultPrompt ?? '') ? next.defaultPrompt : undefined,
    }
    if (Object.values(changes).every((value) => value === undefined)) {
      router.back()
      return
    }
    form$.isSaving.set(true)
    try {
      await updateDetails({ campId: camp._id, ...changes })
      router.back()
    } catch (error) {
      Alert.alert('Couldn’t save', parseError(error).message)
    } finally {
      form$.isSaving.set(false)
    }
  }

  return (
    <YStack gap={18}>
      <YStack gap={6}>
        <SectionLabel>NAME</SectionLabel>
        <Input
          value={name}
          onChangeText={(text) => form$.name.set(text)}
          maxLength={CAMP_SETTINGS_LIMITS.nameMax}
          accessibilityLabel="Camp name"
        />
      </YStack>
      <YStack gap={6}>
        <SectionLabel>PURPOSE</SectionLabel>
        <Input
          value={purpose}
          onChangeText={(text) => form$.purpose.set(text)}
          maxLength={CAMP_SETTINGS_LIMITS.purposeMax}
          multiline
          minHeight={88}
          textAlignVertical="top"
          paddingVertical={10}
          accessibilityLabel="Camp purpose"
        />
        <Text fontSize={12} color={'$placeholderColor'}>
          Shown on the camp page and in Browse.
        </Text>
      </YStack>
      <YStack gap={6}>
        <SectionLabel>PROMPT</SectionLabel>
        <Input
          value={prompt}
          onChangeText={(text) => form$.defaultPrompt.set(text)}
          maxLength={CAMP_SETTINGS_LIMITS.promptMax}
          placeholder="What’s on your mind this week?"
          accessibilityLabel="Camp prompt"
        />
        <Text fontSize={12} color={'$placeholderColor'}>
          A question to get people started when they spark here.
        </Text>
      </YStack>
      <Button variant="primary" size="$lg" disabled={isSaving} onPress={handleSave}>
        {isSaving ? (
          <Spinner color={'$color'} />
        ) : (
          <Text color={'$color'} fontWeight="900">
            Save
          </Text>
        )}
      </Button>
    </YStack>
  )
}

export default function CampDetailsSettingsScreen() {
  const { campId, camp } = useOwnedCamp()
  return (
    <CampSettingsScaffold title="Details" campId={campId} camp={camp} backTo="settings">
      {(owned) => <DetailsForm camp={owned} />}
    </CampSettingsScaffold>
  )
}

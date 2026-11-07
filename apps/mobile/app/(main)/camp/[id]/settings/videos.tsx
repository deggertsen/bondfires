import { parseError, useAppThemeColors } from '@bondfires/app'
import { Button, Spinner, Text } from '@bondfires/ui'
import { useObservable, useValue } from '@legendapp/state/react'
import { useMutation } from 'convex/react'
import { useRouter } from 'expo-router'
import { Alert, Switch } from 'react-native'
import { XStack, YStack } from 'tamagui'
import { api } from '../../../../../../../convex/_generated/api'
import {
  CAMP_SETTINGS_LIMITS,
  readCampRulesInput,
} from '../../../../../../../convex/lib/campSettingsPolicy'
import { LimitControl, SectionLabel } from '../../../../../components/camps/CampSettingsControls'
import {
  CampSettingsScaffold,
  type OwnedCamp,
  useOwnedCamp,
} from '../../../../../components/camps/CampSettingsScaffold'

function VideosForm({ camp }: { camp: OwnedCamp }) {
  const router = useRouter()
  const { colors } = useAppThemeColors()
  const updateRules = useMutation(api.camps.updateCampRules)
  const rules$ = useObservable(readCampRulesInput(camp.rules))
  const ui$ = useObservable({ isSaving: false })
  const maxDuration = useValue(rules$.maxDurationMinutes)
  const maxResponses = useValue(rules$.maxResponses)
  const requiresTradeTags = useValue(rules$.requiresTradeTags)
  const isSaving = useValue(ui$.isSaving)

  const handleSave = async () => {
    ui$.isSaving.set(true)
    try {
      await updateRules({ campId: camp._id, rules: rules$.get() })
      router.back()
    } catch (error) {
      Alert.alert('Couldn’t save', parseError(error).message)
    } finally {
      ui$.isSaving.set(false)
    }
  }

  return (
    <YStack gap={22}>
      <YStack gap={8}>
        <SectionLabel>LONGEST VIDEO</SectionLabel>
        <LimitControl
          label="Longest video"
          unit="min"
          value={maxDuration}
          defaultValue={10}
          min={1}
          max={CAMP_SETTINGS_LIMITS.maxDurationMinutes}
          onChange={(value) => rules$.maxDurationMinutes.set(value)}
        />
        <Text fontSize={12} color={'$placeholderColor'} lineHeight={17}>
          {maxDuration === null
            ? 'Each person can record up to their plan’s limit (5 min on Free, up to 3 hours on Pro).'
            : 'Applies to sparks and responses. Nobody goes past their own plan: Free members still stop at 5 min.'}
        </Text>
      </YStack>

      <YStack gap={8}>
        <SectionLabel>RESPONSES PER BONDFIRE</SectionLabel>
        <LimitControl
          label="Responses per Bondfire"
          value={maxResponses}
          defaultValue={10}
          min={1}
          max={CAMP_SETTINGS_LIMITS.maxResponses}
          onChange={(value) => rules$.maxResponses.set(value)}
        />
        <Text fontSize={12} color={'$placeholderColor'} lineHeight={17}>
          {maxResponses === null
            ? 'Bondfires take as many responses as people want to give.'
            : `Once a Bondfire has ${maxResponses} ${maxResponses === 1 ? 'response' : 'responses'}, it stops taking new ones.`}
        </Text>
      </YStack>

      <XStack
        alignItems="center"
        gap={12}
        padding={14}
        borderRadius={14}
        backgroundColor={'$backgroundHover'}
        borderWidth={1}
        borderColor={'$borderColor'}
      >
        <YStack flex={1} gap={2}>
          <Text fontSize={15} fontWeight="800">
            Need / offer tags
          </Text>
          <Text fontSize={12} color={'$placeholderColor'} lineHeight={17}>
            Ask people to tag what they need or can offer when they spark. Good for trading camps.
          </Text>
        </YStack>
        <Switch
          value={requiresTradeTags}
          onValueChange={(value) => rules$.requiresTradeTags.set(value)}
          trackColor={{ true: colors.primary, false: colors.borderColor }}
          accessibilityLabel="Need / offer tags"
        />
      </XStack>

      <YStack gap={8}>
        <Text fontSize={12} color={'$placeholderColor'} textAlign="center">
          New limits apply to videos recorded from now on.
        </Text>
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
    </YStack>
  )
}

export default function CampVideosSettingsScreen() {
  const { campId, camp } = useOwnedCamp()
  return (
    <CampSettingsScaffold
      title="Videos and responses"
      campId={campId}
      camp={camp}
      backTo="settings"
    >
      {(owned) => <VideosForm camp={owned} />}
    </CampSettingsScaffold>
  )
}

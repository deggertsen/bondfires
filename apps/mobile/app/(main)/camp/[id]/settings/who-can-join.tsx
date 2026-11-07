import { parseError } from '@bondfires/app'
import { Button, Spinner, Text } from '@bondfires/ui'
import { useObservable, useValue } from '@legendapp/state/react'
import { useMutation } from 'convex/react'
import { useRouter } from 'expo-router'
import { useRef } from 'react'
import { Alert, Pressable } from 'react-native'
import { XStack, YStack } from 'tamagui'
import { api } from '../../../../../../../convex/_generated/api'
import {
  ALL_CAMP_TIERS,
  type CampGenderRule,
  type CampRuleVisibilityMode,
  campAgeBounds,
  changedCampRules,
  readCampRulesInput,
} from '../../../../../../../convex/lib/campSettingsPolicy'
import {
  LimitControl,
  SectionLabel,
  SegmentedControl,
} from '../../../../../components/camps/CampSettingsControls'
import {
  CampSettingsScaffold,
  type OwnedCamp,
  useOwnedCamp,
} from '../../../../../components/camps/CampSettingsScaffold'
import { tierLabel } from '../../../../../lib/campSettings'

const MODE_OPTIONS: { value: CampRuleVisibilityMode; title: string; detail: string }[] = [
  {
    value: 'gate',
    title: 'Show it, but they can’t join',
    detail: 'They see the camp and why they can’t join.',
  },
  { value: 'hide', title: 'Hide it from them', detail: 'It never shows up in their Browse.' },
]

function WhoCanJoinForm({ camp }: { camp: OwnedCamp }) {
  const router = useRouter()
  const updateRules = useMutation(api.camps.updateCampRules)
  const bounds = campAgeBounds(camp.ageBand ?? 'adult')
  const initialRules = useRef(readCampRulesInput(camp.rules)).current
  const rules$ = useObservable(readCampRulesInput(camp.rules))
  const ui$ = useObservable({ isSaving: false })
  const gender = useValue(rules$.gender)
  const minAge = useValue(rules$.minAge)
  const maxAge = useValue(rules$.maxAge)
  const tiers = useValue(rules$.allowedTiers)
  const mode = useValue(rules$.visibilityMode)
  const isSaving = useValue(ui$.isSaving)

  const toggleTier = (tier: (typeof ALL_CAMP_TIERS)[number]) => {
    const current = rules$.allowedTiers.get()
    if (current.includes(tier)) {
      if (current.length === 1) return // at least one plan must be able to join
      rules$.allowedTiers.set(current.filter((t) => t !== tier))
    } else {
      rules$.allowedTiers.set([...current, tier])
    }
  }

  const handleSave = async () => {
    ui$.isSaving.set(true)
    try {
      await updateRules({
        campId: camp._id,
        rules: changedCampRules(initialRules, rules$.get(), [
          'gender',
          'minAge',
          'maxAge',
          'allowedTiers',
          'visibilityMode',
        ]),
      })
      router.back()
    } catch (error) {
      Alert.alert('Couldn’t save', parseError(error).message)
    } finally {
      ui$.isSaving.set(false)
    }
  }

  const allTiers = ALL_CAMP_TIERS.every((tier) => tiers.includes(tier))

  return (
    <YStack gap={20}>
      <YStack gap={8}>
        <SectionLabel>GENDER</SectionLabel>
        <SegmentedControl<CampGenderRule>
          accessibilityLabel="Gender"
          options={[
            { value: 'any', label: 'Anyone' },
            { value: 'male', label: 'Men' },
            { value: 'female', label: 'Women' },
          ]}
          value={gender}
          onChange={(value) => rules$.gender.set(value)}
        />
      </YStack>

      <YStack gap={8}>
        <SectionLabel>MINIMUM AGE</SectionLabel>
        <LimitControl
          label="Minimum age"
          noLimitLabel="No minimum"
          value={minAge}
          defaultValue={Math.min(bounds.max, Math.max(bounds.min, 21))}
          min={bounds.min}
          max={maxAge ?? bounds.max}
          onChange={(value) => rules$.minAge.set(value)}
        />
      </YStack>

      <YStack gap={8}>
        <SectionLabel>MAXIMUM AGE</SectionLabel>
        <LimitControl
          label="Maximum age"
          noLimitLabel="No maximum"
          value={maxAge}
          defaultValue={bounds.max === 17 ? 17 : 65}
          min={minAge ?? bounds.min}
          max={bounds.max}
          onChange={(value) => rules$.maxAge.set(value)}
        />
      </YStack>

      <YStack gap={8}>
        <SectionLabel>PLAN</SectionLabel>
        <XStack flexWrap="wrap" gap={8}>
          {ALL_CAMP_TIERS.map((tier) => {
            const on = tiers.includes(tier)
            return (
              <Pressable
                key={tier}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: on }}
                accessibilityLabel={`${tierLabel(tier)} members can join`}
                onPress={() => toggleTier(tier)}
              >
                <YStack
                  height={40}
                  paddingHorizontal={16}
                  borderRadius={999}
                  justifyContent="center"
                  backgroundColor={'$backgroundHover'}
                  borderWidth={on ? 2 : 1}
                  borderColor={on ? '$primary' : '$borderColor'}
                >
                  <Text fontSize={13} fontWeight="900" color={on ? '$color' : '$placeholderColor'}>
                    {tierLabel(tier)}
                  </Text>
                </YStack>
              </Pressable>
            )
          })}
        </XStack>
        <Text fontSize={12} color={'$placeholderColor'}>
          {allTiers
            ? 'All plans can join. Turn a plan off to keep it out.'
            : 'Only the highlighted plans can join.'}
        </Text>
      </YStack>

      <YStack gap={8}>
        <SectionLabel>IF SOMEONE DOESN’T MATCH</SectionLabel>
        <YStack
          borderRadius={14}
          backgroundColor={'$backgroundHover'}
          borderWidth={1}
          borderColor={'$borderColor'}
          overflow="hidden"
          accessibilityRole="radiogroup"
        >
          {MODE_OPTIONS.map((option, index) => {
            const selected = option.value === mode
            return (
              <Pressable
                key={option.value}
                accessibilityRole="radio"
                accessibilityState={{ checked: selected }}
                onPress={() => rules$.visibilityMode.set(option.value)}
              >
                <XStack
                  alignItems="center"
                  gap={12}
                  padding={14}
                  borderBottomWidth={index === MODE_OPTIONS.length - 1 ? 0 : 1}
                  borderBottomColor={'$borderColor'}
                >
                  <YStack
                    width={20}
                    height={20}
                    borderRadius={10}
                    borderWidth={selected ? 6 : 2}
                    borderColor={selected ? '$primary' : '$placeholderColor'}
                  />
                  <YStack flex={1} gap={2}>
                    <Text fontSize={15} fontWeight="800">
                      {option.title}
                    </Text>
                    <Text fontSize={12} color={'$placeholderColor'}>
                      {option.detail}
                    </Text>
                  </YStack>
                </XStack>
              </Pressable>
            )
          })}
        </YStack>
      </YStack>

      <YStack gap={8}>
        <Text fontSize={12} color={'$placeholderColor'} textAlign="center" lineHeight={17}>
          {[
            'Everyone already in stays.',
            gender !== 'any'
              ? 'Members who don’t match the gender setting can watch but not post.'
              : null,
            allTiers ? null : 'Plans you turn off can’t spark here.',
          ]
            .filter(Boolean)
            .join(' ')}
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

export default function CampWhoCanJoinSettingsScreen() {
  const { campId, camp } = useOwnedCamp()
  return (
    <CampSettingsScaffold title="Who can join" campId={campId} camp={camp} backTo="settings">
      {(owned) => <WhoCanJoinForm camp={owned} />}
    </CampSettingsScaffold>
  )
}

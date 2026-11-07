import { parseError, useAppThemeColors } from '@bondfires/app'
import { Button, Spinner, Text } from '@bondfires/ui'
import { useObservable, useValue } from '@legendapp/state/react'
import { ChevronDown, ChevronUp, Plus, Trash2 } from '@tamagui/lucide-icons'
import { useMutation } from 'convex/react'
import { useRouter } from 'expo-router'
import type { ComponentType } from 'react'
import { Alert, Pressable, TextInput } from 'react-native'
import { XStack, YStack } from 'tamagui'
import { api } from '../../../../../../../convex/_generated/api'
import {
  CAMP_SETTINGS_LIMITS,
  readCampRulesInput,
} from '../../../../../../../convex/lib/campSettingsPolicy'
import {
  CampSettingsScaffold,
  type OwnedCamp,
  useOwnedCamp,
} from '../../../../../components/camps/CampSettingsScaffold'

function IconButton({
  icon: Icon,
  label,
  disabled,
  onPress,
}: {
  icon: ComponentType<{ size?: number; color?: string }>
  label: string
  disabled?: boolean
  onPress: () => void
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      hitSlop={4}
    >
      <YStack
        width={36}
        height={44}
        alignItems="center"
        justifyContent="center"
        opacity={disabled ? 0.3 : 1}
      >
        <Icon size={18} color={'$placeholderColor'} />
      </YStack>
    </Pressable>
  )
}

function GuidelinesForm({ camp }: { camp: OwnedCamp }) {
  const router = useRouter()
  const { colors } = useAppThemeColors()
  const updateRules = useMutation(api.camps.updateCampRules)
  const rules$ = useObservable(readCampRulesInput(camp.rules))
  const ui$ = useObservable({ draft: '', isSaving: false })
  const items = useValue(rules$.guidelines)
  const draft = useValue(ui$.draft)
  const isSaving = useValue(ui$.isSaving)
  const atLimit = items.length >= CAMP_SETTINGS_LIMITS.guidelines

  const addDraft = () => {
    const text = ui$.draft.get().trim()
    if (!text || rules$.guidelines.get().length >= CAMP_SETTINGS_LIMITS.guidelines) return
    rules$.guidelines.set([...rules$.guidelines.get(), text])
    ui$.draft.set('')
  }

  const move = (index: number, delta: -1 | 1) => {
    const next = [...rules$.guidelines.get()]
    const target = index + delta
    if (target < 0 || target >= next.length) return
    ;[next[index], next[target]] = [next[target], next[index]]
    rules$.guidelines.set(next)
  }

  const remove = (index: number) => {
    rules$.guidelines.set(rules$.guidelines.get().filter((_, i) => i !== index))
  }

  const handleSave = async () => {
    // A typed but un-added line is almost certainly meant to be kept.
    addDraft()
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
    <YStack gap={14}>
      <Text fontSize={14} color={'$placeholderColor'} lineHeight={20}>
        Shown on the camp page, and to people before they join. Bondfires’ community guidelines
        always apply too.
      </Text>

      <YStack
        borderRadius={14}
        backgroundColor={'$backgroundHover'}
        borderWidth={1}
        borderColor={'$borderColor'}
        overflow="hidden"
      >
        {items.map((line, index) => (
          <XStack
            // biome-ignore lint/suspicious/noArrayIndexKey: lines can repeat while editing; position is the identity
            key={`${index}-${line}`}
            alignItems="center"
            gap={2}
            paddingLeft={14}
            paddingRight={4}
            minHeight={56}
            borderBottomWidth={1}
            borderBottomColor={'$borderColor'}
          >
            <Text flex={1} fontSize={15} lineHeight={20} paddingVertical={10}>
              {line}
            </Text>
            <IconButton
              icon={ChevronUp}
              label={`Move “${line}” up`}
              disabled={index === 0}
              onPress={() => move(index, -1)}
            />
            <IconButton
              icon={ChevronDown}
              label={`Move “${line}” down`}
              disabled={index === items.length - 1}
              onPress={() => move(index, 1)}
            />
            <IconButton icon={Trash2} label={`Delete “${line}”`} onPress={() => remove(index)} />
          </XStack>
        ))}
        <XStack alignItems="center" gap={10} paddingLeft={14} paddingRight={8} minHeight={56}>
          <Plus size={18} color={atLimit ? '$placeholderColor' : '$primary'} />
          <TextInput
            value={draft}
            onChangeText={(text) => ui$.draft.set(text)}
            onSubmitEditing={addDraft}
            editable={!atLimit}
            placeholder={atLimit ? 'That’s the most a camp can have' : 'Add a guideline'}
            placeholderTextColor={colors.placeholderColor}
            maxLength={CAMP_SETTINGS_LIMITS.guidelineLength}
            returnKeyType="done"
            accessibilityLabel="Add a guideline"
            style={{ flex: 1, color: colors.color, fontSize: 15, paddingVertical: 12 }}
          />
          {draft.trim() ? (
            <Pressable accessibilityRole="button" onPress={addDraft} hitSlop={6}>
              <Text fontSize={14} fontWeight="900" color={'$primary'}>
                Add
              </Text>
            </Pressable>
          ) : null}
        </XStack>
      </YStack>
      <Text fontSize={12} color={'$placeholderColor'} paddingHorizontal={4}>
        Keep each one to a line. Up to {CAMP_SETTINGS_LIMITS.guidelines}.
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
  )
}

export default function CampGuidelinesSettingsScreen() {
  const { campId, camp } = useOwnedCamp()
  return (
    <CampSettingsScaffold title="Camp guidelines" campId={campId} camp={camp} backTo="settings">
      {(owned) => <GuidelinesForm camp={owned} />}
    </CampSettingsScaffold>
  )
}

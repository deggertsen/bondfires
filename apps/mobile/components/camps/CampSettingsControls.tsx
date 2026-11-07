import { useAppThemeColors } from '@bondfires/app'
import { Text } from '@bondfires/ui'
import { Check, Globe, Lock, Minus, Plus } from '@tamagui/lucide-icons'
import { useEffect, useRef, useState } from 'react'
import { Pressable, TextInput } from 'react-native'
import { XStack, YStack } from 'tamagui'
import {
  type CampJoinMode,
  type CampVisibility,
  type CampVisibilityChoice,
  parseLimitInput,
} from '../../lib/campSettings'

export function SectionLabel({ children }: { children: string }) {
  return (
    <Text fontSize={12} fontWeight="900" color={'$placeholderColor'} letterSpacing={0.4}>
      {children}
    </Text>
  )
}

/** Equal-width pill choices on a sunken track. */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  accessibilityLabel,
}: {
  options: { value: T; label: string }[]
  value: T
  onChange: (value: T) => void
  accessibilityLabel: string
}) {
  return (
    <XStack
      accessibilityRole="radiogroup"
      accessibilityLabel={accessibilityLabel}
      padding={4}
      gap={6}
      borderRadius={12}
      backgroundColor={'$backgroundHover'}
      borderWidth={1}
      borderColor={'$borderColor'}
    >
      {options.map((option) => {
        const selected = option.value === value
        return (
          <Pressable
            key={option.value}
            style={{ flex: 1 }}
            accessibilityRole="radio"
            accessibilityState={{ checked: selected }}
            onPress={() => onChange(option.value)}
          >
            <YStack
              height={40}
              borderRadius={9}
              alignItems="center"
              justifyContent="center"
              backgroundColor={selected ? '$primary' : 'transparent'}
            >
              <Text
                fontSize={13}
                fontWeight="900"
                color={selected ? '$background' : '$color'}
                numberOfLines={1}
              >
                {option.label}
              </Text>
            </YStack>
          </Pressable>
        )
      })}
    </XStack>
  )
}

function VisibilityCard({
  kind,
  title,
  detail,
  selected,
  disabled,
  badge,
  onPress,
  compact,
}: {
  kind: CampVisibility
  title: string
  detail: string
  selected: boolean
  disabled?: boolean
  badge?: string
  onPress: () => void
  compact: boolean
}) {
  const Icon = kind === 'public' ? Globe : Lock
  return (
    <Pressable
      style={compact ? { flex: 1 } : undefined}
      accessibilityRole="radio"
      accessibilityState={{ checked: selected, disabled }}
      accessibilityLabel={`${title}. ${detail}`}
      disabled={disabled}
      onPress={onPress}
    >
      <YStack
        gap={6}
        padding={14}
        borderRadius={16}
        backgroundColor={'$backgroundHover'}
        borderWidth={selected ? 2 : 1}
        borderColor={selected ? '$primary' : '$borderColor'}
        opacity={disabled ? 0.55 : 1}
      >
        <XStack alignItems="center" gap={10}>
          <Icon size={22} color={'$color'} />
          {compact ? null : (
            <Text fontSize={16} fontWeight="900" flex={1}>
              {title}
            </Text>
          )}
          {compact ? <YStack flex={1} /> : null}
          {badge ? (
            <YStack
              paddingHorizontal={6}
              paddingVertical={2}
              borderRadius={5}
              borderWidth={1}
              borderColor={'$borderColor'}
            >
              <Text fontSize={10} fontWeight="900" color={'$placeholderColor'}>
                {badge}
              </Text>
            </YStack>
          ) : null}
          {selected && compact ? (
            <YStack
              width={20}
              height={20}
              borderRadius={10}
              backgroundColor={'$primary'}
              alignItems="center"
              justifyContent="center"
            >
              <Check size={12} color={'$background'} strokeWidth={3.5} />
            </YStack>
          ) : null}
        </XStack>
        {compact ? (
          <Text fontSize={16} fontWeight="900">
            {title}
          </Text>
        ) : null}
        <Text
          fontSize={compact ? 12 : 13}
          color={'$placeholderColor'}
          lineHeight={compact ? 16 : 18}
        >
          {detail}
        </Text>
      </YStack>
    </Pressable>
  )
}

const JOIN_OPTIONS: { value: CampJoinMode; label: string }[] = [
  { value: 'open', label: 'Open' },
  { value: 'approval', label: 'Approval required' },
]

/**
 * Public / Private choice plus, for Public, how people join. `compact` lays
 * the two cards side by side (Create Camp sheet); otherwise they stack with
 * longer copy (Visibility screen).
 */
export function VisibilityPicker({
  value,
  onChange,
  canChoosePublic,
  currentVisibility,
  compact = false,
}: {
  value: CampVisibilityChoice
  onChange: (value: CampVisibilityChoice) => void
  canChoosePublic: boolean
  /** Marks the camp's saved visibility with a CURRENT badge. */
  currentVisibility?: CampVisibility
  compact?: boolean
}) {
  const isPublic = value.visibility === 'public'
  const publicCard = (
    <VisibilityCard
      kind="public"
      title="Public"
      detail={
        compact
          ? canChoosePublic
            ? 'Anyone can find it in Browse'
            : 'Public camps need Pro'
          : canChoosePublic
            ? 'Shows up in Browse. Members with Plus can spark their own Bondfires.'
            : 'Public camps need Pro.'
      }
      selected={isPublic}
      disabled={!canChoosePublic && !isPublic}
      badge={currentVisibility === 'public' ? 'CURRENT' : undefined}
      onPress={() => onChange({ ...value, visibility: 'public' })}
      compact={compact}
    />
  )
  const privateCard = (
    <VisibilityCard
      kind="private"
      title="Private"
      detail={
        compact
          ? 'Invite code only'
          : 'Hidden from Browse. People join with an invite code. Only you spark; members respond.'
      }
      selected={!isPublic}
      badge={currentVisibility === 'private' ? 'CURRENT' : undefined}
      onPress={() => onChange({ ...value, visibility: 'private' })}
      compact={compact}
    />
  )
  const joinControl = isPublic ? (
    <YStack gap={8}>
      <SectionLabel>HOW PEOPLE JOIN</SectionLabel>
      <SegmentedControl
        accessibilityLabel="How people join"
        options={JOIN_OPTIONS}
        value={value.join}
        onChange={(join) => onChange({ ...value, join })}
      />
      <Text fontSize={12} color={'$placeholderColor'} lineHeight={17}>
        {value.join === 'open'
          ? 'Anyone can join right away.'
          : 'You approve each request to join.'}
        {compact ? ' Members with Plus can spark their own Bondfires.' : ''}
      </Text>
    </YStack>
  ) : compact ? (
    <YStack
      padding={12}
      borderRadius={12}
      backgroundColor={'$backgroundHover'}
      borderWidth={1}
      borderColor={'$borderColor'}
    >
      <Text fontSize={12} color={'$placeholderColor'} lineHeight={17}>
        People join with an invite code you share. You spark; members respond.
      </Text>
    </YStack>
  ) : null

  if (compact) {
    return (
      <YStack gap={14}>
        <XStack gap={10} accessibilityRole="radiogroup" accessibilityLabel="Visibility">
          {publicCard}
          {privateCard}
        </XStack>
        {joinControl}
      </YStack>
    )
  }
  return (
    <YStack gap={10} accessibilityRole="radiogroup" accessibilityLabel="Visibility">
      {publicCard}
      {joinControl ? <YStack paddingHorizontal={4}>{joinControl}</YStack> : null}
      {privateCard}
    </YStack>
  )
}

/**
 * "No limit" or a whole number the owner sets with − / + or by typing.
 * `value` null means no limit.
 */
export function LimitControl({
  label,
  unit,
  value,
  defaultValue,
  min,
  max,
  noLimitLabel = 'No limit',
  onChange,
}: {
  label: string
  unit?: string
  value: number | null
  defaultValue: number
  min: number
  max: number
  noLimitLabel?: string
  onChange: (value: number | null) => void
}) {
  const { colors } = useAppThemeColors()
  const [draft, setDraft] = useState(value === null ? '' : String(value))
  const isEditing = useRef(false)
  useEffect(() => {
    if (!isEditing.current) setDraft(value === null ? '' : String(value))
  }, [value])

  const commitDraft = () => {
    const parsed = parseLimitInput(draft, min, max)
    if (parsed === null) {
      setDraft(value === null ? '' : String(value))
      return
    }
    setDraft(String(parsed))
    onChange(parsed)
  }

  return (
    <YStack
      padding={4}
      borderRadius={14}
      backgroundColor={'$backgroundHover'}
      borderWidth={1}
      borderColor={'$borderColor'}
    >
      <SegmentedControl
        accessibilityLabel={label}
        options={[
          { value: 'none', label: noLimitLabel },
          { value: 'set', label: 'Set a limit' },
        ]}
        value={value === null ? 'none' : 'set'}
        onChange={(mode) => {
          isEditing.current = false
          onChange(mode === 'none' ? null : Math.min(max, Math.max(min, value ?? defaultValue)))
        }}
      />
      {value !== null ? (
        <XStack
          alignItems="center"
          gap={10}
          paddingTop={12}
          paddingBottom={8}
          paddingLeft={10}
          paddingRight={6}
        >
          <Text fontSize={15} fontWeight="700" flex={1}>
            {unit === 'min' ? 'Minutes' : label}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Lower ${label.toLowerCase()}`}
            disabled={value <= min}
            onPress={() => {
              const next = Math.max(min, value - 1)
              setDraft(String(next))
              onChange(next)
            }}
          >
            <YStack
              width={44}
              height={44}
              borderRadius={12}
              backgroundColor={'$backgroundPress'}
              alignItems="center"
              justifyContent="center"
              opacity={value <= min ? 0.4 : 1}
            >
              <Minus size={18} color={'$color'} />
            </YStack>
          </Pressable>
          <XStack
            width={84}
            height={44}
            borderRadius={12}
            borderWidth={1}
            borderColor={'$borderColor'}
            backgroundColor={'$background'}
            alignItems="center"
            justifyContent="center"
            gap={4}
          >
            <TextInput
              value={draft}
              onFocus={() => {
                isEditing.current = true
              }}
              onChangeText={(text) => {
                isEditing.current = true
                setDraft(text)
                // Save can run while the keyboard remains open. Keep the
                // form value current without clamping the visible draft mid-entry.
                const parsed = parseLimitInput(text, min, max)
                if (parsed !== null) onChange(parsed)
              }}
              onBlur={() => {
                isEditing.current = false
                commitDraft()
              }}
              onSubmitEditing={commitDraft}
              keyboardType="number-pad"
              returnKeyType="done"
              maxLength={String(max).length}
              accessibilityLabel={label}
              style={{
                color: colors.color,
                fontSize: 19,
                fontWeight: '900',
                textAlign: 'center',
                minWidth: 28,
                padding: 0,
              }}
            />
            {unit ? (
              <Text fontSize={12} color={'$placeholderColor'}>
                {unit}
              </Text>
            ) : null}
          </XStack>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Raise ${label.toLowerCase()}`}
            disabled={value >= max}
            onPress={() => {
              const next = Math.min(max, value + 1)
              setDraft(String(next))
              onChange(next)
            }}
          >
            <YStack
              width={44}
              height={44}
              borderRadius={12}
              backgroundColor={'$backgroundPress'}
              alignItems="center"
              justifyContent="center"
              opacity={value >= max ? 0.4 : 1}
            >
              <Plus size={18} color={'$color'} />
            </YStack>
          </Pressable>
        </XStack>
      ) : null}
    </YStack>
  )
}

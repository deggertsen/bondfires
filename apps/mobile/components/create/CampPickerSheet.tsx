import { useAppThemeColors } from '@bondfires/app'
import { Text } from '@bondfires/ui'
import { useObservable, useValue } from '@legendapp/state/react'
import { Check, Clock, Plus, Search, Tent } from '@tamagui/lucide-icons'
import { useMemo } from 'react'
import { Pressable, TextInput } from 'react-native'
import { Sheet, XStack, YStack } from 'tamagui'
import type { Id } from '../../../../convex/_generated/dataModel'
import type { CampWithMembership } from './shared'
import { type CampPickerList, filterCampsByName, formatMemberCount } from './sparkComposer'

interface CampPickerSheetProps {
  open: boolean
  onClose: () => void
  list: CampPickerList<CampWithMembership>
  selectedCampId: Id<'camps'> | null
  onSelect: (campId: Id<'camps'>) => void
  onFindMore: () => void
}

/**
 * "Choose a camp" sheet behind the Camp tab's camp field. The last-used camp
 * leads; search only appears once the list is long enough to need it.
 */
export function CampPickerSheet({
  open,
  onClose,
  list,
  selectedCampId,
  onSelect,
  onFindMore,
}: CampPickerSheetProps) {
  const { colors } = useAppThemeColors()
  const query$ = useObservable('')
  const query = useValue(query$)

  const lastUsed = list.lastUsed && filterCampsByName([list.lastUsed], query)[0]
  const others = useMemo(() => filterCampsByName(list.others, query), [list.others, query])
  const pending = useMemo(() => filterCampsByName(list.pending, query), [list.pending, query])
  const hasMatches = Boolean(lastUsed) || others.length > 0 || pending.length > 0

  // The sheet stays mounted between opens, so clear the search on every exit.
  const handleOpenChange = (isOpen: boolean) => {
    if (isOpen) return
    query$.set('')
    onClose()
  }
  const select = (campId: Id<'camps'>) => {
    query$.set('')
    onSelect(campId)
  }

  const content = (
    <YStack gap={4}>
      {lastUsed ? (
        <>
          <SectionLabel>Last used</SectionLabel>
          <CampRow
            camp={lastUsed}
            selected={lastUsed._id === selectedCampId}
            onPress={() => select(lastUsed._id)}
          />
        </>
      ) : null}
      {others.length > 0 ? (
        <>
          <SectionLabel>{lastUsed ? 'All your camps' : 'Your camps'}</SectionLabel>
          {others.map((camp) => (
            <CampRow
              key={camp._id}
              camp={camp}
              selected={camp._id === selectedCampId}
              onPress={() => select(camp._id)}
            />
          ))}
        </>
      ) : null}
      {pending.map((camp) => (
        <CampRow key={camp._id} camp={camp} selected={false} pending />
      ))}
      {!hasMatches ? (
        <Text color={'$placeholderColor'} fontSize={14} paddingVertical={20} textAlign="center">
          No camps match “{query.trim()}”.
        </Text>
      ) : null}
    </YStack>
  )

  return (
    <Sheet
      modal
      open={open}
      onOpenChange={handleOpenChange}
      dismissOnSnapToBottom
      moveOnKeyboardChange
      {...(list.showSearch ? { snapPoints: [85] } : { snapPointsMode: 'fit' as const })}
    >
      <Sheet.Overlay backgroundColor="rgba(0,0,0,0.45)" />
      <Sheet.Frame
        backgroundColor={'$backgroundPress'}
        borderTopLeftRadius={20}
        borderTopRightRadius={20}
        paddingHorizontal={16}
        paddingTop={12}
        paddingBottom={32}
        gap={12}
      >
        <Sheet.Handle backgroundColor={'$borderColor'} />
        <XStack alignItems="baseline" justifyContent="space-between" paddingHorizontal={2}>
          <Text fontSize={20} fontWeight="800">
            Choose a camp
          </Text>
          <Text fontSize={13} color={'$placeholderColor'}>
            {list.pickableCount === 1 ? '1 camp' : `${list.pickableCount} camps`}
          </Text>
        </XStack>

        {list.showSearch ? (
          <XStack
            alignItems="center"
            gap={10}
            paddingHorizontal={14}
            borderRadius={12}
            borderWidth={1}
            borderColor={'$borderColor'}
            backgroundColor={'$background'}
          >
            <Search size={16} color={'$placeholderColor'} />
            <TextInput
              value={query}
              onChangeText={(text) => query$.set(text)}
              placeholder="Search your camps"
              placeholderTextColor={colors.placeholderColor}
              accessibilityLabel="Search your camps"
              autoCorrect={false}
              returnKeyType="search"
              style={{ flex: 1, color: colors.color, fontSize: 15, paddingVertical: 11 }}
            />
          </XStack>
        ) : null}

        {list.showSearch ? (
          <Sheet.ScrollView keyboardShouldPersistTaps="handled">{content}</Sheet.ScrollView>
        ) : (
          content
        )}

        <Pressable onPress={onFindMore} accessibilityRole="button">
          <XStack
            height={48}
            borderRadius={12}
            borderWidth={1}
            borderColor={'$borderColor'}
            alignItems="center"
            justifyContent="center"
            gap={8}
          >
            <Plus size={16} color={'$primary'} />
            <Text fontSize={14} fontWeight="700">
              Find more camps
            </Text>
          </XStack>
        </Pressable>
      </Sheet.Frame>
    </Sheet>
  )
}

function SectionLabel({ children }: { children: string }) {
  return (
    <Text
      fontSize={12}
      fontWeight="700"
      letterSpacing={0.7}
      textTransform="uppercase"
      color={'$placeholderColor'}
      paddingTop={10}
      paddingBottom={2}
      paddingHorizontal={2}
    >
      {children}
    </Text>
  )
}

/** Camp color tile used by the sheet rows and the Camp tab's camp field. */
export function CampSwatch({ color, size = 40 }: { color: string | undefined; size?: number }) {
  return (
    <YStack
      width={size}
      height={size}
      borderRadius={size * 0.3}
      backgroundColor={color ?? '$backgroundHover'}
      alignItems="center"
      justifyContent="center"
    >
      <Tent size={size / 2} color={'$color'} />
    </YStack>
  )
}

function CampRow({
  camp,
  selected,
  pending = false,
  onPress,
}: {
  camp: CampWithMembership
  selected: boolean
  pending?: boolean
  onPress?: () => void
}) {
  const memberCount = formatMemberCount(camp.activeMemberCount)
  return (
    <Pressable
      onPress={onPress}
      disabled={pending}
      accessibilityRole="button"
      accessibilityState={{ selected, disabled: pending }}
      accessibilityLabel={`${camp.name}${pending ? ', request pending' : ''}`}
    >
      <XStack alignItems="center" gap={12} paddingVertical={10} paddingHorizontal={2}>
        <YStack opacity={pending ? 0.5 : 1}>
          <CampSwatch color={camp.color} />
        </YStack>
        <YStack flex={1} gap={2}>
          <Text
            fontSize={16}
            fontWeight={selected ? '800' : '700'}
            color={pending ? '$placeholderColor' : '$color'}
            numberOfLines={1}
          >
            {camp.name}
          </Text>
          <Text fontSize={12} color={'$placeholderColor'} numberOfLines={1}>
            {pending ? 'Request pending' : (memberCount ?? camp.theme ?? 'Camp')}
          </Text>
        </YStack>
        {selected ? <Check size={20} color={'$primary'} /> : null}
        {pending ? <Clock size={16} color={'$placeholderColor'} /> : null}
      </XStack>
    </Pressable>
  )
}

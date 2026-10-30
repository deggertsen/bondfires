import { parseError, useAppThemeColors, useAuth } from '@bondfires/app'
import { Button, Spinner, Text } from '@bondfires/ui'
import { useObservable, useValue } from '@legendapp/state/react'
import { Check, ChevronsUpDown, Tent, Video } from '@tamagui/lucide-icons'
import type { FunctionReturnType } from 'convex/server'
import { useRouter } from 'expo-router'
import { type ReactNode, useCallback, useMemo } from 'react'
import { Alert, Pressable, ScrollView, StatusBar } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { XStack, YStack } from 'tamagui'
import type { api } from '../../../../convex/_generated/api'
import type { Id } from '../../../../convex/_generated/dataModel'
import { isAuthSessionErrorMessage, redirectToCampJoinLogin } from '../../lib/campJoinAuth'
import { createForCampPath, routes } from '../../lib/routes'
import { CampPickerSheet, CampSwatch } from './CampPickerSheet'
import { SparkComposerHeader } from './SparkModeToggle'
import { type CampWithMembership, formatMaxDuration, type TradeTag } from './shared'
import {
  buildCampCtaLabel,
  type CampPickerList,
  formatMemberCount,
  suggestCampsToJoin,
} from './sparkComposer'

interface CampSparkPaneProps {
  modeToggle: ReactNode
  onClose: () => void
  /** Every camp from `camps.list`; undefined while loading. */
  camps: CampWithMembership[] | undefined
  pickerList: CampPickerList<CampWithMembership> | null
  selectedCamp: CampWithMembership | null
  /** The caller asked for a camp that is no longer pickable. */
  requestedCampUnavailable: boolean
  maxRecordingSeconds: number | undefined
  tradeTag: TradeTag | null
  userGender: string | undefined
  joinCamp: (args: { campId: Id<'camps'> }) => Promise<FunctionReturnType<typeof api.camps.join>>
  onSelectCamp: (campId: Id<'camps'>) => void
  onTradeTagChange: (tag: TradeTag) => void
  onRecord: () => void
}

/**
 * Camp half of the Spark composer: a camp field that opens the camp sheet, the
 * chosen camp's prompt and rules, and Trading Post's Need/Offer choice. People
 * in no camps get suggestions to join instead.
 */
export function CampSparkPane({
  modeToggle,
  onClose,
  camps,
  pickerList,
  selectedCamp,
  requestedCampUnavailable,
  maxRecordingSeconds,
  tradeTag,
  userGender,
  joinCamp,
  onSelectCamp,
  onTradeTagChange,
  onRecord,
}: CampSparkPaneProps) {
  const { colors, statusBarStyle } = useAppThemeColors()
  const insets = useSafeAreaInsets()
  const router = useRouter()
  const sheetOpen$ = useObservable(false)
  const sheetOpen = useValue(sheetOpen$)

  const handleFindMore = useCallback(() => {
    sheetOpen$.set(false)
    router.replace(routes.camps)
  }, [router, sheetOpen$])

  const requiresTradeTag = selectedCamp?.rules.advisory.requiresTradeTags === true
  const canRecord = !!selectedCamp && (!requiresTradeTag || tradeTag !== null)

  let body: ReactNode
  if (camps === undefined || pickerList === null) {
    body = (
      <YStack flex={1} alignItems="center" justifyContent="center" gap={14}>
        <Spinner size="large" color={'$primary'} />
        <Text color={'$placeholderColor'}>Loading camps...</Text>
      </YStack>
    )
  } else if (pickerList.pickableCount === 0 || !selectedCamp) {
    body = (
      <NoCampsState
        camps={camps}
        pending={pickerList.pending}
        userGender={userGender}
        joinCamp={joinCamp}
        onJoined={onSelectCamp}
        onBrowse={handleFindMore}
      />
    )
  } else {
    const memberCount = formatMemberCount(selectedCamp.activeMemberCount)
    const prompt = selectedCamp.defaultPrompt ?? selectedCamp.purpose
    body = (
      <ScrollView contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 140 }}>
        <YStack gap={8} marginBottom={20}>
          <Text fontSize={16} fontWeight="700">
            Which camp?
          </Text>
          {requestedCampUnavailable ? (
            <Text fontSize={12} color={'$placeholderColor'}>
              That camp isn't available anymore. Pick another below.
            </Text>
          ) : null}
          <Pressable
            onPress={() => sheetOpen$.set(true)}
            accessibilityRole="button"
            accessibilityHint="Opens the list of your camps"
            accessibilityLabel={`Camp: ${selectedCamp.name}`}
          >
            <XStack
              alignItems="center"
              gap={12}
              paddingVertical={12}
              paddingHorizontal={14}
              borderRadius={14}
              borderWidth={1}
              borderColor={'$borderColorHover'}
              backgroundColor={'$backgroundHover'}
            >
              <CampSwatch color={selectedCamp.color} size={36} />
              <YStack flex={1} gap={2}>
                <Text fontSize={16} fontWeight="800" numberOfLines={1}>
                  {selectedCamp.name}
                </Text>
                <Text fontSize={12} color={'$placeholderColor'} numberOfLines={1}>
                  {[memberCount, `1 of ${pickerList.pickableCount}`].filter(Boolean).join(' · ')}
                </Text>
              </YStack>
              <ChevronsUpDown size={20} color={'$color'} />
            </XStack>
          </Pressable>
        </YStack>

        <YStack
          padding={20}
          borderRadius={20}
          borderWidth={1}
          borderColor={'$borderColor'}
          backgroundColor={'$backgroundHover'}
          gap={14}
        >
          <Text
            fontSize={11}
            fontWeight="700"
            letterSpacing={0.9}
            textTransform="uppercase"
            color={'$secondary'}
          >
            Camp prompt
          </Text>
          <Text fontSize={24} lineHeight={30} fontWeight="800">
            {prompt}
          </Text>
          {selectedCamp.defaultPrompt ? (
            <Text fontSize={14} lineHeight={20} color={'$placeholderColor'}>
              {selectedCamp.purpose}
            </Text>
          ) : null}
          <XStack gap={6} flexWrap="wrap">
            {maxRecordingSeconds ? (
              <RuleChip label={`Up to ${formatMaxDuration(maxRecordingSeconds)}`} />
            ) : null}
            {requiresTradeTag ? <RuleChip label="Tag required" /> : null}
            <RuleChip label="Title after recording" />
          </XStack>
          {requiresTradeTag ? (
            <YStack gap={8} paddingTop={14} borderTopWidth={1} borderTopColor={'$borderColor'}>
              <Text fontSize={13} fontWeight="700">
                This spark is a…
              </Text>
              <XStack gap={8} role="radiogroup" accessibilityLabel="Need or offer">
                {(['need', 'offer'] as const).map((tag) => {
                  const selected = tradeTag === tag
                  return (
                    <Pressable
                      key={tag}
                      style={{ flex: 1 }}
                      onPress={() => onTradeTagChange(tag)}
                      accessibilityRole="radio"
                      accessibilityState={{ checked: selected }}
                    >
                      <XStack
                        height={44}
                        borderRadius={12}
                        borderWidth={1}
                        alignItems="center"
                        justifyContent="center"
                        gap={6}
                        borderColor={selected ? '$primary' : '$borderColor'}
                        backgroundColor={selected ? '$primary' : '$background'}
                      >
                        {selected ? <Check size={14} color={'$color'} /> : null}
                        <Text
                          fontSize={15}
                          fontWeight={selected ? '800' : '700'}
                          textTransform="capitalize"
                        >
                          {tag}
                        </Text>
                      </XStack>
                    </Pressable>
                  )
                })}
              </XStack>
            </YStack>
          ) : null}
        </YStack>
      </ScrollView>
    )
  }

  return (
    <YStack flex={1} backgroundColor={'$background'}>
      <StatusBar barStyle={statusBarStyle} backgroundColor={colors.background} />
      <SparkComposerHeader topInset={insets.top} onClose={onClose} />
      {modeToggle}
      {body}

      {selectedCamp && pickerList && pickerList.pickableCount > 0 ? (
        <>
          <YStack
            position="absolute"
            left={0}
            right={0}
            bottom={0}
            paddingHorizontal={16}
            paddingTop={12}
            paddingBottom={Math.max(insets.bottom, 12) + 8}
            backgroundColor={'$background'}
            borderTopWidth={1}
            borderTopColor={'$borderColor'}
          >
            <Button
              variant="primary"
              size="$lg"
              disabled={!canRecord}
              onPress={onRecord}
              icon={<Video size={18} color={'$color'} />}
            >
              <Text color={'$color'} fontWeight="800" numberOfLines={1}>
                {buildCampCtaLabel(selectedCamp.name, requiresTradeTag ? tradeTag : null)}
              </Text>
            </Button>
          </YStack>
          <CampPickerSheet
            open={sheetOpen}
            onClose={() => sheetOpen$.set(false)}
            list={pickerList}
            selectedCampId={selectedCamp._id}
            onSelect={(campId) => {
              sheetOpen$.set(false)
              onSelectCamp(campId)
            }}
            onFindMore={handleFindMore}
          />
        </>
      ) : null}
    </YStack>
  )
}

function RuleChip({ label }: { label: string }) {
  return (
    <XStack
      paddingHorizontal={10}
      paddingVertical={5}
      borderRadius={999}
      borderWidth={1}
      borderColor={'$borderColor'}
    >
      <Text fontSize={12} color={'$color'} opacity={0.85}>
        {label}
      </Text>
    </XStack>
  )
}

function NoCampsState({
  camps,
  pending,
  userGender,
  joinCamp,
  onJoined,
  onBrowse,
}: {
  camps: CampWithMembership[]
  pending: CampWithMembership[]
  userGender: string | undefined
  joinCamp: CampSparkPaneProps['joinCamp']
  onJoined: (campId: Id<'camps'>) => void
  onBrowse: () => void
}) {
  const router = useRouter()
  const { isAuthenticated } = useAuth()
  const joiningCampId$ = useObservable<Id<'camps'> | null>(null)
  const joiningCampId = useValue(joiningCampId$)
  const suggestions = useMemo(() => suggestCampsToJoin(camps, userGender), [camps, userGender])

  const handleJoin = useCallback(
    async (camp: CampWithMembership) => {
      if (!isAuthenticated) {
        redirectToCampJoinLogin(router, camp._id, createForCampPath(camp._id))
        return
      }
      if (joiningCampId$.get()) return
      joiningCampId$.set(camp._id)
      try {
        const result = await joinCamp({ campId: camp._id })
        if (result.status === 'pending') {
          Alert.alert('Request Sent', 'Your camp membership request is pending approval.')
          return
        }
        onJoined(camp._id)
      } catch (error) {
        const info = parseError(error)
        if (isAuthSessionErrorMessage(info.message)) {
          redirectToCampJoinLogin(router, camp._id, createForCampPath(camp._id))
          return
        }
        Alert.alert('Camp Unavailable', info.message)
      } finally {
        joiningCampId$.set(null)
      }
    },
    [isAuthenticated, joinCamp, joiningCampId$, onJoined, router],
  )

  return (
    <ScrollView contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 140 }}>
      <YStack
        alignItems="center"
        gap={12}
        paddingHorizontal={16}
        paddingTop={12}
        paddingBottom={28}
      >
        <YStack
          width={72}
          height={72}
          borderRadius={36}
          alignItems="center"
          justifyContent="center"
          borderWidth={1}
          borderColor={'$primary'}
          backgroundColor={'$backgroundHover'}
        >
          <Tent size={32} color={'$primary'} />
        </YStack>
        <Text fontSize={20} fontWeight="800" textAlign="center">
          You're not in a camp yet
        </Text>
        <Text fontSize={14} lineHeight={20} color={'$placeholderColor'} textAlign="center">
          Camps are open circles around a shared interest. Join one to spark there, or switch to
          People for something private.
        </Text>
      </YStack>

      {pending.length > 0 ? (
        <YStack gap={8} marginBottom={20}>
          <EmptyStateLabel>Waiting for approval</EmptyStateLabel>
          {pending.map((camp) => (
            <SuggestedCampRow key={camp._id} camp={camp} caption="Request pending" />
          ))}
        </YStack>
      ) : null}

      {suggestions.length > 0 ? (
        <YStack gap={8} marginBottom={20}>
          <EmptyStateLabel>Suggested for you</EmptyStateLabel>
          {suggestions.map((camp) => (
            <SuggestedCampRow
              key={camp._id}
              camp={camp}
              caption={camp.purpose}
              joining={joiningCampId === camp._id}
              onJoin={() => handleJoin(camp)}
            />
          ))}
        </YStack>
      ) : null}

      <Button variant="outline" size="$lg" onPress={onBrowse}>
        <Text color={'$color'} fontWeight="800">
          Browse all camps
        </Text>
      </Button>
    </ScrollView>
  )
}

function EmptyStateLabel({ children }: { children: string }) {
  return (
    <Text
      fontSize={12}
      fontWeight="700"
      letterSpacing={0.7}
      textTransform="uppercase"
      color={'$placeholderColor'}
    >
      {children}
    </Text>
  )
}

function SuggestedCampRow({
  camp,
  caption,
  joining = false,
  onJoin,
}: {
  camp: CampWithMembership
  caption: string
  joining?: boolean
  onJoin?: () => void
}) {
  return (
    <XStack
      alignItems="center"
      gap={12}
      padding={12}
      borderRadius={14}
      borderWidth={1}
      borderColor={'$borderColor'}
      backgroundColor={'$backgroundHover'}
    >
      <CampSwatch color={camp.color} />
      <YStack flex={1} gap={2}>
        <Text fontSize={16} fontWeight="800" numberOfLines={1}>
          {camp.name}
        </Text>
        <Text fontSize={12} color={'$placeholderColor'} numberOfLines={1}>
          {caption}
        </Text>
      </YStack>
      {onJoin ? (
        <Button variant="primary" size="$sm" onPress={onJoin} disabled={joining}>
          {joining ? (
            <Spinner size="small" color={'$color'} />
          ) : (
            <Text color={'$color'} fontWeight="800">
              Join
            </Text>
          )}
        </Button>
      ) : null}
    </XStack>
  )
}

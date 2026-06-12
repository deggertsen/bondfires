import { parseError, useAppThemeColors } from '@bondfires/app'
import { Spinner, Text } from '@bondfires/ui'
import { Flame, Sparkles } from '@tamagui/lucide-icons'
import type { FunctionReturnType } from 'convex/server'
import { useRouter } from 'expo-router'
import { useCallback, useState } from 'react'
import { Alert, Pressable, ScrollView, StatusBar } from 'react-native'
import { XStack, YStack } from 'tamagui'
import type { api } from '../../../../convex/_generated/api'
import type { Doc, Id } from '../../../../convex/_generated/dataModel'
import { routes } from '../../lib/routes'
import { SparkTitleSheet } from '../SparkTitleSheet'
import type { CampWithMembership } from './shared'

interface CampPickerScreenProps {
  camps: CampWithMembership[] | undefined
  sortedCamps: CampWithMembership[]
  personalCampDoc: Doc<'personalCamps'> | null | undefined
  joinCamp: (args: { campId: Id<'camps'> }) => Promise<FunctionReturnType<typeof api.camps.join>>
  /**
   * Called once the user has confirmed a camp (after the title sheet).
   * The router owns selectedCampId/tradeTag and the persisted camp id.
   */
  onCampConfirmed: (campId: Id<'camps'>) => void
}

export function CampPickerScreen({
  camps,
  sortedCamps,
  personalCampDoc,
  joinCamp,
  onCampConfirmed,
}: CampPickerScreenProps) {
  const { colors, statusBarStyle } = useAppThemeColors()
  const router = useRouter()
  const [sparkTitleSheetCamp, setSparkTitleSheetCamp] = useState<CampWithMembership | null>(null)

  const handleSelectCamp = useCallback(
    async (camp: CampWithMembership) => {
      try {
        if (camp.membership?.status !== 'active') {
          const result = await joinCamp({ campId: camp._id })
          if (result.status === 'pending') {
            Alert.alert('Request Sent', 'Your camp membership request is pending approval.')
            return
          }
        }

        // Show the title sheet before proceeding to the camp prompt
        setSparkTitleSheetCamp(camp)
      } catch (error) {
        const message = parseError(error).message
        Alert.alert('Camp Unavailable', message)
      }
    },
    [joinCamp],
  )

  const handleSparkTitleSubmit = useCallback(
    (sparkTitle: string) => {
      const camp = sparkTitleSheetCamp
      setSparkTitleSheetCamp(null)
      if (!camp) return
      onCampConfirmed(camp._id)
      // Navigate with title param so it flows through the recording pipeline
      router.replace(routes.createForCamp(camp._id, sparkTitle || undefined))
    },
    [onCampConfirmed, router, sparkTitleSheetCamp],
  )

  const handleOpenPersonalHearth = useCallback(() => {
    router.replace(routes.createForPersonalCamp())
  }, [router])

  return (
    <YStack flex={1} backgroundColor={'$background'}>
      <StatusBar barStyle={statusBarStyle} backgroundColor={colors.background} />
      <YStack paddingTop={64} paddingHorizontal={20} paddingBottom={16} gap={8}>
        <Text fontSize={28} fontWeight="900">
          Choose a Camp
        </Text>
        <Text fontSize={14} color={'$placeholderColor'} lineHeight={20}>
          Every Bondfire starts in a camp.
        </Text>
      </YStack>
      {camps === undefined ? (
        <YStack flex={1} alignItems="center" justifyContent="center" gap={14}>
          <Spinner size="large" color={'$primary'} />
          <Text color={'$placeholderColor'}>Loading camps...</Text>
        </YStack>
      ) : (
        <ScrollView contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 32 }}>
          <YStack gap={10}>
            {sortedCamps.map((camp) => {
              const isActiveMember = camp.membership?.status === 'active'
              const isPending = camp.membership?.status === 'pending'
              return (
                <Pressable key={camp._id} disabled={isPending} onPress={() => handleSelectCamp(camp)}>
                  <YStack
                    padding={14}
                    borderRadius={16}
                    backgroundColor={'$backgroundHover'}
                    borderWidth={1}
                    borderColor={camp.color ?? '$borderColor'}
                    opacity={isPending ? 0.65 : 1}
                    gap={8}
                  >
                    <XStack justifyContent="space-between" alignItems="center" gap={12}>
                      <YStack flex={1} gap={3}>
                        <Text fontSize={17} fontWeight="900" numberOfLines={1}>
                          {camp.name}
                        </Text>
                        <Text fontSize={12} color={'$placeholderColor'} numberOfLines={1}>
                          {camp.theme ?? 'Camp'}
                        </Text>
                      </YStack>
                      <Text
                        fontSize={12}
                        color={isActiveMember ? '$success' : '$placeholderColor'}
                        fontWeight="900"
                      >
                        {isPending ? 'Pending' : isActiveMember ? 'Joined' : 'Join'}
                      </Text>
                    </XStack>
                    <Text fontSize={14} color={'$color'} lineHeight={20}>
                      {camp.purpose}
                    </Text>
                  </YStack>
                </Pressable>
              )
            })}
            {/* Personal Hearth — visually distinct from camp cards */}
            <Pressable onPress={handleOpenPersonalHearth}>
              <YStack
                padding={14}
                borderRadius={16}
                backgroundColor={'rgba(217, 119, 54, 0.07)'}
                borderWidth={1}
                borderColor={'$primary'}
                borderStyle="dashed"
                gap={8}
              >
                <XStack justifyContent="space-between" alignItems="center" gap={12}>
                  <XStack alignItems="center" gap={10} flex={1}>
                    <YStack
                      width={36}
                      height={36}
                      borderRadius={18}
                      backgroundColor={'rgba(217, 119, 54, 0.15)'}
                      alignItems="center"
                      justifyContent="center"
                    >
                      <Flame size={18} color={'$primary'} />
                    </YStack>
                    <YStack flex={1} gap={2}>
                      <Text fontSize={16} fontWeight="900" color={'$primary'} numberOfLines={1}>
                        {personalCampDoc?.name ?? 'My Hearth'}
                      </Text>
                      <Text fontSize={12} color={'$placeholderColor'} numberOfLines={1}>
                        Your personal space
                      </Text>
                    </YStack>
                  </XStack>
                  <Sparkles size={16} color={'$primary'} />
                </XStack>
                <Text fontSize={14} color={'$color'} lineHeight={20}>
                  Private sparks just for you. No camp rules, no audience — just your own fire.
                </Text>
              </YStack>
            </Pressable>
          </YStack>
        </ScrollView>
      )}
      <SparkTitleSheet
        open={sparkTitleSheetCamp !== null}
        campName={sparkTitleSheetCamp?.name}
        onSubmit={handleSparkTitleSubmit}
        onCancel={() => setSparkTitleSheetCamp(null)}
      />
    </YStack>
  )
}

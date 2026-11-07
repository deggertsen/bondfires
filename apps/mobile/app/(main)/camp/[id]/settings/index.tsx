import { useSubscription } from '@bondfires/app'
import { Text } from '@bondfires/ui'
import { Globe, Lock } from '@tamagui/lucide-icons'
import { useQuery } from 'convex/react'
import { useRouter } from 'expo-router'
import { Pressable } from 'react-native'
import { XStack, YStack } from 'tamagui'
import { api } from '../../../../../../../convex/_generated/api'
import { readCampRulesInput } from '../../../../../../../convex/lib/campSettingsPolicy'
import { SectionLabel } from '../../../../../components/camps/CampSettingsControls'
import {
  CampSettingsScaffold,
  SettingsGroup,
  SettingsRow,
  useOwnedCamp,
} from '../../../../../components/camps/CampSettingsScaffold'
import {
  describeAccess,
  describeParticipation,
  describeWhoCanJoin,
} from '../../../../../lib/campSettings'
import { routes } from '../../../../../lib/routes'

/** Owner's camp settings: details, visibility, and rules. */
export default function CampSettingsScreen() {
  const router = useRouter()
  const { campId, camp } = useOwnedCamp()
  const { currentTier } = useSubscription()
  const kindling = useQuery(
    api.campKindling.getKindlingBalance,
    camp && currentTier === 'pro' ? {} : 'skip',
  )

  return (
    <CampSettingsScaffold
      title="Camp settings"
      subtitle={camp?.name}
      campId={campId}
      camp={camp}
      backTo="camp"
    >
      {(owned) => {
        const rules = readCampRulesInput(owned.rules)
        const access = describeAccess(owned.access)
        const isPrivate = owned.access === 'invite'
        const AccessIcon = isPrivate ? Lock : Globe
        const go = (section: Parameters<typeof routes.campSettingsSection>[1]) =>
          router.push(routes.campSettingsSection(owned._id, section))
        return (
          <>
            <YStack gap={6}>
              <SectionLabel>DETAILS</SectionLabel>
              <SettingsGroup>
                <SettingsRow label="Name" value={owned.name} onPress={() => go('details')} />
                <SettingsRow label="Purpose" value={owned.purpose} onPress={() => go('details')} />
                <SettingsRow
                  label="Prompt"
                  value={owned.defaultPrompt ?? 'None'}
                  onPress={() => go('details')}
                  last
                />
              </SettingsGroup>
            </YStack>

            <YStack gap={6}>
              <SectionLabel>ACCESS</SectionLabel>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Visibility: ${access.title}`}
                accessibilityHint={access.detail}
                onPress={() => go('visibility')}
              >
                <XStack
                  alignItems="center"
                  gap={12}
                  padding={12}
                  borderRadius={14}
                  backgroundColor={'$backgroundHover'}
                  borderWidth={1}
                  borderColor={'$borderColor'}
                >
                  <YStack
                    width={36}
                    height={36}
                    borderRadius={10}
                    backgroundColor={'$backgroundPress'}
                    alignItems="center"
                    justifyContent="center"
                  >
                    <AccessIcon size={20} color={'$secondary'} />
                  </YStack>
                  <YStack flex={1} gap={2}>
                    <Text fontSize={15} fontWeight="800">
                      {access.title}
                    </Text>
                    <Text fontSize={12} color={'$placeholderColor'}>
                      {access.detail}
                    </Text>
                  </YStack>
                </XStack>
              </Pressable>
            </YStack>

            <YStack gap={6}>
              <SectionLabel>RULES</SectionLabel>
              <SettingsGroup>
                {isPrivate ? null : (
                  <SettingsRow
                    label="Who can join"
                    detail={describeWhoCanJoin(rules)}
                    onPress={() => go('who-can-join')}
                  />
                )}
                <SettingsRow
                  label="Videos and responses"
                  detail={describeParticipation(rules)}
                  onPress={() => go('videos')}
                />
                <SettingsRow
                  label="Camp guidelines"
                  detail={
                    rules.guidelines.length === 0
                      ? 'None yet'
                      : `${rules.guidelines.length} ${rules.guidelines.length === 1 ? 'guideline' : 'guidelines'}`
                  }
                  onPress={() => go('guidelines')}
                  last
                />
              </SettingsGroup>
              {isPrivate ? (
                <Text fontSize={12} color={'$placeholderColor'} paddingHorizontal={4}>
                  Private camps let in whoever you invite, so there are no join rules.
                </Text>
              ) : null}
            </YStack>

            {kindling ? (
              <XStack
                alignItems="center"
                justifyContent="space-between"
                padding={14}
                borderRadius={14}
                backgroundColor={'$backgroundHover'}
                borderWidth={1}
                borderColor={'$borderColor'}
              >
                <YStack gap={2}>
                  <Text fontSize={11} fontWeight="900" color={'$placeholderColor'}>
                    CAMP KINDLING
                  </Text>
                  <Text fontSize={14} fontWeight="800">
                    This camp uses 1 a month
                  </Text>
                </YStack>
                <Text
                  fontSize={13}
                  fontWeight="900"
                  color={kindling.balance > 0 ? '$success' : '$error'}
                >
                  {kindling.balance} left
                </Text>
              </XStack>
            ) : null}
          </>
        )
      }}
    </CampSettingsScaffold>
  )
}

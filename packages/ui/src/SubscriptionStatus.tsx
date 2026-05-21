import { type SubscriptionTier, TIER_LABELS } from '@bondfires/app'
import { bondfireColors } from '@bondfires/config'
import { Crown, Flame, Sparkles, Star } from '@tamagui/lucide-icons'
import { Pressable } from 'react-native'
import { Card, Spinner, Text, XStack, YStack } from 'tamagui'

const TIER_ICONS: Record<string, typeof Star> = {
  free: Star,
  plus: Flame,
  premium: Crown,
  pro: Sparkles,
}

interface SubscriptionStatusProps {
  currentTier: SubscriptionTier
  isRestoring: boolean
  onManagePress: () => void
  onRestorePress: () => void
}

export function SubscriptionStatus({
  currentTier,
  isRestoring,
  onManagePress,
  onRestorePress,
}: SubscriptionStatusProps) {
  const TierIcon = TIER_ICONS[currentTier] ?? Star
  const tierColor =
    currentTier === 'pro'
      ? bondfireColors.moltenGold
      : currentTier === 'premium'
        ? bondfireColors.bondfireCopper
        : currentTier === 'plus'
          ? bondfireColors.ember
          : bondfireColors.ash

  return (
    <Card
      backgroundColor={bondfireColors.charcoal}
      borderWidth={1}
      borderColor={bondfireColors.iron}
      borderRadius={12}
      padding={16}
    >
      {/* Current tier display */}
      <XStack alignItems="center" justifyContent="space-between" marginBottom={12}>
        <XStack alignItems="center" gap={10}>
          <YStack
            width={40}
            height={40}
            borderRadius={20}
            backgroundColor={`${tierColor}20`}
            alignItems="center"
            justifyContent="center"
          >
            <TierIcon size={20} color={tierColor} />
          </YStack>
          <YStack>
            <Text
              color={bondfireColors.ash}
              fontSize={11}
              fontWeight="700"
              textTransform="uppercase"
            >
              Subscription
            </Text>
            <Text color={bondfireColors.whiteSmoke} fontSize={16} fontWeight="700">
              {TIER_LABELS[currentTier]} Plan
            </Text>
            <Text color={bondfireColors.ash} fontSize={12}>
              {currentTier === 'free' ? 'Browse and watch bondfires' : 'Active subscription'}
            </Text>
          </YStack>
        </XStack>
      </XStack>

      {/* Action buttons */}
      <XStack gap={12}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={currentTier === 'free' ? 'Upgrade subscription plan' : 'Manage plan'}
          onPress={onManagePress}
          style={{ flex: 1 }}
        >
          <YStack
            backgroundColor={bondfireColors.bondfireCopper}
            borderRadius={12}
            paddingVertical={12}
            alignItems="center"
          >
            <Text color={bondfireColors.whiteSmoke} fontSize={14} fontWeight="600">
              {currentTier === 'free' ? 'Upgrade Plan' : 'Manage Plan'}
            </Text>
          </YStack>
        </Pressable>

        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Restore purchases"
          onPress={onRestorePress}
          disabled={isRestoring}
        >
          <YStack
            backgroundColor={bondfireColors.iron}
            borderRadius={12}
            paddingVertical={12}
            paddingHorizontal={16}
            minWidth={96}
            alignItems="center"
            opacity={isRestoring ? 0.6 : 1}
          >
            {isRestoring ? (
              <Spinner size="small" color={bondfireColors.whiteSmoke} />
            ) : (
              <Text color={bondfireColors.whiteSmoke} fontSize={14} fontWeight="600">
                Restore
              </Text>
            )}
          </YStack>
        </Pressable>
      </XStack>
    </Card>
  )
}

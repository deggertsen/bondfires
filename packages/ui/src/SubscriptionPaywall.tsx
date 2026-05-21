import type { SubscriptionTier, TierInfo } from '@bondfires/app'
import { bondfireColors } from '@bondfires/config'
import { Check, Crown, Flame, Sparkles, Star, X } from '@tamagui/lucide-icons'
import { Pressable, ScrollView } from 'react-native'
import { Card, Sheet, Spinner, Text, XStack, YStack } from 'tamagui'
import { Button } from './Button'

const TIER_ICONS: Record<string, typeof Flame> = {
  plus: Flame,
  premium: Crown,
  pro: Sparkles,
}

interface SubscriptionPaywallProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  tiers: TierInfo[]
  currentTier: SubscriptionTier
  onPurchase: (tier: SubscriptionTier) => void
  onRestore: () => void
  isPurchasing: boolean
  isRestoring: boolean
  purchasingTier: SubscriptionTier | null
  lastError: string | null
}

export function SubscriptionPaywall({
  open,
  onOpenChange,
  tiers,
  currentTier,
  onPurchase,
  onRestore,
  isPurchasing,
  isRestoring,
  purchasingTier,
  lastError,
}: SubscriptionPaywallProps) {
  if (!open) return null

  const handlePurchase = (tier: SubscriptionTier) => {
    if (tier === 'free' || tier === currentTier) {
      onOpenChange(false)
      return
    }
    onPurchase(tier)
  }

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      snapPoints={[90]}
      dismissOnSnapToBottom
      disableDrag={false}
    >
      <Sheet.Overlay
        animation="lazy"
        enterStyle={{ opacity: 0 }}
        exitStyle={{ opacity: 0 }}
        backgroundColor="rgba(0,0,0,0.6)"
      />
      <Sheet.Frame
        backgroundColor={bondfireColors.gunmetal}
        borderTopLeftRadius={24}
        borderTopRightRadius={24}
        padding={20}
      >
        {/* Header */}
        <XStack justifyContent="space-between" alignItems="center" marginBottom={20}>
          <YStack>
            <Text color={bondfireColors.whiteSmoke} fontSize={22} fontWeight="700">
              Choose Your Plan
            </Text>
            <Text color={bondfireColors.ash} fontSize={14} marginTop={4}>
              Create bondfires with Plus or higher
            </Text>
          </YStack>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Close subscription plans"
            onPress={() => onOpenChange(false)}
          >
            <YStack
              width={36}
              height={36}
              borderRadius={18}
              backgroundColor={bondfireColors.iron}
              alignItems="center"
              justifyContent="center"
            >
              <X size={20} color={bondfireColors.whiteSmoke} />
            </YStack>
          </Pressable>
        </XStack>

        {/* Error message */}
        {lastError && (
          <Card
            backgroundColor={bondfireColors.error}
            padding={12}
            borderRadius={12}
            marginBottom={16}
          >
            <Text color={bondfireColors.whiteSmoke} fontSize={13}>
              {lastError}
            </Text>
          </Card>
        )}

        {/* Tier cards */}
        <ScrollView
          showsVerticalScrollIndicator={false}
          style={{ flex: 1 }}
          contentContainerStyle={{ paddingBottom: 20 }}
        >
          <YStack gap={12}>
            {/* Free tier */}
            <TierCard
              tier="free"
              price="$0"
              description="Browse, join, and watch."
              features={[
                { label: 'Browse camps and bondfires', included: true },
                { label: 'Watch and respond to bondfires', included: true },
                { label: 'Up to 30 minutes of viewing', included: true },
                { label: 'Create your own bondfires', included: false },
                { label: 'Private camps', included: false },
              ]}
              isCurrent={currentTier === 'free'}
              onPurchase={handlePurchase}
              isPurchasing={isPurchasing && purchasingTier === 'free'}
            />

            {/* Paid tiers */}
            {tiers
              .filter((t) => t.tier !== 'free')
              .map((tier) => (
                <TierCard
                  key={tier.tier}
                  tier={tier.tier}
                  price={tier.price ?? 'Coming Soon'}
                  description={tier.description}
                  features={tier.features}
                  isCurrent={tier.isCurrent}
                  isHighest={tier.isHighest}
                  isAvailable={tier.isAvailable}
                  onPurchase={handlePurchase}
                  isPurchasing={isPurchasing && purchasingTier === tier.tier}
                />
              ))}
          </YStack>
        </ScrollView>

        {/* Restore purchases */}
        <XStack justifyContent="center" paddingVertical={12}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Restore subscription purchases"
            onPress={onRestore}
            disabled={isRestoring}
          >
            <XStack alignItems="center" gap={6}>
              {isRestoring ? <Spinner size="small" color={bondfireColors.ash} /> : null}
              <Text color={bondfireColors.ash} fontSize={13} textDecorationLine="underline">
                {isRestoring ? 'Restoring...' : 'Restore purchases'}
              </Text>
            </XStack>
          </Pressable>
        </XStack>
      </Sheet.Frame>
    </Sheet>
  )
}

interface TierCardProps {
  tier: SubscriptionTier
  price: string
  description: string
  features: { label: string; included: boolean }[]
  isCurrent: boolean
  isAvailable?: boolean
  isHighest?: boolean
  onPurchase: (tier: SubscriptionTier) => void
  isPurchasing: boolean
}

function TierCard({
  tier,
  price,
  description,
  features,
  isCurrent,
  isAvailable = true,
  isHighest,
  onPurchase,
  isPurchasing,
}: TierCardProps) {
  const TierIcon = tier === 'free' ? Star : (TIER_ICONS[tier] ?? Star)
  const isFree = tier === 'free'
  const isComingSoon = !isFree && !isAvailable
  const accentColor = isHighest
    ? bondfireColors.moltenGold
    : isCurrent
      ? bondfireColors.bondfireCopper
      : bondfireColors.iron
  const priceColor = isComingSoon ? bondfireColors.ash : bondfireColors.moltenGold
  const ctaColor = isHighest ? bondfireColors.whiteSmoke : bondfireColors.bondfireCopper

  return (
    <Card
      backgroundColor={bondfireColors.charcoal}
      borderWidth={isHighest ? 2 : isCurrent ? 2 : 1}
      borderColor={accentColor}
      borderRadius={12}
      padding={16}
      opacity={isComingSoon ? 0.72 : 1}
    >
      {/* Tier header */}
      <XStack justifyContent="space-between" alignItems="center" marginBottom={12}>
        <XStack alignItems="center" gap={8}>
          <TierIcon size={20} color={bondfireColors.bondfireCopper} />
          <Text color={bondfireColors.whiteSmoke} fontSize={18} fontWeight="700">
            {tier === 'free' ? 'Free' : tier.charAt(0).toUpperCase() + tier.slice(1)}
          </Text>
        </XStack>
        <YStack alignItems="flex-end">
          <Text color={priceColor} fontSize={18} fontWeight="700">
            {price}
          </Text>
          {!isFree && isAvailable && (
            <Text color={bondfireColors.ash} fontSize={11}>
              /month
            </Text>
          )}
        </YStack>
      </XStack>

      {/* Description */}
      <Text color={bondfireColors.ash} fontSize={13} marginBottom={12}>
        {description}
      </Text>

      {/* Features */}
      <YStack gap={8} marginBottom={16}>
        {features.map((feature) => (
          <XStack key={feature.label} alignItems="center" gap={8}>
            {feature.included ? (
              <Check size={14} color={bondfireColors.success} />
            ) : (
              <X size={14} color={bondfireColors.ash} opacity={0.45} />
            )}
            <Text
              color={feature.included ? bondfireColors.whiteSmoke : bondfireColors.ash}
              fontSize={13}
              opacity={feature.included ? 1 : 0.55}
            >
              {feature.label}
            </Text>
          </XStack>
        ))}
      </YStack>

      {/* Action button */}
      {isCurrent ? (
        <Button
          variant="outline"
          size="$md"
          disabled
          opacity={0.7}
          borderColor={bondfireColors.bondfireCopper}
          color={bondfireColors.bondfireCopper}
        >
          <Text color={bondfireColors.bondfireCopper} fontWeight="600">
            Current plan
          </Text>
        </Button>
      ) : (
        <Button
          variant={isHighest ? 'primary' : 'outline'}
          size="$md"
          disabled={isPurchasing || !isAvailable}
          onPress={() => onPurchase(tier)}
          backgroundColor={isHighest ? bondfireColors.bondfireCopper : 'transparent'}
          borderColor={
            isHighest ? 'transparent' : isAvailable ? bondfireColors.ash : bondfireColors.iron
          }
          opacity={isPurchasing || !isAvailable ? 0.65 : 1}
        >
          <XStack alignItems="center" gap={8}>
            {isPurchasing ? (
              <Spinner
                size="small"
                color={isHighest ? bondfireColors.whiteSmoke : bondfireColors.bondfireCopper}
              />
            ) : null}
            <Text color={isAvailable ? ctaColor : bondfireColors.ash} fontWeight="600">
              {isFree
                ? 'Continue free'
                : !isAvailable
                  ? 'Coming soon'
                  : isPurchasing
                    ? 'Processing...'
                    : 'Subscribe'}
            </Text>
          </XStack>
        </Button>
      )}
    </Card>
  )
}

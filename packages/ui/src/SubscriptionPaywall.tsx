import type { BillingPeriod, SubscriptionTier, TierInfo } from '@bondfires/app'
import { bondfireColors } from '@bondfires/config'
import { Check, Crown, Flame, Sparkles, Star, X } from '@tamagui/lucide-icons'
import { useState } from 'react'
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
  onPurchase: (tier: SubscriptionTier, productId?: string) => void
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
  const [selectedPeriods, setSelectedPeriods] = useState<
    Partial<Record<SubscriptionTier, BillingPeriod>>
  >({})

  if (!open) return null

  const handlePurchase = (tier: SubscriptionTier, productId?: string) => {
    if (tier === 'free' || tier === currentTier) {
      onOpenChange(false)
      return
    }
    onPurchase(tier, productId)
  }

  const handlePeriodChange = (tier: SubscriptionTier, period: BillingPeriod) => {
    setSelectedPeriods((current) => ({ ...current, [tier]: period }))
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
                  annualPrice={tier.annualPrice ?? null}
                  productId={tier.productId}
                  annualProductId={tier.annualProductId ?? null}
                  description={tier.description}
                  features={tier.features}
                  isCurrent={tier.isCurrent}
                  isHighest={tier.isHighest}
                  isAvailable={tier.isAvailable}
                  selectedPeriod={selectedPeriods[tier.tier] ?? 'monthly'}
                  onPeriodChange={handlePeriodChange}
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
  annualPrice?: string | null
  productId?: string | null
  annualProductId?: string | null
  description: string
  features: { label: string; included: boolean }[]
  isCurrent: boolean
  isAvailable?: boolean
  isHighest?: boolean
  selectedPeriod?: BillingPeriod
  onPeriodChange?: (tier: SubscriptionTier, period: BillingPeriod) => void
  onPurchase: (tier: SubscriptionTier, productId?: string) => void
  isPurchasing: boolean
}

function TierCard({
  tier,
  price,
  annualPrice,
  productId,
  annualProductId,
  description,
  features,
  isCurrent,
  isAvailable = true,
  isHighest,
  selectedPeriod = 'monthly',
  onPeriodChange,
  onPurchase,
  isPurchasing,
}: TierCardProps) {
  const TierIcon = tier === 'free' ? Star : (TIER_ICONS[tier] ?? Star)
  const isFree = tier === 'free'
  const monthlyAvailable = !!productId && !!price
  const annualAvailable = !!annualProductId && !!annualPrice
  const activePeriod =
    selectedPeriod === 'annual' && annualAvailable
      ? 'annual'
      : monthlyAvailable
        ? 'monthly'
        : annualAvailable
          ? 'annual'
          : 'monthly'
  const selectedProductId = activePeriod === 'annual' ? annualProductId : productId
  const selectedPrice = activePeriod === 'annual' ? annualPrice : price
  const isComingSoon = !isFree && (!isAvailable || !selectedProductId || !selectedPrice)
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
            {selectedPrice ?? 'Coming Soon'}
          </Text>
          {!isFree && !isComingSoon && (
            <Text color={bondfireColors.ash} fontSize={11}>
              /{activePeriod === 'annual' ? 'year' : 'month'}
            </Text>
          )}
        </YStack>
      </XStack>

      {/* Description */}
      <Text color={bondfireColors.ash} fontSize={13} marginBottom={12}>
        {description}
      </Text>

      {!isFree && annualProductId ? (
        <XStack gap={8} marginBottom={12}>
          <BillingOption
            label="Monthly"
            price={price}
            selected={activePeriod === 'monthly'}
            disabled={!productId || !price}
            onPress={() => onPeriodChange?.(tier, 'monthly')}
          />
          <BillingOption
            label="Annual"
            price={annualPrice ?? 'Coming Soon'}
            selected={activePeriod === 'annual'}
            disabled={!annualProductId || !annualPrice}
            onPress={() => onPeriodChange?.(tier, 'annual')}
          />
        </XStack>
      ) : null}

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
          disabled={isPurchasing || isComingSoon}
          onPress={() => onPurchase(tier, selectedProductId ?? undefined)}
          backgroundColor={isHighest ? bondfireColors.bondfireCopper : 'transparent'}
          borderColor={
            isHighest ? 'transparent' : isAvailable ? bondfireColors.ash : bondfireColors.iron
          }
          opacity={isPurchasing || isComingSoon ? 0.65 : 1}
        >
          <XStack alignItems="center" gap={8}>
            {isPurchasing ? (
              <Spinner
                size="small"
                color={isHighest ? bondfireColors.whiteSmoke : bondfireColors.bondfireCopper}
              />
            ) : null}
            <Text color={isComingSoon ? bondfireColors.ash : ctaColor} fontWeight="600">
              {isFree
                ? 'Continue free'
                : isComingSoon
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

interface BillingOptionProps {
  label: string
  price: string | null
  selected: boolean
  disabled: boolean
  onPress: () => void
}

function BillingOption({ label, price, selected, disabled, onPress }: BillingOptionProps) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected, disabled }}
      disabled={disabled}
      onPress={onPress}
      style={{ flex: 1 }}
    >
      <YStack
        borderWidth={1}
        borderColor={selected ? bondfireColors.bondfireCopper : bondfireColors.iron}
        backgroundColor={selected ? `${bondfireColors.bondfireCopper}20` : bondfireColors.gunmetal}
        borderRadius={10}
        paddingVertical={8}
        paddingHorizontal={10}
        opacity={disabled ? 0.55 : 1}
      >
        <Text color={bondfireColors.whiteSmoke} fontSize={12} fontWeight="700">
          {label}
        </Text>
        <Text color={bondfireColors.ash} fontSize={11} numberOfLines={1}>
          {price ?? 'Coming Soon'}
        </Text>
      </YStack>
    </Pressable>
  )
}

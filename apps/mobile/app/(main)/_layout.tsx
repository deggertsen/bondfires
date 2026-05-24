import type { ExtraCampSlotInfo, SubscriptionTier, TierInfo } from '@bondfires/app'
import {
  EXTRA_CAMP_SLOT_PRODUCTS,
  getExtraCampSlotCount,
  subscriptionStore$,
  TIER_DEFINITIONS,
  useSubscription,
} from '@bondfires/app'
import { SubscriptionPaywall } from '@bondfires/ui'
import { useValue } from '@legendapp/state/react'
import { Stack } from 'expo-router'
import { useMemo } from 'react'

function GlobalPaywall() {
  const {
    currentTier,
    showExtraCampAddon,
    isPurchasing,
    isRestoring,
    purchasingProductId,
    purchasingTier,
    lastError,
    productPrices,
    productsLoaded,
    purchase,
    purchaseExtraCampSlots,
    restore,
    hidePaywall,
    clearError,
  } = useSubscription({ initializeIap: true })

  const isPaywallVisible = useValue(subscriptionStore$.isPaywallVisible)

  const tiers = useMemo((): TierInfo[] | null => {
    if (!productsLoaded) return null

    const freeTier: TierInfo = {
      tier: 'free' as SubscriptionTier,
      productId: null,
      displayName: 'Free',
      price: '$0',
      description: 'Browse, join, and watch bondfires.',
      features: [
        { label: 'Browse camps and bondfires', included: true },
        { label: 'Watch and respond to bondfires', included: true },
        { label: 'Up to 30 minutes of viewing', included: true },
        { label: 'Create your own bondfires', included: false },
        { label: 'Private camps', included: false },
      ],
      isCurrent: currentTier === 'free',
      isFeatured: false,
      isAvailable: true,
    }

    const paidTierNames: Array<'plus' | 'premium' | 'pro'> = ['plus', 'premium', 'pro']
    const paidTiers: TierInfo[] = paidTierNames.map((tier) => {
      const def = TIER_DEFINITIONS[tier]
      const price = productPrices[def.productId] ?? null
      return {
        tier: tier as SubscriptionTier,
        productId: def.productId,
        annualProductId: def.annualProductId,
        displayName: def.displayName,
        price,
        annualPrice: productPrices[def.annualProductId] ?? null,
        description: def.description,
        features: def.features.map((f: { label: string }) => ({ label: f.label, included: true })),
        isCurrent: currentTier === tier,
        isFeatured: tier === 'premium',
        isAvailable: price !== null || productPrices[def.annualProductId] !== undefined,
      }
    })

    return [freeTier, ...paidTiers]
  }, [currentTier, productPrices, productsLoaded])

  const extraCampSlots = useMemo((): ExtraCampSlotInfo[] => {
    if (!productsLoaded || !showExtraCampAddon) return []

    return Object.values(EXTRA_CAMP_SLOT_PRODUCTS).map((productId) => {
      const slotCount = getExtraCampSlotCount(productId)
      const price = productPrices[productId] ?? null
      return {
        productId,
        displayName: `${slotCount} pack`,
        slotCount,
        price,
        isAvailable: price !== null,
      }
    })
  }, [productPrices, productsLoaded, showExtraCampAddon])

  if (!tiers) return null

  return (
    <SubscriptionPaywall
      open={isPaywallVisible}
      onOpenChange={(open) => {
        if (!open) {
          hidePaywall()
          clearError()
        }
      }}
      tiers={tiers}
      extraCampSlots={extraCampSlots}
      currentTier={currentTier}
      onPurchase={purchase}
      onPurchaseExtraCampSlots={purchaseExtraCampSlots}
      onRestore={restore}
      isPurchasing={isPurchasing}
      isRestoring={isRestoring}
      purchasingTier={purchasingTier}
      purchasingProductId={purchasingProductId}
      lastError={lastError}
    />
  )
}

export default function MainLayout() {
  return (
    <>
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="bondfire/[id]" options={{ headerShown: false }} />
        <Stack.Screen name="camp/[id]" options={{ headerShown: false }} />
      </Stack>
      <GlobalPaywall />
    </>
  )
}

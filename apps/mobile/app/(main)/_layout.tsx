import type { SubscriptionTier, TierInfo } from '@bondfires/app'
import { subscriptionStore$, TIER_DEFINITIONS, useSubscription } from '@bondfires/app'
import { SubscriptionPaywall } from '@bondfires/ui'
import { useValue } from '@legendapp/state/react'
import { Stack } from 'expo-router'
import { useMemo } from 'react'

function GlobalPaywall() {
  const {
    currentTier,
    isPurchasing,
    isRestoring,
    purchasingTier,
    lastError,
    productPrices,
    productsLoaded,
    purchase,
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
      isHighest: false,
      isAvailable: true,
    }

    const paidTierNames: Array<'plus' | 'premium' | 'pro'> = ['plus', 'premium', 'pro']
    const paidTiers: TierInfo[] = paidTierNames.map((tier) => {
      const def = TIER_DEFINITIONS[tier]
      const price = productPrices[def.productId] ?? null
      return {
        tier: tier as SubscriptionTier,
        productId: def.productId,
        displayName: def.displayName,
        price,
        description: def.description,
        features: def.features.map((f: { label: string }) => ({ label: f.label, included: true })),
        isCurrent: currentTier === tier,
        isHighest: tier === 'pro',
        isAvailable: price !== null,
      }
    })

    return [freeTier, ...paidTiers]
  }, [currentTier, productPrices, productsLoaded])

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
      currentTier={currentTier}
      onPurchase={purchase}
      onRestore={restore}
      isPurchasing={isPurchasing}
      isRestoring={isRestoring}
      purchasingTier={purchasingTier}
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

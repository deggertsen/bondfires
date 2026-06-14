import type { ExtraCampAddOnInfo, SubscriptionTier, TierInfo } from '@bondfires/app'
import {
  EXTRA_CAMP_ADD_ON_DEFINITION,
  subscriptionStore$,
  TIER_DEFINITIONS,
  useSubscription,
} from '@bondfires/app'
import { SubscriptionPaywall } from '@bondfires/ui'
import { useValue } from '@legendapp/state/react'
import { Stack } from 'expo-router'
import { useMemo } from 'react'
import { FreeCapabilitiesExplainer } from '../../components/FreeCapabilitiesExplainer'

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
    purchaseExtraCamp,
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
      description: 'Browse, join camps, watch and respond.',
      features: [
        { label: 'Browse and join camps open to your tier', included: true },
        { label: 'Watch and respond to bondfires', included: true },
        { label: '5-minute response recordings', included: true },
        { label: 'Join private camps by invite', included: true },
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

  const extraCampAddOn = useMemo((): ExtraCampAddOnInfo | null => {
    if (!productsLoaded || !showExtraCampAddon) return null

    const def = EXTRA_CAMP_ADD_ON_DEFINITION
    const threePackPrice = productPrices[def.threePackProductId] ?? null
    const tenPackPrice = productPrices[def.tenPackProductId] ?? null

    return {
      ...def,
      threePackPrice,
      tenPackPrice,
      isAvailable: threePackPrice !== null || tenPackPrice !== null,
    }
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
      extraCampAddOn={extraCampAddOn}
      currentTier={currentTier}
      onPurchase={purchase}
      onPurchaseExtraCamp={purchaseExtraCamp}
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
        {/* Create lives in the stack (not the tab bar) so it mounts on push and
            fully unmounts on navigate-away — preventing a lingering duplicate
            instance and any orphaned, still-billing Mux live session. The Flame
            tab-bar entry just pushes this route. */}
        <Stack.Screen name="create" options={{ headerShown: false }} />
        <Stack.Screen name="bondfire/[id]" options={{ headerShown: false }} />
        <Stack.Screen name="camp/[id]" options={{ headerShown: false }} />
        <Stack.Screen
          name="personal-bondfire/[bondfireId]/[code]"
          options={{ headerShown: false }}
        />
        <Stack.Screen name="personal-camp" options={{ headerShown: false }} />
      </Stack>
      <GlobalPaywall />
      <FreeCapabilitiesExplainer />
    </>
  )
}

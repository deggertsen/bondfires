import { useEffect, useCallback } from 'react'
import { Platform, Alert } from 'react-native'
import { useQuery } from 'convex/react'
import {
  purchaseErrorListener,
  purchaseUpdatedListener,
  endConnection,
  finishTransaction,
  fetchProducts,
  getAvailablePurchases,
  requestPurchase,
} from 'expo-iap'
import { api } from '../../../../convex/_generated/api'
import {
  subscriptionStore$,
  subscriptionActions,
  SUBSCRIPTION_PRODUCT_IDS,
  type SubscriptionTier,
  TIER_RANK,
  CREATE_REQUIRED_TIER,
  tierMeetsRequirement,
} from '../store/subscription.store'

function mapProductIdToTier(productId: string): SubscriptionTier | null {
  for (const [tier, id] of Object.entries(SUBSCRIPTION_PRODUCT_IDS)) {
    if (id === productId) return tier as SubscriptionTier
  }
  return null
}

/**
 * useSubscription - Main hook for subscription IAP.
 *
 * Provides:
 * - currentTier: user's active subscription tier
 * - tiers: list of all tiers with prices and feature info
 * - purchase: initiate a purchase for a given tier
 * - restore: restore previous purchases
 * - canCreate: whether the user can create bondfires
 * - showUpgradePrompt: show the paywall for upgrades
 */
export function useSubscription() {
  // Convex subscription state
  const subscriptionQuery = useQuery(api.subscriptions.current)

  // Sync Convex state → local store
  useEffect(() => {
    if (subscriptionQuery?.tier) {
      subscriptionActions.setCurrentTier(subscriptionQuery.tier)
    }
  }, [subscriptionQuery?.tier])

  // Initialize IAP: fetch products and listen for purchase updates
  useEffect(() => {
    let purchaseUpdateSub: { remove: () => void } | undefined
    let purchaseErrorSub: { remove: () => void } | undefined
    let mounted = true

    async function initIAP() {
      try {
        const allProductIds = Object.values(SUBSCRIPTION_PRODUCT_IDS)
        const products = await fetchProducts({ skus: allProductIds, type: 'subs' })

        if (mounted && products) {
          const productList = Array.isArray(products) ? products : [products]
          subscriptionActions.setProducts(
            productList.map((p) => ({
              productId: p.id ?? '',
              price: p.displayPrice ?? '',
            })),
          )
        } else if (mounted) {
          subscriptionActions.setProductsLoaded(true)
        }
      } catch (err) {
        console.warn('Failed to fetch IAP products:', err)
        if (mounted) {
          subscriptionActions.setProductsLoaded(true)
        }
      }

      // Listen for purchase updates (e.g. subscription renewals, pending transactions)
      purchaseUpdateSub = purchaseUpdatedListener(async (purchase) => {
        try {
          const tier = mapProductIdToTier(purchase.productId)
          if (tier) {
            await finishTransaction({ purchase, isConsumable: false })
            subscriptionActions.setCurrentTier(tier)
          }
        } catch (err) {
          console.warn('Error processing purchase update:', err)
        }
      })

      purchaseErrorSub = purchaseErrorListener((error: any) => {
        console.warn('IAP purchase error:', error)
        const errMsg =
          error?.message ?? error?.debugMessage ?? 'Purchase failed. Please try again.'
        subscriptionActions.failPurchase(errMsg)
      })
    }

    initIAP()

    return () => {
      mounted = false
      purchaseUpdateSub?.remove()
      purchaseErrorSub?.remove()
      endConnection()
    }
  }, [])

  const purchase = useCallback(async (tier: SubscriptionTier) => {
    if (tier === 'free') {
      subscriptionActions.hidePaywall()
      return
    }

    const productId = SUBSCRIPTION_PRODUCT_IDS[tier]
    subscriptionActions.startPurchase(tier)

    try {
      await requestPurchase({
        request: {
          apple: { sku: productId },
          google: { skus: [productId] },
        },
        type: 'subs',
      })
      // Purchase result handled by purchaseUpdatedListener
      subscriptionActions.hidePaywall()
    } catch (err: any) {
      const message =
        err?.message ?? err?.debugMessage ?? 'Purchase was not completed.'
      if (
        message.includes('cancelled') ||
        message.includes('canceled') ||
        message.includes('user cancelled') ||
        err?.code === 'E_USER_CANCELLED'
      ) {
        subscriptionActions.completePurchase(false)
      } else {
        subscriptionActions.failPurchase(message)
        Alert.alert('Purchase Failed', message)
      }
    }
  }, [])

  const restore = useCallback(async () => {
    subscriptionActions.startRestore()

    try {
      const purchases = await getAvailablePurchases({})
      if (!purchases || purchases.length === 0) {
        subscriptionActions.completeRestore(false)
        Alert.alert(
          'No Purchases Found',
          "We couldn't find any previous purchases to restore.",
        )
        return
      }

      let highestTier: SubscriptionTier = 'free'
      for (const p of purchases) {
        const tier = mapProductIdToTier(p.productId)
        if (tier && TIER_RANK[tier] > TIER_RANK[highestTier]) {
          highestTier = tier
        }
        try {
          await finishTransaction({ purchase: p, isConsumable: false })
        } catch {
          // Some may already be finished
        }
      }

      if (highestTier !== 'free') {
        subscriptionActions.setCurrentTier(highestTier)
        subscriptionActions.completeRestore(true)
        Alert.alert('Purchases Restored', `Your ${highestTier} subscription has been restored.`)
      } else {
        subscriptionActions.completeRestore(false)
        Alert.alert(
          'No Purchases Found',
          "We couldn't find any active subscription purchases to restore.",
        )
      }
    } catch (err: any) {
      const message = err?.message ?? 'Failed to restore purchases.'
      subscriptionActions.failRestore(message)
      Alert.alert('Restore Failed', message)
    }
  }, [])

  const subscriptionStore = subscriptionStore$

  return {
    currentTier: subscriptionStore.currentTier.get(),
    isPurchasing: subscriptionStore.isPurchasing.get(),
    isRestoring: subscriptionStore.isRestoring.get(),
    purchasingTier: subscriptionStore.purchasingTier.get(),
    lastError: subscriptionStore.lastError.get(),
    productPrices: subscriptionStore.productPrices.get(),
    productsLoaded: subscriptionStore.productsLoaded.get(),
    canCreate: tierMeetsRequirement(
      subscriptionStore.currentTier.get(),
      CREATE_REQUIRED_TIER,
    ),
    purchase,
    restore,
    showPaywall: subscriptionActions.showPaywall,
    hidePaywall: subscriptionActions.hidePaywall,
    clearError: subscriptionActions.clearError,
  }
}

import { useValue } from '@legendapp/state/react'
import { useQuery } from 'convex/react'
import {
  endConnection,
  fetchProducts,
  finishTransaction,
  getAvailablePurchases,
  initConnection,
  type ProductSubscription,
  purchaseErrorListener,
  purchaseUpdatedListener,
  requestPurchase,
} from 'expo-iap'
import { useCallback, useEffect } from 'react'
import { Alert, Platform } from 'react-native'
import { api } from '../../../../convex/_generated/api'
import {
  CREATE_REQUIRED_TIER,
  SUBSCRIPTION_PRODUCT_IDS,
  type SubscriptionTier,
  subscriptionActions,
  subscriptionStore$,
  TIER_RANK,
  tierMeetsRequirement,
} from '../store/subscription.store'

function mapProductIdToTier(productId: string): SubscriptionTier | null {
  for (const [tier, id] of Object.entries(SUBSCRIPTION_PRODUCT_IDS)) {
    if (id === productId) return tier as SubscriptionTier
  }
  return null
}

function getErrorField(error: unknown, field: 'message' | 'debugMessage' | 'code') {
  if (!error || typeof error !== 'object' || !(field in error)) return undefined
  const value = (error as Record<string, unknown>)[field]
  return typeof value === 'string' ? value : undefined
}

function getIapErrorMessage(error: unknown, fallback: string) {
  return getErrorField(error, 'message') ?? getErrorField(error, 'debugMessage') ?? fallback
}

function isUserCancelledPurchase(error: unknown, message: string) {
  const normalizedMessage = message.toLowerCase()
  return (
    normalizedMessage.includes('cancelled') ||
    normalizedMessage.includes('canceled') ||
    normalizedMessage.includes('user cancelled') ||
    getErrorField(error, 'code') === 'E_USER_CANCELLED'
  )
}

function getAndroidOfferToken(product: ProductSubscription): string | null {
  if (product.platform !== 'android') return null
  return (
    product.subscriptionOffers?.[0]?.offerTokenAndroid ??
    product.subscriptionOfferDetailsAndroid?.[0]?.offerToken ??
    null
  )
}

let iapConnectionPromise: Promise<boolean> | null = null
let iapConsumerCount = 0
let purchaseUpdateSub: { remove: () => void } | undefined
let purchaseErrorSub: { remove: () => void } | undefined

async function ensureIapConnection() {
  if (!iapConnectionPromise) {
    iapConnectionPromise = initConnection().catch((error) => {
      iapConnectionPromise = null
      throw error
    })
  }

  await iapConnectionPromise
}

async function loadSubscriptionProducts() {
  const allProductIds = Object.values(SUBSCRIPTION_PRODUCT_IDS)
  const products = await fetchProducts({ skus: allProductIds, type: 'subs' })
  const productList = Array.isArray(products) ? products : [products]

  subscriptionActions.setProducts(
    productList
      .filter((product): product is ProductSubscription => !!product?.id)
      .map((product) => ({
        productId: product.id,
        price: product.displayPrice,
        offerToken: getAndroidOfferToken(product),
      })),
  )
}

function subscribeToPurchaseUpdates() {
  if (!purchaseUpdateSub) {
    purchaseUpdateSub = purchaseUpdatedListener(async (purchase) => {
      try {
        const tier = mapProductIdToTier(purchase.productId)
        if (tier) {
          await finishTransaction({ purchase, isConsumable: false })
          subscriptionActions.completePurchase(true, tier)
          subscriptionActions.hidePaywall()
        }
      } catch (err) {
        console.warn('Error processing purchase update:', err)
        subscriptionActions.failPurchase('Purchase completed, but could not be finalized.')
      }
    })
  }

  if (!purchaseErrorSub) {
    purchaseErrorSub = purchaseErrorListener((error) => {
      console.warn('IAP purchase error:', error)
      const errMsg = error?.message ?? error?.debugMessage ?? 'Purchase failed. Please try again.'
      subscriptionActions.failPurchase(errMsg)
    })
  }
}

async function releaseIapConnection() {
  purchaseUpdateSub?.remove()
  purchaseErrorSub?.remove()
  purchaseUpdateSub = undefined
  purchaseErrorSub = undefined
  await endConnection()
  iapConnectionPromise = null
}

interface UseSubscriptionOptions {
  initializeIap?: boolean
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
export function useSubscription(options: UseSubscriptionOptions = {}) {
  const { initializeIap = false } = options
  // Convex subscription state
  const subscriptionQuery = useQuery(api.subscriptions.current)
  const currentTier = useValue(subscriptionStore$.currentTier)
  const isPurchasing = useValue(subscriptionStore$.isPurchasing)
  const isRestoring = useValue(subscriptionStore$.isRestoring)
  const purchasingTier = useValue(subscriptionStore$.purchasingTier)
  const lastError = useValue(subscriptionStore$.lastError)
  const productPrices = useValue(subscriptionStore$.productPrices)
  const productOfferTokens = useValue(subscriptionStore$.productOfferTokens)
  const productsLoaded = useValue(subscriptionStore$.productsLoaded)

  // Sync Convex state → local store
  useEffect(() => {
    if (subscriptionQuery?.tier) {
      subscriptionActions.setCurrentTier(subscriptionQuery.tier)
    }
  }, [subscriptionQuery?.tier])

  // Initialize IAP: fetch products and listen for purchase updates
  useEffect(() => {
    if (!initializeIap) return

    let mounted = true
    iapConsumerCount += 1

    async function initIAP() {
      try {
        await ensureIapConnection()
        if (!mounted) return

        subscribeToPurchaseUpdates()
        await loadSubscriptionProducts()
      } catch (err) {
        console.warn('Failed to initialize IAP:', err)
        if (mounted) {
          subscriptionActions.setProductsLoaded(true)
        }
      }
    }

    initIAP()

    return () => {
      mounted = false
      iapConsumerCount = Math.max(0, iapConsumerCount - 1)
      if (iapConsumerCount === 0) {
        releaseIapConnection().catch((err) => {
          console.warn('Failed to close IAP connection:', err)
        })
      }
    }
  }, [initializeIap])

  const purchase = useCallback(async (tier: SubscriptionTier) => {
    if (tier === 'free') {
      subscriptionActions.hidePaywall()
      return
    }

    const productId = SUBSCRIPTION_PRODUCT_IDS[tier]
    subscriptionActions.startPurchase(tier)

    try {
      await ensureIapConnection()

      const offerToken = subscriptionStore$.productOfferTokens[productId].get()
      if (Platform.OS === 'android' && !offerToken) {
        throw new Error('This subscription is not available for purchase yet.')
      }

      await requestPurchase({
        request: {
          apple: { sku: productId },
          google: {
            skus: [productId],
            subscriptionOffers: offerToken ? [{ sku: productId, offerToken }] : undefined,
          },
        },
        type: 'subs',
      })
      // Purchase result handled by purchaseUpdatedListener
    } catch (err: unknown) {
      const message = getIapErrorMessage(err, 'Purchase was not completed.')
      if (isUserCancelledPurchase(err, message)) {
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
      await ensureIapConnection()
      const purchases = await getAvailablePurchases({})
      if (!purchases || purchases.length === 0) {
        subscriptionActions.completeRestore(false)
        Alert.alert('No Purchases Found', "We couldn't find any previous purchases to restore.")
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
    } catch (err: unknown) {
      const message = getIapErrorMessage(err, 'Failed to restore purchases.')
      subscriptionActions.failRestore(message)
      Alert.alert('Restore Failed', message)
    }
  }, [])

  return {
    currentTier,
    isPurchasing,
    isRestoring,
    purchasingTier,
    lastError,
    productPrices,
    productOfferTokens,
    productsLoaded,
    canCreate: tierMeetsRequirement(currentTier, CREATE_REQUIRED_TIER),
    purchase,
    restore,
    showPaywall: subscriptionActions.showPaywall,
    hidePaywall: subscriptionActions.hidePaywall,
    clearError: subscriptionActions.clearError,
  }
}

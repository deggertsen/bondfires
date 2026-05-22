import { useValue } from '@legendapp/state/react'
import { useMutation, useQuery } from 'convex/react'
import Constants from 'expo-constants'
import {
  deepLinkToSubscriptions,
  endConnection,
  fetchProducts,
  finishTransaction,
  getAvailablePurchases,
  initConnection,
  type ProductSubscription,
  type Purchase,
  purchaseErrorListener,
  purchaseUpdatedListener,
  requestPurchase,
} from 'expo-iap'
import { useCallback, useEffect } from 'react'
import { Alert, Platform } from 'react-native'
import { api } from '../../../../convex/_generated/api'
import {
  ALL_SUBSCRIPTION_PRODUCT_IDS,
  CREATE_REQUIRED_TIER,
  PRODUCT_ID_TO_TIER,
  type SubscriptionTier,
  subscriptionActions,
  subscriptionStore$,
  TIER_PRODUCT_IDS,
  TIER_RANK,
  tierMeetsRequirement,
} from '../store/subscription.store'

function mapProductIdToTier(productId: string): SubscriptionTier | null {
  return PRODUCT_ID_TO_TIER[productId] ?? null
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
  const products = await fetchProducts({ skus: ALL_SUBSCRIPTION_PRODUCT_IDS, type: 'subs' })
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

function getPurchaseField(purchase: Purchase, field: string) {
  const value = (purchase as unknown as Record<string, unknown>)[field]
  return typeof value === 'string' ? value : undefined
}

function getPurchaseNumberField(purchase: Purchase, field: string) {
  const value = (purchase as unknown as Record<string, unknown>)[field]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function getPurchasePlatform(purchase: Purchase): 'ios' | 'android' {
  return purchase.store === 'apple' || purchase.platform === 'ios' ? 'ios' : 'android'
}

function getStoreOriginalTransactionId(purchase: Purchase) {
  return (
    getPurchaseField(purchase, 'originalTransactionIdentifierIOS') ??
    purchase.transactionId ??
    purchase.purchaseToken ??
    purchase.id
  )
}

async function processPurchase(
  purchase: Purchase,
  syncPurchase: (purchase: Purchase) => Promise<SubscriptionTier>,
) {
  const tier = mapProductIdToTier(purchase.productId)
  if (!tier) return null

  const syncedTier = await syncPurchase(purchase)
  await finishTransaction({ purchase, isConsumable: false })
  subscriptionActions.completePurchase(true, syncedTier)
  subscriptionActions.hidePaywall()
  return syncedTier
}

function subscribeToPurchaseUpdates(
  syncPurchase: (purchase: Purchase) => Promise<SubscriptionTier>,
) {
  if (!purchaseUpdateSub) {
    purchaseUpdateSub = purchaseUpdatedListener(async (purchase) => {
      try {
        await processPurchase(purchase, syncPurchase)
      } catch (err) {
        console.warn('Error processing purchase update:', err)
        subscriptionActions.failPurchase(
          'Purchase completed, but could not be synced. Please restore purchases.',
        )
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
  const syncStorePurchase = useMutation(api.subscriptions.syncStorePurchase)
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

        subscribeToPurchaseUpdates(async (purchase) => {
          const result = await syncStorePurchase({
            platform: getPurchasePlatform(purchase),
            storeProductId: purchase.productId,
            storeTransactionId: purchase.transactionId ?? purchase.id,
            storeOriginalTransactionId: getStoreOriginalTransactionId(purchase),
            storePurchaseToken: purchase.purchaseToken ?? undefined,
            currentPeriodEnd: getPurchaseNumberField(purchase, 'expirationDateIOS'),
            purchasedAt: purchase.transactionDate,
          })
          return result.tier
        })
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
  }, [initializeIap, syncStorePurchase])

  const purchase = useCallback(async (tier: SubscriptionTier, productId?: string) => {
    if (tier === 'free') {
      subscriptionActions.hidePaywall()
      return
    }

    const tierProductId = productId ?? TIER_PRODUCT_IDS[tier].monthly
    subscriptionActions.startPurchase(tier)

    try {
      await ensureIapConnection()

      const offerToken = subscriptionStore$.productOfferTokens[tierProductId].get()
      if (Platform.OS === 'android' && !offerToken) {
        throw new Error('This subscription is not available for purchase yet.')
      }

      await requestPurchase({
        request: {
          apple: { sku: tierProductId },
          google: {
            skus: [tierProductId],
            subscriptionOffers: offerToken ? [{ sku: tierProductId, offerToken }] : undefined,
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
        const tier = await processPurchase(p, async (purchaseToSync) => {
          const result = await syncStorePurchase({
            platform: getPurchasePlatform(purchaseToSync),
            storeProductId: purchaseToSync.productId,
            storeTransactionId: purchaseToSync.transactionId ?? purchaseToSync.id,
            storeOriginalTransactionId: getStoreOriginalTransactionId(purchaseToSync),
            storePurchaseToken: purchaseToSync.purchaseToken ?? undefined,
            currentPeriodEnd: getPurchaseNumberField(purchaseToSync, 'expirationDateIOS'),
            purchasedAt: purchaseToSync.transactionDate,
          })
          return result.tier
        })
        if (tier && TIER_RANK[tier] > TIER_RANK[highestTier]) {
          highestTier = tier
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
  }, [syncStorePurchase])

  const managePlan = useCallback(async () => {
    try {
      await ensureIapConnection()
      const activeProductId = subscriptionQuery?.subscription?.storeProductId
      await deepLinkToSubscriptions({
        skuAndroid: activeProductId ?? TIER_PRODUCT_IDS.plus.monthly,
        packageNameAndroid:
          Constants.expoConfig?.android?.package ??
          Constants.expoConfig?.ios?.bundleIdentifier ??
          'org.bondfires',
      })
    } catch (err: unknown) {
      const message = getIapErrorMessage(err, 'Could not open subscription management.')
      Alert.alert('Manage Subscription', message)
    }
  }, [subscriptionQuery?.subscription?.storeProductId])

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
    managePlan,
    showPaywall: subscriptionActions.showPaywall,
    hidePaywall: subscriptionActions.hidePaywall,
    clearError: subscriptionActions.clearError,
  }
}

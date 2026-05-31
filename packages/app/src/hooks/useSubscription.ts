import { useValue } from '@legendapp/state/react'
import { useAction, useMutation, useQuery } from 'convex/react'
import Constants from 'expo-constants'
import {
  deepLinkToSubscriptions,
  endConnection,
  fetchProducts,
  finishTransaction,
  getAvailablePurchases,
  initConnection,
  type Product,
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
  ALL_STORE_PRODUCT_IDS,
  CREATE_REQUIRED_TIER,
  EXTRA_CAMP_PRODUCT_IDS,
  isExtraCampProductId,
  PRODUCT_ID_TO_PURCHASE_KIND,
  type StorePurchaseKind,
  type SubscriptionTier,
  subscriptionActions,
  subscriptionStore$,
  TIER_PRODUCT_IDS,
  TIER_RANK,
  tierMeetsRequirement,
} from '../store/subscription.store'

type StorePurchaseSyncResult = {
  tier: SubscriptionTier
  kind: StorePurchaseKind
  status: 'pending_verification' | 'active' | 'trialing' | 'past_due' | 'canceled' | 'expired'
}

function mapProductIdToPurchaseKind(productId: string): StorePurchaseKind | null {
  return PRODUCT_ID_TO_PURCHASE_KIND[productId] ?? null
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

type StoreProduct = Product | ProductSubscription
type AndroidOfferProduct = {
  subscriptionOffers?: Array<{ offerTokenAndroid?: string | null }> | null
  subscriptionOfferDetailsAndroid?: Array<{ offerToken?: string | null }> | null
}

function getAndroidOfferToken(product: StoreProduct): string | null {
  if (product.platform !== 'android') return null
  if (!('subscriptionOffers' in product) && !('subscriptionOfferDetailsAndroid' in product)) {
    return null
  }
  const subscription = product as AndroidOfferProduct
  return (
    subscription.subscriptionOffers?.[0]?.offerTokenAndroid ??
    subscription.subscriptionOfferDetailsAndroid?.[0]?.offerToken ??
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

async function loadSubscriptionProducts(showExtraCampAddon: boolean) {
  const products = await fetchProducts({ skus: ALL_STORE_PRODUCT_IDS, type: 'all' })
  const productList = Array.isArray(products) ? products : [products]
  const visibleProducts = showExtraCampAddon
    ? productList
    : productList.filter((product) => !product?.id || !isExtraCampProductId(product.id))

  subscriptionActions.setProducts(
    visibleProducts
      .filter((product): product is StoreProduct => !!product?.id)
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

function getStorePurchaseSyncArgs(purchase: Purchase) {
  return {
    platform: getPurchasePlatform(purchase),
    storeProductId: purchase.productId,
    storeTransactionId: purchase.transactionId ?? purchase.id,
    storeOriginalTransactionId: getStoreOriginalTransactionId(purchase),
    storePurchaseToken: purchase.purchaseToken ?? undefined,
    currentPeriodEnd: getPurchaseNumberField(purchase, 'expirationDateIOS'),
    purchasedAt: purchase.transactionDate,
  }
}

function getStorePurchaseVerifyArgs(purchase: Purchase) {
  const syncArgs = getStorePurchaseSyncArgs(purchase)
  return {
    platform: syncArgs.platform,
    storeProductId: syncArgs.storeProductId,
    storeTransactionId: syncArgs.storeTransactionId,
    storeOriginalTransactionId: syncArgs.storeOriginalTransactionId,
    storePurchaseToken: syncArgs.storePurchaseToken,
  }
}

function storeStatusUnlocksEntitlements(status: StorePurchaseSyncResult['status']) {
  return status === 'active' || status === 'trialing'
}

async function processPurchase(
  purchase: Purchase,
  syncPurchase: (purchase: Purchase) => Promise<StorePurchaseSyncResult>,
) {
  const kind = mapProductIdToPurchaseKind(purchase.productId)
  if (!kind) return null

  const result = await syncPurchase(purchase)
  if (!storeStatusUnlocksEntitlements(result.status)) {
    subscriptionActions.failPurchase(
      result.status === 'pending_verification'
        ? 'Purchase is still pending store verification. Please restore purchases after it completes.'
        : 'Purchase is not currently active.',
    )
    return result
  }

  await finishTransaction({ purchase, isConsumable: kind === 'consumable' })
  subscriptionActions.completePurchase(true, result.tier)
  subscriptionActions.hidePaywall()
  return result
}

function subscribeToPurchaseUpdates(
  syncPurchase: (purchase: Purchase) => Promise<StorePurchaseSyncResult>,
) {
  if (!purchaseUpdateSub) {
    purchaseUpdateSub = purchaseUpdatedListener(async (purchase) => {
      try {
        const result = await processPurchase(purchase, syncPurchase)
        if (result?.status === 'pending_verification') {
          Alert.alert(
            'Purchase Pending',
            'Your purchase was recorded but is still pending store verification. Please restore purchases after it completes.',
          )
        }
      } catch (err) {
        console.warn('Error processing purchase update:', err)
        subscriptionActions.failPurchase(
          'Purchase completed, but could not be verified. Please restore purchases.',
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
  const verifyStorePurchase = useAction(api.subscriptions.verifyStorePurchase)
  const currentTier = useValue(subscriptionStore$.currentTier)
  const showExtraCampAddon = currentTier === 'pro'
  /** Whether the user owns camps that would be frozen on downgrade from a paid tier. */
  const hasCampsAtRisk = currentTier !== 'free' && subscriptionQuery?.tier === currentTier
  const isPurchasing = useValue(subscriptionStore$.isPurchasing)
  const isRestoring = useValue(subscriptionStore$.isRestoring)
  const purchasingTier = useValue(subscriptionStore$.purchasingTier)
  const purchasingProductId = useValue(subscriptionStore$.purchasingProductId)
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
          await syncStorePurchase(getStorePurchaseSyncArgs(purchase))
          return await verifyStorePurchase(getStorePurchaseVerifyArgs(purchase))
        })
        await loadSubscriptionProducts(showExtraCampAddon)
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
  }, [initializeIap, syncStorePurchase, verifyStorePurchase, showExtraCampAddon])

  useEffect(() => {
    if (!initializeIap || !productsLoaded) return
    void loadSubscriptionProducts(showExtraCampAddon)
  }, [initializeIap, productsLoaded, showExtraCampAddon])

  const requestStorePurchase = useCallback(async (productId: string) => {
    try {
      await ensureIapConnection()

      const kind = mapProductIdToPurchaseKind(productId)
      if (!kind) {
        throw new Error('Unsupported store product.')
      }
      const offerToken = subscriptionStore$.productOfferTokens[productId].get()
      if (kind === 'subscription' && Platform.OS === 'android' && !offerToken) {
        throw new Error('This store product is not available for purchase yet.')
      }

      if (kind === 'consumable') {
        await requestPurchase({
          request: {
            apple: { sku: productId },
            google: { skus: [productId] },
          },
          type: 'in-app',
        })
      } else {
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
      }
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

  const purchase = useCallback(
    async (tier: SubscriptionTier, productId?: string) => {
      if (tier === 'free') {
        subscriptionActions.hidePaywall()
        return
      }

      const tierProductId = productId ?? TIER_PRODUCT_IDS[tier].monthly
      subscriptionActions.startPurchase(tier, tierProductId)
      await requestStorePurchase(tierProductId)
    },
    [requestStorePurchase],
  )

  const purchaseExtraCamp = useCallback(
    async (productId: string = EXTRA_CAMP_PRODUCT_IDS.campSlot3Pack) => {
      subscriptionActions.startAddOnPurchase(productId)
      await requestStorePurchase(productId)
    },
    [requestStorePurchase],
  )

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
      let syncedPurchaseCount = 0
      for (const p of purchases) {
        const result = await processPurchase(p, async (purchaseToSync) => {
          await syncStorePurchase(getStorePurchaseSyncArgs(purchaseToSync))
          return await verifyStorePurchase(getStorePurchaseVerifyArgs(purchaseToSync))
        })
        if (result && storeStatusUnlocksEntitlements(result.status)) {
          syncedPurchaseCount += 1
        }
        if (
          result?.tier &&
          storeStatusUnlocksEntitlements(result.status) &&
          TIER_RANK[result.tier] > TIER_RANK[highestTier]
        ) {
          highestTier = result.tier
        }
      }

      if (highestTier !== 'free') {
        subscriptionActions.setCurrentTier(highestTier)
        subscriptionActions.completeRestore(true)
        Alert.alert('Purchases Restored', `Your ${highestTier} subscription has been restored.`)
      } else if (syncedPurchaseCount > 0) {
        subscriptionActions.completeRestore(true)
        Alert.alert(
          'Purchases Submitted',
          'Your purchases were recorded and will unlock after store verification completes.',
        )
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
  }, [syncStorePurchase, verifyStorePurchase])

  const managePlan = useCallback(async () => {
    /** Opens the OS-level subscription management screen. */
    async function openSubscriptionManagement(activeProductId?: string) {
      try {
        await ensureIapConnection()
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
    }

    // Warn before redirecting to OS subscription management if the user
    // has camps that would be frozen on downgrade/cancellation.
    if (hasCampsAtRisk) {
      Alert.alert(
        'Your Camps Will Be Frozen',
        "If you downgrade or cancel your subscription, any camps beyond your new tier's limit will become read-only. You will have 30 days to resubscribe and reclaim them before they become eligible for another Pro member to take over as camp owner.",
        [
          { text: 'Go Back', style: 'cancel' },
          {
            text: 'Continue to Manage',
            style: 'destructive',
            onPress: () =>
              openSubscriptionManagement(subscriptionQuery?.subscription?.storeProductId),
          },
        ],
      )
      return
    }

    await openSubscriptionManagement(subscriptionQuery?.subscription?.storeProductId)
  }, [subscriptionQuery?.subscription?.storeProductId, hasCampsAtRisk])

  return {
    currentTier,
    isPurchasing,
    isRestoring,
    purchasingTier,
    purchasingProductId,
    lastError,
    productPrices,
    productOfferTokens,
    productsLoaded,
    showExtraCampAddon,
    canCreate: tierMeetsRequirement(currentTier, CREATE_REQUIRED_TIER),
    purchase,
    purchaseExtraCamp,
    restore,
    managePlan,
    showPaywall: subscriptionActions.showPaywall,
    hidePaywall: subscriptionActions.hidePaywall,
    clearError: subscriptionActions.clearError,
  }
}

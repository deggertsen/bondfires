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
import { useCallback, useEffect, useRef, useState } from 'react'
import { Alert, Platform } from 'react-native'
import { api } from '../../../../convex/_generated/api'
import { telemetry } from '../services/telemetry'
import {
  ALL_SUBSCRIPTION_PRODUCT_IDS,
  CREATE_REQUIRED_TIER,
  EXTRA_CAMP_PRODUCT_IDS,
  KINDLING_PACK_PRODUCT_IDS,
  PRODUCT_ID_TO_PURCHASE_KIND,
  type StorePurchaseKind,
  type SubscriptionTier,
  subscriptionActions,
  subscriptionStore$,
  TIER_PRODUCT_IDS,
  TIER_RANK,
  tierMeetsRequirement,
} from '../store/subscription.store'
import { createIapConnectionCoordinator } from '../utils/iapConnectionCoordinator'
import {
  buildIapCatalogTelemetryData,
  type IapCatalogAttemptPhase,
  type IapCatalogReconnectStatus,
  isUserCancelledPurchase,
  loadIapCatalogWithRecovery,
  serializeIapError,
} from '../utils/subscriptionIapPolicy'

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

let purchaseUpdateSub: { remove: () => void } | undefined
let purchaseErrorSub: { remove: () => void } | undefined
let syncPurchaseForUpdates: ((purchase: Purchase) => Promise<StorePurchaseSyncResult>) | undefined
const iapConnection = createIapConnectionCoordinator({ initConnection, endConnection })
const IAP_CATALOG_ATTEMPT_CANCELLED = Symbol('IAP_CATALOG_ATTEMPT_CANCELLED')

class IapCatalogLoadError extends Error {
  constructor(
    message: string,
    readonly underlyingError: unknown,
    readonly returnedProductIds: string[],
    readonly missingSubscriptionProductIds: string[],
  ) {
    super(message)
    this.name = 'IapCatalogLoadError'
  }
}

async function loadSubscriptionProducts() {
  // Fetch subscriptions and in-app products separately.
  // Billing 8.x + openiap-google 2.2.1 throws on ProductQueryType.All if
  // either product type query fails (e.g., no INAPP products configured in
  // Play Console), so we avoid 'all' and query each type independently.
  const [subsProducts, inappProducts] = await Promise.allSettled([
    fetchProducts({ skus: ALL_SUBSCRIPTION_PRODUCT_IDS, type: 'subs' }),
    fetchProducts({
      skus: [
        KINDLING_PACK_PRODUCT_IDS.campKindling3Pack,
        KINDLING_PACK_PRODUCT_IDS.campKindling10Pack,
      ],
      type: 'in-app',
    }),
  ])

  const returnedInAppProducts =
    inappProducts.status === 'fulfilled'
      ? Array.isArray(inappProducts.value)
        ? inappProducts.value
        : [inappProducts.value]
      : []
  const returnedInAppProductIds = returnedInAppProducts
    .filter((product): product is StoreProduct => !!product?.id)
    .map((product) => product.id)

  // Subscription pricing is required for the paywall. Kindling packs are an
  // optional add-on, so their failure is logged without blocking subscriptions.
  if (subsProducts.status === 'rejected') {
    throw new IapCatalogLoadError(
      'Failed to fetch subscription products.',
      subsProducts.reason,
      returnedInAppProductIds,
      [...ALL_SUBSCRIPTION_PRODUCT_IDS],
    )
  }

  const subsList = Array.isArray(subsProducts.value) ? subsProducts.value : [subsProducts.value]
  const availableSubscriptionProducts = subsList.filter(
    (product): product is StoreProduct => !!product?.id,
  )
  if (availableSubscriptionProducts.length === 0) {
    throw new IapCatalogLoadError(
      'The store returned no subscription products.',
      new Error('The store returned no subscription products.'),
      returnedInAppProductIds,
      [...ALL_SUBSCRIPTION_PRODUCT_IDS],
    )
  }

  const allProducts = [...availableSubscriptionProducts, ...returnedInAppProducts]
  const availableProducts = allProducts.filter((product): product is StoreProduct => !!product?.id)
  const returnedSubscriptionProductIds = new Set(
    availableSubscriptionProducts.map((product) => product.id),
  )
  const missingSubscriptionProductIds = ALL_SUBSCRIPTION_PRODUCT_IDS.filter(
    (productId) => !returnedSubscriptionProductIds.has(productId),
  )

  return {
    products: availableProducts,
    returnedProductIds: availableProducts.map((product) => product.id),
    missingSubscriptionProductIds,
    optionalProductError: inappProducts.status === 'rejected' ? inappProducts.reason : undefined,
  }
}

function getCatalogFailure(error: unknown) {
  if (error instanceof IapCatalogLoadError) {
    return {
      error: error.underlyingError,
      returnedProductIds: error.returnedProductIds,
      missingSubscriptionProductIds: error.missingSubscriptionProductIds,
    }
  }
  return {
    error,
    returnedProductIds: [] as string[],
    missingSubscriptionProductIds: [] as string[],
  }
}

async function runCatalogAttempt(phase: IapCatalogAttemptPhase, isActive: () => boolean) {
  let reconnectStatus: IapCatalogReconnectStatus = 'not_attempted'

  try {
    await iapConnection.ensureConnected()
    if (!isActive()) return

    const result = await loadIapCatalogWithRecovery({
      platform: Platform.OS,
      loadCatalog: loadSubscriptionProducts,
      getRecoveryError: (error) => getCatalogFailure(error).error,
      getRecoveryErrorFromResult: (result) => result.optionalProductError,
      reconnect: async () => {
        if (!isActive()) throw IAP_CATALOG_ATTEMPT_CANCELLED
        reconnectStatus = 'failed'
        await iapConnection.reconnect()
        reconnectStatus = 'succeeded'
      },
    })
    if (!isActive()) return

    subscriptionActions.setProducts(
      result.products.map((product) => ({
        productId: product.id,
        price: product.displayPrice,
        offerToken: getAndroidOfferToken(product),
      })),
    )

    if (
      result.optionalProductError !== undefined ||
      result.missingSubscriptionProductIds.length > 0
    ) {
      const warningError =
        result.optionalProductError ??
        new Error(
          `The store omitted ${result.missingSubscriptionProductIds.length} requested subscription products.`,
        )
      telemetry.warn(
        'iap:catalog',
        'IAP catalog loaded partially',
        buildIapCatalogTelemetryData({
          phase,
          platform: Platform.OS,
          requestedSubscriptionProductIds: ALL_SUBSCRIPTION_PRODUCT_IDS,
          returnedProductIds: result.returnedProductIds,
          missingSubscriptionProductIds: result.missingSubscriptionProductIds,
          reconnectStatus,
          error: warningError,
        }),
      )
    }
  } catch (error) {
    if (error === IAP_CATALOG_ATTEMPT_CANCELLED || !isActive()) return

    const failure = getCatalogFailure(error)
    telemetry.warn(
      'iap:catalog',
      'Failed to load IAP catalog',
      buildIapCatalogTelemetryData({
        phase,
        platform: Platform.OS,
        requestedSubscriptionProductIds: ALL_SUBSCRIPTION_PRODUCT_IDS,
        returnedProductIds: failure.returnedProductIds,
        missingSubscriptionProductIds: failure.missingSubscriptionProductIds,
        reconnectStatus,
        error: failure.error,
      }),
    )
    throw error
  }
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
  syncPurchaseForUpdates = syncPurchase
  if (!purchaseUpdateSub) {
    purchaseUpdateSub = purchaseUpdatedListener(async (purchase) => {
      try {
        const currentSyncPurchase = syncPurchaseForUpdates
        if (!currentSyncPurchase) return

        const result = await processPurchase(purchase, currentSyncPurchase)
        if (result?.status === 'pending_verification') {
          Alert.alert(
            'Purchase Pending',
            'Your purchase was recorded but is still pending store verification. Please restore purchases after it completes.',
          )
        }
      } catch (err) {
        telemetry.warn('iap:update', 'Error processing purchase update', {
          error: serializeIapError(err),
        })
        subscriptionActions.failPurchase(
          'Purchase completed, but could not be verified. Please restore purchases.',
        )
      }
    })
  }

  if (!purchaseErrorSub) {
    purchaseErrorSub = purchaseErrorListener((error) => {
      const errMsg = error?.message ?? error?.debugMessage ?? 'Purchase failed. Please try again.'
      // User-cancelled purchases are not errors — don't surface them as failures
      // or pollute telemetry with them.
      if (isUserCancelledPurchase(error, errMsg)) {
        subscriptionActions.completePurchase(false)
        return
      }
      telemetry.warn('iap:error', 'IAP purchase error', { error: serializeIapError(error) })
      subscriptionActions.failPurchase(errMsg)
    })
  }
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
  const productFetchFailed = useValue(subscriptionStore$.productFetchFailed)
  const [isRetryingProductFetch, setIsRetryingProductFetch] = useState(false)
  const iapActiveRef = useRef(false)
  const iapGenerationRef = useRef(0)

  const syncAndVerifyStorePurchase = useCallback(
    async (purchase: Purchase) => {
      await syncStorePurchase(getStorePurchaseSyncArgs(purchase))
      return await verifyStorePurchase(getStorePurchaseVerifyArgs(purchase))
    },
    [syncStorePurchase, verifyStorePurchase],
  )

  // Sync Convex state → local store
  useEffect(() => {
    // `undefined` means the query is still loading; anything else (including a
    // null/free result) means the live tier is now authoritative for this
    // session, so the tab bar can stop relying on the persisted last-known tier.
    if (subscriptionQuery !== undefined) {
      subscriptionActions.markSubscriptionResolved()
    }
    if (subscriptionQuery?.tier) {
      subscriptionActions.setCurrentTier(subscriptionQuery.tier)
    }
  }, [subscriptionQuery])

  // Initialize IAP: fetch products and listen for purchase updates
  useEffect(() => {
    if (!initializeIap) return

    const generation = iapGenerationRef.current + 1
    iapGenerationRef.current = generation
    iapActiveRef.current = true
    iapConnection.addConsumer()
    // expo-iap can emit queued transactions during initialization, so listeners
    // must exist before the native connection opens.
    subscribeToPurchaseUpdates(syncAndVerifyStorePurchase)

    async function initIAP() {
      try {
        await runCatalogAttempt(
          'initial',
          () => iapActiveRef.current && iapGenerationRef.current === generation,
        )
      } catch {
        if (iapActiveRef.current && iapGenerationRef.current === generation) {
          subscriptionActions.failProductFetch()
        }
      }
    }

    initIAP()

    return () => {
      if (iapGenerationRef.current === generation) {
        iapActiveRef.current = false
      }
      iapConnection
        .removeConsumer(() => {
          purchaseUpdateSub?.remove()
          purchaseErrorSub?.remove()
          purchaseUpdateSub = undefined
          purchaseErrorSub = undefined
          syncPurchaseForUpdates = undefined
        })
        .catch((err) => {
          telemetry.warn('iap:close', 'Failed to close IAP connection', {
            error: serializeIapError(err),
          })
        })
    }
  }, [initializeIap, syncAndVerifyStorePurchase])

  const retryProductFetch = useCallback(async () => {
    if (!initializeIap || isRetryingProductFetch) return
    setIsRetryingProductFetch(true)
    const generation = iapGenerationRef.current
    try {
      subscribeToPurchaseUpdates(syncAndVerifyStorePurchase)
      await runCatalogAttempt(
        'manual_retry',
        () => iapActiveRef.current && iapGenerationRef.current === generation,
      )
    } catch {
      subscriptionActions.failProductFetch()
    } finally {
      setIsRetryingProductFetch(false)
    }
  }, [initializeIap, isRetryingProductFetch, syncAndVerifyStorePurchase])

  const requestStorePurchase = useCallback(async (productId: string) => {
    try {
      await iapConnection.ensureConnected()

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
    async (productId: string = EXTRA_CAMP_PRODUCT_IDS.campKindling3Pack) => {
      subscriptionActions.startAddOnPurchase(productId)
      await requestStorePurchase(productId)
    },
    [requestStorePurchase],
  )

  const restore = useCallback(async () => {
    subscriptionActions.startRestore()

    try {
      await iapConnection.ensureConnected()
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
        await iapConnection.ensureConnected()
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
    productFetchFailed,
    retryProductFetch,
    isRetryingProductFetch,
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

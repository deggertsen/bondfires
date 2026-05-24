import { observable } from '@legendapp/state'

/**
 * Product IDs as defined in the Phase 2 launch plan.
 * These must exactly match the product identifiers configured in App Store Connect
 * and Google Play Console.
 */
export const SUBSCRIPTION_PRODUCT_IDS = {
  plusMonthly: 'bondfires.plus.monthly',
  plusAnnual: 'bondfires.plus.annual',
  premiumMonthly: 'bondfires.premium.monthly',
  premiumAnnual: 'bondfires.premium.annual',
  proMonthly: 'bondfires.pro.monthly',
  proAnnual: 'bondfires.pro.annual',
} as const

/**
 * Consumable IAP product IDs for purchasing extra camp slots.
 * These are one-time purchases (not subscriptions). Each purchase adds
 * the specified number of slots to the user's balance.
 */
export const EXTRA_CAMP_SLOT_PRODUCTS = {
  single: 'bondfires.extra_camp.1',
  pack5: 'bondfires.extra_camp.5',
  pack10: 'bondfires.extra_camp.10',
} as const

/** Product ID → number of slots granted */
export const EXTRA_CAMP_SLOT_COUNTS: Record<string, number> = {
  [EXTRA_CAMP_SLOT_PRODUCTS.single]: 1,
  [EXTRA_CAMP_SLOT_PRODUCTS.pack5]: 5,
  [EXTRA_CAMP_SLOT_PRODUCTS.pack10]: 10,
}

export function isExtraCampSlotProduct(productId: string): boolean {
  return productId in EXTRA_CAMP_SLOT_COUNTS
}

export function getExtraCampSlotCount(productId: string): number {
  return EXTRA_CAMP_SLOT_COUNTS[productId] ?? 0
}

export type SubscriptionTier = 'free' | 'plus' | 'premium' | 'pro'
export type BillingPeriod = 'monthly' | 'annual'
export type StorePurchaseKind = 'subscription' | 'consumable'

export const TIER_PRODUCT_IDS: Record<
  Exclude<SubscriptionTier, 'free'>,
  Record<BillingPeriod, string>
> = {
  plus: {
    monthly: SUBSCRIPTION_PRODUCT_IDS.plusMonthly,
    annual: SUBSCRIPTION_PRODUCT_IDS.plusAnnual,
  },
  premium: {
    monthly: SUBSCRIPTION_PRODUCT_IDS.premiumMonthly,
    annual: SUBSCRIPTION_PRODUCT_IDS.premiumAnnual,
  },
  pro: {
    monthly: SUBSCRIPTION_PRODUCT_IDS.proMonthly,
    annual: SUBSCRIPTION_PRODUCT_IDS.proAnnual,
  },
}

export const PRODUCT_ID_TO_TIER: Record<string, SubscriptionTier | undefined> = {
  [SUBSCRIPTION_PRODUCT_IDS.plusMonthly]: 'plus',
  [SUBSCRIPTION_PRODUCT_IDS.plusAnnual]: 'plus',
  [SUBSCRIPTION_PRODUCT_IDS.premiumMonthly]: 'premium',
  [SUBSCRIPTION_PRODUCT_IDS.premiumAnnual]: 'premium',
  [SUBSCRIPTION_PRODUCT_IDS.proMonthly]: 'pro',
  [SUBSCRIPTION_PRODUCT_IDS.proAnnual]: 'pro',
}

export const PRODUCT_ID_TO_PURCHASE_KIND: Record<string, StorePurchaseKind | undefined> = {
  [SUBSCRIPTION_PRODUCT_IDS.plusMonthly]: 'subscription',
  [SUBSCRIPTION_PRODUCT_IDS.plusAnnual]: 'subscription',
  [SUBSCRIPTION_PRODUCT_IDS.premiumMonthly]: 'subscription',
  [SUBSCRIPTION_PRODUCT_IDS.premiumAnnual]: 'subscription',
  [SUBSCRIPTION_PRODUCT_IDS.proMonthly]: 'subscription',
  [SUBSCRIPTION_PRODUCT_IDS.proAnnual]: 'subscription',
  [EXTRA_CAMP_SLOT_PRODUCTS.single]: 'consumable',
  [EXTRA_CAMP_SLOT_PRODUCTS.pack5]: 'consumable',
  [EXTRA_CAMP_SLOT_PRODUCTS.pack10]: 'consumable',
}

export const ALL_SUBSCRIPTION_PRODUCT_IDS: string[] = Object.values(SUBSCRIPTION_PRODUCT_IDS)
export const ALL_EXTRA_CAMP_SLOT_PRODUCT_IDS: string[] = Object.values(EXTRA_CAMP_SLOT_PRODUCTS)
export const ALL_PRODUCT_IDS: string[] = [
  ...ALL_SUBSCRIPTION_PRODUCT_IDS,
  ...ALL_EXTRA_CAMP_SLOT_PRODUCT_IDS,
]

export const TIER_RANK: Record<SubscriptionTier, number> = {
  free: 0,
  plus: 1,
  premium: 2,
  pro: 3,
}

export const TIER_LABELS: Record<SubscriptionTier, string> = {
  free: 'Free',
  plus: 'Plus',
  premium: 'Premium',
  pro: 'Pro',
}

export interface TierFeature {
  label: string
  included: boolean
}

export interface TierInfo {
  tier: SubscriptionTier
  productId: string | null
  annualProductId?: string | null
  displayName: string
  price: string | null
  annualPrice?: string | null
  description: string
  features: TierFeature[]
  isCurrent: boolean
  isFeatured: boolean
  isAvailable: boolean
}

export interface ExtraCampSlotInfo {
  productId: string
  displayName: string
  slotCount: number
  price: string | null
  isAvailable: boolean
}

/**
 * Static tier metadata — used for the paywall UI even when products haven't loaded.
 * Prices are populated from the store once products are fetched.
 */
export const TIER_DEFINITIONS: Record<
  Exclude<SubscriptionTier, 'free'>,
  {
    productId: string
    annualProductId: string
    displayName: string
    description: string
    features: { label: string }[]
  }
> = {
  plus: {
    productId: TIER_PRODUCT_IDS.plus.monthly,
    annualProductId: TIER_PRODUCT_IDS.plus.annual,
    displayName: 'Plus',
    description: 'Create in public camps and one private camp.',
    features: [
      { label: 'Create bondfires in public camps' },
      { label: 'One private camp' },
      { label: 'Up to 30-minute recordings' },
      { label: '1-month private camp video storage' },
    ],
  },
  premium: {
    productId: TIER_PRODUCT_IDS.premium.monthly,
    annualProductId: TIER_PRODUCT_IDS.premium.annual,
    displayName: 'Premium',
    description: 'Keep private camp videos without the Plus storage limit.',
    features: [
      { label: 'Everything in Plus' },
      { label: 'Unlimited private camp video storage' },
      { label: 'Up to 30-minute recordings' },
      { label: 'Priority support' },
    ],
  },
  pro: {
    productId: TIER_PRODUCT_IDS.pro.monthly,
    annualProductId: TIER_PRODUCT_IDS.pro.annual,
    displayName: 'Pro',
    description: 'Manage public camps up to the included allowance.',
    features: [
      { label: 'Everything in Premium' },
      { label: 'Public camp management' },
      { label: 'Extra public camp slots available as one-time purchases' },
      { label: 'Advanced analytics' },
      { label: 'Early access to new features' },
    ],
  },
}

/** Base camp limits by tier. Only Pro can create public camps. */
export const TIER_CAMP_LIMITS: Record<
  SubscriptionTier,
  { publicCamps: number; privateCamps: number }
> = {
  free: { publicCamps: 0, privateCamps: 0 },
  plus: { publicCamps: 0, privateCamps: 1 },
  premium: { publicCamps: 0, privateCamps: 1 },
  pro: { publicCamps: 3, privateCamps: 1 },
}

export interface SubscriptionState {
  /** The user's current active tier from Convex (or 'free' if none). */
  currentTier: SubscriptionTier
  /** Whether the store products have been fetched. */
  productsLoaded: boolean
  /** Map of productId → localized price string (e.g. "$4.99"). */
  productPrices: Record<string, string>
  /** Map of productId → Android subscription offer token required for purchase. */
  productOfferTokens: Record<string, string>
  /** Whether a purchase is in progress. */
  isPurchasing: boolean
  /** Whether a restore is in progress. */
  isRestoring: boolean
  /** The tier being purchased, if any. */
  purchasingTier: SubscriptionTier | null
  /** The store product currently being purchased, if any. */
  purchasingProductId: string | null
  /** Last purchase or restore error message. */
  lastError: string | null
  /** Whether the paywall sheet is visible. */
  isPaywallVisible: boolean
}

export const subscriptionStore$ = observable<SubscriptionState>({
  currentTier: 'free',
  productsLoaded: false,
  productPrices: {},
  productOfferTokens: {},
  isPurchasing: false,
  isRestoring: false,
  purchasingTier: null,
  purchasingProductId: null,
  lastError: null,
  isPaywallVisible: false,
})

export const subscriptionActions = {
  setCurrentTier(tier: SubscriptionTier) {
    subscriptionStore$.currentTier.set(tier)
  },

  setProducts(products: Array<{ productId: string; price: string; offerToken?: string | null }>) {
    const prices: Record<string, string> = {}
    const offerTokens: Record<string, string> = {}
    for (const p of products) {
      prices[p.productId] = p.price
      if (p.offerToken) {
        offerTokens[p.productId] = p.offerToken
      }
    }
    subscriptionStore$.productPrices.set(prices)
    subscriptionStore$.productOfferTokens.set(offerTokens)
    subscriptionStore$.productsLoaded.set(true)
  },

  setProductsLoaded(loaded: boolean) {
    subscriptionStore$.productsLoaded.set(loaded)
  },

  startPurchase(tier: SubscriptionTier, productId?: string) {
    subscriptionStore$.isPurchasing.set(true)
    subscriptionStore$.purchasingTier.set(tier)
    subscriptionStore$.purchasingProductId.set(productId ?? null)
    subscriptionStore$.lastError.set(null)
  },

  startConsumablePurchase(productId: string) {
    subscriptionStore$.isPurchasing.set(true)
    subscriptionStore$.purchasingTier.set(null)
    subscriptionStore$.purchasingProductId.set(productId)
    subscriptionStore$.lastError.set(null)
  },

  completePurchase(success: boolean, tier?: SubscriptionTier) {
    subscriptionStore$.isPurchasing.set(false)
    subscriptionStore$.purchasingTier.set(null)
    subscriptionStore$.purchasingProductId.set(null)
    if (success && tier) {
      subscriptionStore$.currentTier.set(tier)
    }
  },

  failPurchase(error: string) {
    subscriptionStore$.isPurchasing.set(false)
    subscriptionStore$.purchasingTier.set(null)
    subscriptionStore$.purchasingProductId.set(null)
    subscriptionStore$.lastError.set(error)
  },

  startRestore() {
    subscriptionStore$.isRestoring.set(true)
    subscriptionStore$.lastError.set(null)
  },

  completeRestore(success: boolean) {
    subscriptionStore$.isRestoring.set(false)
    if (!success) {
      subscriptionStore$.lastError.set('No purchases found to restore.')
    }
  },

  failRestore(error: string) {
    subscriptionStore$.isRestoring.set(false)
    subscriptionStore$.lastError.set(error)
  },

  showPaywall() {
    subscriptionStore$.isPaywallVisible.set(true)
  },

  hidePaywall() {
    subscriptionStore$.isPaywallVisible.set(false)
  },

  clearError() {
    subscriptionStore$.lastError.set(null)
  },
}

/**
 * Check if a tier is sufficient to meet a required tier.
 */
export function tierMeetsRequirement(
  userTier: SubscriptionTier,
  requiredTier: SubscriptionTier,
): boolean {
  return TIER_RANK[userTier] >= TIER_RANK[requiredTier]
}

/**
 * Get the minimum tier required for creating a bondfire.
 * Users must be at least Plus to create.
 */
export const CREATE_REQUIRED_TIER: SubscriptionTier = 'plus'

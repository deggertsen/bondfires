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

/** Slot pack product IDs — consumable IAPs for extra camp slots. */
export const SLOT_PACK_PRODUCT_IDS = {
  campSlot3Pack: 'bondfires.camp_slots.3pack',
  campSlot10Pack: 'bondfires.camp_slots.10pack',
} as const

export type SubscriptionTier = 'free' | 'plus' | 'premium' | 'pro'
export type BillingPeriod = 'monthly' | 'annual'
export type SlotPackSize = 'threePack' | 'tenPack'
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

export const EXTRA_CAMP_PRODUCT_IDS = {
  campSlot3Pack: SLOT_PACK_PRODUCT_IDS.campSlot3Pack,
  campSlot10Pack: SLOT_PACK_PRODUCT_IDS.campSlot10Pack,
}

export function isExtraCampProductId(productId: string) {
  return (
    productId === SLOT_PACK_PRODUCT_IDS.campSlot3Pack ||
    productId === SLOT_PACK_PRODUCT_IDS.campSlot10Pack
  )
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
  [SLOT_PACK_PRODUCT_IDS.campSlot3Pack]: 'consumable',
  [SLOT_PACK_PRODUCT_IDS.campSlot10Pack]: 'consumable',
}

export const ALL_SUBSCRIPTION_PRODUCT_IDS = Object.values(SUBSCRIPTION_PRODUCT_IDS)
export const ALL_STORE_PRODUCT_IDS = [
  ...Object.values(SUBSCRIPTION_PRODUCT_IDS),
  ...Object.values(SLOT_PACK_PRODUCT_IDS),
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

export interface ExtraCampAddOnInfo {
  threePackProductId: string
  tenPackProductId: string
  displayName: string
  description: string
  threePackPrice: string | null
  tenPackPrice: string | null
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
    description: 'Manage public camps with monthly camp slots.',
    features: [
      { label: 'Everything in Premium' },
      { label: 'Public camp management' },
      { label: '3 included public camp slots each month' },
      { label: 'Extra camp slots available as consumables' },
      { label: 'Advanced analytics' },
      { label: 'Early access to new features' },
    ],
  },
}

export const EXTRA_CAMP_ADD_ON_DEFINITION = {
  threePackProductId: EXTRA_CAMP_PRODUCT_IDS.campSlot3Pack,
  tenPackProductId: EXTRA_CAMP_PRODUCT_IDS.campSlot10Pack,
  displayName: 'Camp slots',
  description: 'Add permanent public camp slots to your balance.',
}

/** Base private-camp limits by tier. Pro public camps are governed by slot balance. */
export const TIER_CAMP_LIMITS: Record<
  SubscriptionTier,
  { publicCamps?: number; privateCamps: number }
> = {
  free: { privateCamps: 0 },
  plus: { privateCamps: 1 },
  premium: { privateCamps: 1 },
  pro: { privateCamps: 1 },
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

  startAddOnPurchase(productId: string) {
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

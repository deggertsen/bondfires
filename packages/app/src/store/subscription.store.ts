import { observable } from '@legendapp/state'

/**
 * Product IDs as defined in the Phase 2 launch plan.
 * These must exactly match the product identifiers configured in App Store Connect
 * and Google Play Console.
 */
export const SUBSCRIPTION_PRODUCT_IDS = {
  plus: 'bondfires.plus.monthly',
  premium: 'bondfires.premium.monthly',
  pro: 'bondfires.pro.monthly',
} as const

export type SubscriptionTier = 'free' | 'plus' | 'premium' | 'pro'

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
  displayName: string
  price: string | null
  description: string
  features: TierFeature[]
  isCurrent: boolean
  isHighest: boolean
}

/**
 * Static tier metadata — used for the paywall UI even when products haven't loaded.
 * Prices are populated from the store once products are fetched.
 */
export const TIER_DEFINITIONS: Record<
  Exclude<SubscriptionTier, 'free'>,
  {
    productId: string
    displayName: string
    description: string
    features: { label: string }[]
  }
> = {
  plus: {
    productId: SUBSCRIPTION_PRODUCT_IDS.plus,
    displayName: 'Plus',
    description: 'Create in public camps and one private camp.',
    features: [
      { label: 'Create bondfires in public camps' },
      { label: 'One private camp' },
      { label: 'Up to 30-minute recordings' },
      { label: '1-month video retention' },
    ],
  },
  premium: {
    productId: SUBSCRIPTION_PRODUCT_IDS.premium,
    displayName: 'Premium',
    description: 'Create anywhere with extended limits.',
    features: [
      { label: 'Everything in Plus' },
      { label: 'Unlimited private camps' },
      { label: 'Up to 60-minute recordings' },
      { label: '3-month video retention' },
      { label: 'Priority support' },
    ],
  },
  pro: {
    productId: SUBSCRIPTION_PRODUCT_IDS.pro,
    displayName: 'Pro',
    description: 'Full creative freedom, unlimited everything.',
    features: [
      { label: 'Everything in Premium' },
      { label: 'Unlimited recording duration' },
      { label: 'Permanent video retention' },
      { label: 'Advanced analytics' },
      { label: 'Early access to new features' },
    ],
  },
}

export interface SubscriptionState {
  /** The user's current active tier from Convex (or 'free' if none). */
  currentTier: SubscriptionTier
  /** Whether the store products have been fetched. */
  productsLoaded: boolean
  /** Map of productId → localized price string (e.g. "$4.99"). */
  productPrices: Record<string, string>
  /** Whether a purchase is in progress. */
  isPurchasing: boolean
  /** Whether a restore is in progress. */
  isRestoring: boolean
  /** The tier being purchased, if any. */
  purchasingTier: SubscriptionTier | null
  /** Last purchase or restore error message. */
  lastError: string | null
  /** Whether the paywall sheet is visible. */
  isPaywallVisible: boolean
}

export const subscriptionStore$ = observable<SubscriptionState>({
  currentTier: 'free',
  productsLoaded: false,
  productPrices: {},
  isPurchasing: false,
  isRestoring: false,
  purchasingTier: null,
  lastError: null,
  isPaywallVisible: false,
})

export const subscriptionActions = {
  setCurrentTier(tier: SubscriptionTier) {
    subscriptionStore$.currentTier.set(tier)
  },

  setProducts(products: Array<{ productId: string; price: string }>) {
    const prices: Record<string, string> = {}
    for (const p of products) {
      prices[p.productId] = p.price
    }
    subscriptionStore$.productPrices.set(prices)
    subscriptionStore$.productsLoaded.set(true)
  },

  setProductsLoaded(loaded: boolean) {
    subscriptionStore$.productsLoaded.set(loaded)
  },

  startPurchase(tier: SubscriptionTier) {
    subscriptionStore$.isPurchasing.set(true)
    subscriptionStore$.purchasingTier.set(tier)
    subscriptionStore$.lastError.set(null)
  },

  completePurchase(success: boolean, tier?: SubscriptionTier) {
    subscriptionStore$.isPurchasing.set(false)
    subscriptionStore$.purchasingTier.set(null)
    if (success && tier) {
      subscriptionStore$.currentTier.set(tier)
    }
  },

  failPurchase(error: string) {
    subscriptionStore$.isPurchasing.set(false)
    subscriptionStore$.purchasingTier.set(null)
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

import { v } from 'convex/values'
import { internal } from './_generated/api'
import type { Id } from './_generated/dataModel'
import type { MutationCtx } from './_generated/server'
import { action, internalMutation, mutation, query } from './_generated/server'
import { auth } from './auth'
import {
  freezeExcessOwnedCamps,
  getActiveSubscriptionTier,
  getEntitlementSubscriptionTier,
  getExtraCampAddOnCount,
  getPublicCampLimit,
  getTierMaxVideoDurationMs,
  handleTierDowngrade,
  handleTierUpgrade,
  processExpiredReclaims as processExpiredReclaimsImpl,
  reclaimFrozenCamps,
  type SubscriptionTier,
  TIER_RANK,
  tierCanCreateBondfires,
} from './entitlements'

type SubscriptionPlatform = 'ios' | 'android'
type StorePurchaseKind = 'subscription' | 'extraCamp'
type VerifiedStoreStatus = 'active' | 'trialing' | 'past_due' | 'canceled' | 'expired'
type StoreSyncStatus = 'pending_verification' | VerifiedStoreStatus

type StoreVerificationResult = {
  status: StoreSyncStatus
  storeProductId: string
  storeTransactionId?: string
  storeOriginalTransactionId?: string
  storePurchaseToken?: string
  currentPeriodEnd?: number
}

type AppleTransactionPayload = {
  bundleId?: string
  expiresDate?: number
  originalTransactionId?: string
  productId?: string
  transactionId?: string
  type?: string
}

type GoogleSubscriptionPurchase = {
  latestOrderId?: string
  lineItems?: Array<{
    expiryTime?: string
    productId?: string
  }>
  subscriptionState?: string
}

const APPLE_PRODUCTION_API_BASE = 'https://api.storekit.itunes.apple.com'
const APPLE_SANDBOX_API_BASE = 'https://api.storekit-sandbox.itunes.apple.com'
const GOOGLE_ANDROID_PUBLISHER_SCOPE = 'https://www.googleapis.com/auth/androidpublisher'
const GOOGLE_OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token'

const storeStatusValidator = v.union(
  v.literal('pending_verification'),
  v.literal('active'),
  v.literal('trialing'),
  v.literal('past_due'),
  v.literal('canceled'),
  v.literal('expired'),
)

const storePurchaseKindValidator = v.union(v.literal('subscription'), v.literal('extraCamp'))

const PRODUCT_ID_TO_TIER: Record<string, SubscriptionTier | undefined> = {
  'bondfires.plus.monthly': 'plus',
  'bondfires.plus.annual': 'plus',
  'bondfires.premium.monthly': 'premium',
  'bondfires.premium.annual': 'premium',
  'bondfires.pro.monthly': 'pro',
  'bondfires.pro.annual': 'pro',
}

const EXTRA_CAMP_PRODUCT_IDS = new Set([
  'bondfires.extra_camp.monthly',
  'bondfires.extra_camp.annual',
])

function getStorePurchaseKind(storeProductId: string): StorePurchaseKind | null {
  if (PRODUCT_ID_TO_TIER[storeProductId]) {
    return 'subscription'
  }

  if (EXTRA_CAMP_PRODUCT_IDS.has(storeProductId)) {
    return 'extraCamp'
  }

  return null
}

function assertStoreProductMatchesKind(storeProductId: string, kind: StorePurchaseKind) {
  if (getStorePurchaseKind(storeProductId) !== kind) {
    throw new Error(
      `Verified store product does not match requested purchase kind: ${storeProductId}`,
    )
  }
}

function getTierForStoreProduct(storeProductId: string) {
  return PRODUCT_ID_TO_TIER[storeProductId] ?? null
}

function base64UrlEncode(input: string | ArrayBuffer) {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : new Uint8Array(input)
  let binary = ''
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

function base64UrlDecode(input: string) {
  const padded = input
    .replaceAll('-', '+')
    .replaceAll('_', '/')
    .padEnd(Math.ceil(input.length / 4) * 4, '=')
  return atob(padded)
}

function parsePrivateKeyPem(privateKey: string) {
  const normalized = privateKey.replace(/\\n/g, '\n')
  const base64 = normalized
    .replace(/-----BEGIN [^-]+-----/g, '')
    .replace(/-----END [^-]+-----/g, '')
    .replace(/\s/g, '')
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes.buffer
}

async function signJwt(
  header: Record<string, unknown>,
  payload: Record<string, unknown>,
  keyAlgorithm: RsaHashedImportParams | EcKeyImportParams,
  signAlgorithm: AlgorithmIdentifier | EcdsaParams,
  privateKey: string,
) {
  const encodedHeader = base64UrlEncode(JSON.stringify(header))
  const encodedPayload = base64UrlEncode(JSON.stringify(payload))
  const signingInput = `${encodedHeader}.${encodedPayload}`
  const key = await crypto.subtle.importKey(
    'pkcs8',
    parsePrivateKeyPem(privateKey),
    keyAlgorithm,
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign(
    signAlgorithm,
    key,
    new TextEncoder().encode(signingInput),
  )
  return `${signingInput}.${base64UrlEncode(signature)}`
}

function readRequiredEnv(name: string) {
  const value = process.env[name]
  if (!value) {
    throw new Error(`${name} is not configured`)
  }
  return value
}

function readGoogleServiceAccount() {
  const rawJson = process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON
  if (rawJson) {
    const parsed = JSON.parse(rawJson) as { client_email?: string; private_key?: string }
    if (!parsed.client_email || !parsed.private_key) {
      throw new Error('GOOGLE_PLAY_SERVICE_ACCOUNT_JSON must include client_email and private_key')
    }
    return {
      clientEmail: parsed.client_email,
      privateKey: parsed.private_key,
    }
  }

  return {
    clientEmail: readRequiredEnv('GOOGLE_PLAY_SERVICE_ACCOUNT_EMAIL'),
    privateKey: readRequiredEnv('GOOGLE_PLAY_SERVICE_ACCOUNT_PRIVATE_KEY'),
  }
}

function decodeAppleSignedTransactionInfo(jws: string): AppleTransactionPayload {
  const [, payload] = jws.split('.')
  if (!payload) {
    throw new Error('Apple transaction response did not include a signed payload')
  }
  return JSON.parse(base64UrlDecode(payload)) as AppleTransactionPayload
}

function mapAppleTransactionStatus(payload: AppleTransactionPayload): VerifiedStoreStatus {
  if (payload.type !== 'Auto-Renewable Subscription') {
    throw new Error(`Unsupported Apple transaction type: ${payload.type ?? 'unknown'}`)
  }

  if (payload.expiresDate && payload.expiresDate > Date.now()) {
    return 'active'
  }

  return 'expired'
}

function mapGoogleSubscriptionStatus(
  subscription: GoogleSubscriptionPurchase,
  currentPeriodEnd?: number,
): StoreSyncStatus {
  const state = subscription.subscriptionState
  const hasFuturePeriod = currentPeriodEnd === undefined || currentPeriodEnd > Date.now()

  if (
    hasFuturePeriod &&
    (state === 'SUBSCRIPTION_STATE_ACTIVE' ||
      state === 'SUBSCRIPTION_STATE_CANCELED' ||
      state === 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD')
  ) {
    return 'active'
  }

  if (state === 'SUBSCRIPTION_STATE_ON_HOLD' || state === 'SUBSCRIPTION_STATE_PAUSED') {
    return 'past_due'
  }

  if (state === 'SUBSCRIPTION_STATE_CANCELED') {
    return 'canceled'
  }

  if (state === 'SUBSCRIPTION_STATE_EXPIRED') {
    return 'expired'
  }

  return 'pending_verification'
}

function getGoogleCurrentPeriodEnd(subscription: GoogleSubscriptionPurchase) {
  const expiryTimes =
    subscription.lineItems
      ?.map((lineItem) => (lineItem.expiryTime ? Date.parse(lineItem.expiryTime) : Number.NaN))
      .filter(Number.isFinite) ?? []
  if (expiryTimes.length === 0) {
    return undefined
  }
  return Math.max(...expiryTimes)
}

function getGoogleProductId(subscription: GoogleSubscriptionPurchase, fallbackProductId: string) {
  const productIds = new Set(
    subscription.lineItems?.map((lineItem) => lineItem.productId).filter(Boolean),
  )
  if (productIds.size === 0) {
    return fallbackProductId
  }
  if (productIds.size > 1) {
    throw new Error('Google purchase contains multiple subscription products')
  }
  return [...productIds][0] ?? fallbackProductId
}

async function verifyAppleStorePurchase(args: {
  storeProductId: string
  storeTransactionId?: string
  storeOriginalTransactionId?: string
}): Promise<StoreVerificationResult> {
  const transactionId = args.storeTransactionId ?? args.storeOriginalTransactionId
  if (!transactionId) {
    throw new Error('Apple verification requires a transaction identifier')
  }

  const bundleId = readRequiredEnv('APPLE_BUNDLE_ID')
  const nowSeconds = Math.floor(Date.now() / 1000)
  const token = await signJwt(
    {
      alg: 'ES256',
      kid: readRequiredEnv('APPLE_IAP_KEY_ID'),
      typ: 'JWT',
    },
    {
      iss: readRequiredEnv('APPLE_IAP_ISSUER_ID'),
      iat: nowSeconds,
      exp: nowSeconds + 20 * 60,
      aud: 'appstoreconnect-v1',
      bid: bundleId,
    },
    { name: 'ECDSA', namedCurve: 'P-256' },
    { name: 'ECDSA', hash: 'SHA-256' },
    readRequiredEnv('APPLE_IAP_PRIVATE_KEY'),
  )

  const environment = process.env.APPLE_IAP_ENVIRONMENT
  const apiBases =
    environment === 'sandbox'
      ? [APPLE_SANDBOX_API_BASE]
      : environment === 'production'
        ? [APPLE_PRODUCTION_API_BASE]
        : [APPLE_PRODUCTION_API_BASE, APPLE_SANDBOX_API_BASE]

  let lastError: string | null = null
  for (const apiBase of apiBases) {
    const response = await fetch(
      `${apiBase}/inApps/v1/transactions/${encodeURIComponent(transactionId)}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
    )
    if (!response.ok) {
      lastError = `${response.status}: ${await response.text()}`
      continue
    }

    const body = (await response.json()) as { signedTransactionInfo?: string }
    if (!body.signedTransactionInfo) {
      throw new Error('Apple transaction response did not include signedTransactionInfo')
    }

    const payload = decodeAppleSignedTransactionInfo(body.signedTransactionInfo)
    if (payload.bundleId !== bundleId) {
      throw new Error('Apple transaction bundle ID does not match this app')
    }
    if (payload.productId !== args.storeProductId) {
      throw new Error('Apple transaction product does not match the requested product')
    }

    return {
      status: mapAppleTransactionStatus(payload),
      storeProductId: payload.productId,
      storeTransactionId: payload.transactionId ?? args.storeTransactionId,
      storeOriginalTransactionId:
        payload.originalTransactionId ?? args.storeOriginalTransactionId ?? payload.transactionId,
      currentPeriodEnd: payload.expiresDate,
    }
  }

  throw new Error(`Apple purchase verification failed${lastError ? `: ${lastError}` : ''}`)
}

async function getGoogleAccessToken() {
  const serviceAccount = readGoogleServiceAccount()
  const nowSeconds = Math.floor(Date.now() / 1000)
  const assertion = await signJwt(
    {
      alg: 'RS256',
      typ: 'JWT',
    },
    {
      iss: serviceAccount.clientEmail,
      scope: GOOGLE_ANDROID_PUBLISHER_SCOPE,
      aud: GOOGLE_OAUTH_TOKEN_URL,
      iat: nowSeconds,
      exp: nowSeconds + 60 * 60,
    },
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    { name: 'RSASSA-PKCS1-v1_5' },
    serviceAccount.privateKey,
  )

  const response = await fetch(GOOGLE_OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }).toString(),
  })

  if (!response.ok) {
    throw new Error(`Google OAuth failed: ${response.status} ${await response.text()}`)
  }

  const body = (await response.json()) as { access_token?: string }
  if (!body.access_token) {
    throw new Error('Google OAuth response did not include an access token')
  }
  return body.access_token
}

async function verifyGoogleStorePurchase(args: {
  storeProductId: string
  storePurchaseToken?: string
}): Promise<StoreVerificationResult> {
  if (!args.storePurchaseToken) {
    throw new Error('Google verification requires a purchase token')
  }

  const packageName = readRequiredEnv('GOOGLE_PLAY_PACKAGE_NAME')
  const accessToken = await getGoogleAccessToken()
  const response = await fetch(
    `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${encodeURIComponent(
      packageName,
    )}/purchases/subscriptionsv2/tokens/${encodeURIComponent(args.storePurchaseToken)}`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    },
  )

  if (!response.ok) {
    throw new Error(
      `Google purchase verification failed: ${response.status} ${await response.text()}`,
    )
  }

  const subscription = (await response.json()) as GoogleSubscriptionPurchase
  const storeProductId = getGoogleProductId(subscription, args.storeProductId)
  if (storeProductId !== args.storeProductId) {
    throw new Error('Google subscription product does not match the requested product')
  }

  const currentPeriodEnd = getGoogleCurrentPeriodEnd(subscription)
  return {
    status: mapGoogleSubscriptionStatus(subscription, currentPeriodEnd),
    storeProductId,
    storeTransactionId: subscription.latestOrderId,
    storeOriginalTransactionId: args.storePurchaseToken,
    storePurchaseToken: args.storePurchaseToken,
    currentPeriodEnd,
  }
}

function getStoreOriginalTransactionId(args: {
  storeTransactionId?: string
  storeOriginalTransactionId?: string
  storePurchaseToken?: string
}) {
  return args.storeOriginalTransactionId ?? args.storeTransactionId ?? args.storePurchaseToken
}

function assertStoreIdentifiers(args: {
  platform: SubscriptionPlatform
  storeTransactionId?: string
  storeOriginalTransactionId?: string
  storePurchaseToken?: string
}) {
  if (args.platform === 'android' && !args.storePurchaseToken) {
    throw new Error('Android purchases require a store purchase token')
  }

  if (args.platform === 'ios' && !args.storeOriginalTransactionId && !args.storeTransactionId) {
    throw new Error('iOS purchases require a store transaction identifier')
  }
}

function getVerifiedSyncStatus(existing?: {
  status: string
  verificationStatus?: string
}): StoreSyncStatus {
  if (
    existing?.verificationStatus === 'verified' &&
    (existing.status === 'active' || existing.status === 'trialing')
  ) {
    return existing.status
  }

  return 'pending_verification'
}

function isVerifiedActiveStoreRecord(existing?: { status: string; verificationStatus?: string }) {
  return getVerifiedSyncStatus(existing) !== 'pending_verification'
}

function getVerificationStateForStatus(status: StoreSyncStatus): 'pending' | 'verified' {
  return status === 'pending_verification' ? 'pending' : 'verified'
}

function statusUnlocksEntitlements(status: StoreSyncStatus) {
  return status === 'active' || status === 'trialing'
}

async function findExistingSubscription(
  ctx: MutationCtx,
  args: {
    userId: Id<'users'>
    storeProductId: string
    storeOriginalTransactionId?: string
    storePurchaseToken?: string
  },
) {
  if (args.storeOriginalTransactionId) {
    const byOriginalTransaction = await ctx.db
      .query('subscriptions')
      .withIndex('by_store_transaction', (q) =>
        q.eq('storeOriginalTransactionId', args.storeOriginalTransactionId),
      )
      .first()
    if (byOriginalTransaction) return byOriginalTransaction
  }

  if (args.storePurchaseToken) {
    const byPurchaseToken = await ctx.db
      .query('subscriptions')
      .withIndex('by_store_purchase_token', (q) =>
        q.eq('storePurchaseToken', args.storePurchaseToken),
      )
      .first()
    if (byPurchaseToken) return byPurchaseToken
  }

  const pendingSubscriptions = await ctx.db
    .query('subscriptions')
    .withIndex('by_user', (q) => q.eq('userId', args.userId).eq('status', 'pending_verification'))
    .collect()

  return (
    pendingSubscriptions.find(
      (subscription) => subscription.storeProductId === args.storeProductId,
    ) ?? null
  )
}

async function findExistingAddOn(
  ctx: MutationCtx,
  args: {
    userId: Id<'users'>
    storeProductId: string
    storeOriginalTransactionId?: string
    storePurchaseToken?: string
  },
) {
  if (args.storeOriginalTransactionId) {
    const byOriginalTransaction = await ctx.db
      .query('subscriptionAddOns')
      .withIndex('by_store_transaction', (q) =>
        q.eq('storeOriginalTransactionId', args.storeOriginalTransactionId),
      )
      .first()
    if (byOriginalTransaction) return byOriginalTransaction
  }

  if (args.storePurchaseToken) {
    const byPurchaseToken = await ctx.db
      .query('subscriptionAddOns')
      .withIndex('by_store_purchase_token', (q) =>
        q.eq('storePurchaseToken', args.storePurchaseToken),
      )
      .first()
    if (byPurchaseToken) return byPurchaseToken
  }

  const pendingAddOns = await ctx.db
    .query('subscriptionAddOns')
    .withIndex('by_user', (q) => q.eq('userId', args.userId).eq('status', 'pending_verification'))
    .collect()

  return pendingAddOns.find((addOn) => addOn.storeProductId === args.storeProductId) ?? null
}

export const current = query({
  args: {},
  handler: async (ctx) => {
    const userId = await auth.getUserId(ctx)
    if (!userId) {
      return null
    }

    const tier = await getEntitlementSubscriptionTier(ctx, userId)
    const now = Date.now()
    const subscriptions = await ctx.db
      .query('subscriptions')
      .withIndex('by_user', (q) => q.eq('userId', userId))
      .collect()
    const activeSubscriptions = subscriptions.filter(
      (subscription) =>
        subscription.verificationStatus === 'verified' &&
        (subscription.status === 'active' || subscription.status === 'trialing') &&
        (!subscription.currentPeriodEnd || subscription.currentPeriodEnd > now),
    )
    const subscription =
      activeSubscriptions.sort((left, right) => TIER_RANK[right.tier] - TIER_RANK[left.tier])[0] ??
      null
    const pendingStorePurchaseCount =
      subscriptions.filter(
        (subscription) =>
          subscription.status === 'pending_verification' &&
          subscription.verificationStatus === 'pending',
      ).length +
      (
        await ctx.db
          .query('subscriptionAddOns')
          .withIndex('by_user', (q) => q.eq('userId', userId).eq('status', 'pending_verification'))
          .collect()
      ).filter((addOn) => addOn.verificationStatus === 'pending').length

    return {
      tier,
      subscription,
      canCreateBondfires: tierCanCreateBondfires(tier),
      maxVideoDurationMs: getTierMaxVideoDurationMs(tier),
      extraCampAddOns: await getExtraCampAddOnCount(ctx, userId),
      publicCampLimit: await getPublicCampLimit(ctx, userId),
      pendingStorePurchaseCount,
    }
  },
})

export const canCreatePrivateCamp = query({
  args: {},
  handler: async (ctx) => {
    const userId = await auth.getUserId(ctx)
    if (!userId) {
      return false
    }

    const tier = await getEntitlementSubscriptionTier(ctx, userId)
    return tier === 'plus' || tier === 'premium' || tier === 'pro'
  },
})

export const syncStorePurchase = mutation({
  args: {
    platform: v.union(v.literal('ios'), v.literal('android')),
    storeProductId: v.string(),
    storeTransactionId: v.optional(v.string()),
    storeOriginalTransactionId: v.optional(v.string()),
    storePurchaseToken: v.optional(v.string()),
    currentPeriodEnd: v.optional(v.number()),
    purchasedAt: v.optional(v.number()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ tier: SubscriptionTier; kind: StorePurchaseKind; status: StoreSyncStatus }> => {
    const userId = await auth.getUserId(ctx)
    if (!userId) {
      throw new Error('Not authenticated')
    }

    const kind = getStorePurchaseKind(args.storeProductId)
    if (!kind) {
      throw new Error(`Unsupported store product: ${args.storeProductId}`)
    }

    assertStoreIdentifiers(args)

    const now = Date.now()
    const storeOriginalTransactionId = getStoreOriginalTransactionId(args)
    let syncStatus: StoreSyncStatus = 'pending_verification'
    const receiptFields = {
      storeTransactionId: args.storeTransactionId,
      storeOriginalTransactionId,
      storePurchaseToken: args.storePurchaseToken,
      updatedAt: now,
    }
    const pendingStoreFields = {
      userId,
      status: 'pending_verification' as const,
      verificationStatus: 'pending' as const,
      platform: args.platform,
      storeProductId: args.storeProductId,
      ...receiptFields,
      currentPeriodEnd: args.currentPeriodEnd,
    }

    if (kind === 'subscription') {
      const tier = PRODUCT_ID_TO_TIER[args.storeProductId]
      if (!tier) {
        throw new Error(`Unsupported subscription product: ${args.storeProductId}`)
      }

      const existing = await findExistingSubscription(ctx, {
        userId,
        storeProductId: args.storeProductId,
        storeOriginalTransactionId,
        storePurchaseToken: args.storePurchaseToken,
      })
      if (existing && existing.userId !== userId) {
        throw new Error('This store subscription is already linked to another account')
      }

      if (existing) {
        syncStatus = getVerifiedSyncStatus(existing)
        if (isVerifiedActiveStoreRecord(existing)) {
          if (existing.storeProductId !== args.storeProductId) {
            throw new Error('Store subscription product changes require server verification')
          }
          await ctx.db.patch(existing._id, receiptFields)
        } else {
          await ctx.db.patch(existing._id, {
            ...pendingStoreFields,
            tier,
          })
        }
      } else {
        await ctx.db.insert('subscriptions', {
          ...pendingStoreFields,
          tier,
          createdAt: args.purchasedAt ?? now,
        })
      }
    } else {
      const existing = await findExistingAddOn(ctx, {
        userId,
        storeProductId: args.storeProductId,
        storeOriginalTransactionId,
        storePurchaseToken: args.storePurchaseToken,
      })
      if (existing && existing.userId !== userId) {
        throw new Error('This store add-on is already linked to another account')
      }

      if (existing) {
        syncStatus = getVerifiedSyncStatus(existing)
        if (isVerifiedActiveStoreRecord(existing)) {
          if (existing.storeProductId !== args.storeProductId) {
            throw new Error('Store add-on product changes require server verification')
          }
          await ctx.db.patch(existing._id, receiptFields)
        } else {
          await ctx.db.patch(existing._id, {
            ...pendingStoreFields,
            type: 'extra_camp',
          })
        }
      } else {
        await ctx.db.insert('subscriptionAddOns', {
          ...pendingStoreFields,
          type: 'extra_camp',
          createdAt: args.purchasedAt ?? now,
        })
      }
    }

    return {
      tier: await getEntitlementSubscriptionTier(ctx, userId),
      kind,
      status: syncStatus,
    }
  },
})

export const applyStorePurchaseVerification = internalMutation({
  args: {
    userId: v.id('users'),
    kind: storePurchaseKindValidator,
    platform: v.union(v.literal('ios'), v.literal('android')),
    requestedStoreProductId: v.string(),
    lookupStoreTransactionId: v.optional(v.string()),
    lookupStoreOriginalTransactionId: v.optional(v.string()),
    lookupStorePurchaseToken: v.optional(v.string()),
    storeProductId: v.string(),
    storeTransactionId: v.optional(v.string()),
    storeOriginalTransactionId: v.optional(v.string()),
    storePurchaseToken: v.optional(v.string()),
    currentPeriodEnd: v.optional(v.number()),
    status: storeStatusValidator,
  },
  handler: async (ctx, args): Promise<{ tier: SubscriptionTier; status: StoreSyncStatus }> => {
    assertStoreProductMatchesKind(args.storeProductId, args.kind)

    const now = Date.now()
    let appliedStatus: StoreSyncStatus = args.status
    const verificationStatus = getVerificationStateForStatus(args.status)
    const lookup = {
      userId: args.userId,
      storeProductId: args.requestedStoreProductId,
      storeOriginalTransactionId:
        args.lookupStoreOriginalTransactionId ??
        args.lookupStoreTransactionId ??
        args.lookupStorePurchaseToken,
      storePurchaseToken: args.lookupStorePurchaseToken,
    }

    if (args.kind === 'subscription') {
      const previousEffectiveTier = await getActiveSubscriptionTier(ctx, args.userId)
      const tier = getTierForStoreProduct(args.storeProductId)
      if (!tier) {
        throw new Error(`Unsupported subscription product: ${args.storeProductId}`)
      }

      const existing =
        (await findExistingSubscription(ctx, lookup)) ??
        (await findExistingSubscription(ctx, {
          userId: args.userId,
          storeProductId: args.storeProductId,
          storeOriginalTransactionId: args.storeOriginalTransactionId,
          storePurchaseToken: args.storePurchaseToken,
        }))

      if (existing && existing.userId !== args.userId) {
        throw new Error('This store subscription is already linked to another account')
      }

      const fields = {
        userId: args.userId,
        tier,
        status: args.status,
        verificationStatus,
        platform: args.platform,
        storeProductId: args.storeProductId,
        storeTransactionId: args.storeTransactionId,
        storeOriginalTransactionId: args.storeOriginalTransactionId,
        storePurchaseToken: args.storePurchaseToken,
        currentPeriodEnd: args.currentPeriodEnd,
        verifiedAt: verificationStatus === 'verified' ? now : undefined,
        updatedAt: now,
      }

      if (existing) {
        await ctx.db.patch(existing._id, fields)
      } else {
        await ctx.db.insert('subscriptions', {
          ...fields,
          createdAt: now,
        })
      }

      if (verificationStatus === 'verified') {
        const newEffectiveTier = await getActiveSubscriptionTier(ctx, args.userId)
        if (TIER_RANK[newEffectiveTier] < TIER_RANK[previousEffectiveTier]) {
          await handleTierDowngrade(ctx, args.userId, previousEffectiveTier, newEffectiveTier)
        } else if (TIER_RANK[newEffectiveTier] > TIER_RANK[previousEffectiveTier]) {
          await handleTierUpgrade(ctx, args.userId, previousEffectiveTier, newEffectiveTier)
          if (TIER_RANK[newEffectiveTier] >= TIER_RANK.pro) {
            await reclaimFrozenCamps(ctx, args.userId, newEffectiveTier)
          }
        }
      }
    } else {
      const existing =
        (await findExistingAddOn(ctx, lookup)) ??
        (await findExistingAddOn(ctx, {
          userId: args.userId,
          storeProductId: args.storeProductId,
          storeOriginalTransactionId: args.storeOriginalTransactionId,
          storePurchaseToken: args.storePurchaseToken,
        }))

      if (existing && existing.userId !== args.userId) {
        throw new Error('This store add-on is already linked to another account')
      }

      const fields = {
        userId: args.userId,
        type: 'extra_camp' as const,
        status: args.status,
        verificationStatus,
        platform: args.platform,
        storeProductId: args.storeProductId,
        storeTransactionId: args.storeTransactionId,
        storeOriginalTransactionId: args.storeOriginalTransactionId,
        storePurchaseToken: args.storePurchaseToken,
        currentPeriodEnd: args.currentPeriodEnd,
        verifiedAt: verificationStatus === 'verified' ? now : undefined,
        updatedAt: now,
      }
      const userTier = await getEntitlementSubscriptionTier(ctx, args.userId)
      const canActivateAddOn =
        !statusUnlocksEntitlements(args.status) || TIER_RANK[userTier] >= TIER_RANK.pro
      const appliedFields = {
        ...fields,
        status: canActivateAddOn ? fields.status : ('expired' as const),
      }
      appliedStatus = appliedFields.status

      if (existing) {
        await ctx.db.patch(existing._id, appliedFields)
      } else {
        await ctx.db.insert('subscriptionAddOns', {
          ...appliedFields,
          createdAt: now,
        })
      }

      if (verificationStatus === 'verified') {
        if (statusUnlocksEntitlements(appliedFields.status)) {
          await reclaimFrozenCamps(ctx, args.userId, userTier)
        } else {
          await freezeExcessOwnedCamps(ctx, args.userId, userTier)
        }
      }
    }

    return {
      tier: await getEntitlementSubscriptionTier(ctx, args.userId),
      status: appliedStatus,
    }
  },
})

export const markStorePurchaseVerificationFailed = internalMutation({
  args: {
    userId: v.id('users'),
    kind: storePurchaseKindValidator,
    storeProductId: v.string(),
    storeTransactionId: v.optional(v.string()),
    storeOriginalTransactionId: v.optional(v.string()),
    storePurchaseToken: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const lookup = {
      userId: args.userId,
      storeProductId: args.storeProductId,
      storeOriginalTransactionId:
        args.storeOriginalTransactionId ?? args.storeTransactionId ?? args.storePurchaseToken,
      storePurchaseToken: args.storePurchaseToken,
    }
    const existing =
      args.kind === 'subscription'
        ? await findExistingSubscription(ctx, lookup)
        : await findExistingAddOn(ctx, lookup)

    if (!existing || existing.userId !== args.userId || isVerifiedActiveStoreRecord(existing)) {
      return
    }

    await ctx.db.patch(existing._id, {
      verificationStatus: 'failed',
      updatedAt: Date.now(),
    })
  },
})

export const verifyStorePurchase = action({
  args: {
    platform: v.union(v.literal('ios'), v.literal('android')),
    storeProductId: v.string(),
    storeTransactionId: v.optional(v.string()),
    storeOriginalTransactionId: v.optional(v.string()),
    storePurchaseToken: v.optional(v.string()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ tier: SubscriptionTier; kind: StorePurchaseKind; status: StoreSyncStatus }> => {
    const userId = await auth.getUserId(ctx)
    if (!userId) {
      throw new Error('Not authenticated')
    }

    const kind = getStorePurchaseKind(args.storeProductId)
    if (!kind) {
      throw new Error(`Unsupported store product: ${args.storeProductId}`)
    }

    assertStoreIdentifiers(args)

    try {
      const verification =
        args.platform === 'ios'
          ? await verifyAppleStorePurchase(args)
          : await verifyGoogleStorePurchase(args)

      assertStoreProductMatchesKind(verification.storeProductId, kind)

      const result = await ctx.runMutation(internal.subscriptions.applyStorePurchaseVerification, {
        userId,
        kind,
        platform: args.platform,
        requestedStoreProductId: args.storeProductId,
        lookupStoreTransactionId: args.storeTransactionId,
        lookupStoreOriginalTransactionId: args.storeOriginalTransactionId,
        lookupStorePurchaseToken: args.storePurchaseToken,
        storeProductId: verification.storeProductId,
        storeTransactionId: verification.storeTransactionId,
        storeOriginalTransactionId: verification.storeOriginalTransactionId,
        storePurchaseToken: verification.storePurchaseToken,
        currentPeriodEnd: verification.currentPeriodEnd,
        status: verification.status,
      })

      return {
        tier: result.tier,
        kind,
        status: result.status,
      }
    } catch (error) {
      await ctx.runMutation(internal.subscriptions.markStorePurchaseVerificationFailed, {
        userId,
        kind,
        storeProductId: args.storeProductId,
        storeTransactionId: args.storeTransactionId,
        storeOriginalTransactionId: args.storeOriginalTransactionId,
        storePurchaseToken: args.storePurchaseToken,
      })
      throw error
    }
  },
})

export const processExpiredReclaims = internalMutation({
  args: {},
  handler: async (ctx) => {
    const result = await processExpiredReclaimsImpl(ctx)
    // biome-ignore lint/suspicious/noConsole: cron job diagnostic logging
    console.log(
      `Reclaim processed: ${result.campsTransferred} transferred, ${result.campsArchived} archived`,
    )
    return result
  },
})

'use node'

import { createHash, randomUUID } from 'node:crypto'
import {
  AppStoreServerAPIClient,
  Environment,
  SignedDataVerifier,
  Status,
} from '@apple/app-store-server-library'
import { v } from 'convex/values'
import { GoogleAuth, OAuth2Client } from 'google-auth-library'
import { internal } from './_generated/api'
import type { Doc } from './_generated/dataModel'
import type { ActionCtx } from './_generated/server'
import { action, internalAction } from './_generated/server'
import { auth } from './auth'
import {
  appleVerificationIdentifiers,
  assertStoreAccountOwnership,
  boundedReconciliationLimit,
  mapAppleSubscriptionState,
  mapGoogleSubscriptionState,
  matchesAppleOriginalTransaction,
  parseGooglePubSubEnvelope,
  type StoreLifecycleResult,
  validateAppleApplication,
} from './lib/storeBillingPolicy'

type AppleEnvironmentName = 'production' | 'sandbox'
type StorePurchaseKind = 'subscription' | 'consumable'

type VerifiedSubscription = StoreLifecycleResult & {
  storeProductId: string
  storeTransactionId?: string
  storeOriginalTransactionId?: string
  storePurchaseToken?: string
  verifiedAccountToken?: string
  storeEnvironment: string
  linkedPurchaseToken?: string
}

type GoogleSubscriptionPurchase = {
  linkedPurchaseToken?: string
  latestOrderId?: string
  subscriptionState?: string
  externalAccountIdentifiers?: { obfuscatedExternalAccountId?: string }
  lineItems?: Array<{
    expiryTime?: string
    productId?: string
    autoRenewingPlan?: { autoRenewEnabled?: boolean }
  }>
}

type GoogleProductPurchase = {
  orderId?: string
  purchaseState?: number
  obfuscatedExternalAccountId?: string
}

type WebhookResult =
  | {
      ok: true
      status:
        | 'duplicate'
        | 'test'
        | 'non_subscription'
        | 'processed'
        | 'accepted_unmatched'
        | 'accepted_rejected'
    }
  | { ok: false; statusCode: number; errorCode: string; retryable?: boolean }

type EventClaim = { claimed: boolean; complete: boolean; attempts: number }

class SafeBillingError extends Error {
  constructor(
    readonly code: string,
    readonly httpStatus: number,
    readonly retryable: boolean,
  ) {
    super(code)
  }
}

function requiredEnv(name: string): string {
  const value: string | undefined = process.env[name]?.trim()
  if (!value) throw new SafeBillingError('billing_configuration_missing', 503, true)
  return value
}

function appleEnvironment(name: AppleEnvironmentName) {
  return name === 'production' ? Environment.PRODUCTION : Environment.SANDBOX
}

function configuredAppleEnvironment(): AppleEnvironmentName {
  const value = requiredEnv('APPLE_IAP_ENVIRONMENT').toLowerCase()
  if (value !== 'production' && value !== 'sandbox') {
    throw new SafeBillingError('apple_environment_invalid', 503, true)
  }
  return value
}

function reconciliationAppleEnvironment(storeEnvironment?: string): AppleEnvironmentName {
  if (storeEnvironment === Environment.SANDBOX) return 'sandbox'
  return configuredAppleEnvironment()
}

function appleConfiguration(environmentName: AppleEnvironmentName) {
  const configuredEnvironment = configuredAppleEnvironment()
  if (environmentName === 'production' && configuredEnvironment !== 'production') {
    throw new SafeBillingError('apple_production_disabled', 404, false)
  }
  if (
    environmentName === 'sandbox' &&
    configuredEnvironment === 'production' &&
    process.env.APPLE_IAP_ALLOW_SANDBOX_NOTIFICATIONS !== 'true'
  ) {
    throw new SafeBillingError('apple_sandbox_disabled', 404, false)
  }
  const bundleId = requiredEnv('APPLE_BUNDLE_ID')
  const appAppleIdRaw = process.env.APPLE_APP_ID?.trim()
  const appAppleId = appAppleIdRaw ? Number(appAppleIdRaw) : undefined
  if (environmentName === 'production' && (!appAppleId || !Number.isSafeInteger(appAppleId))) {
    throw new SafeBillingError('apple_app_id_invalid', 503, true)
  }
  const rootCertificates = requiredEnv('APPLE_ROOT_CA_CERTIFICATES_BASE64')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => Buffer.from(value, 'base64'))
  if (
    rootCertificates.length === 0 ||
    rootCertificates.some((certificate) => certificate.length === 0)
  ) {
    throw new SafeBillingError('apple_root_certificates_invalid', 503, true)
  }
  const environment = appleEnvironment(environmentName)
  return {
    environment,
    environmentName,
    bundleId,
    appAppleId,
    verifier: new SignedDataVerifier(
      rootCertificates,
      true,
      environment,
      bundleId,
      environmentName === 'production' ? appAppleId : undefined,
    ),
    client: new AppStoreServerAPIClient(
      requiredEnv('APPLE_IAP_PRIVATE_KEY').replaceAll('\\n', '\n'),
      requiredEnv('APPLE_IAP_KEY_ID'),
      requiredEnv('APPLE_IAP_ISSUER_ID'),
      bundleId,
      environment,
    ),
  }
}

function validateAppleResponse(
  config: ReturnType<typeof appleConfiguration>,
  response: { environment?: string; bundleId?: string; appAppleId?: number },
) {
  validateAppleApplication(
    {
      environment:
        config.environmentName === 'production' ? ('Production' as const) : ('Sandbox' as const),
      bundleId: config.bundleId,
      appAppleId: config.appAppleId,
    },
    response,
  )
}

async function fetchAppleSubscription(
  transactionId: string,
  environmentName: AppleEnvironmentName,
  notificationType?: string,
  expectedOriginalTransactionId?: string,
  notificationTransactionId?: string,
): Promise<VerifiedSubscription> {
  const config = appleConfiguration(environmentName)
  const response = await config.client.getAllSubscriptionStatuses(transactionId)
  validateAppleResponse(config, response)
  const candidates = []
  for (const group of response.data ?? []) {
    for (const item of group.lastTransactions ?? []) {
      if (!item.signedTransactionInfo) continue
      const transaction = await config.verifier.verifyAndDecodeTransaction(
        item.signedTransactionInfo,
      )
      const renewal = item.signedRenewalInfo
        ? await config.verifier.verifyAndDecodeRenewalInfo(item.signedRenewalInfo)
        : undefined
      if (!transaction.productId || !transaction.originalTransactionId) continue
      if (
        !matchesAppleOriginalTransaction(
          expectedOriginalTransactionId,
          transaction.originalTransactionId,
        )
      ) {
        continue
      }
      const lifecycle = mapAppleSubscriptionState({
        status: typeof item.status === 'number' ? item.status : undefined,
        expiresDate: transaction.expiresDate,
        gracePeriodExpiresDate: renewal?.gracePeriodExpiresDate,
        autoRenewStatus:
          typeof renewal?.autoRenewStatus === 'number' ? renewal.autoRenewStatus : undefined,
        revoked: item.status === Status.REVOKED || transaction.revocationDate !== undefined,
        refunded:
          notificationType === 'REFUND' && transaction.transactionId === notificationTransactionId,
        now: Date.now(),
      })
      candidates.push({ item, transaction, renewal, lifecycle })
    }
  }
  const candidate = candidates.sort((left, right) => {
    const leftEntitled = left.lifecycle.status === 'active' || left.lifecycle.status === 'trialing'
    const rightEntitled =
      right.lifecycle.status === 'active' || right.lifecycle.status === 'trialing'
    if (leftEntitled !== rightEntitled) return rightEntitled ? 1 : -1
    return (right.transaction.signedDate ?? 0) - (left.transaction.signedDate ?? 0)
  })[0]
  const candidateProductId = candidate?.transaction.productId
  if (!candidate || !candidateProductId) {
    throw new SafeBillingError('apple_subscription_not_found', 503, true)
  }
  return {
    ...candidate.lifecycle,
    storeProductId: candidateProductId,
    storeTransactionId: candidate.transaction.transactionId,
    storeOriginalTransactionId: candidate.transaction.originalTransactionId,
    verifiedAccountToken:
      candidate.transaction.appAccountToken ?? candidate.renewal?.appAccountToken,
    storeEnvironment: config.environment,
  }
}

async function verifyAppleTransaction(args: {
  transactionId: string
  expectedOriginalTransactionId?: string
  storeProductId: string
  kind: StorePurchaseKind
  environmentName: AppleEnvironmentName
}) {
  const config = appleConfiguration(args.environmentName)
  if (args.kind === 'subscription') {
    const result = await fetchAppleSubscription(
      args.transactionId,
      args.environmentName,
      undefined,
      args.expectedOriginalTransactionId,
    )
    if (result.storeProductId !== args.storeProductId) {
      throw new SafeBillingError('apple_product_mismatch', 400, false)
    }
    return result
  }

  const response = await config.client.getTransactionInfo(args.transactionId)
  if (!response.signedTransactionInfo) {
    throw new SafeBillingError('apple_transaction_missing', 503, true)
  }
  const transaction = await config.verifier.verifyAndDecodeTransaction(
    response.signedTransactionInfo,
  )
  if (transaction.productId !== args.storeProductId || transaction.type !== 'Consumable') {
    throw new SafeBillingError('apple_product_mismatch', 400, false)
  }
  const refunded = transaction.revocationDate !== undefined
  return {
    status: refunded ? ('expired' as const) : ('active' as const),
    storeState: refunded ? ('refunded' as const) : ('active' as const),
    willRenew: false,
    storeProductId: transaction.productId,
    storeTransactionId: transaction.transactionId,
    storeOriginalTransactionId: transaction.originalTransactionId ?? transaction.transactionId,
    verifiedAccountToken: transaction.appAccountToken,
    storeEnvironment: config.environment,
  }
}

function googleCredentials() {
  const json = process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON
  if (json) {
    const parsed = JSON.parse(json) as { client_email?: string; private_key?: string }
    if (!parsed.client_email || !parsed.private_key) {
      throw new SafeBillingError('google_service_account_invalid', 503, true)
    }
    return { client_email: parsed.client_email, private_key: parsed.private_key }
  }
  return {
    client_email: requiredEnv('GOOGLE_PLAY_SERVICE_ACCOUNT_EMAIL'),
    private_key: requiredEnv('GOOGLE_PLAY_SERVICE_ACCOUNT_PRIVATE_KEY').replaceAll('\\n', '\n'),
  }
}

async function googleAccessToken() {
  const client = await new GoogleAuth({
    credentials: googleCredentials(),
    scopes: ['https://www.googleapis.com/auth/androidpublisher'],
  }).getClient()
  const token = await client.getAccessToken()
  if (!token.token) throw new SafeBillingError('google_oauth_failed', 503, true)
  return token.token
}

function googleLineItem(subscription: GoogleSubscriptionPurchase): {
  productId: string
  expiryTimeMs: number
  autoRenewingPlan?: { autoRenewEnabled?: boolean }
} {
  const items = (subscription.lineItems ?? [])
    .map((item) => ({
      ...item,
      expiryTimeMs: item.expiryTime ? Date.parse(item.expiryTime) : Number.NaN,
    }))
    .filter((item) => item.productId && Number.isFinite(item.expiryTimeMs))
    .sort((left, right) => right.expiryTimeMs - left.expiryTimeMs)
  const item = items[0]
  if (!item?.productId)
    throw new SafeBillingError('google_subscription_line_item_missing', 503, true)
  return { ...item, productId: item.productId }
}

async function fetchGoogleSubscription(
  purchaseToken: string,
  notificationType?: number,
  refunded = false,
): Promise<VerifiedSubscription> {
  const packageName = requiredEnv('GOOGLE_PLAY_PACKAGE_NAME')
  const response = await fetch(
    `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${encodeURIComponent(packageName)}/purchases/subscriptionsv2/tokens/${encodeURIComponent(purchaseToken)}`,
    { headers: { Authorization: `Bearer ${await googleAccessToken()}` } },
  )
  if (!response.ok) throw new SafeBillingError(`google_api_${response.status}`, 503, true)
  const subscription = (await response.json()) as GoogleSubscriptionPurchase
  const item = googleLineItem(subscription)
  const lifecycle = mapGoogleSubscriptionState({
    subscriptionState: subscription.subscriptionState,
    expiryTime: item.expiryTimeMs,
    autoRenewEnabled: item.autoRenewingPlan?.autoRenewEnabled,
    notificationType,
    refunded,
    now: Date.now(),
  })
  return {
    ...lifecycle,
    storeProductId: item.productId,
    storeTransactionId: subscription.latestOrderId,
    storeOriginalTransactionId: purchaseToken,
    storePurchaseToken: purchaseToken,
    linkedPurchaseToken: subscription.linkedPurchaseToken,
    verifiedAccountToken: subscription.externalAccountIdentifiers?.obfuscatedExternalAccountId,
    storeEnvironment: 'Production',
  }
}

async function fetchGoogleProduct(
  purchaseToken: string,
  storeProductId: string,
): Promise<VerifiedSubscription> {
  const packageName = requiredEnv('GOOGLE_PLAY_PACKAGE_NAME')
  const response = await fetch(
    `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${encodeURIComponent(packageName)}/purchases/products/${encodeURIComponent(storeProductId)}/tokens/${encodeURIComponent(purchaseToken)}`,
    { headers: { Authorization: `Bearer ${await googleAccessToken()}` } },
  )
  if (!response.ok) throw new SafeBillingError(`google_api_${response.status}`, 503, true)
  const product = (await response.json()) as GoogleProductPurchase
  const status =
    product.purchaseState === 0
      ? ('active' as const)
      : product.purchaseState === 1
        ? ('canceled' as const)
        : ('pending_verification' as const)
  return {
    status,
    storeState:
      status === 'active'
        ? ('active' as const)
        : status === 'canceled'
          ? ('canceled' as const)
          : ('pending' as const),
    willRenew: false,
    storeProductId,
    storeTransactionId: product.orderId,
    storeOriginalTransactionId: purchaseToken,
    storePurchaseToken: purchaseToken,
    verifiedAccountToken: product.obfuscatedExternalAccountId,
    storeEnvironment: 'Production',
  }
}

async function verifyGooglePushToken(authorization: string) {
  const match = /^Bearer\s+(.+)$/.exec(authorization)
  if (!match) throw new SafeBillingError('google_push_auth_missing', 401, false)
  const ticket = await new OAuth2Client().verifyIdToken({
    idToken: match[1],
    audience: requiredEnv('GOOGLE_PUBSUB_AUDIENCE'),
  })
  const payload = ticket.getPayload()
  if (!payload) throw new SafeBillingError('google_push_identity_mismatch', 401, false)
  if (
    payload.email !== requiredEnv('GOOGLE_PUBSUB_PUSH_SERVICE_ACCOUNT_EMAIL') ||
    payload.email_verified !== true
  ) {
    throw new SafeBillingError('google_push_identity_mismatch', 401, false)
  }
}

function subjectHash(value: string) {
  return createHash('sha256').update(value).digest('hex')
}

function safeFailure(error: unknown) {
  if (error instanceof SafeBillingError) return error
  return new SafeBillingError('provider_verification_failed', 503, true)
}

async function applyVerifiedSubscription(
  ctx: ActionCtx,
  subscription: Doc<'subscriptions'>,
  verified: VerifiedSubscription,
  storeReadStartedAt: number,
  lastStoreEventAt?: number,
) {
  const ownership = await ctx.runQuery(internal.storeBilling.getVerificationContext, {
    userId: subscription.userId,
    kind: 'subscription',
    storeOriginalTransactionId: subscription.storeOriginalTransactionId,
    storePurchaseToken: subscription.storePurchaseToken,
  })
  assertStoreAccountOwnership({
    ...ownership,
    verifiedAccountToken: verified.verifiedAccountToken,
  })
  await ctx.runMutation(internal.subscriptions.applyStorePurchaseVerification, {
    userId: subscription.userId,
    kind: 'subscription',
    platform: subscription.platform,
    requestedStoreProductId: subscription.storeProductId,
    lookupStoreTransactionId: subscription.storeTransactionId,
    lookupStoreOriginalTransactionId: subscription.storeOriginalTransactionId,
    lookupStorePurchaseToken: subscription.storePurchaseToken,
    storeProductId: verified.storeProductId,
    storeTransactionId: verified.storeTransactionId,
    storeOriginalTransactionId: verified.storeOriginalTransactionId,
    storePurchaseToken: verified.storePurchaseToken,
    currentPeriodEnd: verified.currentPeriodEnd,
    status: verified.status,
    storeState: verified.storeState,
    willRenew: verified.willRenew,
    storeEnvironment: verified.storeEnvironment,
    lastStoreEventAt,
    storeReadStartedAt,
    linkedPurchaseToken: verified.linkedPurchaseToken,
  })
}

export const prepareStorePurchase = action({
  args: {},
  handler: async (ctx): Promise<{ accountToken: string }> => {
    const userId = await auth.getUserId(ctx)
    if (!userId) throw new Error('Not authenticated')
    const accountToken: string = await ctx.runMutation(
      internal.storeBilling.setStoreAccountTokenIfMissing,
      {
        userId,
        candidate: randomUUID(),
      },
    )
    return { accountToken }
  },
})

export const verifyApplePurchase = internalAction({
  args: {
    kind: v.union(v.literal('subscription'), v.literal('consumable')),
    storeProductId: v.string(),
    storeTransactionId: v.optional(v.string()),
    storeOriginalTransactionId: v.optional(v.string()),
  },
  handler: async (_ctx, args) => {
    const { transactionId, expectedOriginalTransactionId } = appleVerificationIdentifiers(args)
    if (!transactionId) throw new Error('Apple verification requires a transaction identifier')
    const configuredEnvironment = configuredAppleEnvironment()
    try {
      return await verifyAppleTransaction({
        transactionId,
        expectedOriginalTransactionId,
        storeProductId: args.storeProductId,
        kind: args.kind,
        environmentName: configuredEnvironment,
      })
    } catch (error) {
      if (
        configuredEnvironment === 'production' &&
        process.env.APPLE_IAP_ALLOW_SANDBOX_NOTIFICATIONS === 'true'
      ) {
        try {
          return await verifyAppleTransaction({
            transactionId,
            expectedOriginalTransactionId,
            storeProductId: args.storeProductId,
            kind: args.kind,
            environmentName: 'sandbox',
          })
        } catch (sandboxError) {
          throw safeFailure(sandboxError)
        }
      }
      throw safeFailure(error)
    }
  },
})

export const verifyGooglePurchase = internalAction({
  args: {
    kind: v.union(v.literal('subscription'), v.literal('consumable')),
    storeProductId: v.string(),
    storePurchaseToken: v.string(),
  },
  handler: async (_ctx, args) => {
    try {
      const result =
        args.kind === 'subscription'
          ? await fetchGoogleSubscription(args.storePurchaseToken)
          : await fetchGoogleProduct(args.storePurchaseToken, args.storeProductId)
      if (result.storeProductId !== args.storeProductId) {
        throw new SafeBillingError('google_product_mismatch', 400, false)
      }
      return result
    } catch (error) {
      throw safeFailure(error)
    }
  },
})

export const processAppleNotification = internalAction({
  args: {
    signedPayload: v.string(),
    environment: v.union(v.literal('production'), v.literal('sandbox')),
  },
  handler: async (ctx, args): Promise<WebhookResult> => {
    let eventKey: string | undefined
    let eventAttempt: number | undefined
    try {
      if (args.signedPayload.length > 128_000)
        throw new SafeBillingError('payload_too_large', 413, false)
      const config = appleConfiguration(args.environment)
      const notification = await config.verifier.verifyAndDecodeNotification(args.signedPayload)
      if (
        !notification.notificationUUID ||
        notification.notificationUUID.length > 128 ||
        notification.version !== '2.0'
      ) {
        throw new SafeBillingError('apple_notification_malformed', 400, false)
      }
      if (notification.data) validateAppleResponse(config, notification.data)
      eventKey = `apple:${notification.version}:${notification.notificationUUID}`
      const transaction = notification.data?.signedTransactionInfo
        ? await config.verifier.verifyAndDecodeTransaction(notification.data.signedTransactionInfo)
        : undefined
      if (notification.data?.signedRenewalInfo) {
        await config.verifier.verifyAndDecodeRenewalInfo(notification.data.signedRenewalInfo)
      }
      const originalTransactionId = transaction?.originalTransactionId
      const claim: EventClaim = await ctx.runMutation(internal.storeBilling.claimEvent, {
        eventKey,
        platform: 'ios',
        version: notification.version,
        notificationType: String(notification.notificationType ?? 'UNKNOWN'),
        subtype: notification.subtype ? String(notification.subtype) : undefined,
        subjectHash: originalTransactionId ? subjectHash(originalTransactionId) : undefined,
      })
      if (claim.claimed) eventAttempt = claim.attempts
      if (!claim.claimed) {
        return claim.complete
          ? { ok: true as const, status: 'duplicate' as const }
          : { ok: false as const, statusCode: 503, errorCode: 'event_in_progress' }
      }
      if (notification.notificationType === 'TEST') {
        await ctx.runMutation(internal.storeBilling.completeEvent, {
          eventKey,
          attempt: claim.attempts,
          ignored: true,
        })
        return { ok: true as const, status: 'test' as const }
      }
      if (!originalTransactionId) {
        await ctx.runMutation(internal.storeBilling.completeEvent, {
          eventKey,
          attempt: claim.attempts,
          ignored: true,
        })
        return { ok: true as const, status: 'non_subscription' as const }
      }
      const subscription = await ctx.runQuery(
        internal.storeBilling.findSubscriptionForStoreSubject,
        {
          platform: 'ios',
          storeOriginalTransactionId: originalTransactionId,
        },
      )
      if (!subscription) {
        if (claim.attempts >= 5) {
          await ctx.runMutation(internal.storeBilling.failEvent, {
            eventKey,
            attempt: claim.attempts,
            errorCode: 'subscription_not_linked',
          })
          return { ok: true as const, status: 'accepted_unmatched' as const }
        }
        throw new SafeBillingError('subscription_not_linked', 503, true)
      }
      const storeReadStartedAt = Date.now()
      const verified = await fetchAppleSubscription(
        originalTransactionId,
        args.environment,
        notification.notificationType ? String(notification.notificationType) : undefined,
        originalTransactionId,
        transaction.transactionId,
      )
      await applyVerifiedSubscription(
        ctx,
        subscription,
        verified,
        storeReadStartedAt,
        notification.signedDate,
      )
      await ctx.runMutation(internal.storeBilling.completeEvent, {
        eventKey,
        attempt: claim.attempts,
      })
      return { ok: true as const, status: 'processed' as const }
    } catch (error) {
      const failure = safeFailure(error)
      if (eventKey && eventAttempt !== undefined) {
        await ctx.runMutation(internal.storeBilling.failEvent, {
          eventKey,
          attempt: eventAttempt,
          errorCode: failure.code,
        })
      }
      if (eventKey && !failure.retryable) {
        return { ok: true as const, status: 'accepted_rejected' as const }
      }
      return {
        ok: false as const,
        statusCode: failure.httpStatus,
        errorCode: failure.code,
        retryable: failure.retryable,
      }
    }
  },
})

export const processGoogleNotification = internalAction({
  args: { authorization: v.string(), bodyJson: v.string() },
  handler: async (ctx, args): Promise<WebhookResult> => {
    let eventKey: string | undefined
    let eventAttempt: number | undefined
    try {
      if (args.bodyJson.length > 128_000)
        throw new SafeBillingError('payload_too_large', 413, false)
      await verifyGooglePushToken(args.authorization)
      const { messageId, rtdn } = parseGooglePubSubEnvelope(
        JSON.parse(args.bodyJson),
        requiredEnv('GOOGLE_PLAY_PACKAGE_NAME'),
      )
      const notification = rtdn.subscriptionNotification
      const voided = rtdn.voidedPurchaseNotification
      const version = notification ? `${rtdn.version}:${notification.version}` : rtdn.version
      const purchaseToken = notification?.purchaseToken ?? voided?.purchaseToken
      eventKey = `google:${version}:${messageId}`
      const claim: EventClaim = await ctx.runMutation(internal.storeBilling.claimEvent, {
        eventKey,
        platform: 'android',
        version,
        notificationType: notification
          ? String(notification.notificationType)
          : voided
            ? `VOIDED_${voided.refundType}`
            : 'TEST',
        subjectHash: purchaseToken ? subjectHash(purchaseToken) : undefined,
      })
      if (claim.claimed) eventAttempt = claim.attempts
      if (!claim.claimed) {
        return claim.complete
          ? { ok: true as const, status: 'duplicate' as const }
          : { ok: false as const, statusCode: 503, errorCode: 'event_in_progress' }
      }
      if (!notification && !voided) {
        await ctx.runMutation(internal.storeBilling.completeEvent, {
          eventKey,
          attempt: claim.attempts,
          ignored: true,
        })
        return { ok: true as const, status: 'test' as const }
      }
      if (voided && voided.productType !== 1) {
        await ctx.runMutation(internal.storeBilling.completeEvent, {
          eventKey,
          attempt: claim.attempts,
          ignored: true,
        })
        return { ok: true as const, status: 'non_subscription' as const }
      }
      if (!purchaseToken) throw new SafeBillingError('google_notification_malformed', 400, false)
      const subscription = await ctx.runQuery(
        internal.storeBilling.findSubscriptionForStoreSubject,
        {
          platform: 'android',
          storePurchaseToken: purchaseToken,
        },
      )
      if (!subscription) {
        if (claim.attempts >= 5) {
          await ctx.runMutation(internal.storeBilling.failEvent, {
            eventKey,
            attempt: claim.attempts,
            errorCode: 'subscription_not_linked',
          })
          return { ok: true as const, status: 'accepted_unmatched' as const }
        }
        throw new SafeBillingError('subscription_not_linked', 503, true)
      }
      const storeReadStartedAt = Date.now()
      const verified = await fetchGoogleSubscription(
        purchaseToken,
        notification?.notificationType,
        voided !== undefined,
      )
      if (
        notification &&
        verified.storeProductId !== notification.subscriptionId &&
        subscription.storeProductId !== notification.subscriptionId
      ) {
        throw new SafeBillingError('google_product_mismatch', 400, false)
      }
      const eventTime = rtdn.eventTimeMillis ? Number(rtdn.eventTimeMillis) : undefined
      await applyVerifiedSubscription(
        ctx,
        subscription,
        verified,
        storeReadStartedAt,
        eventTime && Number.isFinite(eventTime) ? eventTime : undefined,
      )
      await ctx.runMutation(internal.storeBilling.completeEvent, {
        eventKey,
        attempt: claim.attempts,
      })
      return { ok: true as const, status: 'processed' as const }
    } catch (error) {
      const failure = safeFailure(error)
      if (eventKey && eventAttempt !== undefined) {
        await ctx.runMutation(internal.storeBilling.failEvent, {
          eventKey,
          attempt: eventAttempt,
          errorCode: failure.code,
        })
      }
      if (eventKey && !failure.retryable) {
        return { ok: true as const, status: 'accepted_rejected' as const }
      }
      return {
        ok: false as const,
        statusCode: failure.httpStatus,
        errorCode: failure.code,
        retryable: failure.retryable,
      }
    }
  },
})

export const reconcileSubscriptions = internalAction({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args): Promise<{ selected: number; processed: number; failed: number }> => {
    const subscriptions: Doc<'subscriptions'>[] = await ctx.runQuery(
      internal.storeBilling.getReconciliationBatch,
      args,
    )
    let processed = 0
    let failed = 0
    for (const subscription of subscriptions) {
      try {
        const storeReadStartedAt = Date.now()
        const verified =
          subscription.platform === 'ios'
            ? await fetchAppleSubscription(
                subscription.storeOriginalTransactionId ?? subscription.storeTransactionId ?? '',
                reconciliationAppleEnvironment(subscription.storeEnvironment),
                undefined,
                subscription.storeOriginalTransactionId,
              )
            : await fetchGoogleSubscription(subscription.storePurchaseToken ?? '')
        await applyVerifiedSubscription(ctx, subscription, verified, storeReadStartedAt)
        processed += 1
      } catch (error) {
        const failure = safeFailure(error)
        await ctx.runMutation(internal.storeBilling.recordReconciliationFailure, {
          subscriptionId: subscription._id,
          errorCode: failure.code,
        })
        failed += 1
      }
    }
    if (subscriptions.length === boundedReconciliationLimit(args.limit)) {
      await ctx.scheduler.runAfter(1_000, internal.storeBillingActions.reconcileSubscriptions, args)
    }
    return { selected: subscriptions.length, processed, failed }
  },
})

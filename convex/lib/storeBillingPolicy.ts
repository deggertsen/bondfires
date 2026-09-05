export type StoreEntitlementStatus =
  | 'pending_verification'
  | 'active'
  | 'trialing'
  | 'past_due'
  | 'canceled'
  | 'expired'

export type StoreLifecycleState =
  | 'pending'
  | 'active'
  | 'trialing'
  | 'grace_period'
  | 'billing_retry'
  | 'canceled'
  | 'paused'
  | 'on_hold'
  | 'expired'
  | 'refunded'
  | 'revoked'

export type StoreLifecycleResult = {
  status: StoreEntitlementStatus
  storeState: StoreLifecycleState
  willRenew: boolean
  currentPeriodEnd?: number
}

const APPLE_ACTIVE = 1
const APPLE_EXPIRED = 2
const APPLE_BILLING_RETRY = 3
const APPLE_BILLING_GRACE_PERIOD = 4
const APPLE_REVOKED = 5

export function mapAppleSubscriptionState(args: {
  status?: number
  expiresDate?: number
  gracePeriodExpiresDate?: number
  autoRenewStatus?: number
  revoked?: boolean
  refunded?: boolean
  now: number
}): StoreLifecycleResult {
  const willRenew = args.autoRenewStatus === 1
  if (args.refunded) {
    return { status: 'expired', storeState: 'refunded', willRenew: false }
  }
  if (args.revoked || args.status === APPLE_REVOKED) {
    return { status: 'expired', storeState: 'revoked', willRenew: false }
  }
  if (args.status === APPLE_BILLING_GRACE_PERIOD) {
    const graceEnd = args.gracePeriodExpiresDate ?? args.expiresDate
    if (graceEnd && graceEnd > args.now) {
      return {
        status: 'active',
        storeState: 'grace_period',
        willRenew,
        currentPeriodEnd: graceEnd,
      }
    }
    return { status: 'past_due', storeState: 'billing_retry', willRenew }
  }
  if (args.status === APPLE_BILLING_RETRY) {
    return { status: 'past_due', storeState: 'billing_retry', willRenew }
  }
  if (args.status === APPLE_EXPIRED || (args.expiresDate && args.expiresDate <= args.now)) {
    return {
      status: 'expired',
      storeState: 'expired',
      willRenew: false,
      currentPeriodEnd: args.expiresDate,
    }
  }
  if (args.status === APPLE_ACTIVE) {
    return {
      status: 'active',
      storeState: willRenew ? 'active' : 'canceled',
      willRenew,
      currentPeriodEnd: args.expiresDate,
    }
  }
  return {
    status: 'pending_verification',
    storeState: 'pending',
    willRenew,
    currentPeriodEnd: args.expiresDate,
  }
}

export function mapGoogleSubscriptionState(args: {
  subscriptionState?: string
  expiryTime?: number
  autoRenewEnabled?: boolean
  notificationType?: number
  refunded?: boolean
  now: number
}): StoreLifecycleResult {
  const willRenew = args.autoRenewEnabled === true
  const terminalProviderState =
    args.subscriptionState === 'SUBSCRIPTION_STATE_EXPIRED' ||
    (args.subscriptionState === 'SUBSCRIPTION_STATE_CANCELED' &&
      (args.expiryTime === undefined || args.expiryTime <= args.now))
  if (terminalProviderState && args.refunded) {
    return {
      status: 'expired',
      storeState: 'refunded',
      willRenew: false,
      currentPeriodEnd: args.expiryTime,
    }
  }
  if (terminalProviderState && args.notificationType === 12) {
    return {
      status: 'expired',
      storeState: 'revoked',
      willRenew: false,
      currentPeriodEnd: args.expiryTime,
    }
  }

  switch (args.subscriptionState) {
    case 'SUBSCRIPTION_STATE_ACTIVE':
      if (args.expiryTime !== undefined && args.expiryTime <= args.now) {
        return {
          status: 'expired',
          storeState: 'expired',
          willRenew: false,
          currentPeriodEnd: args.expiryTime,
        }
      }
      return {
        status: 'active',
        storeState: willRenew ? 'active' : 'canceled',
        willRenew,
        currentPeriodEnd: args.expiryTime,
      }
    case 'SUBSCRIPTION_STATE_CANCELED':
      if (args.expiryTime !== undefined && args.expiryTime > args.now) {
        return {
          status: 'active',
          storeState: 'canceled',
          willRenew: false,
          currentPeriodEnd: args.expiryTime,
        }
      }
      return {
        status: 'canceled',
        storeState: 'canceled',
        willRenew: false,
        currentPeriodEnd: args.expiryTime,
      }
    case 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD':
      if (args.expiryTime !== undefined && args.expiryTime > args.now) {
        return {
          status: 'active',
          storeState: 'grace_period',
          willRenew,
          currentPeriodEnd: args.expiryTime,
        }
      }
      return {
        status: 'past_due',
        storeState: 'billing_retry',
        willRenew,
        currentPeriodEnd: args.expiryTime,
      }
    case 'SUBSCRIPTION_STATE_ON_HOLD':
      return {
        status: 'past_due',
        storeState: 'on_hold',
        willRenew,
        currentPeriodEnd: args.expiryTime,
      }
    case 'SUBSCRIPTION_STATE_PAUSED':
      return {
        status: 'past_due',
        storeState: 'paused',
        willRenew,
        currentPeriodEnd: args.expiryTime,
      }
    case 'SUBSCRIPTION_STATE_EXPIRED':
    case 'SUBSCRIPTION_STATE_PENDING_PURCHASE_CANCELED':
      return {
        status: 'expired',
        storeState: 'expired',
        willRenew: false,
        currentPeriodEnd: args.expiryTime,
      }
    case 'SUBSCRIPTION_STATE_PENDING':
      return {
        status: 'pending_verification',
        storeState: 'pending',
        willRenew,
        currentPeriodEnd: args.expiryTime,
      }
    default:
      return {
        status: 'pending_verification',
        storeState: 'pending',
        willRenew,
        currentPeriodEnd: args.expiryTime,
      }
  }
}

export function validateAppleApplication(
  expected: { environment: 'Production' | 'Sandbox'; bundleId: string; appAppleId?: number },
  actual: { environment?: string; bundleId?: string; appAppleId?: number },
) {
  if (actual.environment !== expected.environment) throw new Error('Apple environment mismatch')
  if (actual.bundleId !== expected.bundleId) throw new Error('Apple bundle ID mismatch')
  if (expected.environment === 'Production' && actual.appAppleId !== expected.appAppleId) {
    throw new Error('Apple app ID mismatch')
  }
}

export function matchesAppleOriginalTransaction(
  expectedOriginalTransactionId: string | undefined,
  actualOriginalTransactionId: string | undefined,
) {
  return (
    expectedOriginalTransactionId === undefined ||
    actualOriginalTransactionId === expectedOriginalTransactionId
  )
}

export function appleVerificationIdentifiers(args: {
  storeTransactionId?: string
  storeOriginalTransactionId?: string
}) {
  return {
    transactionId: args.storeTransactionId ?? args.storeOriginalTransactionId,
    expectedOriginalTransactionId: args.storeOriginalTransactionId,
  }
}

export type GoogleRtdn = {
  version: string
  packageName: string
  eventTimeMillis?: string
  subscriptionNotification?: {
    version: string
    notificationType: number
    purchaseToken: string
    subscriptionId: string
  }
  testNotification?: { version: string }
  voidedPurchaseNotification?: {
    purchaseToken: string
    orderId: string
    productType: number
    refundType: number
  }
}

export function parseGooglePubSubEnvelope(
  body: unknown,
  expectedPackageName: string,
): { messageId: string; rtdn: GoogleRtdn } {
  if (!body || typeof body !== 'object') throw new Error('Malformed Pub/Sub envelope')
  const message = (body as { message?: unknown }).message
  if (!message || typeof message !== 'object') throw new Error('Malformed Pub/Sub message')
  const { data, messageId } = message as { data?: unknown; messageId?: unknown }
  if (
    typeof data !== 'string' ||
    typeof messageId !== 'string' ||
    messageId.length === 0 ||
    messageId.length > 256
  ) {
    throw new Error('Malformed Pub/Sub message')
  }

  let decoded: unknown
  try {
    const binary = atob(data)
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
    decoded = JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    throw new Error('Malformed RTDN data')
  }
  if (!decoded || typeof decoded !== 'object') throw new Error('Malformed RTDN data')
  const rtdn = decoded as Partial<GoogleRtdn>
  if (rtdn.packageName !== expectedPackageName) throw new Error('Google package name mismatch')
  if (typeof rtdn.version !== 'string' || rtdn.version.length > 32) {
    throw new Error('Unsupported RTDN version')
  }

  if (rtdn.testNotification) {
    if (typeof rtdn.testNotification.version !== 'string') {
      throw new Error('Malformed RTDN test notification')
    }
    return { messageId, rtdn: rtdn as GoogleRtdn }
  }

  if (rtdn.voidedPurchaseNotification) {
    const voided = rtdn.voidedPurchaseNotification
    if (
      typeof voided.purchaseToken !== 'string' ||
      voided.purchaseToken.length === 0 ||
      voided.purchaseToken.length > 4_096 ||
      typeof voided.orderId !== 'string' ||
      voided.orderId.length === 0 ||
      voided.orderId.length > 512 ||
      !Number.isInteger(voided.productType) ||
      !Number.isInteger(voided.refundType)
    ) {
      throw new Error('Malformed RTDN voided purchase notification')
    }
    return { messageId, rtdn: rtdn as GoogleRtdn }
  }

  const notification = rtdn.subscriptionNotification
  if (
    !notification ||
    typeof notification.version !== 'string' ||
    !Number.isInteger(notification.notificationType) ||
    typeof notification.purchaseToken !== 'string' ||
    notification.purchaseToken.length === 0 ||
    notification.purchaseToken.length > 4_096 ||
    typeof notification.subscriptionId !== 'string' ||
    notification.subscriptionId.length === 0 ||
    notification.subscriptionId.length > 512
  ) {
    throw new Error('Unsupported or malformed RTDN notification')
  }
  return { messageId, rtdn: rtdn as GoogleRtdn }
}

export function assertStoreAccountOwnership(args: {
  expectedAccountToken?: string
  verifiedAccountToken?: string
  alreadyVerifiedForUser: boolean
}) {
  if (args.verifiedAccountToken) {
    if (args.verifiedAccountToken !== args.expectedAccountToken) {
      throw new Error('Store account binding mismatch')
    }
    return
  }
  if (!args.alreadyVerifiedForUser) {
    throw new Error('Store transaction is missing a verified account binding')
  }
}

export function canUseStoreRecordForUser(args: {
  recordUserId: string
  requestedUserId: string
  verificationStatus?: 'pending' | 'verified' | 'failed' | 'refunded'
}) {
  // A client-submitted pending claim never establishes ownership. It may be
  // reused only by the same user; verified/refunded rows remain globally
  // authoritative so a different user cannot replay the store identifier.
  return (
    args.recordUserId === args.requestedUserId ||
    args.verificationStatus === 'verified' ||
    args.verificationStatus === 'refunded'
  )
}

export function selectStoreRecordForUser<
  T extends {
    userId: string
    verificationStatus?: 'pending' | 'verified' | 'failed' | 'refunded'
  },
>(records: T[], requestedUserId: string): T | undefined {
  return (
    records.find(
      (record) =>
        record.verificationStatus === 'verified' || record.verificationStatus === 'refunded',
    ) ?? records.find((record) => record.userId === requestedUserId)
  )
}

export function canClaimStoreEvent(
  event: {
    status: 'processing' | 'processed' | 'failed' | 'ignored'
    lastAttemptAt: number
  } | null,
  now: number,
  leaseMs = 5 * 60 * 1_000,
) {
  if (!event) return true
  if (event.status === 'processed' || event.status === 'ignored') return false
  if (event.status === 'failed') return true
  return event.lastAttemptAt + leaseMs <= now
}

export function boundedReconciliationLimit(requested?: number) {
  return Math.min(
    Math.max(
      Math.trunc(typeof requested === 'number' && Number.isFinite(requested) ? requested : 20),
      1,
    ),
    50,
  )
}

export function nextStoreSyncAt(now: number, state: StoreLifecycleState, failureCount = 0) {
  if (failureCount > 0) {
    return now + Math.min(60 * 60 * 1_000 * 2 ** (failureCount - 1), 24 * 60 * 60 * 1_000)
  }
  if (state === 'pending' || state === 'billing_retry' || state === 'on_hold') {
    return now + 60 * 60 * 1_000
  }
  if (state === 'active' || state === 'trialing' || state === 'grace_period') {
    return now + 12 * 60 * 60 * 1_000
  }
  if (state === 'canceled' || state === 'paused') return now + 6 * 60 * 60 * 1_000
  return now + 7 * 24 * 60 * 60 * 1_000
}

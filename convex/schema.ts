import { authTables } from '@convex-dev/auth/server'
import { defineSchema, defineTable } from 'convex/server'
import { v } from 'convex/values'

const subscriptionTier = v.union(
  v.literal('free'),
  v.literal('plus'),
  v.literal('premium'),
  v.literal('pro'),
)

const storePlatform = v.union(v.literal('ios'), v.literal('android'))
const storeEntitlementStatus = v.union(
  v.literal('pending_verification'),
  v.literal('active'),
  v.literal('trialing'),
  v.literal('past_due'),
  v.literal('canceled'),
  v.literal('expired'),
)
const storeVerificationStatus = v.union(
  v.literal('pending'),
  v.literal('verified'),
  v.literal('failed'),
  v.literal('refunded'),
)
const userGender = v.union(v.literal('male'), v.literal('female'), v.literal('other'))
const campAccessVisibilityMode = v.union(v.literal('hide'), v.literal('gate'))

const campRules = v.object({
  access: v.object({
    gender: v.optional(
      v.object({
        value: v.union(v.literal('male'), v.literal('female'), v.literal('any')),
        visibilityMode: campAccessVisibilityMode,
      }),
    ),
    allowedTiers: v.optional(
      v.object({
        value: v.array(subscriptionTier),
        visibilityMode: v.union(v.literal('hide'), v.literal('gate')),
      }),
    ),
    inviteOnly: v.optional(
      v.object({
        value: v.boolean(),
        visibilityMode: campAccessVisibilityMode,
      }),
    ),
    minAge: v.optional(
      v.object({
        value: v.number(),
        visibilityMode: campAccessVisibilityMode,
      }),
    ),
    maxAge: v.optional(
      v.object({
        value: v.number(),
        visibilityMode: campAccessVisibilityMode,
      }),
    ),
  }),
  participation: v.object({
    maxDurationMs: v.optional(v.number()),
    maxResponses: v.optional(v.number()),
  }),
  advisory: v.object({
    guidelines: v.optional(v.array(v.string())),
    requiresTradeTags: v.optional(v.boolean()),
  }),
})

export default defineSchema({
  // Include auth tables from @convex-dev/auth
  ...authTables,

  // Users table - extends auth with profile info
  users: defineTable({
    // Auth fields (managed by @convex-dev/auth)
    email: v.optional(v.string()),
    emailVerified: v.optional(v.boolean()),
    emailVerificationTime: v.optional(v.number()), // Timestamp when email was verified

    // Profile fields
    name: v.optional(v.string()),
    firstName: v.optional(v.string()),
    lastName: v.optional(v.string()),
    displayName: v.optional(v.string()),
    photoUrl: v.optional(v.string()),
    photoStorageId: v.optional(v.id('_storage')),
    gender: userGender,
    birthDate: v.optional(v.string()), // ISO date string (YYYY-MM-DD), private

    // Stats (denormalized for performance)
    bondfireCount: v.optional(v.number()),
    responseCount: v.optional(v.number()),
    totalViews: v.optional(v.number()),

    // Metadata
    createdAt: v.optional(v.number()),
    updatedAt: v.optional(v.number()),

    // Admin flags
    isAdmin: v.optional(v.boolean()),
    role: v.optional(v.union(v.literal('admin'), v.literal('user'))),

    // Admin-forced subscription tier override for QA and app review.
    // When set, this overrides any store-based subscription in entitlements.
    forcedTier: v.optional(subscriptionTier),
  })
    .index('email', ['email']) // Required by @convex-dev/auth (must be named exactly 'email')
    .index('by_role', ['role'])
    .searchIndex('search_email', { searchField: 'email' }),

  // Audit log for admin-forced subscription tier changes
  tierAuditLog: defineTable({
    action: v.union(v.literal('set'), v.literal('cleared')),
    targetUserId: v.id('users'),
    targetEmail: v.string(),
    tier: v.optional(subscriptionTier),
    adminUserId: v.id('users'),
    adminEmail: v.string(),
    timestamp: v.number(),
  })
    .index('by_target', ['targetUserId'])
    .index('by_admin', ['adminUserId']),

  // Camps - rule-governed spaces where bondfires live
  camps: defineTable({
    slug: v.string(),
    name: v.string(),
    theme: v.optional(v.string()),
    purpose: v.string(),
    icon: v.optional(v.string()),
    color: v.optional(v.string()),
    defaultPrompt: v.optional(v.string()),
    // Migration step: accept both old flat format and new nested format.
    // After running camps:resetAndReseed, this should be locked to campRules only.
    rules: campRules,
    nameOverride: v.optional(v.string()), // Private camp custom name override
    ownerDisplayName: v.optional(v.string()), // Denormalized owner display name at camp creation
    crisisBroadcast: v.optional(v.boolean()),
    welcomeBroadcast: v.optional(v.boolean()),
    access: v.union(v.literal('open'), v.literal('approval'), v.literal('invite')),
    status: v.union(
      v.literal('active'),
      v.literal('frozen'),
      v.literal('grace'),
      v.literal('inactive'),
      v.literal('archived'),
    ),
    frozenAt: v.optional(v.number()),
    reclaimDeadline: v.optional(v.number()),
    gracePeriodStart: v.optional(v.number()),
    gracePeriodEnd: v.optional(v.number()),
    archivedAt: v.optional(v.number()),
    // Optional until the production backfill has run; all new writes set this.
    ownerId: v.optional(v.id('users')),
    bondfireCount: v.optional(v.number()),
    activeMemberCount: v.optional(v.number()),
    isLaunchCamp: v.optional(v.boolean()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index('by_slug', ['slug'])
    .index('by_owner', ['ownerId', 'createdAt']),

  // Camp membership, notification preferences, and moderation roles
  campMembers: defineTable({
    userId: v.id('users'),
    campId: v.id('camps'),
    role: v.union(v.literal('owner'), v.literal('moderator'), v.literal('member')),
    status: v.union(
      v.literal('pending'),
      v.literal('active'),
      v.literal('banned'),
      v.literal('rejected'),
    ),
    muted: v.boolean(),
    moderationReason: v.optional(v.string()),
    joinedAt: v.optional(v.number()),
    requestedAt: v.optional(v.number()),
    approvedAt: v.optional(v.number()),
    rejectedAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index('by_user', ['userId', 'status'])
    .index('by_camp', ['campId', 'createdAt'])
    .index('by_user_camp', ['userId', 'campId'])
    .index('by_camp_status', ['campId', 'status']),

  // Invite codes for private/invite-only camps
  campInvites: defineTable({
    code: v.string(),
    campId: v.id('camps'),
    uses: v.number(),
    maxUses: v.optional(v.number()),
    expiresAt: v.optional(v.number()),
    createdBy: v.id('users'),
    createdAt: v.number(),
  })
    .index('by_code', ['code'])
    .index('by_camp', ['campId', 'createdAt'])
    .index('by_created_by', ['createdBy', 'createdAt']),

  // Store subscription state. Client sync only records pending receipts; entitlement helpers
  // count active/trialing rows after server-side store validation marks them verified.
  subscriptions: defineTable({
    userId: v.id('users'),
    tier: subscriptionTier,
    status: storeEntitlementStatus,
    verificationStatus: v.optional(storeVerificationStatus),
    platform: storePlatform,
    storeProductId: v.string(),
    storeTransactionId: v.optional(v.string()),
    storeOriginalTransactionId: v.optional(v.string()),
    storePurchaseToken: v.optional(v.string()),
    currentPeriodEnd: v.optional(v.number()),
    verifiedAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index('by_user', ['userId', 'status'])
    .index('by_store_transaction', ['storeOriginalTransactionId'])
    .index('by_store_purchase_token', ['storePurchaseToken']),

  // Immutable ledger of all camp slot movements.
  // Balance is always computed from this table, never stored.
  campSlotTransactions: defineTable({
    userId: v.id('users'),
    type: v.union(
      v.literal('monthly_grant'),
      v.literal('iap_purchase'),
      v.literal('monthly_consumption'),
      v.literal('slot_credit'),
      v.literal('refund'),
      v.literal('grace_period_entry'),
      v.literal('reactivation'),
      v.literal('member_claim'),
    ),
    amount: v.number(), // positive = credit, negative = debit
    campId: v.optional(v.id('camps')),
    periodStart: v.optional(v.number()),
    periodEnd: v.optional(v.number()),
    metadata: v.optional(v.any()),
    createdAt: v.number(),
  })
    .index('by_user', ['userId', 'createdAt'])
    .index('by_type', ['type', 'createdAt'])
    .index('by_camp', ['campId', 'createdAt'])
    .index('by_user_camp', ['userId', 'campId']),

  // Tracks IAP consumable purchases from stores (slot packs).
  consumablePurchases: defineTable({
    userId: v.id('users'),
    platform: storePlatform,
    storeProductId: v.string(),
    storeTransactionId: v.optional(v.string()),
    storeOriginalTransactionId: v.optional(v.string()),
    storePurchaseToken: v.optional(v.string()),
    quantity: v.number(), // how many slots purchased
    verificationStatus: storeVerificationStatus,
    verifiedAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index('by_user', ['userId'])
    .index('by_verification_status_created', ['verificationStatus', 'createdAt'])
    .index('by_transaction', ['storeTransactionId'])
    .index('by_store_transaction', ['storeOriginalTransactionId'])
    .index('by_store_purchase_token', ['storePurchaseToken']),

  // Reconciliation audit log for daily slot balance checks and refunds.
  reconciliationLog: defineTable({
    severity: v.union(v.literal('info'), v.literal('warning'), v.literal('error')),
    category: v.string(), // e.g. 'orphaned_credit', 'unverified_purchase', 'balance_drift', 'duplicate_transaction', 'refund'
    message: v.string(),
    userId: v.optional(v.id('users')),
    purchaseId: v.optional(v.id('consumablePurchases')),
    transactionId: v.optional(v.string()), // store transaction ID
    metadata: v.optional(v.any()),
    createdAt: v.number(),
  })
    .index('by_category', ['category', 'createdAt'])
    .index('by_user', ['userId', 'createdAt'])
    .index('by_created', ['createdAt']),

  // Personal Camps — 1:1 per-subscriber space. Auto-created on Plus+ activation.
  personalCamps: defineTable({
    ownerId: v.id('users'),
    name: v.string(),
    status: v.union(v.literal('active'), v.literal('frozen')),
    frozenAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index('by_owner', ['ownerId']),

  // Personal Bondfire Participants — tracks per-bondfire membership in personal camps
  personalBondfireParticipants: defineTable({
    bondfireId: v.id('bondfires'),
    userId: v.id('users'),
    status: v.union(v.literal('active'), v.literal('left'), v.literal('removed')),
    joinedAt: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index('by_bondfire_status', ['bondfireId', 'status'])
    .index('by_user', ['userId']),

  // Personal Bondfire Invites — bondfire-level invite codes scoped to personal camps
  personalBondfireInvites: defineTable({
    bondfireId: v.id('bondfires'),
    code: v.string(),
    createdBy: v.id('users'),
    expiresAt: v.number(),
    createdAt: v.number(),
  })
    .index('by_code', ['code'])
    .index('by_bondfire', ['bondfireId']),

  // Bondfires - main video posts
  bondfires: defineTable({
    // Creator reference
    userId: v.id('users'),
    creatorName: v.optional(v.string()), // Denormalized for display
    campId: v.optional(v.id('camps')),
    personalCampId: v.optional(v.id('personalCamps')),
    frozen: v.optional(v.boolean()),

    // Video storage
    videoStatus: v.optional(
      v.union(
        v.literal('waiting_for_upload'),
        v.literal('processing'),
        v.literal('live'),
        v.literal('ready'),
        v.literal('errored'),
      ),
    ),
    liveSessionId: v.optional(v.id('liveSessions')),
    muxUploadId: v.optional(v.string()),
    muxAssetId: v.optional(v.string()),
    muxPlaybackId: v.optional(v.string()),
    muxPlaybackPolicy: v.optional(v.union(v.literal('public'), v.literal('signed'))),
    muxAssetStatus: v.optional(v.string()),
    muxAspectRatio: v.optional(v.string()),
    muxMaxResolution: v.optional(v.string()),
    muxLiveStreamId: v.optional(v.string()),
    muxLivePlaybackId: v.optional(v.string()),

    // Video metadata
    durationMs: v.optional(v.number()),
    width: v.optional(v.number()),
    height: v.optional(v.number()),

    // Content metadata
    tags: v.optional(v.array(v.string())),
    metadata: v.optional(v.any()), // Extensible JSON metadata
    expiresAt: v.optional(v.number()),

    // Stats
    videoCount: v.number(), // Total videos including responses (for feed ordering)
    viewCount: v.optional(v.number()),

    // Timestamps
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    // Primary feed ordering: video_count ASC (prioritize newer/smaller bondfires)
    .index('by_video_count', ['videoCount', 'createdAt'])
    // User's bondfires
    .index('by_user', ['userId', 'createdAt'])
    // Recent bondfires
    .index('by_created', ['createdAt'])
    .index('by_camp', ['campId', 'createdAt'])
    .index('by_personal_camp', ['personalCampId', 'createdAt'])
    .index('by_expires_at', ['expiresAt'])
    .index('by_mux_upload', ['muxUploadId'])
    .index('by_mux_asset', ['muxAssetId'])
    .index('by_live_stream', ['muxLiveStreamId']),

  // Bondfire Videos - response videos to bondfires
  bondfireVideos: defineTable({
    // References
    bondfireId: v.id('bondfires'),
    userId: v.id('users'),
    creatorName: v.optional(v.string()), // Denormalized for display

    // Position in the bondfire sequence
    sequenceNumber: v.number(),

    // Video storage
    videoStatus: v.optional(
      v.union(
        v.literal('waiting_for_upload'),
        v.literal('processing'),
        v.literal('live'),
        v.literal('ready'),
        v.literal('errored'),
      ),
    ),
    liveSessionId: v.optional(v.id('liveSessions')),
    muxUploadId: v.optional(v.string()),
    muxAssetId: v.optional(v.string()),
    muxPlaybackId: v.optional(v.string()),
    muxPlaybackPolicy: v.optional(v.union(v.literal('public'), v.literal('signed'))),
    muxAssetStatus: v.optional(v.string()),
    muxAspectRatio: v.optional(v.string()),
    muxMaxResolution: v.optional(v.string()),
    muxLiveStreamId: v.optional(v.string()),
    muxLivePlaybackId: v.optional(v.string()),

    // Video metadata
    durationMs: v.optional(v.number()),
    width: v.optional(v.number()),
    height: v.optional(v.number()),

    // Content metadata
    tags: v.optional(v.array(v.string())),
    metadata: v.optional(v.any()),
    expiresAt: v.optional(v.number()),

    // Timestamps
    createdAt: v.number(),
  })
    // Get all videos for a bondfire in order
    .index('by_bondfire', ['bondfireId', 'sequenceNumber'])
    // User's response videos
    .index('by_user', ['userId', 'createdAt'])
    .index('by_expires_at', ['expiresAt'])
    .index('by_mux_upload', ['muxUploadId'])
    .index('by_mux_asset', ['muxAssetId'])
    .index('by_live_stream', ['muxLiveStreamId']),

  // Per-user read markers for ongoing Bondfire conversations.
  bondfireThreadReads: defineTable({
    userId: v.id('users'),
    bondfireId: v.id('bondfires'),
    lastReadAt: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index('by_user', ['userId', 'updatedAt'])
    .index('by_user_bondfire', ['userId', 'bondfireId'])
    .index('by_bondfire', ['bondfireId']),

  // Profile Close Circle pins. A user can pin up to 8 other participants.
  closeCirclePins: defineTable({
    ownerId: v.id('users'),
    pinnedUserId: v.id('users'),
    order: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index('by_owner', ['ownerId', 'order'])
    .index('by_owner_pinned', ['ownerId', 'pinnedUserId'])
    .index('by_pinned_user', ['pinnedUserId']),

  // Live Sessions - Mux live broadcasts before they become replay assets
  liveSessions: defineTable({
    userId: v.id('users'),
    bondfireId: v.optional(v.id('bondfires')),
    bondfireVideoId: v.optional(v.id('bondfireVideos')),
    muxLiveStreamId: v.string(),
    muxLivePlaybackId: v.optional(v.string()),
    muxActiveAssetId: v.optional(v.string()),
    muxRecentAssetId: v.optional(v.string()),
    muxRecordedAssetId: v.optional(v.string()),
    transport: v.optional(v.union(v.literal('rtmps'), v.literal('srt'))),
    latencyMode: v.optional(v.union(v.literal('standard'), v.literal('reduced'), v.literal('low'))),
    status: v.union(
      v.literal('created'),
      v.literal('starting'),
      v.literal('live'),
      v.literal('ending'),
      v.literal('ended'),
      v.literal('errored'),
    ),
    startedAt: v.optional(v.number()),
    endedAt: v.optional(v.number()),
    errorMessage: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index('by_user', ['userId', 'createdAt'])
    .index('by_mux_live_stream', ['muxLiveStreamId'])
    .index('by_status', ['status', 'updatedAt']),

  muxWebhookEvents: defineTable({
    eventId: v.string(),
    eventType: v.string(),
    createdAt: v.number(),
  }).index('by_event_id', ['eventId']),

  // Watch Events - video analytics
  watchEvents: defineTable({
    userId: v.id('users'),

    // Video reference - can be bondfire or bondfireVideo
    videoType: v.union(v.literal('bondfire'), v.literal('response')),
    videoId: v.string(), // ID of bondfire or bondfireVideo

    // Event details
    eventType: v.union(
      v.literal('start'),
      v.literal('milestone_25'),
      v.literal('milestone_50'),
      v.literal('milestone_75'),
      v.literal('complete'),
    ),
    positionMs: v.number(), // Position when event occurred
    durationMs: v.optional(v.number()), // Total video duration

    // Timestamp
    createdAt: v.number(),
  })
    .index('by_user', ['userId', 'createdAt'])
    .index('by_video', ['videoId', 'createdAt'])
    .index('by_user_video', ['userId', 'videoId']),

  // Device Tokens - for push notifications
  deviceTokens: defineTable({
    userId: v.id('users'),

    // Push notification token
    token: v.string(),
    platform: v.union(v.literal('ios'), v.literal('android')),

    // Token type - FCM (Firebase) or Expo
    tokenType: v.optional(v.union(v.literal('fcm'), v.literal('expo'))),

    // Device identifier (for managing multiple devices per user)
    deviceId: v.optional(v.string()),

    // Timestamps
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index('by_user', ['userId'])
    .index('by_token', ['token']),

  // Video Reports - for content moderation / child safety compliance
  reports: defineTable({
    // Reporter reference
    reporterUserId: v.id('users'),

    // Video reference - exactly one must be set (enforced in mutation)
    bondfireId: v.optional(v.id('bondfires')),
    bondfireVideoId: v.optional(v.id('bondfireVideos')),

    // Video owner (for quick reference)
    videoOwnerId: v.id('users'),

    // Report category
    category: v.union(
      v.literal('camp_guidelines'),
      v.literal('community_guidelines'),
      v.literal('terms_of_service'),
      v.literal('privacy_policy'),
    ),

    // Sub-category (for community guidelines)
    subCategory: v.optional(
      v.union(
        v.literal('harassment_or_abuse'),
        v.literal('discrimination'),
        v.literal('harmful_content'),
        v.literal('spam_or_solicitation'),
        v.literal('misinformation'),
        v.literal('impersonation'),
        v.literal('pornographic_content'),
        v.literal('child_safety_concern'),
        v.literal('other'),
      ),
    ),

    // Additional comments from reporter (required, min 30 chars enforced in mutation)
    comments: v.string(),

    // Status for moderation workflow
    status: v.union(
      v.literal('pending'),
      v.literal('reviewed'),
      v.literal('resolved'),
      v.literal('dismissed'),
    ),

    // Timestamps
    createdAt: v.number(),
    reviewedAt: v.optional(v.number()),
  })
    .index('by_bondfire', ['bondfireId', 'createdAt'])
    .index('by_bondfire_video', ['bondfireVideoId', 'createdAt'])
    .index('by_reporter', ['reporterUserId', 'createdAt'])
    .index('by_status', ['status', 'createdAt'])
    .index('by_video_owner', ['videoOwnerId', 'createdAt']),

  // Client telemetry logs from React Native app
  clientLogs: defineTable({
    userId: v.optional(v.id('users')),
    level: v.union(
      v.literal('error'),
      v.literal('warn'),
      v.literal('info'),
      v.literal('breadcrumb'),
    ),
    event: v.string(),
    message: v.string(),
    data: v.optional(v.any()),
    platform: v.union(v.literal('ios'), v.literal('android')),
    appVersion: v.optional(v.string()),
    sessionId: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index('by_log_user', ['userId', 'createdAt'])
    .index('by_log_level', ['level', 'createdAt'])
    .index('by_log_event', ['event', 'createdAt'])
    .index('by_log_session', ['sessionId', 'createdAt']),
})

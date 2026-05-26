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
)
const subscriptionAddOnType = v.union(v.literal('extra_camp'))

const userGender = v.union(v.literal('male'), v.literal('female'), v.literal('other'))

const campRules = v.object({
  gender: v.optional(v.union(v.literal('male'), v.literal('female'), v.literal('any'))),
  minDurationMs: v.optional(v.number()),
  maxDurationMs: v.optional(v.number()),
  maxResponses: v.optional(v.number()),
  requiresTradeTags: v.optional(v.boolean()),
  allowedTiers: v.optional(v.array(subscriptionTier)),
  advisoryGuidelines: v.optional(v.array(v.string())),
})

const campVisibilityRule = v.object({
  type: v.union(
    v.literal('minTier'),
    v.literal('gender'),
    v.literal('minAge'),
    v.literal('inviteRequired'),
  ),
  minTier: v.optional(subscriptionTier),
  gender: v.optional(v.union(v.literal('male'), v.literal('female'))),
  minAge: v.optional(v.number()),
})

const campJoinRule = v.object({
  type: v.union(
    v.literal('minTier'),
    v.literal('gender'),
    v.literal('minAge'),
    v.literal('inviteRequired'),
    v.literal('approvalRequired'),
  ),
  minTier: v.optional(subscriptionTier),
  gender: v.optional(v.union(v.literal('male'), v.literal('female'))),
  minAge: v.optional(v.number()),
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
    rules: campRules,
    visibilityRules: v.optional(v.array(campVisibilityRule)),
    joinRules: v.optional(v.array(campJoinRule)),
    nameOverride: v.optional(v.string()), // Private camp custom name override
    ownerDisplayName: v.optional(v.string()), // Denormalized owner display name at camp creation
    crisisBroadcast: v.optional(v.boolean()),
    welcomeBroadcast: v.optional(v.boolean()),
    visibility: v.union(v.literal('public'), v.literal('private')),
    access: v.union(v.literal('open'), v.literal('approval'), v.literal('invite')),
    status: v.union(v.literal('active'), v.literal('frozen'), v.literal('archived')),
    frozenAt: v.optional(v.number()),
    reclaimDeadline: v.optional(v.number()),
    // Optional until the production backfill has run; all new writes set this.
    ownerId: v.optional(v.id('users')),
    bondfireCount: v.optional(v.number()),
    activeMemberCount: v.optional(v.number()),
    isLaunchCamp: v.optional(v.boolean()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index('by_slug', ['slug'])
    .index('by_status_visibility', ['status', 'visibility'])
    .index('by_owner', ['ownerId', 'createdAt']),

  // Camp membership, notification preferences, and moderation roles
  campMembers: defineTable({
    userId: v.id('users'),
    campId: v.id('camps'),
    role: v.union(v.literal('owner'), v.literal('moderator'), v.literal('member')),
    status: v.union(v.literal('pending'), v.literal('active'), v.literal('banned')),
    muted: v.boolean(),
    joinedAt: v.optional(v.number()),
    requestedAt: v.optional(v.number()),
    approvedAt: v.optional(v.number()),
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

  // Store add-ons that extend paid-plan allowances.
  subscriptionAddOns: defineTable({
    userId: v.id('users'),
    type: subscriptionAddOnType,
    status: storeEntitlementStatus,
    verificationStatus: storeVerificationStatus,
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

  // Bondfires - main video posts
  bondfires: defineTable({
    // Creator reference
    userId: v.id('users'),
    creatorName: v.optional(v.string()), // Denormalized for display
    campId: v.optional(v.id('camps')),

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
})

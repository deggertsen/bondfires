import { authTables } from '@convex-dev/auth/server'
import { defineSchema, defineTable } from 'convex/server'
import { v } from 'convex/values'

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
    displayName: v.optional(v.string()),
    photoUrl: v.optional(v.string()),
    photoStorageId: v.optional(v.id('_storage')),

    // Stats (denormalized for performance)
    bondfireCount: v.optional(v.number()),
    responseCount: v.optional(v.number()),
    totalViews: v.optional(v.number()),

    // Metadata
    createdAt: v.optional(v.number()),
    updatedAt: v.optional(v.number()),

    // Admin flags
    isReviewerAccount: v.optional(v.boolean()), // For Google Play / App Store reviewer accounts
  }).index('email', ['email']), // Required by @convex-dev/auth (must be named exactly 'email')

  // Bondfires - main video posts
  bondfires: defineTable({
    // Creator reference
    userId: v.id('users'),
    creatorName: v.optional(v.string()), // Denormalized for display

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

    // Timestamps
    createdAt: v.number(),
  })
    // Get all videos for a bondfire in order
    .index('by_bondfire', ['bondfireId', 'sequenceNumber'])
    // User's response videos
    .index('by_user', ['userId', 'createdAt'])
    .index('by_mux_upload', ['muxUploadId'])
    .index('by_mux_asset', ['muxAssetId'])
    .index('by_live_stream', ['muxLiveStreamId']),

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

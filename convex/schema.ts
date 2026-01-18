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

    // Video storage (S3 keys)
    videoKey: v.string(), // HD video key in S3
    sdVideoKey: v.optional(v.string()), // SD video key in S3
    thumbnailKey: v.optional(v.string()), // Thumbnail image key

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
    .index('by_created', ['createdAt']),

  // Bondfire Videos - response videos to bondfires
  bondfireVideos: defineTable({
    // References
    bondfireId: v.id('bondfires'),
    userId: v.id('users'),
    creatorName: v.optional(v.string()), // Denormalized for display

    // Position in the bondfire sequence
    sequenceNumber: v.number(),

    // Video storage (S3 keys)
    videoKey: v.string(), // HD video key in S3
    sdVideoKey: v.optional(v.string()), // SD video key in S3
    thumbnailKey: v.optional(v.string()),

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
    .index('by_user', ['userId', 'createdAt']),

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
})

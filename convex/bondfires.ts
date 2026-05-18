import { v } from 'convex/values'
import { internal } from './_generated/api'
import type { Id } from './_generated/dataModel'
import type { MutationCtx } from './_generated/server'
import { mutation, query } from './_generated/server'
import { auth } from './auth'

type SubscriptionTier = 'free' | 'plus' | 'premium' | 'pro'

const TIER_RANK: Record<SubscriptionTier, number> = {
  free: 0,
  plus: 1,
  premium: 2,
  pro: 3,
}

// Works for both `bondfires` and `bondfireVideos` rows — they share the
// status/playback fields this predicate touches.
function isPlayableVideoRecord(record: {
  videoStatus?: string
  muxPlaybackId?: string
  muxLivePlaybackId?: string
}) {
  const status = record.videoStatus ?? 'ready'
  return (
    (status === 'ready' && !!record.muxPlaybackId) ||
    (status === 'live' && !!record.muxLivePlaybackId)
  )
}

function withLiveFlags<T extends { videoStatus?: string; muxLivePlaybackId?: string }>(
  record: T,
): T & { isLive: boolean; livePlaybackId?: string } {
  const isLive = (record.videoStatus ?? 'ready') === 'live' && !!record.muxLivePlaybackId
  return {
    ...record,
    isLive,
    livePlaybackId: isLive ? record.muxLivePlaybackId : undefined,
  }
}

async function getActiveSubscriptionTier(
  ctx: MutationCtx,
  userId: Id<'users'>,
): Promise<SubscriptionTier> {
  const now = Date.now()
  const subscriptions = await ctx.db
    .query('subscriptions')
    .withIndex('by_user', (q) => q.eq('userId', userId))
    .collect()
  const activeSubscriptions = subscriptions.filter(
    (subscription) =>
      (subscription.status === 'active' || subscription.status === 'trialing') &&
      (!subscription.currentPeriodEnd || subscription.currentPeriodEnd > now),
  )

  return activeSubscriptions.reduce<SubscriptionTier>(
    (highest, subscription) =>
      TIER_RANK[subscription.tier] > TIER_RANK[highest] ? subscription.tier : highest,
    'free',
  )
}

// List bondfires for the feed (ordered by videoCount ASC for discovery)
export const listFeed = query({
  args: {
    limit: v.optional(v.number()),
    cursor: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const limit = args.limit ?? 20

    // Query bondfires ordered by video_count ascending (prioritize newer/smaller)
    const bondfires = await ctx.db
      .query('bondfires')
      .withIndex('by_video_count')
      .order('asc')
      .take(limit * 3)

    return bondfires.filter(isPlayableVideoRecord).slice(0, limit).map(withLiveFlags)
  },
})

export const listByCamp = query({
  args: {
    campId: v.id('camps'),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = args.limit ?? 20
    const bondfires = await ctx.db
      .query('bondfires')
      .withIndex('by_camp', (q) => q.eq('campId', args.campId))
      .order('desc')
      .take(limit * 3)

    return bondfires.filter(isPlayableVideoRecord).slice(0, limit).map(withLiveFlags)
  },
})

// Get a single bondfire by ID
export const get = query({
  args: { id: v.id('bondfires') },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.id)
  },
})

// Get a bondfire with all its response videos
export const getWithVideos = query({
  args: { bondfireId: v.id('bondfires') },
  handler: async (ctx, args) => {
    const bondfire = await ctx.db.get(args.bondfireId)
    if (!bondfire || !isPlayableVideoRecord(bondfire)) {
      return null
    }

    const videos = await ctx.db
      .query('bondfireVideos')
      .withIndex('by_bondfire', (q) => q.eq('bondfireId', args.bondfireId))
      .order('asc')
      .collect()

    const readyVideos = videos.filter(isPlayableVideoRecord).map(withLiveFlags)

    return {
      ...withLiveFlags(bondfire),
      videos: readyVideos,
    }
  },
})

// Get bondfires by user
export const listByUser = query({
  args: { userId: v.id('users') },
  handler: async (ctx, args) => {
    const bondfires = await ctx.db
      .query('bondfires')
      .withIndex('by_user', (q) => q.eq('userId', args.userId))
      .order('desc')
      .collect()

    return bondfires.filter(isPlayableVideoRecord).map(withLiveFlags)
  },
})

// Create a new bondfire
export const create = mutation({
  args: {
    campId: v.optional(v.id('camps')),
    muxUploadId: v.optional(v.string()),
    muxAssetId: v.optional(v.string()),
    muxPlaybackId: v.optional(v.string()),
    muxPlaybackPolicy: v.optional(v.union(v.literal('public'), v.literal('signed'))),
    videoStatus: v.optional(
      v.union(
        v.literal('waiting_for_upload'),
        v.literal('processing'),
        v.literal('live'),
        v.literal('ready'),
        v.literal('errored'),
      ),
    ),
    durationMs: v.optional(v.number()),
    width: v.optional(v.number()),
    height: v.optional(v.number()),
    tags: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    const userId = await auth.getUserId(ctx)
    if (!userId) {
      throw new Error('Not authenticated')
    }

    const user = await ctx.db.get(userId)
    const now = Date.now()
    if (!user) {
      throw new Error('User not found')
    }

    if (!args.muxAssetId || !args.muxPlaybackId) {
      throw new Error('Mux asset ID and playback ID are required for Mux videos')
    }

    if (!args.campId) {
      throw new Error('Choose a camp before sparking a Bondfire')
    }
    const campId = args.campId

    const camp = await ctx.db.get(campId)
    if (!camp || camp.status !== 'active') {
      throw new Error('Camp not found')
    }

    const membership = await ctx.db
      .query('campMembers')
      .withIndex('by_user_camp', (q) => q.eq('userId', userId).eq('campId', campId))
      .first()
    if (membership?.status !== 'active') {
      throw new Error('Join this camp before sparking here')
    }

    const campGender = camp.rules.gender
    if (campGender && campGender !== 'any' && user.gender !== campGender) {
      throw new Error('This camp is limited to members who match its gender setting')
    }

    if (
      args.durationMs !== undefined &&
      camp.rules.minDurationMs &&
      args.durationMs < camp.rules.minDurationMs
    ) {
      throw new Error('This recording is shorter than the camp allows')
    }

    if (camp.rules.maxDurationMs && args.durationMs && args.durationMs > camp.rules.maxDurationMs) {
      throw new Error('This recording is longer than the camp allows')
    }

    if (camp.rules.allowedTiers && camp.rules.allowedTiers.length > 0) {
      const tier = await getActiveSubscriptionTier(ctx, userId)
      if (!camp.rules.allowedTiers.includes(tier)) {
        throw new Error('Your membership tier cannot spark in this camp')
      }
    }

    if (camp.rules.requiresTradeTags) {
      const tags = args.tags ?? []
      if (!tags.includes('need') && !tags.includes('offer')) {
        throw new Error('The Trading Post requires a need or offer tag')
      }
    }

    const bondfireId = await ctx.db.insert('bondfires', {
      userId,
      creatorName: user?.displayName ?? user?.name,
      campId,
      videoStatus: args.videoStatus ?? 'ready',
      muxUploadId: args.muxUploadId,
      muxAssetId: args.muxAssetId,
      muxPlaybackId: args.muxPlaybackId,
      muxPlaybackPolicy: args.muxPlaybackPolicy,
      muxAssetStatus: args.videoStatus,
      durationMs: args.durationMs,
      width: args.width,
      height: args.height,
      tags: args.tags,
      videoCount: 1, // Starts with 1 (the original video)
      viewCount: 0,
      createdAt: now,
      updatedAt: now,
    })

    // Update user's bondfire count
    await ctx.db.patch(userId, {
      bondfireCount: (user?.bondfireCount ?? 0) + 1,
      updatedAt: now,
    })

    const latestCamp = await ctx.db.get(campId)
    if (latestCamp) {
      await ctx.db.patch(campId, {
        bondfireCount: (latestCamp.bondfireCount ?? 0) + 1,
        updatedAt: now,
      })
    }

    if ((args.videoStatus ?? 'ready') === 'ready') {
      await ctx.scheduler.runAfter(0, internal.sendNotification.notifyCampBondfire, {
        bondfireId,
        creatorId: userId,
        creatorName: user?.displayName ?? user?.name ?? 'Someone',
      })
    }

    return bondfireId
  },
})

// Record a unique view for the current user. Views are counted once per
// viewer/bondfire and never for the creator's own videos.
export const incrementViews = mutation({
  args: { bondfireId: v.id('bondfires') },
  handler: async (ctx, args) => {
    const viewerId = await auth.getUserId(ctx)
    if (!viewerId) {
      throw new Error('Not authenticated')
    }

    const bondfire = await ctx.db.get(args.bondfireId)
    if (!bondfire) {
      throw new Error('Bondfire not found')
    }

    if (bondfire.userId === viewerId) {
      return { recorded: false, reason: 'own_video' }
    }

    const existingView = await ctx.db
      .query('watchEvents')
      .withIndex('by_user_video', (q) => q.eq('userId', viewerId).eq('videoId', args.bondfireId))
      .filter((q) => q.eq(q.field('eventType'), 'start'))
      .first()

    if (existingView) {
      return { recorded: false, reason: 'already_viewed' }
    }

    const now = Date.now()
    await ctx.db.insert('watchEvents', {
      userId: viewerId,
      videoType: 'bondfire',
      videoId: args.bondfireId,
      eventType: 'start',
      positionMs: 0,
      durationMs: bondfire.durationMs,
      createdAt: now,
    })

    const creator = await ctx.db.get(bondfire.userId)

    await ctx.db.patch(args.bondfireId, {
      viewCount: (bondfire.viewCount ?? 0) + 1,
      updatedAt: now,
    })

    if (creator) {
      await ctx.db.patch(bondfire.userId, {
        totalViews: (creator.totalViews ?? 0) + 1,
        updatedAt: now,
      })
    }

    return { recorded: true }
  },
})

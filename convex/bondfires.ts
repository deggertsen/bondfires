import { v } from 'convex/values'
import { internal } from './_generated/api'
import type { Doc, Id } from './_generated/dataModel'
import type { MutationCtx, QueryCtx } from './_generated/server'
import { action, internalQuery, mutation, query } from './_generated/server'
import { auth } from './auth'
import {
  buildViewerVisibilityContext,
  filterVisibleBondfiresForViewer,
  isBondfireVisibleToViewer,
  isCampContentVisibleToViewer,
} from './bondfireVisibility'
import { isCampParticipableStatus } from './campLifecycle'
import {
  assertCanCreateBondfire,
  assertVideoDurationWithinTierLimit,
  getPrivateCampExpiresAt,
} from './entitlements'
import { canViewPersonalBondfire } from './personalBondfireAccess'

type ExpiredPrivateCampVideoCleanupResult = {
  expiredBondfires?: number
  muxAssetsToDelete?: number
  deletedBondfires?: number
  deletedResponses?: number
  deletedMuxAssets?: number
  missingMuxAssets?: number
  remainingMayExist: boolean
}
type PublicUser = {
  _id: Id<'users'>
  displayName?: string
  name?: string
  photoUrl?: string
}

// Works for both `bondfires` and `bondfireVideos` rows — they share the
// status/playback fields this predicate touches. Exported for the
// videoCountRepair cron, which uses it to decide which rows count.
export function isPlayableVideoRecord(record: {
  videoStatus?: string
  muxPlaybackId?: string
  muxLivePlaybackId?: string
  expiresAt?: number
}) {
  if (record.expiresAt !== undefined && record.expiresAt <= Date.now()) {
    return false
  }

  const status = record.videoStatus ?? 'ready'
  return (
    (status === 'ready' && !!record.muxPlaybackId) ||
    (status === 'live' && !!record.muxLivePlaybackId)
  )
}

// In-flight responses: counted in bondfire.videoCount (live responses count at
// provisioning, see videos.ts createMuxLiveStream) but not yet playable. The
// thread viewer surfaces these so the response count and the swipe list never
// silently disagree while Mux finishes the recorded asset.
function isProcessingVideoRecord(record: {
  videoStatus?: string
  muxPlaybackId?: string
  muxLivePlaybackId?: string
  expiresAt?: number
}) {
  if (record.expiresAt !== undefined && record.expiresAt <= Date.now()) {
    return false
  }

  const status = record.videoStatus ?? 'ready'
  if (status === 'errored') {
    return false
  }

  return !isPlayableVideoRecord(record)
}

function isDetailVisibleVideoRecord(record: {
  videoStatus?: string
  muxPlaybackId?: string
  muxLivePlaybackId?: string
  expiresAt?: number
}) {
  if (record.expiresAt !== undefined && record.expiresAt <= Date.now()) {
    return false
  }

  const status = record.videoStatus ?? 'ready'
  if (status === 'pending' || status === 'processing' || status === 'errored') {
    return true
  }

  return isPlayableVideoRecord(record)
}

function toPublicUser(user: Doc<'users'>): PublicUser {
  return {
    _id: user._id,
    displayName: user.displayName,
    name: user.name,
    photoUrl: user.photoUrl,
  }
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

async function getThreadParticipants(ctx: QueryCtx, bondfire: Doc<'bondfires'>) {
  const userId = await auth.getUserId(ctx)
  const pinnedUserIds = new Set<Id<'users'>>()
  if (userId) {
    const pins = await ctx.db
      .query('closeCirclePins')
      .withIndex('by_owner', (q) => q.eq('ownerId', userId))
      .collect()
    for (const pin of pins) {
      pinnedUserIds.add(pin.pinnedUserId)
    }
  }

  const participantMap = new Map<Id<'users'>, { latestAt: number; videoCount: number }>()
  participantMap.set(bondfire.userId, { latestAt: bondfire.createdAt, videoCount: 1 })

  const videos = await ctx.db
    .query('bondfireVideos')
    .withIndex('by_bondfire', (q) => q.eq('bondfireId', bondfire._id))
    .collect()

  for (const video of videos.filter(isPlayableVideoRecord)) {
    const current = participantMap.get(video.userId)
    participantMap.set(video.userId, {
      latestAt: Math.max(current?.latestAt ?? 0, video.createdAt),
      videoCount: (current?.videoCount ?? 0) + 1,
    })
  }

  const users = await Promise.all(
    [...participantMap.keys()].map((participantId) => ctx.db.get(participantId)),
  )
  return users
    .flatMap((participant) => {
      if (!participant) {
        return []
      }

      const participation = participantMap.get(participant._id)
      if (!participation) {
        return []
      }

      return [
        {
          user: toPublicUser(participant),
          latestAt: participation.latestAt,
          videoCount: participation.videoCount,
          isPinned: pinnedUserIds.has(participant._id),
        },
      ]
    })
    .sort((a, b) => b.latestAt - a.latestAt)
}

async function filterVisibleBondfires(ctx: QueryCtx, bondfires: Doc<'bondfires'>[]) {
  const userId = await auth.getUserId(ctx)
  const viewer = await buildViewerVisibilityContext(ctx, userId)
  return await filterVisibleBondfiresForViewer(ctx, bondfires, viewer)
}

async function resolveCampLabel(ctx: QueryCtx, bondfire: Doc<'bondfires'>) {
  if (bondfire.personalCampId) {
    const personalCamp = await ctx.db.get(bondfire.personalCampId)
    if (personalCamp) {
      return personalCamp.name
    }
  }

  if (bondfire.campId) {
    const campId = bondfire.campId
    const camp = await ctx.db.get(campId)
    if (camp) {
      return camp.name
    }
  }

  return undefined
}

async function deleteWatchEventsForVideo(ctx: MutationCtx, videoId: string) {
  const watchEvents = await ctx.db
    .query('watchEvents')
    .withIndex('by_video', (q) => q.eq('videoId', videoId))
    .collect()

  for (const watchEvent of watchEvents) {
    await ctx.db.delete(watchEvent._id)
  }
}

async function removeBondfireFromPinnedLists(ctx: MutationCtx, bondfireId: Id<'bondfires'>) {
  const users = await ctx.db.query('users').collect()
  const now = Date.now()

  for (const user of users) {
    if (!user.pinnedBondfireIds?.includes(bondfireId)) {
      continue
    }

    await ctx.db.patch(user._id, {
      pinnedBondfireIds: user.pinnedBondfireIds.filter((id) => id !== bondfireId),
      updatedAt: now,
    })
  }
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
      .take(limit * 5)

    const visibleBondfires = await filterVisibleBondfires(
      ctx,
      bondfires.filter(isPlayableVideoRecord),
    )

    const withCampLabels = await Promise.all(
      visibleBondfires.slice(0, limit).map(async (bondfire) => {
        const campLabel = await resolveCampLabel(ctx, bondfire)
        return { ...withLiveFlags(bondfire), campLabel }
      }),
    )

    return withCampLabels
  },
})

export const listByCamp = query({
  args: {
    campId: v.id('camps'),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = args.limit ?? 20
    const camp = await ctx.db.get(args.campId)
    if (!camp) {
      return []
    }

    const userId = await auth.getUserId(ctx)
    const viewer = await buildViewerVisibilityContext(ctx, userId)
    if (!isCampContentVisibleToViewer(camp, viewer)) {
      return []
    }

    const bondfires = await ctx.db
      .query('bondfires')
      .withIndex('by_camp', (q) => q.eq('campId', args.campId))
      .order('desc')
      .take(limit * 3)

    const filtered = bondfires.filter(isPlayableVideoRecord).slice(0, limit)

    return filtered.map((bondfire) => ({ ...withLiveFlags(bondfire), campLabel: camp.name }))
  },
})

// Get a single bondfire by ID
export const get = query({
  args: { id: v.id('bondfires') },
  handler: async (ctx, args) => {
    const bondfire = await ctx.db.get(args.id)
    if (!bondfire || !isDetailVisibleVideoRecord(bondfire)) {
      return null
    }

    const [visible] = await filterVisibleBondfires(ctx, [bondfire])
    if (!visible) {
      return null
    }

    return bondfire
  },
})

/** Get a bondfire with its camp context for permission checks. */
export const getWithCampContext = query({
  args: { id: v.id('bondfires') },
  handler: async (ctx, args) => {
    const bondfire = await ctx.db.get(args.id)
    if (!bondfire || !isDetailVisibleVideoRecord(bondfire)) {
      return null
    }

    const [visible] = await filterVisibleBondfires(ctx, [bondfire])
    if (!visible) {
      return null
    }

    if (!bondfire.campId) {
      return {
        bondfire,
        camp: null,
        membership: null,
        canInvite: bondfire.userId === (await auth.getUserId(ctx)),
      }
    }

    const campId = bondfire.campId
    const camp = await ctx.db.get(campId)
    const userId = (await auth.getUserId(ctx)) ?? undefined

    let membership = null
    if (userId) {
      const m = await ctx.db
        .query('campMembers')
        .withIndex('by_user_camp', (q) => q.eq('userId', userId).eq('campId', campId))
        .unique()
      membership = m
    }

    const isCreator = bondfire.userId === userId
    const isOwnerOrMod = membership?.role === 'owner' || membership?.role === 'moderator'
    const isPublicCamp = camp?.access === 'open'
    const isActiveMember = membership?.status === 'active'

    const canInvite = isCreator || isOwnerOrMod || (isPublicCamp && isActiveMember)

    return { bondfire, camp, membership, canInvite }
  },
})

export const getForNotification = internalQuery({
  args: { id: v.id('bondfires') },
  handler: async (ctx, args) => {
    const bondfire = await ctx.db.get(args.id)
    if (!bondfire || !isDetailVisibleVideoRecord(bondfire)) {
      return null
    }

    return bondfire
  },
})

// Get a bondfire with all its response videos
export const getWithVideos = query({
  args: { bondfireId: v.id('bondfires') },
  handler: async (ctx, args) => {
    const bondfire = await ctx.db.get(args.bondfireId)
    if (!bondfire || !isDetailVisibleVideoRecord(bondfire)) {
      return null
    }

    const [visible] = await filterVisibleBondfires(ctx, [bondfire])
    if (!visible) {
      return null
    }
    const camp = bondfire.campId ? await ctx.db.get(bondfire.campId) : null

    const videos = await ctx.db
      .query('bondfireVideos')
      .withIndex('by_bondfire', (q) => q.eq('bondfireId', args.bondfireId))
      .order('asc')
      .collect()

    const readyVideos = videos.filter(isPlayableVideoRecord).map(withLiveFlags)

    // Lightweight projection only — no Mux IDs leak for unfinished videos.
    const processingResponses = videos.filter(isProcessingVideoRecord).map((video) => ({
      _id: video._id,
      userId: video.userId,
      creatorName: video.creatorName,
      createdAt: video.createdAt,
    }))

    return {
      ...withLiveFlags(bondfire),
      campStatus: camp?.status,
      campName: camp?.name,
      videos: readyVideos,
      processingResponses,
      participants: await getThreadParticipants(ctx, bondfire),
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

    const visibleBondfires = await filterVisibleBondfires(
      ctx,
      bondfires.filter(isPlayableVideoRecord),
    )

    return visibleBondfires.map(withLiveFlags)
  },
})

export const cleanupExpiredPrivateCampVideos = action({
  args: {
    dryRun: v.optional(v.boolean()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<ExpiredPrivateCampVideoCleanupResult> => {
    const userId = await auth.getUserId(ctx)
    if (!userId) {
      throw new Error('Not authenticated')
    }

    const isAdmin = await ctx.runQuery(internal.videos.isUserAdmin, { userId })
    if (!isAdmin) {
      throw new Error('Only admins can clean up expired private camp videos')
    }

    return await ctx.runAction(internal.videos.cleanupExpiredPrivateCampVideos, args)
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
    muxLiveStreamId: v.optional(v.string()),
    muxLivePlaybackId: v.optional(v.string()),
    title: v.optional(v.string()),
    videoStatus: v.optional(
      v.union(
        v.literal('pending'),
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
      if (args.videoStatus !== 'pending') {
        throw new Error('Mux asset ID and playback ID are required for Mux videos')
      }
      // Pending bondfires don't require Mux asset IDs yet; fall through.
    }

    if (!args.campId) {
      throw new Error('Choose a camp before sparking a Bondfire')
    }
    const campId = args.campId

    const camp = await ctx.db.get(campId)
    if (!camp || !isCampParticipableStatus(camp.status)) {
      throw new Error('Camp not found')
    }

    const membership = await ctx.db
      .query('campMembers')
      .withIndex('by_user_camp', (q) => q.eq('userId', userId).eq('campId', campId))
      .first()
    if (membership?.status !== 'active') {
      throw new Error('Join this camp before sparking here')
    }

    if (camp.access === 'invite' && camp.ownerId !== userId) {
      throw new Error('Only the private camp owner can spark here')
    }

    const campGender = camp.rules?.access.gender?.value
    if (campGender && campGender !== 'any' && user.gender !== campGender) {
      throw new Error('This camp is limited to members who match its gender setting')
    }

    if (
      camp.rules?.participation.maxDurationMs &&
      args.durationMs &&
      args.durationMs > camp.rules.participation.maxDurationMs
    ) {
      throw new Error('This recording is longer than the camp allows')
    }

    // Enforce tier-based video duration limit.
    await assertVideoDurationWithinTierLimit(ctx, userId, args.durationMs)

    // Enforce tier-based Bondfire creation permission (Free cannot create).
    const tier = await assertCanCreateBondfire(ctx, userId)
    if (camp.rules?.access.allowedTiers?.value && camp.rules.access.allowedTiers.value.length > 0) {
      if (!camp.rules.access.allowedTiers.value.includes(tier)) {
        throw new Error('Your membership tier cannot spark in this camp')
      }
    }

    if (camp.rules?.advisory.requiresTradeTags) {
      const tags = args.tags ?? []
      if (!tags.includes('need') && !tags.includes('offer')) {
        throw new Error('The Trading Post requires a need or offer tag')
      }
    }

    if (camp.access === 'invite' && args.muxPlaybackPolicy !== 'signed') {
      throw new Error('Private camp videos must use signed Mux playback')
    }

    const bondfireId = await ctx.db.insert('bondfires', {
      userId,
      creatorName: user?.displayName ?? user?.name,
      campId,
      title: args.title,
      frozen: false,
      videoStatus: args.videoStatus ?? 'ready',
      muxUploadId: args.muxUploadId,
      muxAssetId: args.muxAssetId,
      muxPlaybackId: args.muxPlaybackId,
      muxPlaybackPolicy: args.muxPlaybackPolicy,
      muxLiveStreamId: args.muxLiveStreamId,
      muxLivePlaybackId: args.muxLivePlaybackId,
      muxAssetStatus: args.videoStatus,
      durationMs: args.durationMs,
      width: args.width,
      height: args.height,
      tags: args.tags,
      expiresAt: await getPrivateCampExpiresAt(ctx, camp, now),
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

    const finalStatus = args.videoStatus ?? 'ready'
    if (finalStatus === 'ready' || finalStatus === 'live') {
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
    if (bondfire.expiresAt !== undefined && bondfire.expiresAt <= Date.now()) {
      throw new Error('Bondfire not found')
    }

    if (bondfire.personalCampId) {
      const canViewBondfire = await canViewPersonalBondfire(ctx, {
        bondfire,
        userId: viewerId,
      })
      if (!canViewBondfire) {
        throw new Error('Bondfire not found')
      }
    } else if (bondfire.campId) {
      const camp = await ctx.db.get(bondfire.campId)
      if (!camp) {
        throw new Error('Camp not found')
      }

      const viewer = await buildViewerVisibilityContext(ctx, viewerId)
      if (!isCampContentVisibleToViewer(camp, viewer)) {
        throw new Error('Bondfire not found')
      }
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

// Pin a bondfire to the user's pinned list (max 8).
export const pinBondfire = mutation({
  args: { bondfireId: v.id('bondfires') },
  handler: async (ctx, args) => {
    const userId = await auth.getUserId(ctx)
    if (!userId) throw new Error('Not authenticated')

    const bondfire = await ctx.db.get(args.bondfireId)
    if (!bondfire) throw new Error('Bondfire not found')
    if (bondfire.expiresAt !== undefined && bondfire.expiresAt <= Date.now()) {
      throw new Error('Bondfire not found')
    }
    const viewer = await buildViewerVisibilityContext(ctx, userId)
    const canViewBondfire = await isBondfireVisibleToViewer(ctx, bondfire, viewer)
    if (!canViewBondfire) {
      throw new Error('Bondfire not found')
    }

    const user = await ctx.db.get(userId)
    if (!user) throw new Error('User not found')

    const pinned = user.pinnedBondfireIds ?? []
    if (pinned.includes(args.bondfireId)) {
      return { pinned: true, already: true }
    }
    if (pinned.length >= 8) {
      throw new Error('You can pin up to 8 bondfires')
    }

    await ctx.db.patch(userId, {
      pinnedBondfireIds: [args.bondfireId, ...pinned],
      updatedAt: Date.now(),
    })

    return { pinned: true }
  },
})

// Unpin a bondfire from the user's pinned list.
export const unpinBondfire = mutation({
  args: { bondfireId: v.id('bondfires') },
  handler: async (ctx, args) => {
    const userId = await auth.getUserId(ctx)
    if (!userId) throw new Error('Not authenticated')

    const user = await ctx.db.get(userId)
    if (!user) throw new Error('User not found')

    const pinned = user.pinnedBondfireIds ?? []
    if (!pinned.includes(args.bondfireId)) {
      return { unpinned: true, already: true }
    }

    await ctx.db.patch(userId, {
      pinnedBondfireIds: pinned.filter((id) => id !== args.bondfireId),
      updatedAt: Date.now(),
    })

    return { unpinned: true }
  },
})

// Delete a bondfire (camp or public). Only the creator can delete.
// Cleans up all response videos, live sessions, personal-bondfire
// associations, watch events, and reports.
export const deleteBondfire = mutation({
  args: { bondfireId: v.id('bondfires') },
  handler: async (ctx, args) => {
    const userId = await auth.getUserId(ctx)
    if (!userId) throw new Error('Not authenticated')

    const bondfire = await ctx.db.get(args.bondfireId)
    if (!bondfire) throw new Error('Bondfire not found')
    if (bondfire.expiresAt !== undefined && bondfire.expiresAt <= Date.now()) {
      throw new Error('Bondfire not found')
    }

    if (bondfire.userId !== userId) {
      throw new Error('Only the bondfire creator can delete it')
    }

    // Delete response videos and their live sessions.
    const responses = await ctx.db
      .query('bondfireVideos')
      .withIndex('by_bondfire', (q) => q.eq('bondfireId', args.bondfireId))
      .collect()
    const responseCountsByUser = new Map<Id<'users'>, number>()

    for (const response of responses) {
      responseCountsByUser.set(
        response.userId,
        (responseCountsByUser.get(response.userId) ?? 0) + 1,
      )
      await deleteWatchEventsForVideo(ctx, response._id)

      const responseReports = await ctx.db
        .query('reports')
        .withIndex('by_bondfire_video', (q) => q.eq('bondfireVideoId', response._id))
        .collect()
      for (const report of responseReports) {
        await ctx.db.delete(report._id)
      }

      if (response.liveSessionId) {
        await ctx.db.delete(response.liveSessionId)
      }
      await ctx.db.delete(response._id)
    }

    // Clean up personal-bondfire participants (if this is a personal bondfire).
    if (bondfire.personalCampId) {
      const participants = await ctx.db
        .query('personalBondfireParticipants')
        .withIndex('by_bondfire_status', (q) => q.eq('bondfireId', args.bondfireId))
        .collect()
      for (const p of participants) {
        await ctx.db.delete(p._id)
      }

      const invites = await ctx.db
        .query('inviteCodes')
        .withIndex('by_parent', (q) =>
          q.eq('parentType', 'personal-bondfire').eq('parentId', args.bondfireId),
        )
        .collect()
      for (const inv of invites) {
        await ctx.db.delete(inv._id)
      }
    }

    // Clean up watch events.
    await deleteWatchEventsForVideo(ctx, args.bondfireId)

    // Delete any reports tied to this bondfire.
    const reports = await ctx.db
      .query('reports')
      .filter((q) => q.eq(q.field('bondfireId'), args.bondfireId))
      .collect()
    for (const r of reports) {
      await ctx.db.delete(r._id)
    }

    // Remove from every user's pinned list.
    const creator = await ctx.db.get(bondfire.userId)
    await removeBondfireFromPinnedLists(ctx, args.bondfireId)

    if (bondfire.liveSessionId) {
      await ctx.db.delete(bondfire.liveSessionId)
    }

    await ctx.db.delete(args.bondfireId)

    // Decrement the creator's bondfire count.
    if (creator) {
      await ctx.db.patch(bondfire.userId, {
        bondfireCount: Math.max(0, (creator.bondfireCount ?? 1) - 1),
        updatedAt: Date.now(),
      })
    }

    for (const [responderId, deletedResponseCount] of responseCountsByUser) {
      const responder = await ctx.db.get(responderId)
      if (!responder) {
        continue
      }

      await ctx.db.patch(responderId, {
        responseCount: Math.max(0, (responder.responseCount ?? 0) - deletedResponseCount),
        updatedAt: Date.now(),
      })
    }

    if (bondfire.campId) {
      const camp = await ctx.db.get(bondfire.campId)
      if (camp) {
        await ctx.db.patch(bondfire.campId, {
          bondfireCount: Math.max(0, (camp.bondfireCount ?? 0) - 1),
          updatedAt: Date.now(),
        })
      }
    }

    return { deleted: true }
  },
})

import { paginationOptsValidator } from 'convex/server'
import { v } from 'convex/values'
import { internal } from './_generated/api'
import type { Doc, Id } from './_generated/dataModel'
import type { MutationCtx, QueryCtx } from './_generated/server'
import { action, internalMutation, internalQuery, mutation, query } from './_generated/server'
import { enforceWatchEventLimit } from './abuseLimits'
import { assertUserCanAccessCamp } from './agePolicy'
import { auth } from './auth'
import {
  buildViewerVisibilityContext,
  ensureViewerCampMembership,
  filterVisibleBondfiresForViewer,
  isBondfireVisibleToViewer,
  isCampContentVisibleToViewer,
  isUserContentVisibleToViewer,
  type ViewerVisibilityContext,
} from './bondfireVisibility'
import { isCampParticipableStatus } from './campLifecycle'
import { initialModerationStatus, requireUgcPermission } from './contentSafety'
import {
  assertCanCreateBondfire,
  assertVideoDurationWithinTierLimit,
  getPrivateCampExpiresAt,
} from './entitlements'
import { throwUserError } from './errors'
import { deleteBondfireInviteArtifacts } from './inviteArtifacts'
import { addInviteBadgesToBondfires } from './inviteBadges'
import { getLatestResponsePlayback } from './lib/latestResponsePlayback'
import { boundedInteger, boundedScanSize } from './lib/queryBounds'
import { incrementProfileViews } from './watchEvents'

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

const DEFAULT_FEED_LIMIT = 20
const MAX_FEED_LIMIT = 50
const MAX_CLEANUP_LIMIT = 100

export function normalizeFeedLimit(limit: number | undefined) {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_FEED_LIMIT
  return Math.min(Math.max(Math.trunc(limit), 1), MAX_FEED_LIMIT)
}

export function normalizeCleanupLimit(limit: number | undefined) {
  if (limit === undefined || !Number.isFinite(limit)) return MAX_CLEANUP_LIMIT
  return Math.min(Math.max(Math.trunc(limit), 1), MAX_CLEANUP_LIMIT)
}
const FEED_PAGE_DEFAULT = 20
const FEED_PAGE_MAX = 50
const FEED_VISIBILITY_SCAN_MULTIPLIER = 3
const FEED_VISIBILITY_SCAN_MAX = 150

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
  // A pending response is only an eagerly provisioned recording session. It
  // has not been counted into the thread and should not appear as either a
  // playable video or an in-flight processing response.
  if (status === 'pending' || status === 'errored' || status === 'awaiting_recovery') {
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
  if (
    status === 'pending' ||
    status === 'processing' ||
    status === 'errored' ||
    status === 'awaiting_recovery'
  ) {
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

async function getThreadParticipants(
  ctx: QueryCtx,
  bondfire: Doc<'bondfires'>,
  viewer: ViewerVisibilityContext,
) {
  const userId = viewer.userId
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
    if (!(await isUserContentVisibleToViewer(ctx, video.userId, viewer))) continue
    if (
      video.moderationStatus === 'removed' ||
      (video.moderationStatus === 'pending_review' &&
        viewer.userId !== video.userId &&
        !viewer.isAdmin)
    ) {
      continue
    }
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

async function decorateFeedPage(ctx: QueryCtx, bondfires: Doc<'bondfires'>[], limit?: number) {
  const userId = await auth.getUserId(ctx)
  const viewer = await buildViewerVisibilityContext(ctx, userId)
  const visibleBondfires = await filterVisibleBondfiresForViewer(
    ctx,
    bondfires.filter(isPlayableVideoRecord),
    viewer,
  )
  const selectedBondfires =
    limit === undefined ? visibleBondfires : visibleBondfires.slice(0, limit)
  const withCampLabels = await Promise.all(
    selectedBondfires.map(async (bondfire) => {
      const [campLabel, latestResponse] = await Promise.all([
        resolveCampLabel(ctx, bondfire),
        getLatestResponsePlayback(ctx, bondfire._id, viewer),
      ])
      return {
        ...withLiveFlags(bondfire),
        campLabel,
        latestResponseBondfireVideoId: latestResponse?.bondfireVideoId,
        latestResponseMuxPlaybackId: latestResponse?.muxPlaybackId,
        latestResponseMuxPlaybackPolicy: latestResponse?.muxPlaybackPolicy,
      }
    }),
  )
  return await addInviteBadgesToBondfires(ctx, userId, withCampLabels)
}

/** Cursor-based discovery feed for current clients. */
export const listFeedPage = query({
  args: { paginationOpts: paginationOptsValidator },
  handler: async (ctx, args) => {
    const requested = boundedInteger(args.paginationOpts.numItems, {
      defaultValue: FEED_PAGE_DEFAULT,
      min: 1,
      max: FEED_PAGE_MAX,
      name: 'paginationOpts.numItems',
    })
    const scanSize = boundedScanSize(
      requested,
      FEED_VISIBILITY_SCAN_MULTIPLIER,
      FEED_VISIBILITY_SCAN_MAX,
    )
    const result = await ctx.db
      .query('bondfires')
      .withIndex('by_video_count')
      .order('asc')
      .paginate({
        ...args.paginationOpts,
        numItems: scanSize,
        maximumRowsRead: FEED_VISIBILITY_SCAN_MAX,
        maximumBytesRead: 2_000_000,
      })

    return { ...result, page: await decorateFeedPage(ctx, result.page) }
  },
})

/**
 * Backward-compatible array wrapper for installed clients. The historical
 * cursor is now honored, and both its requested result and scan are capped.
 */
export const listFeed = query({
  args: {
    limit: v.optional(v.number()),
    cursor: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const limit = normalizeFeedLimit(args.limit)
    const result = await ctx.db
      .query('bondfires')
      .withIndex('by_video_count')
      .order('asc')
      .paginate({
        cursor: args.cursor ?? null,
        numItems: boundedScanSize(limit, FEED_VISIBILITY_SCAN_MULTIPLIER, FEED_VISIBILITY_SCAN_MAX),
        maximumRowsRead: FEED_VISIBILITY_SCAN_MAX,
        maximumBytesRead: 2_000_000,
      })
    return await decorateFeedPage(ctx, result.page, limit)
  },
})

export const listByCamp = query({
  args: {
    campId: v.id('camps'),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = normalizeFeedLimit(args.limit)
    const camp = await ctx.db.get(args.campId)
    if (!camp) {
      return []
    }

    const userId = await auth.getUserId(ctx)
    const viewer = await buildViewerVisibilityContext(ctx, userId)
    await ensureViewerCampMembership(ctx, viewer, camp._id)
    if (!isCampContentVisibleToViewer(camp, viewer)) {
      return []
    }

    const bondfires = await ctx.db
      .query('bondfires')
      .withIndex('by_camp', (q) => q.eq('campId', args.campId))
      .order('desc')
      .take(boundedScanSize(limit, FEED_VISIBILITY_SCAN_MULTIPLIER, FEED_VISIBILITY_SCAN_MAX))

    const filtered = (
      await filterVisibleBondfiresForViewer(ctx, bondfires.filter(isPlayableVideoRecord), viewer)
    ).slice(0, limit)

    const withCampLabels = await Promise.all(
      filtered.map(async (bondfire) => {
        const latestResponse = await getLatestResponsePlayback(ctx, bondfire._id, viewer)
        return {
          ...withLiveFlags(bondfire),
          campLabel: camp.name,
          latestResponseBondfireVideoId: latestResponse?.bondfireVideoId,
          latestResponseMuxPlaybackId: latestResponse?.muxPlaybackId,
          latestResponseMuxPlaybackPolicy: latestResponse?.muxPlaybackPolicy,
        }
      }),
    )

    return await addInviteBadgesToBondfires(ctx, userId, withCampLabels)
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

    const viewerId = await auth.getUserId(ctx)
    const viewer = await buildViewerVisibilityContext(ctx, viewerId)
    if (
      !(await isBondfireVisibleToViewer(ctx, bondfire, viewer, {
        allowAdminModerationReview: true,
      }))
    ) {
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

    const viewerId = await auth.getUserId(ctx)
    const viewer = await buildViewerVisibilityContext(ctx, viewerId)
    if (
      !(await isBondfireVisibleToViewer(ctx, bondfire, viewer, {
        allowAdminModerationReview: true,
      }))
    ) {
      return null
    }

    if (!bondfire.campId) {
      return {
        bondfire,
        camp: null,
        membership: null,
        hasInviteClaim: false,
        canInvite: bondfire.userId === (await auth.getUserId(ctx)),
      }
    }

    const campId = bondfire.campId
    const camp = await ctx.db.get(campId)
    const userId = (await auth.getUserId(ctx)) ?? undefined

    let membership = null
    let hasInviteClaim = false
    if (userId) {
      const m = await ctx.db
        .query('campMembers')
        .withIndex('by_user_camp', (q) => q.eq('userId', userId).eq('campId', campId))
        .unique()
      membership = m

      const inviteClaim = await ctx.db
        .query('inviteClaims')
        .withIndex('by_bondfire_claimer', (q) =>
          q.eq('bondfireId', bondfire._id).eq('claimerId', userId),
        )
        .first()
      hasInviteClaim = inviteClaim !== null
    }

    const isCreator = bondfire.userId === userId
    const isOwnerOrMod = membership?.role === 'owner' || membership?.role === 'moderator'
    const isPublicCamp = camp?.access === 'open'
    const isActiveMember = membership?.status === 'active'

    const canInvite = isCreator || isOwnerOrMod || (isPublicCamp && isActiveMember)

    return { bondfire, camp, membership, hasInviteClaim, canInvite }
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

    const viewerId = await auth.getUserId(ctx)
    const viewer = await buildViewerVisibilityContext(ctx, viewerId)
    if (
      !(await isBondfireVisibleToViewer(ctx, bondfire, viewer, {
        allowAdminModerationReview: true,
      }))
    ) {
      return null
    }
    const camp = bondfire.campId ? await ctx.db.get(bondfire.campId) : null
    const campName = await resolveCampLabel(ctx, bondfire)

    const videos = await ctx.db
      .query('bondfireVideos')
      .withIndex('by_bondfire', (q) => q.eq('bondfireId', args.bondfireId))
      .order('asc')
      .collect()

    const responseVisibility = await Promise.all(
      videos.map(async (video) => {
        if (!(await isUserContentVisibleToViewer(ctx, video.userId, viewer))) return false
        return !(
          video.moderationStatus === 'removed' ||
          (video.moderationStatus === 'pending_review' &&
            viewerId !== video.userId &&
            !viewer.isAdmin)
        )
      }),
    )
    const visibleVideos = videos.filter((_, index) => responseVisibility[index])

    // Watched flags drive the initial scroll position (first unwatched video).
    // The viewer's own videos always count as watched.
    const hasWatchEvent = async (videoId: string) => {
      if (!viewerId) return false
      const event = await ctx.db
        .query('watchEvents')
        .withIndex('by_user_video', (q) => q.eq('userId', viewerId).eq('videoId', videoId))
        .first()
      return event !== null
    }

    const playableVideos = visibleVideos.filter(isPlayableVideoRecord)
    const [mainWatched, ...videosWatched] = await Promise.all([
      bondfire.userId === viewerId ? true : hasWatchEvent(bondfire._id),
      ...playableVideos.map((video) =>
        video.userId === viewerId ? true : hasWatchEvent(video._id),
      ),
    ])

    const readyVideos = playableVideos.map((video, index) => ({
      ...withLiveFlags(video),
      watchedByViewer: videosWatched[index],
    }))

    // Lightweight projection only — no Mux IDs leak for unfinished videos.
    const processingResponses = visibleVideos.filter(isProcessingVideoRecord).map((video) => ({
      _id: video._id,
      userId: video.userId,
      creatorName: video.creatorName,
      createdAt: video.createdAt,
    }))

    return {
      ...withLiveFlags(bondfire),
      watchedByViewer: mainWatched,
      campStatus: camp?.status,
      campName,
      videos: readyVideos,
      processingResponses,
      participants: await getThreadParticipants(ctx, bondfire, viewer),
    }
  },
})

/**
 * Diagnose why `getWithVideos` returned null for a bondfire. Read-only, mirrors
 * the exact null branches in `getWithVideos`. The detail screen calls this when
 * it hits the unavailable state so the precise reason lands in telemetry —
 * critical for root-causing user reports of recently-recorded bondfires that
 * show "isn't available".
 */
export const getUnavailableReason = query({
  args: { bondfireId: v.id('bondfires') },
  handler: async (ctx, args) => {
    const bondfire = await ctx.db.get(args.bondfireId)
    if (!bondfire) {
      return { reason: 'deleted' as const, videoStatus: undefined }
    }
    if (bondfire.expiresAt !== undefined && bondfire.expiresAt <= Date.now()) {
      return { reason: 'expired' as const, videoStatus: bondfire.videoStatus }
    }
    if (!isDetailVisibleVideoRecord(bondfire)) {
      return { reason: 'video_unavailable' as const, videoStatus: bondfire.videoStatus }
    }
    const [visible] = await filterVisibleBondfires(ctx, [bondfire])
    if (!visible) {
      return { reason: 'access_filtered' as const, videoStatus: bondfire.videoStatus }
    }
    // Resolves fine now — the null was a transient read/connect race.
    return { reason: 'available' as const, videoStatus: bondfire.videoStatus }
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

    return await ctx.runAction(internal.videos.cleanupExpiredPrivateCampVideos, {
      dryRun: args.dryRun,
      limit: normalizeCleanupLimit(args.limit),
    })
  },
})

// Create a new bondfire
// Legacy record attachment is internal-only: clients must use videos.createMuxDirectUpload,
// which creates the pending row before Mux asset identifiers can be attached.
export const create = internalMutation({
  args: {
    userId: v.id('users'),
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
    const userId = args.userId

    const user = await ctx.db.get(userId)
    const now = Date.now()
    if (!user) {
      throwUserError('User not found')
    }
    await requireUgcPermission(ctx, userId)

    if (!args.muxAssetId || !args.muxPlaybackId) {
      if (args.videoStatus !== 'pending') {
        throwUserError('Mux asset ID and playback ID are required for Mux videos')
      }
      // Pending bondfires don't require Mux asset IDs yet; fall through.
    }

    if (!args.campId) {
      throwUserError('Choose a camp before sparking a Bondfire')
    }
    const campId = args.campId

    const camp = await ctx.db.get(campId)
    if (!camp || !isCampParticipableStatus(camp.status)) {
      throwUserError('Camp not found')
    }
    assertUserCanAccessCamp(user, camp)

    const membership = await ctx.db
      .query('campMembers')
      .withIndex('by_user_camp', (q) => q.eq('userId', userId).eq('campId', campId))
      .first()
    if (membership?.status !== 'active') {
      throwUserError('Join this camp before sparking here')
    }

    if (camp.access === 'invite' && camp.ownerId !== userId) {
      throwUserError('Only the private camp owner can spark here')
    }

    const campGender = camp.rules?.access?.gender?.value
    if (campGender && campGender !== 'any' && user.gender !== campGender) {
      throwUserError('This camp is limited to members who match its gender setting')
    }

    if (
      camp.rules?.participation?.maxDurationMs &&
      args.durationMs &&
      args.durationMs > camp.rules.participation.maxDurationMs
    ) {
      throwUserError('This recording is longer than the camp allows')
    }

    // Enforce tier-based video duration limit.
    await assertVideoDurationWithinTierLimit(ctx, userId, args.durationMs)

    // Enforce tier-based Bondfire creation permission (Free cannot create).
    const tier = await assertCanCreateBondfire(ctx, userId)
    const allowedTiers = camp.rules?.access?.allowedTiers?.value
    if (allowedTiers && allowedTiers.length > 0) {
      if (!allowedTiers.includes(tier)) {
        throwUserError('Your membership tier cannot spark in this camp')
      }
    }

    if (camp.rules?.advisory?.requiresTradeTags) {
      const tags = args.tags ?? []
      if (!tags.includes('need') && !tags.includes('offer')) {
        throwUserError('The Trading Post requires a need or offer tag')
      }
    }

    if (camp.access === 'invite' && args.muxPlaybackPolicy !== 'signed') {
      throwUserError('Private camp videos must use signed Mux playback')
    }

    const bondfireId = await ctx.db.insert('bondfires', {
      userId,
      creatorName: user?.displayName ?? user?.name,
      campId,
      moderationStatus: initialModerationStatus(camp, false),
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

// Update a bondfire's title. Owner-only; called from the post-record
// completion screen where the user can edit the pre-filled default title.
export const updateTitle = mutation({
  args: {
    bondfireId: v.id('bondfires'),
    title: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = await auth.getUserId(ctx)
    if (!userId) {
      throw new Error('Not authenticated')
    }

    const bondfire = await ctx.db.get(args.bondfireId)
    if (!bondfire) {
      throw new Error('Bondfire not found')
    }
    if (bondfire.userId !== userId) {
      throw new Error('Not authorized to edit this bondfire')
    }
    await requireUgcPermission(ctx, userId)

    if (bondfire.campId) {
      const camp = await ctx.db.get(bondfire.campId)
      if (
        camp &&
        (camp.access === 'open' || camp.access === 'approval') &&
        bondfire.moderationStatus !== 'pending_review'
      ) {
        throwUserError('A public Bondfire title cannot be edited after moderation approval.')
      }
    }

    const trimmed = args.title.trim().slice(0, 80)
    // Empty titles fall back to a sensible default rather than clearing the field.
    const title =
      trimmed || (bondfire.creatorName ? `${bondfire.creatorName}'s Bondfire` : 'My Bondfire')

    await ctx.db.patch(args.bondfireId, { title, updatedAt: Date.now() })
    return { title }
  },
})

// Backward-compatible view endpoint for older app builds. Current builds record
// starts through watchEvents.record so response plays can be attributed too.
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

    const viewer = await buildViewerVisibilityContext(ctx, viewerId)
    if (!(await isBondfireVisibleToViewer(ctx, bondfire, viewer))) {
      throw new Error('Bondfire not found')
    }

    if (bondfire.userId === viewerId) {
      return { recorded: false, reason: 'own_video' }
    }

    await enforceWatchEventLimit(ctx, viewerId)
    const existingStart = await ctx.db
      .query('watchEvents')
      .withIndex('by_user_video_event', (q) =>
        q.eq('userId', viewerId).eq('videoId', args.bondfireId).eq('eventType', 'start'),
      )
      .first()
    if (existingStart) return { recorded: false, reason: 'duplicate' }

    const now = Date.now()
    const result = await incrementProfileViews(
      ctx,
      { videoType: 'bondfire', videoId: args.bondfireId, eventType: 'start' },
      viewerId,
    )
    if (!result.counted) {
      return { recorded: false, reason: 'creator_not_found' }
    }

    await ctx.db.insert('watchEvents', {
      userId: viewerId,
      videoType: 'bondfire',
      videoId: args.bondfireId,
      eventType: 'start',
      positionMs: 0,
      durationMs: bondfire.durationMs,
      createdAt: now,
    })

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
    const existingPinned = await Promise.all(pinned.map((id) => ctx.db.get(id)))
    const validPinned = pinned.filter((_, index) => existingPinned[index] !== null)
    if (validPinned.includes(args.bondfireId)) {
      return { pinned: true, already: true }
    }
    if (validPinned.length >= 8) {
      throw new Error('You can pin up to 8 bondfires')
    }

    await ctx.db.patch(userId, {
      pinnedBondfireIds: [args.bondfireId, ...validPinned],
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
    }

    await deleteBondfireInviteArtifacts(ctx, args.bondfireId)

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

    // Deleted pin ids are pruned lazily the next time each user pins a fire.
    const creator = await ctx.db.get(bondfire.userId)
    // Pinned ids are capped at eight per user and are pruned lazily by
    // pinBondfire. Avoid a full users-table scan on every deletion.

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

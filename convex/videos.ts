import { v } from 'convex/values'
import { internal } from './_generated/api'
import type { Doc, Id } from './_generated/dataModel'
import type { ActionCtx, MutationCtx, QueryCtx } from './_generated/server'
import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from './_generated/server'
import { assertUserCanAccessCamp } from './agePolicy'
import { auth } from './auth'
import {
  buildViewerVisibilityContext,
  isBondfireVisibleToViewer,
  isUserContentVisibleToViewer,
} from './bondfireVisibility'
import { isCampParticipableStatus } from './campLifecycle'
import {
  initialModerationStatus,
  isModeratedContentVisible,
  requireUgcPermission,
} from './contentSafety'
import {
  assertCanCreateBondfire,
  assertVideoDurationWithinTierLimit,
  getEntitlementSubscriptionTier,
  getPrivateCampExpiresAt,
  PAID_TIERS,
} from './entitlements'
import { throwUserError } from './errors'
import { deleteBondfireInviteArtifacts } from './inviteArtifacts'
import { cancelSegmentMedia } from './lib/segmentMediaCleanup'
import { canResumeUnrecordedDraft, isPlayableVideoRecord } from './lib/videoLifecycle'
import { importedUrls } from './mediaImports'
import {
  assertCanRespondToPersonalBondfire,
  getPersonalCampForOwner,
} from './personalBondfireAccess'
import { enqueueRetentionMedia } from './retentionMedia'
import { assertUsersMayInteract } from './userSafety'

type PlaybackPolicy = 'public' | 'signed'

type ExpiredPrivateCampVideoCleanupBatch = {
  bondfireIds: Array<Id<'bondfires'>>
  muxAssetIds: string[]
  expiredBondfires: number
  remainingMayExist: boolean
}

type ExpiredPrivateCampVideoCleanupResult = {
  expiredBondfires?: number
  muxAssetsToDelete?: number
  deletedBondfires?: number
  deletedResponses?: number
  remainingMayExist: boolean
}

const MAX_VIDEO_DIMENSION_PX = 16_384

const MAX_VIDEO_TAGS = 20

const MAX_VIDEO_TAG_LENGTH = 64

export function assertClientMediaMetadataBounds(args: {
  width?: number
  height?: number
  tags?: string[]
}) {
  for (const [name, value] of [
    ['width', args.width],
    ['height', args.height],
  ] as const) {
    if (
      value !== undefined &&
      (!Number.isInteger(value) || value < 1 || value > MAX_VIDEO_DIMENSION_PX)
    ) {
      throwUserError(`Video ${name} is invalid`)
    }
  }
  if (
    args.tags &&
    (args.tags.length > MAX_VIDEO_TAGS ||
      args.tags.some((tag) => tag.length < 1 || tag.length > MAX_VIDEO_TAG_LENGTH))
  ) {
    throwUserError('Video tags are invalid')
  }
}

function assertDurationWithinCampRules(camp: Doc<'camps'>, durationMs: number | undefined) {
  if (durationMs === undefined) {
    return
  }

  const maxDurationMs = camp.rules?.participation?.maxDurationMs
  if (maxDurationMs && durationMs > maxDurationMs) {
    throwUserError('This recording is longer than the camp allows')
  }
}

async function assertCanCreateInCamp(
  ctx: QueryCtx | MutationCtx,
  args: {
    userId: Id<'users'>
    campId: Id<'camps'>
    durationMs?: number
    tags?: string[]
  },
) {
  return await assertUserCanParticipateInCamp(ctx, { ...args, operation: 'spark' })
}

async function assertCanCreatePersonalBondfire(
  ctx: QueryCtx | MutationCtx,
  args: {
    userId: Id<'users'>
    durationMs?: number
  },
) {
  await requireUgcPermission(ctx, args.userId)
  await assertVideoDurationWithinTierLimit(ctx, args.userId, args.durationMs)

  const tier = await getEntitlementSubscriptionTier(ctx, args.userId)
  if (!PAID_TIERS.includes(tier)) {
    throwUserError('A Hearth requires a Plus, Premium, or Pro subscription.')
  }

  const owner = await ctx.db.get(args.userId)
  if (!owner) throwUserError('User not found')
  const personalCamp = await getPersonalCampForOwner(ctx, owner)

  if (!personalCamp) {
    throwUserError('Hearth not found. Subscribe to Plus, Premium, or Pro to create one.')
  }

  if (personalCamp.status !== 'active') {
    throwUserError('Your hearth is currently frozen. Please re-subscribe to reactivate it.')
  }

  return personalCamp
}

export async function assertCanViewBondfire(
  ctx: QueryCtx,
  args: { userId: Id<'users'> | null; bondfire: Doc<'bondfires'> },
) {
  const viewer = await buildViewerVisibilityContext(ctx, args.userId)
  if (
    !(await isBondfireVisibleToViewer(ctx, args.bondfire, viewer, {
      allowAdminModerationReview: true,
    }))
  ) {
    throwUserError('Bondfire not found')
  }
}

export async function assertCanViewResponse(
  ctx: QueryCtx,
  args: {
    userId: Id<'users'> | null
    bondfire: Doc<'bondfires'>
    response: Doc<'bondfireVideos'>
  },
) {
  const viewer = await buildViewerVisibilityContext(ctx, args.userId)
  if (
    !(await isBondfireVisibleToViewer(ctx, args.bondfire, viewer, {
      allowAdminModerationReview: true,
    })) ||
    !(await isUserContentVisibleToViewer(ctx, args.response.userId, viewer)) ||
    !isModeratedContentVisible(args.response.moderationStatus, {
      isOwner: args.userId === args.response.userId,
      isAdmin: viewer.isAdmin,
    })
  ) {
    throwUserError('Video not found')
  }
}

async function assertUserCanParticipateInCamp(
  ctx: QueryCtx | MutationCtx,
  args: {
    userId: Id<'users'>
    campId: Id<'camps'>
    operation: 'spark' | 'response'
    durationMs?: number
    tags?: string[]
  },
): Promise<Doc<'camps'>> {
  await requireUgcPermission(ctx, args.userId)
  const [user, camp] = await Promise.all([ctx.db.get(args.userId), ctx.db.get(args.campId)])
  if (!user) {
    throwUserError('User not found')
  }
  if (!camp || !isCampParticipableStatus(camp.status)) {
    throwUserError('Camp not found')
  }
  assertUserCanAccessCamp(user, camp)

  const membership = await ctx.db
    .query('campMembers')
    .withIndex('by_user_camp', (q) => q.eq('userId', args.userId).eq('campId', args.campId))
    .first()

  if (membership?.status !== 'active') {
    throwUserError('Join this camp before sparking here')
  }

  if (args.operation === 'spark' && camp.access === 'invite' && camp.ownerId !== args.userId) {
    throwUserError('Only the private camp owner can spark here')
  }

  const campGender = camp.rules?.access?.gender?.value
  if (campGender && campGender !== 'any' && user.gender !== campGender) {
    throwUserError('This camp is limited to members who match its gender setting')
  }

  assertDurationWithinCampRules(camp, args.durationMs)

  const allowedTiers = camp.rules?.access?.allowedTiers?.value
  if (args.operation === 'spark' && allowedTiers && allowedTiers.length > 0) {
    const tier = await getEntitlementSubscriptionTier(ctx, args.userId)
    if (!allowedTiers.includes(tier)) {
      throwUserError('Your membership tier cannot spark in this camp')
    }
  }

  if (args.operation === 'spark') {
    await assertCanCreateBondfire(ctx, args.userId)
    await assertVideoDurationWithinTierLimit(ctx, args.userId, args.durationMs)
  }

  if (args.operation === 'spark' && camp.rules?.advisory?.requiresTradeTags) {
    const tags = args.tags ?? []
    if (!tags.includes('need') && !tags.includes('offer')) {
      throwUserError('The Trading Post requires a need or offer tag')
    }
  }

  return camp
}

async function assertCanRespondToBondfire(
  ctx: QueryCtx | MutationCtx,
  args: {
    userId: Id<'users'>
    bondfireId: Id<'bondfires'>
    durationMs?: number
  },
): Promise<Doc<'bondfires'>> {
  await requireUgcPermission(ctx, args.userId)
  const bondfire = await ctx.db.get(args.bondfireId)
  if (!bondfire) {
    throwUserError('Bondfire not found')
  }
  if (bondfire.expiresAt !== undefined && bondfire.expiresAt <= Date.now()) {
    throwUserError('Bondfire not found')
  }
  await assertUsersMayInteract(ctx, args.userId, bondfire.userId)

  await assertVideoDurationWithinTierLimit(ctx, args.userId, args.durationMs)

  if (bondfire.personalCampId) {
    await assertCanRespondToPersonalBondfire(ctx, {
      bondfire,
      userId: args.userId,
    })
    return bondfire
  }

  if (!bondfire.campId) {
    return bondfire
  }

  const camp = await assertUserCanParticipateInCamp(ctx, {
    userId: args.userId,
    campId: bondfire.campId,
    operation: 'response',
    durationMs: args.durationMs,
  })

  const maxResponses = camp.rules?.participation?.maxResponses
  if (maxResponses !== undefined) {
    const existingVideos = await ctx.db
      .query('bondfireVideos')
      .withIndex('by_bondfire', (q) => q.eq('bondfireId', args.bondfireId))
      .collect()
    const activeResponses = existingVideos.filter((video) => video.videoStatus !== 'errored')
    if (activeResponses.length >= maxResponses) {
      throwUserError('This Bondfire already has the maximum number of responses')
    }
  }

  return bondfire
}

export const isUserAdmin = internalQuery({
  args: {
    userId: v.id('users'),
  },
  handler: async (ctx, args) => {
    const user = await ctx.db.get(args.userId)
    return user?.isAdmin === true
  },
})

export const listExpiredPrivateCampVideoCleanupBatch = internalQuery({
  args: {
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<ExpiredPrivateCampVideoCleanupBatch> => {
    const now = Date.now()
    const limit = args.limit ?? 100
    const expiredBondfires = await ctx.db
      .query('bondfires')
      .withIndex('by_expires_at', (q) => q.gt('expiresAt', 0).lte('expiresAt', now))
      .take(limit)
    const muxAssetIds = new Set<string>()

    for (const bondfire of expiredBondfires) {
      if (bondfire.muxAssetId) {
        muxAssetIds.add(bondfire.muxAssetId)
      }

      const responses = await ctx.db
        .query('bondfireVideos')
        .withIndex('by_bondfire', (q) => q.eq('bondfireId', bondfire._id))
        .collect()

      for (const response of responses) {
        if (response.muxAssetId) {
          muxAssetIds.add(response.muxAssetId)
        }
      }
    }

    return {
      bondfireIds: expiredBondfires.map((bondfire) => bondfire._id),
      muxAssetIds: [...muxAssetIds],
      expiredBondfires: expiredBondfires.length,
      remainingMayExist: expiredBondfires.length === limit,
    }
  },
})

export const deleteExpiredPrivateCampVideoRecords = internalMutation({
  args: {
    bondfireIds: v.array(v.id('bondfires')),
  },
  handler: async (ctx, args) => {
    const now = Date.now()
    const affectedUsers = new Set<Id<'users'>>()
    const affectedCamps = new Set<Id<'camps'>>()
    let deletedBondfires = 0
    let deletedResponses = 0

    for (const bondfireId of args.bondfireIds) {
      const bondfire = await ctx.db.get(bondfireId)
      if (!bondfire?.expiresAt || bondfire.expiresAt > now) {
        continue
      }

      affectedUsers.add(bondfire.userId)
      if (bondfire.campId) {
        affectedCamps.add(bondfire.campId)
      }

      const responses = await ctx.db
        .query('bondfireVideos')
        .withIndex('by_bondfire', (q) => q.eq('bondfireId', bondfire._id))
        .collect()

      for (const response of responses) {
        affectedUsers.add(response.userId)
        if (response.muxAssetId) await enqueueRetentionMedia(ctx, 'asset', response.muxAssetId)
        await cancelSegmentMedia(ctx, response)
        await ctx.db.delete(response._id)
        deletedResponses += 1
      }

      await deleteBondfireInviteArtifacts(ctx, bondfire._id)
      if (bondfire.muxAssetId) await enqueueRetentionMedia(ctx, 'asset', bondfire.muxAssetId)
      await cancelSegmentMedia(ctx, bondfire)
      await ctx.db.delete(bondfire._id)
      deletedBondfires += 1
    }

    for (const campId of affectedCamps) {
      const campBondfires = await ctx.db
        .query('bondfires')
        .withIndex('by_camp', (q) => q.eq('campId', campId))
        .collect()

      await ctx.db.patch(campId, {
        bondfireCount: campBondfires.filter(isPlayableVideoRecord).length,
        updatedAt: now,
      })
    }

    for (const affectedUserId of affectedUsers) {
      const [userBondfires, userResponses] = await Promise.all([
        ctx.db
          .query('bondfires')
          .withIndex('by_user', (q) => q.eq('userId', affectedUserId))
          .collect(),
        ctx.db
          .query('bondfireVideos')
          .withIndex('by_user', (q) => q.eq('userId', affectedUserId))
          .collect(),
      ])

      await ctx.db.patch(affectedUserId, {
        bondfireCount: userBondfires.filter(isPlayableVideoRecord).length,
        responseCount: userResponses.filter(isPlayableVideoRecord).length,
        updatedAt: now,
      })
    }

    return {
      deletedBondfires,
      deletedResponses,
    }
  },
})

export const cleanupExpiredPrivateCampVideos = internalAction({
  args: {
    dryRun: v.optional(v.boolean()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<ExpiredPrivateCampVideoCleanupResult> => {
    const batch: ExpiredPrivateCampVideoCleanupBatch = await ctx.runQuery(
      internal.videos.listExpiredPrivateCampVideoCleanupBatch,
      { limit: args.limit },
    )

    if (args.dryRun) {
      return {
        expiredBondfires: batch.expiredBondfires,
        muxAssetsToDelete: batch.muxAssetIds.length,
        remainingMayExist: batch.remainingMayExist,
      }
    }

    const deletedRecords: {
      deletedBondfires: number
      deletedResponses: number
    } = await ctx.runMutation(internal.videos.deleteExpiredPrivateCampVideoRecords, {
      bondfireIds: batch.bondfireIds,
    })

    return {
      ...deletedRecords,

      remainingMayExist: batch.remainingMayExist,
    }
  },
})

export const validateCreateCampContext = internalQuery({
  args: {
    userId: v.id('users'),
    campId: v.id('camps'),
    durationMs: v.optional(v.number()),
    tags: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    await assertCanCreateInCamp(ctx, args)
    return { valid: true }
  },
})

export const validateRespondCampContext = internalQuery({
  args: {
    userId: v.id('users'),
    bondfireId: v.id('bondfires'),
    durationMs: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await assertCanRespondToBondfire(ctx, args)
    return { valid: true }
  },
})

export const validateCreateCamp = query({
  args: {
    campId: v.id('camps'),
    durationMs: v.optional(v.number()),
    tags: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    const userId = await auth.getUserId(ctx)
    if (!userId) {
      return { valid: false, error: 'You must have an account to spark a Bondfire' }
    }
    try {
      await assertCanCreateInCamp(ctx, {
        userId,
        campId: args.campId,
        durationMs: args.durationMs,
        tags: args.tags,
      })
      return { valid: true }
    } catch (error) {
      return {
        valid: false,
        error: error instanceof Error ? error.message : 'Cannot spark in this camp',
      }
    }
  },
})

export const validateRespondCamp = query({
  args: {
    bondfireId: v.id('bondfires'),
    durationMs: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const userId = await auth.getUserId(ctx)
    if (!userId) {
      return { valid: false, error: 'You must have an account to respond to a Bondfire' }
    }
    try {
      await assertCanRespondToBondfire(ctx, {
        userId,
        bondfireId: args.bondfireId,
        durationMs: args.durationMs,
      })
      return { valid: true }
    } catch (error) {
      return {
        valid: false,
        error: error instanceof Error ? error.message : 'Cannot respond to this Bondfire',
      }
    }
  },
})

export const validatePersonalCreate = query({
  args: {},
  handler: async (ctx, _args) => {
    const userId = await auth.getUserId(ctx)
    if (!userId) {
      return { valid: false, error: 'You must have an account to spark a Personal Bondfire' }
    }

    try {
      await assertCanCreatePersonalBondfire(ctx, { userId })
      return { valid: true }
    } catch (error) {
      return {
        valid: false,
        error: error instanceof Error ? error.message : 'You cannot create a Personal Bondfire',
      }
    }
  },
})

export const validatePersonalCreateForUser = internalQuery({
  args: {
    userId: v.id('users'),
    durationMs: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await assertCanCreatePersonalBondfire(ctx, args)
    return { valid: true }
  },
})

export type PendingVideoArgs = {
  userId: Id<'users'>
  segmentRecordingId: Id<'segmentRecordings'>
  isResponse: boolean
  bondfireId?: Id<'bondfires'>
  campId?: Id<'camps'>
  personalCamp?: boolean
  tags?: string[]
  playbackPolicy: PlaybackPolicy
  durationMs?: number
  width?: number
  height?: number
  draftBondfireId?: Id<'bondfires'>
}

export async function createPendingVideoRecord(ctx: MutationCtx, args: PendingVideoArgs) {
  assertClientMediaMetadataBounds(args)
  const mediaFields = { segmentRecordingId: args.segmentRecordingId }
  const now = Date.now()
  const user = await ctx.db.get(args.userId)
  if (!user || user.accountDeletionStatus) {
    throwUserError('This account is being deleted')
  }

  if (args.isResponse) {
    if (!args.bondfireId) {
      throwUserError('A bondfire ID is required when creating a pending response upload')
    }

    const bondfire = await assertCanRespondToBondfire(ctx, {
      userId: args.userId,
      bondfireId: args.bondfireId,
      durationMs: args.durationMs,
    })
    const responseCamp = bondfire.campId ? await ctx.db.get(bondfire.campId) : null
    if (bondfire.personalCampId && args.playbackPolicy !== 'signed') {
      throw new Error('Personal fire responses must use signed playback')
    }

    const existingVideos = await ctx.db
      .query('bondfireVideos')
      .withIndex('by_bondfire', (q) => q.eq('bondfireId', args.bondfireId as Id<'bondfires'>))
      .collect()
    const sequenceNumber = existingVideos.length + 1
    const recordId = await ctx.db.insert('bondfireVideos', {
      bondfireId: args.bondfireId,
      userId: args.userId,
      creatorName: user?.displayName ?? user?.name,
      moderationStatus: initialModerationStatus(responseCamp, !!bondfire.personalCampId),
      sequenceNumber,
      videoStatus: 'waiting_for_upload',
      ...mediaFields,
      durationMs: args.durationMs,
      width: args.width,
      height: args.height,
      tags: args.tags,
      expiresAt: bondfire.expiresAt,
      createdAt: now,
    })

    return { recordId, recordType: 'response' as const }
  }

  // Personal camp bondfire creation
  if (args.personalCamp) {
    if (args.playbackPolicy === 'public') {
      throw new Error('Personal fire videos must use signed playback.')
    }

    // When a draft bondfire exists (pre-recording invite flow), activate it
    // instead of creating a new row. Same entitlement gate as fresh creation
    // — the subscription may have lapsed (or the recording may exceed the
    // tier's duration limit) since the draft was created.
    if (args.draftBondfireId) {
      const draft = await ctx.db.get(args.draftBondfireId)
      if (!draft) {
        throwUserError('Draft bondfire not found')
      }
      if (draft.userId !== args.userId) {
        throwUserError('Only the draft owner can activate it.')
      }
      if (!canResumeUnrecordedDraft(draft)) {
        throwUserError('This draft has expired or already has a recording.')
      }
      await assertCanCreatePersonalBondfire(ctx, {
        userId: args.userId,
        durationMs: args.durationMs,
      })

      // draftExpiresAt is intentionally kept: it marks the row as draft-born
      // so cancel/error paths can revert it to 'draft' (see
      // bondfireFailureCleanup.revertBondfireToDraft). Only `status` gates
      // the cleanup cron.
      await ctx.db.patch(args.draftBondfireId, {
        status: 'live',
        videoStatus: 'waiting_for_upload',
        ...mediaFields,
        durationMs: args.durationMs,
        width: args.width,
        height: args.height,
        tags: args.tags,
        updatedAt: now,
      })

      // Drafts don't count toward bondfireCount until they hold a recording.
      await ctx.db.patch(args.userId, {
        bondfireCount: (user?.bondfireCount ?? 0) + 1,
        updatedAt: now,
      })

      return { recordId: args.draftBondfireId, recordType: 'bondfire' as const }
    }

    const personalCamp = await assertCanCreatePersonalBondfire(ctx, {
      userId: args.userId,
      durationMs: args.durationMs,
    })

    const recordId = await ctx.db.insert('bondfires', {
      userId: args.userId,
      creatorName: user?.displayName ?? user?.name,
      moderationStatus: 'approved',
      personalCampId: personalCamp._id,
      frozen: false,
      videoStatus: 'waiting_for_upload',
      ...mediaFields,
      durationMs: args.durationMs,
      width: args.width,
      height: args.height,
      tags: args.tags,
      videoCount: 1,
      viewCount: 0,
      createdAt: now,
      updatedAt: now,
    })

    // Add the owner as a participant.
    await ctx.db.insert('personalBondfireParticipants', {
      bondfireId: recordId,
      userId: args.userId,
      status: 'active',
      joinedAt: now,
      createdAt: now,
      updatedAt: now,
    })

    // Update user's bondfire count.
    await ctx.db.patch(args.userId, {
      bondfireCount: (user?.bondfireCount ?? 0) + 1,
      updatedAt: now,
    })

    return { recordId, recordType: 'bondfire' as const }
  }

  if (!args.campId) {
    throwUserError('Choose a camp before sparking a Bondfire')
  }

  const camp = await assertCanCreateInCamp(ctx, {
    userId: args.userId,
    campId: args.campId,
    durationMs: args.durationMs,
    tags: args.tags,
  })
  const expiresAt = await getPrivateCampExpiresAt(ctx, camp, now)

  const recordId = await ctx.db.insert('bondfires', {
    userId: args.userId,
    creatorName: user?.displayName ?? user?.name,
    moderationStatus: initialModerationStatus(camp, false),
    campId: args.campId,
    frozen: false,
    videoStatus: 'waiting_for_upload',
    ...mediaFields,
    durationMs: args.durationMs,
    width: args.width,
    height: args.height,
    tags: args.tags,
    expiresAt,
    videoCount: 1,
    viewCount: 0,
    createdAt: now,
    updatedAt: now,
  })

  return { recordId, recordType: 'bondfire' as const }
}

// Compatibility endpoint for installed clients. Never provisions or polls retired media.
export const createMuxDirectUpload = action({
  args: {
    filename: v.string(),
    contentType: v.string(),
    isResponse: v.boolean(),
    bondfireId: v.optional(v.id('bondfires')),
    campId: v.optional(v.id('camps')),
    personalCamp: v.optional(v.boolean()),
    tags: v.optional(v.array(v.string())),
    durationMs: v.optional(v.number()),
    width: v.optional(v.number()),
    height: v.optional(v.number()),
    draftBondfireId: v.optional(v.id('bondfires')),
  },
  handler: async (ctx) => {
    if (!(await auth.getUserId(ctx))) throwUserError('Not authenticated')
    throwUserError('Please update Bondfires to use R2 video recording.')
  },
})

// Compatibility endpoint for installed clients. Never provisions or polls retired media.
export const createLiveStream = action({
  args: {
    isResponse: v.boolean(),
    bondfireId: v.optional(v.id('bondfires')),
    campId: v.optional(v.id('camps')),
    personalCamp: v.optional(v.boolean()),
    tags: v.optional(v.array(v.string())),
    width: v.optional(v.number()),
    height: v.optional(v.number()),
    title: v.optional(v.string()),
    pending: v.optional(v.boolean()),
    draftBondfireId: v.optional(v.id('bondfires')),
  },
  handler: async (ctx) => {
    if (!(await auth.getUserId(ctx))) throwUserError('Not authenticated')
    throwUserError('Please update Bondfires to use R2 video recording.')
  },
})

// Compatibility endpoint for installed clients. Never provisions or polls retired media.
export const createLiveBackupDirectUpload = action({
  args: {
    liveSessionId: v.id('liveSessions'),
    filename: v.string(),
    contentType: v.string(),
    durationMs: v.optional(v.number()),
    width: v.optional(v.number()),
    height: v.optional(v.number()),
  },
  handler: async (ctx) => {
    if (!(await auth.getUserId(ctx))) throwUserError('Not authenticated')
    throwUserError('Please update Bondfires to use R2 video recording.')
  },
})

// Compatibility endpoint for installed clients. Never provisions or polls retired media.
export const getMuxUploadStatus = action({
  args: { uploadId: v.string() },
  handler: async (ctx) => {
    if (!(await auth.getUserId(ctx))) throwUserError('Not authenticated')
    throwUserError('Please update Bondfires to use R2 video recording.')
  },
})

// Compatibility endpoint for installed clients. Never provisions or polls retired media.
export const getUploadCompletion = query({
  args: { uploadId: v.string() },
  handler: async (ctx) => {
    if (!(await auth.getUserId(ctx))) throwUserError('Not authenticated')
    throwUserError('Please update Bondfires to use R2 video recording.')
  },
})

// Compatibility endpoint for installed clients. Never provisions or polls retired media.
export const monitorUploadCompletion = mutation({
  args: { uploadId: v.string() },
  handler: async (ctx) => {
    if (!(await auth.getUserId(ctx))) throwUserError('Not authenticated')
    throwUserError('Please update Bondfires to use R2 video recording.')
  },
})

// Compatibility endpoint for installed clients. Never provisions or polls retired media.
export const endLiveStream = action({
  args: {
    liveSessionId: v.id('liveSessions'),
    reason: v.optional(v.string()),
    localBackupAvailable: v.optional(v.boolean()),
  },
  handler: async (ctx) => {
    if (!(await auth.getUserId(ctx))) throwUserError('Not authenticated')
    throwUserError('Please update Bondfires to use R2 video recording.')
  },
})

// Compatibility endpoint for installed clients. Never provisions or polls retired media.
export const getLiveSessionRecordStatus = query({
  args: {
    liveSessionId: v.id('liveSessions'),
  },
  handler: async (ctx) => {
    if (!(await auth.getUserId(ctx))) throwUserError('Not authenticated')
    throwUserError('Please update Bondfires to use R2 video recording.')
  },
})

// Compatibility endpoint for installed clients. Never provisions or polls retired media.
export const cancelLiveStream = action({
  args: {
    liveSessionId: v.id('liveSessions'),
    reason: v.optional(v.string()),
  },
  handler: async (ctx) => {
    if (!(await auth.getUserId(ctx))) throwUserError('Not authenticated')
    throwUserError('Please update Bondfires to use R2 video recording.')
  },
})

// Compatibility endpoint for installed clients. Never provisions or polls retired media.
export const markBondfireLive = mutation({
  args: {
    bondfireId: v.id('bondfires'),
  },
  handler: async (ctx) => {
    if (!(await auth.getUserId(ctx))) throwUserError('Not authenticated')
    throwUserError('Please update Bondfires to use R2 video recording.')
  },
})

// Compatibility endpoint for installed clients. Never provisions or polls retired media.
export const markBondfireVideoLive = mutation({
  args: {
    bondfireVideoId: v.id('bondfireVideos'),
  },
  handler: async (ctx) => {
    if (!(await auth.getUserId(ctx))) throwUserError('Not authenticated')
    throwUserError('Please update Bondfires to use R2 video recording.')
  },
})

// Compatibility endpoint for installed clients. Never provisions or polls retired media.
export const touchLiveSession = mutation({
  args: {
    liveSessionId: v.id('liveSessions'),
  },
  handler: async (ctx) => {
    if (!(await auth.getUserId(ctx))) throwUserError('Not authenticated')
    throwUserError('Please update Bondfires to use R2 video recording.')
  },
})

// Compatibility endpoint for installed clients. Never provisions or polls retired media.
export const confirmLiveSessionLocalBackup = mutation({
  args: {
    liveSessionId: v.id('liveSessions'),
  },
  handler: async (ctx) => {
    if (!(await auth.getUserId(ctx))) throwUserError('Not authenticated')
    throwUserError('Please update Bondfires to use R2 video recording.')
  },
})

// Older clients may still send provider IDs; identity and authorization use the record.
const videoUrlArgs = {
  muxPlaybackId: v.optional(v.string()),
  muxPlaybackPolicy: v.optional(v.union(v.literal('public'), v.literal('signed'))),
  bondfireId: v.optional(v.id('bondfires')),
  bondfireVideoId: v.optional(v.id('bondfireVideos')),
}
type VideoUrlRequest = {
  muxPlaybackId?: string
  muxPlaybackPolicy?: 'public' | 'signed'
  bondfireId?: Id<'bondfires'>
  bondfireVideoId?: Id<'bondfireVideos'>
}
const unavailableUrls = {
  hdUrl: '',
  thumbnailUrl: '',
  previewUrl: '',
  captionsUrl: '',
  expiresIn: 0,
}
async function resolvePlaybackUrls(ctx: ActionCtx, args: VideoUrlRequest) {
  return (await importedUrls(ctx, args)) ?? unavailableUrls
}
export const getVideoUrls = action({ args: videoUrlArgs, handler: resolvePlaybackUrls })
export const getVideoUrlsBatch = action({
  args: { items: v.array(v.object(videoUrlArgs)) },
  handler: async (ctx, { items }) => {
    if (items.length > 100) throwUserError('Too many videos requested')
    return Promise.all(items.map((item) => resolvePlaybackUrls(ctx, item)))
  },
})
async function resolveThumbnailUrl(ctx: ActionCtx, args: VideoUrlRequest) {
  const imported = await importedUrls(ctx, args)
  if (imported) return imported
  // A new native recording has no imported thumbnail. Reuse the spark's
  // imported thumbnail, without scanning old responses for a provider ID.
  if (args.bondfireVideoId && args.bondfireId) {
    return (await importedUrls(ctx, { bondfireId: args.bondfireId })) ?? unavailableUrls
  }
  return unavailableUrls
}
export const getThumbnailUrl = action({ args: videoUrlArgs, handler: resolveThumbnailUrl })
export const getThumbnailUrlsBatch = action({
  args: { items: v.array(v.object(videoUrlArgs)) },
  handler: async (ctx, { items }) => {
    if (items.length > 50) throwUserError('Too many thumbnails requested')
    return Promise.all(items.map((item) => resolveThumbnailUrl(ctx, item)))
  },
})

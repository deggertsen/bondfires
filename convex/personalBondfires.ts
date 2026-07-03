import { v } from 'convex/values'
import { internal } from './_generated/api'
import type { Doc, Id } from './_generated/dataModel'
import type { MutationCtx, QueryCtx } from './_generated/server'
import { mutation, query } from './_generated/server'
import { auth } from './auth'
import {
  assertVideoDurationWithinTierLimit,
  getEntitlementSubscriptionTier,
  PAID_TIERS,
} from './entitlements'
import { throwUserError, withUserFacingErrors } from './errors'
import { generateAndInsertInviteCode, normalizeInviteCode } from './inviteCodes'
import { canViewPersonalBondfire, getPersonalBondfireParticipant } from './personalBondfireAccess'

// ── Constants ──────────────────────────────────────────────────────────────

/** Plus users get 2 participants (sparker + 1), Premium/Pro get 8. */
function getParticipantCap(tier: string): number {
  if (tier === 'premium' || tier === 'pro') {
    return 8
  }
  return 2
}

// ── Helpers ────────────────────────────────────────────────────────────────

async function getCurrentUser(ctx: QueryCtx | MutationCtx) {
  const userId = await auth.getUserId(ctx)
  if (!userId) {
    throwUserError('Not authenticated')
  }

  const user = await ctx.db.get(userId)
  if (!user) {
    throwUserError('User not found')
  }

  return user
}

async function getActiveParticipantCount(
  ctx: QueryCtx | MutationCtx,
  bondfireId: Id<'bondfires'>,
): Promise<number> {
  const participants = await ctx.db
    .query('personalBondfireParticipants')
    .withIndex('by_bondfire_status', (q) => q.eq('bondfireId', bondfireId).eq('status', 'active'))
    .collect()

  return participants.length
}

async function getPersonalBondfireOrThrow(
  ctx: QueryCtx | MutationCtx,
  bondfireId: Id<'bondfires'>,
) {
  const bondfire = await ctx.db.get(bondfireId)
  if (!bondfire) {
    throwUserError('Bondfire not found')
  }

  const personalCampId = bondfire.personalCampId
  if (!personalCampId) {
    throwUserError('This bondfire is not part of a hearth.')
  }

  return { ...bondfire, personalCampId }
}

async function assertPersonalCampActive(
  ctx: QueryCtx | MutationCtx,
  personalCampId: Id<'personalCamps'>,
  message = 'This hearth is currently unavailable.',
) {
  const personalCamp = await ctx.db.get(personalCampId)
  if (!personalCamp || personalCamp.status !== 'active') {
    throwUserError(message)
  }

  return personalCamp
}

// ── Mutations ──────────────────────────────────────────────────────────────

/**
 * Create a bondfire in the current user's hearth.
 * Sets personalCampId instead of campId.
 * Checks the hearth exists and is active.
 */
export const createBondfire = mutation({
  args: {
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
    const user = await getCurrentUser(ctx)
    const now = Date.now()
    await assertVideoDurationWithinTierLimit(ctx, user._id, args.durationMs)

    if (args.muxPlaybackPolicy === 'public') {
      throwUserError('Personal Fire videos must use signed playback.')
    }

    // The user must be on a paid tier.
    const tier = await getEntitlementSubscriptionTier(ctx, user._id)
    if (!PAID_TIERS.includes(tier)) {
      throwUserError('A Hearth requires a Plus, Premium, or Pro subscription.')
    }

    // Find the user's hearth — must exist and be active.
    const personalCamp = await ctx.db
      .query('personalCamps')
      .withIndex('by_owner', (q) => q.eq('ownerId', user._id))
      .first()

    if (!personalCamp) {
      throwUserError('Hearth not found. Subscribe to Plus, Premium, or Pro to create one.')
    }

    if (personalCamp.status !== 'active') {
      throwUserError('Your hearth is currently frozen. Please re-subscribe to reactivate it.')
    }

    // Create the bondfire with personalCampId.
    const bondfireId = await ctx.db.insert('bondfires', {
      userId: user._id,
      creatorName: user.displayName ?? user.name,
      personalCampId: personalCamp._id,
      frozen: false,
      videoStatus: args.videoStatus ?? 'ready',
      muxUploadId: args.muxUploadId,
      muxAssetId: args.muxAssetId,
      muxPlaybackId: args.muxPlaybackId,
      muxPlaybackPolicy: args.muxPlaybackPolicy ?? 'signed',
      muxAssetStatus: args.videoStatus,
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
      bondfireId,
      userId: user._id,
      status: 'active',
      joinedAt: now,
      createdAt: now,
      updatedAt: now,
    })

    // Update user's bondfire count.
    await ctx.db.patch(user._id, {
      bondfireCount: (user.bondfireCount ?? 0) + 1,
      updatedAt: now,
    })

    return bondfireId
  },
})

/**
 * Generate an invite code for a personal bondfire.
 * Only the bondfire owner can create invites.
 * Checks participant cap: Plus=2, Premium/Pro=8.
 * Now delegates to the unified inviteCodes.generateAndInsertInviteCode helper.
 */
export const createInvite = mutation({
  args: {
    bondfireId: v.id('bondfires'),
  },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx)

    const bondfire = await getPersonalBondfireOrThrow(ctx, args.bondfireId)

    // Only the owner can create invites.
    if (bondfire.userId !== user._id) {
      throwUserError('Only the bondfire owner can create invite codes.')
    }

    await assertPersonalCampActive(
      ctx,
      bondfire.personalCampId,
      'Your hearth is currently frozen. Please re-subscribe to reactivate it.',
    )

    // Check participant cap.
    const activeCount = await getActiveParticipantCount(ctx, args.bondfireId)
    const tier = await getEntitlementSubscriptionTier(ctx, user._id)
    if (!PAID_TIERS.includes(tier)) {
      throwUserError('A Hearth requires a Plus, Premium, or Pro subscription.')
    }
    const cap = getParticipantCap(tier)

    if (activeCount >= cap) {
      if (tier === 'plus') {
        throwUserError('Upgrade to Premium or Pro to invite more people to your Hearth.')
      }
      throwUserError('This fire is full.')
    }

    // Delegate to the unified invite code system
    const result = await generateAndInsertInviteCode(ctx, {
      parentType: 'personal-bondfire',
      parentId: args.bondfireId,
      createdBy: user._id,
      expiresInDays: 7,
    })

    return {
      code: result.code,
      expiresAt: result.expiresAt,
      bondfireId: args.bondfireId,
    }
  },
})

/**
 * Redeem an invite code to join a personal bondfire.
 * Validates: code not expired, bondfire exists, cap not reached.
 * Re-joins users who previously left/were removed.
 */
export const redeemInvite = mutation({
  args: {
    code: v.string(),
  },
  handler: (ctx, args) =>
    withUserFacingErrors(
      'personalBondfires.redeemInvite',
      'Something went wrong joining this fire. Please try again.',
      () => redeemInviteHandler(ctx, args.code),
    ),
})

export async function redeemInviteHandler(ctx: MutationCtx, rawCode: string) {
  const user = await getCurrentUser(ctx)
  const now = Date.now()
  const code = normalizeInviteCode(rawCode)

  const unifiedInvite = await ctx.db
    .query('inviteCodes')
    .withIndex('by_code', (q) => q.eq('code', code))
    .first()

  if (!unifiedInvite) {
    throwUserError('Invite not found.')
  }

  if (unifiedInvite.expiresAt !== undefined && unifiedInvite.expiresAt <= now) {
    throwUserError('This invite has expired.')
  }
  if (unifiedInvite.maxUses !== undefined && unifiedInvite.uses >= unifiedInvite.maxUses) {
    throwUserError('This invite has already been used.')
  }
  if (unifiedInvite.parentType !== 'personal-bondfire') {
    throwUserError('Invite not found.')
  }

  const bondfireId = unifiedInvite.parentId as Id<'bondfires'>

  const bondfire = await ctx.db.get(bondfireId)
  if (!bondfire) {
    throwUserError('This fire has ended.')
  }

  if (!bondfire.personalCampId) {
    throwUserError('This bondfire is not part of a hearth.')
  }

  await assertPersonalCampActive(
    ctx,
    bondfire.personalCampId,
    'The hearth is currently unavailable. The owner may have cancelled their subscription.',
  )

  // Check if user is already an active participant.
  const existingParticipant = await getPersonalBondfireParticipant(ctx, {
    bondfireId: bondfire._id,
    userId: user._id,
  })

  if (existingParticipant?.status === 'active') {
    return { bondfireId: bondfire._id, alreadyJoined: true }
  }

  // Check participant cap based on owner's tier.
  const owner = await ctx.db.get(bondfire.userId)
  const ownerTier = owner ? await getEntitlementSubscriptionTier(ctx, owner._id) : 'free'
  const cap = getParticipantCap(ownerTier)
  const activeCount = await getActiveParticipantCount(ctx, bondfire._id)

  if (activeCount >= cap) {
    throwUserError('This fire is full.')
  }

  if (existingParticipant) {
    await ctx.db.patch(existingParticipant._id, {
      status: 'active',
      joinedAt: now,
      leftAt: undefined,
      removedAt: undefined,
      removedBy: undefined,
      updatedAt: now,
    })
  } else {
    await ctx.db.insert('personalBondfireParticipants', {
      bondfireId: bondfire._id,
      userId: user._id,
      status: 'active',
      joinedAt: now,
      createdAt: now,
      updatedAt: now,
    })
  }

  await ctx.db.patch(unifiedInvite._id, { uses: unifiedInvite.uses + 1 })

  // Let the Hearth bondfire's creator know someone joined.
  await ctx.scheduler.runAfter(0, internal.sendNotification.notifyHearthJoin, {
    bondfireId: bondfire._id,
    joinerId: user._id,
    joinerName: user.displayName ?? user.name ?? 'Someone',
  })

  return { bondfireId: bondfire._id, alreadyJoined: false }
}

/**
 * Remove a participant from a personal bondfire.
 * Only the bondfire owner can remove participants.
 * Cannot remove themselves.
 */
export const removeParticipant = mutation({
  args: {
    bondfireId: v.id('bondfires'),
    participantId: v.id('users'),
  },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx)
    const now = Date.now()

    const bondfire = await getPersonalBondfireOrThrow(ctx, args.bondfireId)

    if (bondfire.userId !== user._id) {
      throwUserError('Only the bondfire owner can remove participants.')
    }

    if (args.participantId === user._id) {
      throwUserError('You cannot remove yourself. Use the leave option instead.')
    }

    const participant = await getPersonalBondfireParticipant(ctx, {
      bondfireId: args.bondfireId,
      userId: args.participantId,
    })

    if (!participant) {
      throwUserError('Participant not found in this bondfire.')
    }

    if (participant.status !== 'active') {
      throwUserError('This participant is no longer in this bondfire.')
    }

    await ctx.db.patch(participant._id, {
      status: 'removed',
      removedAt: now,
      removedBy: user._id,
      updatedAt: now,
    })
  },
})

/**
 * Leave a personal bondfire as a participant.
 * Cannot be used by the bondfire owner.
 */
export const leaveBondfire = mutation({
  args: {
    bondfireId: v.id('bondfires'),
  },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx)
    const now = Date.now()

    const bondfire = await getPersonalBondfireOrThrow(ctx, args.bondfireId)

    if (bondfire.userId === user._id) {
      throwUserError('The owner cannot leave their own bondfire. Delete it instead.')
    }

    const participant = await getPersonalBondfireParticipant(ctx, {
      bondfireId: args.bondfireId,
      userId: user._id,
    })

    if (!participant) {
      throwUserError('You are not a participant in this bondfire.')
    }

    if (participant.status !== 'active') {
      throwUserError('You are no longer in this bondfire.')
    }

    await ctx.db.patch(participant._id, {
      status: 'left',
      leftAt: now,
      updatedAt: now,
    })
  },
})

/**
 * Delete a personal bondfire and all associated rows.
 * Only the bondfire owner can delete it.
 */
export const deleteBondfire = mutation({
  args: {
    bondfireId: v.id('bondfires'),
  },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx)

    const bondfire = await getPersonalBondfireOrThrow(ctx, args.bondfireId)

    if (bondfire.userId !== user._id) {
      throwUserError('Only the bondfire owner can delete it.')
    }

    // Delete all participants.
    const participants = await ctx.db
      .query('personalBondfireParticipants')
      .withIndex('by_bondfire_status', (q) => q.eq('bondfireId', args.bondfireId))
      .collect()

    for (const p of participants) {
      await ctx.db.delete(p._id)
    }

    // Delete all invites.
    const invites = await ctx.db
      .query('inviteCodes')
      .withIndex('by_parent', (q) =>
        q.eq('parentType', 'personal-bondfire').eq('parentId', args.bondfireId),
      )
      .collect()

    for (const inv of invites) {
      await ctx.db.delete(inv._id)
    }

    // Delete response videos and their live sessions.
    const responses = await ctx.db
      .query('bondfireVideos')
      .withIndex('by_bondfire', (q) => q.eq('bondfireId', args.bondfireId))
      .collect()

    for (const response of responses) {
      if (response.liveSessionId) {
        await ctx.db.delete(response.liveSessionId)
      }
      await ctx.db.delete(response._id)
    }

    if (bondfire.liveSessionId) {
      await ctx.db.delete(bondfire.liveSessionId)
    }

    // Delete the bondfire itself.
    await ctx.db.delete(args.bondfireId)
    await ctx.db.patch(user._id, {
      bondfireCount: Math.max(0, (user.bondfireCount ?? 1) - 1),
      updatedAt: Date.now(),
    })
  },
})

// ── Queries ────────────────────────────────────────────────────────────────

/**
 * Check if an invite code is valid and return bondfire info.
 * Used by the client before showing the join screen.
 */
export const checkInvite = query({
  args: {
    code: v.string(),
  },
  handler: async (ctx, args) => {
    const code = normalizeInviteCode(args.code)
    const now = Date.now()

    // Check unified inviteCodes table
    const invite = await ctx.db
      .query('inviteCodes')
      .withIndex('by_code', (q) => q.eq('code', code))
      .first()

    if (!invite) {
      return { valid: false, reason: 'not_found' as const }
    }

    if (invite.expiresAt !== undefined && invite.expiresAt <= now) {
      return { valid: false, reason: 'expired' as const }
    }

    if (invite.maxUses !== undefined && invite.uses >= invite.maxUses) {
      return { valid: false, reason: 'used' as const }
    }

    if (invite.parentType !== 'personal-bondfire') {
      return { valid: false, reason: 'not_found' as const }
    }

    const bondfire = await ctx.db.get(invite.parentId as Id<'bondfires'>)
    if (!bondfire) {
      return { valid: false, reason: 'ended' as const }
    }
    if (!bondfire.personalCampId) {
      return { valid: false, reason: 'invalid' as const }
    }
    const personalCamp = await ctx.db.get(bondfire.personalCampId)
    if (!personalCamp || personalCamp.status !== 'active') {
      return { valid: false, reason: 'frozen' as const }
    }
    const activeCount = await getActiveParticipantCount(ctx, bondfire._id)
    const owner = await ctx.db.get(bondfire.userId)
    const ownerTier = owner ? await getEntitlementSubscriptionTier(ctx, owner._id) : 'free'
    const cap = getParticipantCap(ownerTier)
    return {
      valid: true,
      bondfireId: bondfire._id,
      creatorName: bondfire.creatorName,
      participantCount: activeCount,
      cap,
    }
  },
})

/**
 * List bondfires in the current user's hearth.
 */
export const listMyPersonalBondfires = query({
  args: {},
  handler: async (ctx) => {
    const userId = await auth.getUserId(ctx)
    if (!userId) {
      return []
    }

    const personalCamp = await ctx.db
      .query('personalCamps')
      .withIndex('by_owner', (q) => q.eq('ownerId', userId))
      .first()

    if (!personalCamp) {
      return []
    }

    const bondfires = await ctx.db
      .query('bondfires')
      .withIndex('by_personal_camp', (q) => q.eq('personalCampId', personalCamp._id))
      .order('desc')
      .collect()

    return await Promise.all(
      bondfires.map(async (bondfire) => ({
        ...bondfire,
        participantCount: await getActiveParticipantCount(ctx, bondfire._id),
      })),
    )
  },
})

/**
 * List active participants for a personal bondfire.
 */
export const listParticipants = query({
  args: {
    bondfireId: v.id('bondfires'),
  },
  handler: async (ctx, args) => {
    const participants = await ctx.db
      .query('personalBondfireParticipants')
      .withIndex('by_bondfire_status', (q) =>
        q.eq('bondfireId', args.bondfireId).eq('status', 'active'),
      )
      .collect()

    const userId = await auth.getUserId(ctx)
    const bondfire = await getPersonalBondfireOrThrow(ctx, args.bondfireId)
    if (!(await canViewPersonalBondfire(ctx, { bondfire, userId }))) {
      return []
    }

    const raw = await Promise.all(participants.map((p) => ctx.db.get(p.userId)))
    const users = raw.filter((u): u is Doc<'users'> => u !== null)

    return users.map((u) => ({
      _id: u._id,
      displayName: u.displayName,
      name: u.name,
      photoUrl: u.photoUrl,
    }))
  },
})

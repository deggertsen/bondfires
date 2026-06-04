import { v } from 'convex/values'
import type { Doc, Id } from './_generated/dataModel'
import type { MutationCtx, QueryCtx } from './_generated/server'
import { mutation, query } from './_generated/server'
import { auth } from './auth'
import { getEntitlementSubscriptionTier, PAID_TIERS } from './entitlements'
import { throwUserError } from './errors'
import { canViewPersonalBondfire, getPersonalBondfireParticipant } from './personalBondfireAccess'

// ── Constants ──────────────────────────────────────────────────────────────

const INVITE_WORDS = [
  'amber',
  'ash',
  'canyon',
  'cedar',
  'ember',
  'forge',
  'harbor',
  'iron',
  'lantern',
  'mesa',
  'oak',
  'river',
  'signal',
  'stone',
  'summit',
  'trail',
  'valley',
  'watch',
  'aurora',
  'basin',
  'beacon',
  'birch',
  'brook',
  'cairn',
  'cliff',
  'cloud',
  'copper',
  'dawn',
  'drift',
  'field',
  'flint',
  'grove',
  'hearth',
  'hollow',
  'kindle',
  'lake',
  'meadow',
  'moon',
  'pine',
  'ridge',
  'root',
  'spark',
  'spring',
  'star',
  'thicket',
  'timber',
  'willow',
  'wind',
  'blaze',
  'bloom',
  'branch',
  'bright',
  'coast',
  'echo',
  'fern',
  'frost',
  'glade',
  'gold',
  'hill',
  'leaf',
  'maple',
  'mist',
  'north',
  'prairie',
  'rain',
  'shade',
  'shore',
  'silver',
  'south',
  'torch',
  'west',
  'wild',
  'wood',
] as const

const INVITE_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000 // 7 days

/** Plus users get 2 participants (sparker + 1), Premium/Pro get 8. */
function getParticipantCap(tier: string): number {
  if (tier === 'premium' || tier === 'pro') {
    return 8
  }
  return 2
}

// ── Helpers ────────────────────────────────────────────────────────────────

function generateInviteCode(seed: string) {
  let hash = 0
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0
  }

  const first = INVITE_WORDS[hash % INVITE_WORDS.length]
  const second = INVITE_WORDS[Math.floor(hash / INVITE_WORDS.length) % INVITE_WORDS.length]
  const third =
    INVITE_WORDS[
      Math.floor(hash / (INVITE_WORDS.length * INVITE_WORDS.length)) % INVITE_WORDS.length
    ]

  return [first, second, third].join('-')
}

function normalizeInviteCode(code: string) {
  return code.trim().toLowerCase().replace(/\s+/g, '-').replace(/-+/g, '-')
}

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
    throwUserError('This bondfire is not part of a personal camp.')
  }

  return { ...bondfire, personalCampId }
}

async function assertPersonalCampActive(
  ctx: QueryCtx | MutationCtx,
  personalCampId: Id<'personalCamps'>,
  message = 'This personal camp is currently unavailable.',
) {
  const personalCamp = await ctx.db.get(personalCampId)
  if (!personalCamp || personalCamp.status !== 'active') {
    throwUserError(message)
  }

  return personalCamp
}

// ── Mutations ──────────────────────────────────────────────────────────────

/**
 * Create a bondfire in the current user's personal camp.
 * Sets personalCampId instead of campId.
 * Checks the personal camp exists and is active.
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

    if (args.muxPlaybackPolicy === 'public') {
      throwUserError('Personal Fire videos must use signed playback.')
    }

    // The user must be on a paid tier.
    const tier = await getEntitlementSubscriptionTier(ctx, user._id)
    if (!PAID_TIERS.includes(tier)) {
      throwUserError('Personal Camps require a Plus, Premium, or Pro subscription.')
    }

    // Find the user's personal camp — must exist and be active.
    const personalCamp = await ctx.db
      .query('personalCamps')
      .withIndex('by_owner', (q) => q.eq('ownerId', user._id))
      .first()

    if (!personalCamp) {
      throwUserError('Personal camp not found. Subscribe to Plus, Premium, or Pro to create one.')
    }

    if (personalCamp.status !== 'active') {
      throwUserError(
        'Your personal camp is currently frozen. Please re-subscribe to reactivate it.',
      )
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
 */
export const createInvite = mutation({
  args: {
    bondfireId: v.id('bondfires'),
  },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx)
    const now = Date.now()

    const bondfire = await getPersonalBondfireOrThrow(ctx, args.bondfireId)

    // Only the owner can create invites.
    if (bondfire.userId !== user._id) {
      throwUserError('Only the bondfire owner can create invite codes.')
    }

    await assertPersonalCampActive(
      ctx,
      bondfire.personalCampId,
      'Your personal camp is currently frozen. Please re-subscribe to reactivate it.',
    )

    // Check participant cap.
    const activeCount = await getActiveParticipantCount(ctx, args.bondfireId)
    const tier = await getEntitlementSubscriptionTier(ctx, user._id)
    if (!PAID_TIERS.includes(tier)) {
      throwUserError('Personal Camps require a Plus, Premium, or Pro subscription.')
    }
    const cap = getParticipantCap(tier)

    if (activeCount >= cap) {
      if (tier === 'plus') {
        throwUserError('Upgrade to Premium or Pro to invite more people to your Personal Fires.')
      }
      throwUserError('This fire is full.')
    }

    // Generate a unique 3-word code.
    const seed = [args.bondfireId, now].join('-')
    let code = generateInviteCode(seed)
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const existing = await ctx.db
        .query('personalBondfireInvites')
        .withIndex('by_code', (q) => q.eq('code', code))
        .first()
      if (!existing) {
        break
      }
      code = generateInviteCode([seed, String(attempt)].join('-'))
    }

    const finalExisting = await ctx.db
      .query('personalBondfireInvites')
      .withIndex('by_code', (q) => q.eq('code', code))
      .first()
    if (finalExisting) {
      throwUserError('Could not generate a unique invite code. Please try again.')
    }

    const expiresAt = now + INVITE_EXPIRY_MS
    await ctx.db.insert('personalBondfireInvites', {
      bondfireId: args.bondfireId,
      code,
      uses: 0,
      createdBy: user._id,
      expiresAt,
      createdAt: now,
    })

    return {
      code,
      expiresAt,
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
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx)
    const now = Date.now()
    const code = normalizeInviteCode(args.code)

    const invite = await ctx.db
      .query('personalBondfireInvites')
      .withIndex('by_code', (q) => q.eq('code', code))
      .first()

    if (!invite) {
      throwUserError('Invite not found.')
    }

    if (invite.expiresAt !== undefined && invite.expiresAt <= now) {
      throwUserError('This invite has expired.')
    }

    if (invite.maxUses !== undefined && invite.uses >= invite.maxUses) {
      throwUserError('This invite has already been used.')
    }

    const bondfire = await ctx.db.get(invite.bondfireId)
    if (!bondfire) {
      throwUserError('This fire has ended.')
    }

    if (!bondfire.personalCampId) {
      throwUserError('This bondfire is not part of a personal camp.')
    }

    await assertPersonalCampActive(
      ctx,
      bondfire.personalCampId,
      'The personal camp is currently unavailable. The owner may have cancelled their subscription.',
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

    await ctx.db.patch(invite._id, {
      uses: invite.uses + 1,
    })

    return { bondfireId: bondfire._id, alreadyJoined: false }
  },
})

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
      .query('personalBondfireInvites')
      .withIndex('by_bondfire', (q) => q.eq('bondfireId', args.bondfireId))
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

    const invite = await ctx.db
      .query('personalBondfireInvites')
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

    const bondfire = await ctx.db.get(invite.bondfireId)
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
 * List bondfires in the current user's personal camp.
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

    return bondfires
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

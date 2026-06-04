/**
 * Personal Bondfires — bondfires within a user's personal camp.
 *
 * Personal camps are 1:1 per paid user. Bondfires in personal camps use
 * 3-word invite codes for access. Participant caps are enforced per tier:
 *   Plus: 2  |  Premium/Pro: 8
 */
import { v } from 'convex/values'
import type { Id } from './_generated/dataModel'
import type { MutationCtx, QueryCtx } from './_generated/server'
import { mutation, query } from './_generated/server'
import { auth } from './auth'
import { getEntitlementSubscriptionTier, PAID_TIERS } from './entitlements'
import { throwUserError } from './errors'

// ── Constants ──────────────────────────────────────────────────────────────

/** Three-word invite code word list. Must be the same as camps.ts INVITE_WORDS. */
const INVITE_WORDS = [
  'amber', 'ash', 'canyon', 'cedar', 'ember', 'forge',
  'harbor', 'iron', 'lantern', 'mesa', 'oak', 'river',
  'signal', 'stone', 'summit', 'trail', 'valley', 'watch',
] as const

/** Invite codes expire after 7 days. */
const INVITE_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000

/** Participant caps per tier. */
const PARTICIPANT_CAP: Record<string, number> = {
  plus: 2,
  premium: 8,
  pro: 8,
}

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Generate a unique 3-word dash-separated invite code.
 * Collision-resistant via deterministic hash of the seed.
 */
function generateInviteCode(seed: string) {
  let hash = 0
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0
  }

  const first = INVITE_WORDS[hash % INVITE_WORDS.length]
  const second =
    INVITE_WORDS[Math.floor(hash / INVITE_WORDS.length) % INVITE_WORDS.length]
  const third =
    INVITE_WORDS[
      Math.floor(hash / (INVITE_WORDS.length * INVITE_WORDS.length)) %
        INVITE_WORDS.length
    ]

  return [first, second, third].join('-')
}

/** Get the current authenticated user. */
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

/** Count active participants in a personal bondfire. */
async function getActiveParticipantCount(
  ctx: QueryCtx | MutationCtx,
  bondfireId: Id<'bondfires'>,
): Promise<number> {
  const participants = await ctx.db
    .query('personalBondfireParticipants')
    .withIndex('by_bondfire_status', (q) =>
      q.eq('bondfireId', bondfireId).eq('status', 'active'),
    )
    .collect()

  return participants.length
}

/** Get the user's personal camp or throw. */
async function getMyPersonalCamp(ctx: MutationCtx) {
  const user = await getCurrentUser(ctx)

  const camp = await ctx.db
    .query('personalCamps')
    .withIndex('by_owner', (q) => q.eq('ownerId', user._id))
    .first()

  if (!camp) {
    throwUserError(
      'You need a Personal Camp. Subscribe to Plus, Premium, or Pro to get one.',
    )
  }

  if (camp.status === 'frozen') {
    throwUserError(
      'Your Personal Camp is frozen. Subscribe to a paid tier to reactivate it.',
    )
  }

  return camp
}

/** Get the participant cap for the current user's tier. */
async function getParticipantCap(
  ctx: MutationCtx,
  userId: Id<'users'>,
): Promise<number> {
  const tier = await getEntitlementSubscriptionTier(ctx, userId)
  return PARTICIPANT_CAP[tier] ?? 0
}

// ── Queries ────────────────────────────────────────────────────────────────

/**
 * Check an invite code is valid (not expired).
 * Returns bondfire info if the code is good, or throws.
 */
export const checkInvite = query({
  args: {
    code: v.string(),
  },
  handler: async (ctx, args) => {
    const invite = await ctx.db
      .query('personalBondfireInvites')
      .withIndex('by_code', (q) => q.eq('code', args.code.toLowerCase()))
      .first()

    if (!invite) {
      throwUserError('Invite not found')
    }

    if (invite.expiresAt <= Date.now()) {
      throwUserError('Invite has expired')
    }

    const bondfire = await ctx.db.get(invite.bondfireId)
    if (!bondfire) {
      throwUserError('Bondfire not found')
    }

    return {
      bondfireId: invite.bondfireId,
      code: invite.code,
      expiresAt: invite.expiresAt,
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

    const camp = await ctx.db
      .query('personalCamps')
      .withIndex('by_owner', (q) => q.eq('ownerId', userId))
      .first()

    if (!camp) {
      return []
    }

    return await ctx.db
      .query('bondfires')
      .withIndex('by_personal_camp', (q) =>
        q.eq('personalCampId', camp._id),
      )
      .order('desc')
      .collect()
  },
})

/**
 * List active participants in a personal bondfire.
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

    const users = await Promise.all(
      participants.map((p) => ctx.db.get(p.userId)),
    )

    return users
      .filter((u) => u !== null)
      .map((u) => ({
        _id: u!._id,
        displayName: u!.displayName,
        name: u!.name,
        photoUrl: u!.photoUrl,
      }))
  },
})

// ── Mutations ──────────────────────────────────────────────────────────────

/**
 * Create a bondfire in the current user's personal camp.
 */
export const createBondfire = mutation({
  args: {
    muxUploadId: v.optional(v.string()),
    muxAssetId: v.optional(v.string()),
    muxPlaybackId: v.optional(v.string()),
    muxPlaybackPolicy: v.optional(
      v.union(v.literal('public'), v.literal('signed')),
    ),
    videoStatus: v.optional(
      v.union(
        v.literal('waiting_for_upload'),
        v.literal('processing'),
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
    const camp = await getMyPersonalCamp(ctx)

    const now = Date.now()
    const bondfireId = await ctx.db.insert('bondfires', {
      userId: user._id,
      creatorName: user.displayName ?? user.name,
      personalCampId: camp._id,
      muxUploadId: args.muxUploadId,
      muxAssetId: args.muxAssetId,
      muxPlaybackId: args.muxPlaybackId,
      muxPlaybackPolicy: args.muxPlaybackPolicy,
      videoStatus: args.videoStatus,
      durationMs: args.durationMs,
      width: args.width,
      height: args.height,
      tags: args.tags,
      videoCount: 1,
      createdAt: now,
      updatedAt: now,
    })

    // Auto-add the creator as a participant
    await ctx.db.insert('personalBondfireParticipants', {
      bondfireId,
      userId: user._id,
      status: 'active',
      joinedAt: now,
      createdAt: now,
      updatedAt: now,
    })

    return bondfireId
  },
})

/**
 * Create an invite code for a personal bondfire.
 * Enforces participant caps (Plus=2, Premium/Pro=8).
 */
export const createInvite = mutation({
  args: {
    bondfireId: v.id('bondfires'),
  },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx)

    // Verify the bondfire belongs to the user's personal camp
    const camp = await getMyPersonalCamp(ctx)
    const bondfire = await ctx.db.get(args.bondfireId)
    if (!bondfire || bondfire.personalCampId !== camp._id) {
      throwUserError('Bondfire not found in your Personal Camp')
    }

    // Enforce participant cap
    const cap = await getParticipantCap(ctx, user._id)
    const activeCount = await getActiveParticipantCount(ctx, args.bondfireId)
    if (activeCount >= cap) {
      if (cap <= 2) {
        throwUserError(
          'Upgrade to Premium or Pro to invite more people to your Personal Fires.',
        )
      }
      throwUserError('Participant limit reached for this bondfire.')
    }

    // Generate a unique invite code
    let code = generateInviteCode(
      [args.bondfireId, Date.now()].join('-'),
    ).toLowerCase()

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const existing = await ctx.db
        .query('personalBondfireInvites')
        .withIndex('by_code', (q) => q.eq('code', code))
        .first()
      if (!existing) {
        break
      }
      code = generateInviteCode(
        [args.bondfireId, Date.now(), attempt].join('-'),
      )
    }

    const existingCheck = await ctx.db
      .query('personalBondfireInvites')
      .withIndex('by_code', (q) => q.eq('code', code))
      .first()
    if (existingCheck) {
      throwUserError('Could not generate a unique invite code. Try again.')
    }

    const now = Date.now()
    await ctx.db.insert('personalBondfireInvites', {
      bondfireId: args.bondfireId,
      code,
      createdBy: user._id,
      expiresAt: now + INVITE_EXPIRY_MS,
      createdAt: now,
    })

    return { code }
  },
})

/**
 * Redeem an invite code to join a personal bondfire.
 */
export const redeemInvite = mutation({
  args: {
    code: v.string(),
  },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx)

    const invite = await ctx.db
      .query('personalBondfireInvites')
      .withIndex('by_code', (q) => q.eq('code', args.code.toLowerCase()))
      .first()

    if (!invite) {
      throwUserError('Invite not found')
    }

    if (invite.expiresAt <= Date.now()) {
      throwUserError('Invite has expired')
    }

    const bondfire = await ctx.db.get(invite.bondfireId)
    if (!bondfire) {
      throwUserError('Bondfire not found')
    }

    // Check if already a participant
    const existing = await ctx.db
      .query('personalBondfireParticipants')
      .withIndex('by_bondfire_status', (q) =>
        q.eq('bondfireId', invite.bondfireId),
      )
      .collect()

    const myEntry = existing.find(
      (p) => p.userId === user._id && p.status === 'active',
    )
    if (myEntry) {
      // Already joined — return the bondfire
      return { bondfireId: invite.bondfireId }
    }

    // Check participant cap
    const campOwnerId = bondfire.personalCampId
      ? (
          await ctx.db.get(bondfire.personalCampId)
        )?.ownerId
      : null
    if (campOwnerId) {
      const cap = await getParticipantCap(ctx, campOwnerId)
      const activeCount = existing.filter((p) => p.status === 'active').length
      if (activeCount >= cap) {
        throwUserError('This bondfire has reached its participant limit.')
      }
    }

    const now = Date.now()

    // If user previously left/removed, reactivate instead of inserting new row
    const previousEntry = existing.find((p) => p.userId === user._id)
    if (previousEntry) {
      await ctx.db.patch(previousEntry._id, {
        status: 'active',
        joinedAt: now,
        updatedAt: now,
      })
    } else {
      await ctx.db.insert('personalBondfireParticipants', {
        bondfireId: invite.bondfireId,
        userId: user._id,
        status: 'active',
        joinedAt: now,
        createdAt: now,
        updatedAt: now,
      })
    }

    return { bondfireId: invite.bondfireId }
  },
})

/**
 * Remove a participant from a personal bondfire (owner only).
 */
export const removeParticipant = mutation({
  args: {
    bondfireId: v.id('bondfires'),
    userId: v.id('users'),
  },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx)
    const camp = await getMyPersonalCamp(ctx)

    // Verify the bondfire belongs to the user's personal camp
    const bondfire = await ctx.db.get(args.bondfireId)
    if (!bondfire || bondfire.personalCampId !== camp._id) {
      throwUserError('Bondfire not found in your Personal Camp')
    }

    // Find the participant
    const participants = await ctx.db
      .query('personalBondfireParticipants')
      .withIndex('by_bondfire_status', (q) =>
        q.eq('bondfireId', args.bondfireId),
      )
      .collect()

    const participant = participants.find(
      (p) => p.userId === args.userId && p.status === 'active',
    )

    if (!participant) {
      throwUserError('Participant not found')
    }

    await ctx.db.patch(participant._id, {
      status: 'removed',
      updatedAt: Date.now(),
    })

    return participant._id
  },
})

/**
 * Leave a personal bondfire (participant themselves).
 */
export const leaveBondfire = mutation({
  args: {
    bondfireId: v.id('bondfires'),
  },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx)

    const participants = await ctx.db
      .query('personalBondfireParticipants')
      .withIndex('by_bondfire_status', (q) =>
        q.eq('bondfireId', args.bondfireId),
      )
      .collect()

    const myEntry = participants.find(
      (p) => p.userId === user._id && p.status === 'active',
    )

    if (!myEntry) {
      throwUserError('You are not a participant in this bondfire')
    }

    await ctx.db.patch(myEntry._id, {
      status: 'left',
      updatedAt: Date.now(),
    })

    return myEntry._id
  },
})

/**
 * Delete a personal bondfire and all related rows (owner only).
 */
export const deleteBondfire = mutation({
  args: {
    bondfireId: v.id('bondfires'),
  },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx)
    const camp = await getMyPersonalCamp(ctx)

    // Verify the bondfire belongs to the user's personal camp
    const bondfire = await ctx.db.get(args.bondfireId)
    if (!bondfire || bondfire.personalCampId !== camp._id) {
      throwUserError('Bondfire not found in your Personal Camp')
    }

    // Delete all participants
    const participants = await ctx.db
      .query('personalBondfireParticipants')
      .withIndex('by_bondfire_status', (q) =>
        q.eq('bondfireId', args.bondfireId),
      )
      .collect()

    for (const participant of participants) {
      await ctx.db.delete(participant._id)
    }

    // Delete all invites
    const invites = await ctx.db
      .query('personalBondfireInvites')
      .withIndex('by_bondfire', (q) =>
        q.eq('bondfireId', args.bondfireId),
      )
      .collect()

    for (const invite of invites) {
      await ctx.db.delete(invite._id)
    }

    // Delete the bondfire itself
    await ctx.db.delete(args.bondfireId)

    return { deleted: true }
  },
})

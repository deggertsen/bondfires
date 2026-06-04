/**
 * Personal Bondfires: bondfires inside a user's personal camp.
 *
 * Personal camps are 1:1 per paid user. Access is invite-based and every
 * shared bondfire path must be gated by active personal-bondfire membership.
 */
import { v } from 'convex/values'
import type { Doc, Id } from './_generated/dataModel'
import type { MutationCtx, QueryCtx } from './_generated/server'
import { mutation, query } from './_generated/server'
import { auth } from './auth'
import {
  assertVideoDurationWithinTierLimit,
  getEntitlementSubscriptionTier,
  PAID_TIERS,
  type SubscriptionTier,
} from './entitlements'
import { throwUserError } from './errors'

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
] as const

const INVITE_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000

const PARTICIPANT_CAP: Record<SubscriptionTier, number> = {
  free: 0,
  plus: 2,
  premium: 8,
  pro: 8,
}

const videoStatusValidator = v.union(
  v.literal('waiting_for_upload'),
  v.literal('processing'),
  v.literal('live'),
  v.literal('ready'),
  v.literal('errored'),
)

type PersonalCamp = Doc<'personalCamps'>

function isPaidTier(tier: SubscriptionTier) {
  return PAID_TIERS.some((paidTier) => paidTier === tier)
}

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
  return code.trim().toLowerCase()
}

function personalCampName(user: Doc<'users'>) {
  const base = user.displayName || user.name || 'Someone'
  return `${base}'s Fire`
}

function isReadablePersonalCamp(camp: PersonalCamp) {
  return camp.status === 'active' || camp.status === 'frozen'
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

async function getParticipant(
  ctx: QueryCtx | MutationCtx,
  userId: Id<'users'>,
  bondfireId: Id<'bondfires'>,
) {
  return await ctx.db
    .query('personalBondfireParticipants')
    .withIndex('by_user_bondfire', (q) => q.eq('userId', userId).eq('bondfireId', bondfireId))
    .first()
}

async function getActiveParticipantCount(ctx: QueryCtx | MutationCtx, bondfireId: Id<'bondfires'>) {
  const participants = await ctx.db
    .query('personalBondfireParticipants')
    .withIndex('by_bondfire_status', (q) => q.eq('bondfireId', bondfireId).eq('status', 'active'))
    .collect()

  return participants.length
}

async function getParticipantCap(ctx: QueryCtx | MutationCtx, userId: Id<'users'>) {
  const tier = await getEntitlementSubscriptionTier(ctx, userId)
  return PARTICIPANT_CAP[tier]
}

async function getOrCreateActivePersonalCamp(ctx: MutationCtx, user: Doc<'users'>) {
  const tier = await getEntitlementSubscriptionTier(ctx, user._id)
  if (!isPaidTier(tier)) {
    throwUserError('Personal Camps require a Plus, Premium, or Pro subscription.')
  }

  const existing = await ctx.db
    .query('personalCamps')
    .withIndex('by_owner', (q) => q.eq('ownerId', user._id))
    .first()

  if (existing) {
    if (existing.status === 'frozen') {
      const now = Date.now()
      await ctx.db.patch(existing._id, {
        status: 'active',
        frozenAt: undefined,
        updatedAt: now,
      })
      return { ...existing, status: 'active' as const, frozenAt: undefined, updatedAt: now }
    }
    return existing
  }

  const now = Date.now()
  const name = personalCampName(user)
  const campId = await ctx.db.insert('personalCamps', {
    ownerId: user._id,
    name,
    status: 'active',
    createdAt: now,
    updatedAt: now,
  })

  return {
    _id: campId,
    _creationTime: now,
    ownerId: user._id,
    name,
    status: 'active' as const,
    createdAt: now,
    updatedAt: now,
  }
}

async function getOwnedPersonalBondfire(
  ctx: MutationCtx,
  args: { ownerId: Id<'users'>; bondfireId: Id<'bondfires'>; requireActiveCamp?: boolean },
) {
  const camp = await ctx.db
    .query('personalCamps')
    .withIndex('by_owner', (q) => q.eq('ownerId', args.ownerId))
    .first()

  if (!camp || (args.requireActiveCamp && camp.status !== 'active')) {
    throwUserError('Personal Camp not found')
  }

  const bondfire = await ctx.db.get(args.bondfireId)
  if (!bondfire || bondfire.personalCampId !== camp._id) {
    throwUserError('Bondfire not found in your Personal Camp')
  }

  return { camp, bondfire }
}

export async function isPersonalBondfireVisibleToViewer(
  ctx: QueryCtx,
  bondfire: Doc<'bondfires'>,
  viewerId: Id<'users'> | null,
) {
  if (!bondfire.personalCampId) {
    return true
  }
  if (!viewerId) {
    return false
  }

  const camp = await ctx.db.get(bondfire.personalCampId)
  if (!camp || !isReadablePersonalCamp(camp)) {
    return false
  }

  const participant = await getParticipant(ctx, viewerId, bondfire._id)
  return participant?.status === 'active'
}

export async function assertCanRespondToPersonalBondfire(
  ctx: QueryCtx | MutationCtx,
  bondfire: Doc<'bondfires'>,
  userId: Id<'users'>,
) {
  if (!bondfire.personalCampId) {
    return
  }

  const camp = await ctx.db.get(bondfire.personalCampId)
  if (!camp || camp.status !== 'active') {
    throwUserError('This Personal Camp is not accepting responses right now.')
  }

  const participant = await getParticipant(ctx, userId, bondfire._id)
  if (participant?.status !== 'active') {
    throwUserError('Join this Personal Fire before responding here')
  }
}

export const checkInvite = query({
  args: {
    code: v.string(),
  },
  handler: async (ctx, args) => {
    const invite = await ctx.db
      .query('personalBondfireInvites')
      .withIndex('by_code', (q) => q.eq('code', normalizeInviteCode(args.code)))
      .first()

    if (!invite) {
      throwUserError('Invite not found')
    }
    if (invite.expiresAt <= Date.now()) {
      throwUserError('Invite has expired')
    }

    const bondfire = await ctx.db.get(invite.bondfireId)
    if (!bondfire?.personalCampId) {
      throwUserError('Bondfire not found')
    }

    const camp = await ctx.db.get(bondfire.personalCampId)
    if (!camp || camp.status !== 'active') {
      throwUserError('This Personal Camp is not accepting new participants right now.')
    }

    return {
      bondfireId: invite.bondfireId,
      code: invite.code,
      expiresAt: invite.expiresAt,
    }
  },
})

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

    if (!camp || !isReadablePersonalCamp(camp)) {
      return []
    }

    return await ctx.db
      .query('bondfires')
      .withIndex('by_personal_camp', (q) => q.eq('personalCampId', camp._id))
      .order('desc')
      .collect()
  },
})

export const listParticipants = query({
  args: {
    bondfireId: v.id('bondfires'),
  },
  handler: async (ctx, args) => {
    const userId = await auth.getUserId(ctx)
    if (!userId) {
      return []
    }

    const bondfire = await ctx.db.get(args.bondfireId)
    if (!bondfire || !(await isPersonalBondfireVisibleToViewer(ctx, bondfire, userId))) {
      return []
    }

    const participants = await ctx.db
      .query('personalBondfireParticipants')
      .withIndex('by_bondfire_status', (q) =>
        q.eq('bondfireId', args.bondfireId).eq('status', 'active'),
      )
      .collect()

    const users = await Promise.all(
      participants.map((participant) => ctx.db.get(participant.userId)),
    )

    return users.flatMap((user) => {
      if (!user) {
        return []
      }

      return [
        {
          _id: user._id,
          displayName: user.displayName,
          name: user.name,
          photoUrl: user.photoUrl,
        },
      ]
    })
  },
})

export const createBondfire = mutation({
  args: {
    muxUploadId: v.optional(v.string()),
    muxAssetId: v.optional(v.string()),
    muxPlaybackId: v.optional(v.string()),
    muxPlaybackPolicy: v.optional(v.union(v.literal('public'), v.literal('signed'))),
    videoStatus: v.optional(videoStatusValidator),
    durationMs: v.optional(v.number()),
    width: v.optional(v.number()),
    height: v.optional(v.number()),
    tags: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx)
    await assertVideoDurationWithinTierLimit(ctx, user._id, args.durationMs)

    const status = args.videoStatus ?? 'ready'
    if (status === 'ready' && (!args.muxAssetId || !args.muxPlaybackId)) {
      throwUserError('Mux asset ID and playback ID are required for Mux videos')
    }
    if (args.muxPlaybackPolicy && args.muxPlaybackPolicy !== 'signed') {
      throwUserError('Personal Fire videos must use signed Mux playback')
    }

    const camp = await getOrCreateActivePersonalCamp(ctx, user)
    const now = Date.now()
    const bondfireId = await ctx.db.insert('bondfires', {
      userId: user._id,
      creatorName: user.displayName ?? user.name,
      personalCampId: camp._id,
      muxUploadId: args.muxUploadId,
      muxAssetId: args.muxAssetId,
      muxPlaybackId: args.muxPlaybackId,
      muxPlaybackPolicy: 'signed',
      muxAssetStatus: status,
      videoStatus: status,
      durationMs: args.durationMs,
      width: args.width,
      height: args.height,
      tags: args.tags,
      videoCount: 1,
      viewCount: 0,
      createdAt: now,
      updatedAt: now,
    })

    await ctx.db.insert('personalBondfireParticipants', {
      bondfireId,
      userId: user._id,
      status: 'active',
      joinedAt: now,
      createdAt: now,
      updatedAt: now,
    })

    await ctx.db.patch(user._id, {
      bondfireCount: (user.bondfireCount ?? 0) + 1,
      updatedAt: now,
    })

    return bondfireId
  },
})

export const createInvite = mutation({
  args: {
    bondfireId: v.id('bondfires'),
  },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx)
    await getOwnedPersonalBondfire(ctx, {
      ownerId: user._id,
      bondfireId: args.bondfireId,
      requireActiveCamp: true,
    })

    const cap = await getParticipantCap(ctx, user._id)
    const activeCount = await getActiveParticipantCount(ctx, args.bondfireId)
    if (activeCount >= cap) {
      if (cap <= PARTICIPANT_CAP.plus) {
        throwUserError('Upgrade to Premium or Pro to invite more people to your Personal Fires.')
      }
      throwUserError('Participant limit reached for this Personal Fire.')
    }

    let code = generateInviteCode([args.bondfireId, Date.now()].join('-'))
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const existing = await ctx.db
        .query('personalBondfireInvites')
        .withIndex('by_code', (q) => q.eq('code', code))
        .first()
      if (!existing) {
        break
      }
      code = generateInviteCode([args.bondfireId, Date.now(), attempt].join('-'))
    }

    const existing = await ctx.db
      .query('personalBondfireInvites')
      .withIndex('by_code', (q) => q.eq('code', code))
      .first()
    if (existing) {
      throwUserError('Could not generate a unique invite code. Try again.')
    }

    const now = Date.now()
    const inviteId = await ctx.db.insert('personalBondfireInvites', {
      bondfireId: args.bondfireId,
      code,
      createdBy: user._id,
      expiresAt: now + INVITE_EXPIRY_MS,
      createdAt: now,
    })

    return {
      inviteId,
      code,
      expiresAt: now + INVITE_EXPIRY_MS,
    }
  },
})

export const redeemInvite = mutation({
  args: {
    code: v.string(),
  },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx)
    const invite = await ctx.db
      .query('personalBondfireInvites')
      .withIndex('by_code', (q) => q.eq('code', normalizeInviteCode(args.code)))
      .first()

    if (!invite) {
      throwUserError('Invite not found')
    }
    if (invite.expiresAt <= Date.now()) {
      throwUserError('Invite has expired')
    }

    const bondfire = await ctx.db.get(invite.bondfireId)
    if (!bondfire?.personalCampId) {
      throwUserError('Bondfire not found')
    }

    const camp = await ctx.db.get(bondfire.personalCampId)
    if (!camp || camp.status !== 'active') {
      throwUserError('This Personal Camp is not accepting new participants right now.')
    }

    const existing = await getParticipant(ctx, user._id, invite.bondfireId)
    if (existing?.status === 'active') {
      return { bondfireId: invite.bondfireId, participantId: existing._id }
    }

    const cap = await getParticipantCap(ctx, camp.ownerId)
    const activeCount = await getActiveParticipantCount(ctx, invite.bondfireId)
    if (activeCount >= cap) {
      throwUserError('This Personal Fire has reached its participant limit.')
    }

    const now = Date.now()
    if (existing) {
      await ctx.db.patch(existing._id, {
        status: 'active',
        joinedAt: now,
        updatedAt: now,
      })
      return { bondfireId: invite.bondfireId, participantId: existing._id }
    }

    const participantId = await ctx.db.insert('personalBondfireParticipants', {
      bondfireId: invite.bondfireId,
      userId: user._id,
      status: 'active',
      joinedAt: now,
      createdAt: now,
      updatedAt: now,
    })

    return { bondfireId: invite.bondfireId, participantId }
  },
})

export const removeParticipant = mutation({
  args: {
    bondfireId: v.id('bondfires'),
    userId: v.id('users'),
  },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx)
    const { bondfire } = await getOwnedPersonalBondfire(ctx, {
      ownerId: user._id,
      bondfireId: args.bondfireId,
      requireActiveCamp: true,
    })

    if (args.userId === bondfire.userId) {
      throwUserError('The Personal Fire owner cannot be removed')
    }

    const participant = await getParticipant(ctx, args.userId, args.bondfireId)
    if (participant?.status !== 'active') {
      throwUserError('Participant not found')
    }

    await ctx.db.patch(participant._id, {
      status: 'removed',
      updatedAt: Date.now(),
    })

    return participant._id
  },
})

export const leaveBondfire = mutation({
  args: {
    bondfireId: v.id('bondfires'),
  },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx)
    const bondfire = await ctx.db.get(args.bondfireId)
    if (!bondfire?.personalCampId) {
      throwUserError('Personal Fire not found')
    }
    if (bondfire.userId === user._id) {
      throwUserError('Delete your Personal Fire instead of leaving it')
    }

    const participant = await getParticipant(ctx, user._id, args.bondfireId)
    if (participant?.status !== 'active') {
      throwUserError('You are not a participant in this Personal Fire')
    }

    await ctx.db.patch(participant._id, {
      status: 'left',
      updatedAt: Date.now(),
    })

    return participant._id
  },
})

export const deleteBondfire = mutation({
  args: {
    bondfireId: v.id('bondfires'),
  },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx)
    await getOwnedPersonalBondfire(ctx, {
      ownerId: user._id,
      bondfireId: args.bondfireId,
    })

    const participants = await ctx.db
      .query('personalBondfireParticipants')
      .withIndex('by_bondfire_status', (q) => q.eq('bondfireId', args.bondfireId))
      .collect()
    for (const participant of participants) {
      await ctx.db.delete(participant._id)
    }

    const invites = await ctx.db
      .query('personalBondfireInvites')
      .withIndex('by_bondfire', (q) => q.eq('bondfireId', args.bondfireId))
      .collect()
    for (const invite of invites) {
      await ctx.db.delete(invite._id)
    }

    await ctx.db.delete(args.bondfireId)
    await ctx.db.patch(user._id, {
      bondfireCount: Math.max(0, (user.bondfireCount ?? 1) - 1),
      updatedAt: Date.now(),
    })

    return { deleted: true }
  },
})

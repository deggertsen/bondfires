import { v } from 'convex/values'
import { internal } from './_generated/api'
import type { Doc, Id } from './_generated/dataModel'
import type { MutationCtx, QueryCtx } from './_generated/server'
import { internalAction, internalMutation, mutation, query } from './_generated/server'
import { auth } from './auth'
import { redeemCampInviteHandler } from './camps'
import { throwUserError, withUserFacingErrors } from './errors'
import { generateAndInsertInviteCode, normalizeInviteCode } from './inviteCodes'
import { redeemInviteHandler as redeemPersonalBondfireInviteHandler } from './personalBondfires'

type InviteClaimSource = 'direct' | 'code' | 'camp'

type DirectInviteArgs = {
  bondfireId: Id<'bondfires'>
  recipientId: Id<'users'>
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

async function assertCanInviteToBondfire(ctx: MutationCtx, bondfire: Doc<'bondfires'>) {
  const sender = await getCurrentUser(ctx)
  const isCreator = bondfire.userId === sender._id
  let hasCampPermission = false

  if (bondfire.campId) {
    const camp = await ctx.db.get(bondfire.campId)
    const membership = await ctx.db
      .query('campMembers')
      .withIndex('by_user_camp', (q) =>
        q.eq('userId', sender._id).eq('campId', bondfire.campId as Id<'camps'>),
      )
      .unique()

    hasCampPermission =
      membership?.role === 'owner' ||
      membership?.role === 'moderator' ||
      (camp?.access === 'open' && membership?.status === 'active')
  }

  if (!isCreator && !hasCampPermission) {
    throwUserError('You do not have permission to invite people to this bondfire')
  }

  return sender
}

async function createInviteNotification(
  ctx: MutationCtx,
  args: {
    userId: Id<'users'>
    title: string
    body: string
    data: Record<string, unknown>
  },
) {
  return await ctx.db.insert('notifications', {
    userId: args.userId,
    type: 'invite',
    title: args.title,
    body: args.body,
    data: args.data,
    read: false,
    createdAt: Date.now(),
  })
}

async function upsertInviteClaim(
  ctx: MutationCtx,
  args: {
    inviteCodeId?: Id<'inviteCodes'>
    bondfireId?: Id<'bondfires'>
    campId?: Id<'camps'>
    senderId: Id<'users'>
    claimerId: Id<'users'>
    source: InviteClaimSource
  },
) {
  const now = Date.now()

  const existingByInviteCode = args.inviteCodeId
    ? await ctx.db
        .query('inviteClaims')
        .withIndex('by_invite_code', (q) =>
          q.eq('inviteCodeId', args.inviteCodeId).eq('claimerId', args.claimerId),
        )
        .first()
    : null
  const existingByBondfire =
    !existingByInviteCode && args.bondfireId
      ? await ctx.db
          .query('inviteClaims')
          .withIndex('by_bondfire_claimer', (q) =>
            q.eq('bondfireId', args.bondfireId).eq('claimerId', args.claimerId),
          )
          .first()
      : null
  const existingByCamp =
    !existingByInviteCode && !existingByBondfire && args.campId
      ? await ctx.db
          .query('inviteClaims')
          .withIndex('by_camp_claimer', (q) =>
            q.eq('campId', args.campId).eq('claimerId', args.claimerId),
          )
          .first()
      : null
  const existing = existingByInviteCode ?? existingByBondfire ?? existingByCamp

  if (existing) {
    await ctx.db.patch(existing._id, {
      inviteCodeId: existing.inviteCodeId ?? args.inviteCodeId,
      bondfireId: existing.bondfireId ?? args.bondfireId,
      campId: existing.campId ?? args.campId,
      senderId: args.senderId,
      source: args.source,
      seen: false,
      dismissed: false,
    })
    return { claimId: existing._id, created: false }
  }

  const claimId = await ctx.db.insert('inviteClaims', {
    inviteCodeId: args.inviteCodeId,
    bondfireId: args.bondfireId,
    campId: args.campId,
    senderId: args.senderId,
    claimerId: args.claimerId,
    source: args.source,
    seen: false,
    dismissed: false,
    createdAt: now,
  })

  return { claimId, created: true }
}

async function createDirectInviteCore(ctx: MutationCtx, args: DirectInviteArgs) {
  const bondfire = await ctx.db.get(args.bondfireId)
  if (!bondfire) {
    throwUserError('Bondfire not found')
  }

  const sender = await assertCanInviteToBondfire(ctx, bondfire)
  if (args.recipientId === sender._id) {
    throwUserError('You cannot invite yourself')
  }

  const recipient = await ctx.db.get(args.recipientId)
  if (!recipient) {
    throwUserError('Recipient not found')
  }

  const senderName = sender.displayName ?? sender.name ?? 'Someone'
  const title = `${senderName} shared a bondfire with you`
  const body = `"${bondfire.creatorName ?? 'Someone'}" - tap to watch`
  const { claimId } = await upsertInviteClaim(ctx, {
    bondfireId: args.bondfireId,
    senderId: sender._id,
    claimerId: args.recipientId,
    source: 'direct',
  })

  await createInviteNotification(ctx, {
    userId: args.recipientId,
    title,
    body,
    data: {
      claimId,
      bondfireId: args.bondfireId,
      campId: bondfire.campId,
      source: 'direct',
    },
  })

  await ctx.scheduler.runAfter(0, internal.inviteClaims.sendDirectInviteNotification, {
    bondfireId: args.bondfireId,
    recipientId: args.recipientId,
    senderName,
    bondfireCreatorName: bondfire.creatorName ?? 'Someone',
    campId: bondfire.campId,
  })

  return claimId
}

export async function createDirectInviteHandler(ctx: MutationCtx, args: DirectInviteArgs) {
  return await createDirectInviteCore(ctx, args)
}

export const createDirectInvite = mutation({
  args: {
    bondfireId: v.id('bondfires'),
    recipientId: v.id('users'),
  },
  handler: async (ctx, args) =>
    withUserFacingErrors(
      'inviteClaims.createDirectInvite',
      'Something went wrong sending this invite. Please try again.',
      () => createDirectInviteCore(ctx, args),
    ),
})

export const createBondfireInviteCode = mutation({
  args: {
    bondfireId: v.id('bondfires'),
  },
  handler: async (ctx, args) => {
    const bondfire = await ctx.db.get(args.bondfireId)
    if (!bondfire) {
      throwUserError('Bondfire not found')
    }
    const sender = await assertCanInviteToBondfire(ctx, bondfire)

    const result = await generateAndInsertInviteCode(ctx, {
      parentType: 'bondfire',
      parentId: args.bondfireId,
      createdBy: sender._id,
      expiresInDays: 7,
    })

    return {
      code: result.code,
      expiresAt: result.expiresAt,
      bondfireId: args.bondfireId,
    }
  },
})

export const redeemInviteCode = mutation({
  args: {
    code: v.string(),
  },
  handler: (ctx, args) =>
    withUserFacingErrors(
      'inviteClaims.redeemInviteCode',
      'Something went wrong redeeming this invite. Please try again.',
      () => redeemInviteCodeHandler(ctx, args.code),
    ),
})

async function redeemInviteCodeHandler(ctx: MutationCtx, rawCode: string) {
  const user = await getCurrentUser(ctx)
  const code = normalizeInviteCode(rawCode)
  const now = Date.now()

  const invite = await ctx.db
    .query('inviteCodes')
    .withIndex('by_code', (q) => q.eq('code', code))
    .first()
  if (!invite) {
    throwUserError('Invite not found')
  }
  if (invite.expiresAt !== undefined && invite.expiresAt <= now) {
    throwUserError('Invite has expired')
  }
  if (invite.maxUses !== undefined && invite.uses >= invite.maxUses) {
    throwUserError('Invite has already been used')
  }

  if (invite.parentType === 'camp') {
    const result = await redeemCampInviteHandler(ctx, code)
    const camp = await ctx.db.get(result.campId)
    const { claimId, created } = await upsertInviteClaim(ctx, {
      inviteCodeId: invite._id,
      campId: result.campId,
      senderId: invite.createdBy,
      claimerId: user._id,
      source: 'camp',
    })
    if (created) {
      await createInviteNotification(ctx, {
        userId: user._id,
        title: 'Camp invite accepted',
        body: `You joined ${camp?.name ?? 'a camp'}.`,
        data: { claimId, campId: result.campId, source: 'camp' },
      })
    }
    return { type: 'camp' as const, campId: result.campId, claimId }
  }

  if (invite.parentType === 'personal-bondfire') {
    const result = await redeemPersonalBondfireInviteHandler(ctx, code)
    const { claimId, created } = await upsertInviteClaim(ctx, {
      inviteCodeId: invite._id,
      bondfireId: result.bondfireId,
      senderId: invite.createdBy,
      claimerId: user._id,
      source: 'code',
    })
    if (created) {
      await createInviteNotification(ctx, {
        userId: user._id,
        title: 'Fire invite accepted',
        body: 'You joined a shared fire.',
        data: { claimId, bondfireId: result.bondfireId, source: 'code' },
      })
    }
    return { type: 'bondfire' as const, bondfireId: result.bondfireId, claimId }
  }

  const bondfireId = invite.parentId as Id<'bondfires'>
  const bondfire = await ctx.db.get(bondfireId)
  if (!bondfire) {
    throwUserError('Bondfire not found')
  }

  const { claimId, created } = await upsertInviteClaim(ctx, {
    inviteCodeId: invite._id,
    bondfireId,
    campId: bondfire.campId,
    senderId: invite.createdBy,
    claimerId: user._id,
    source: 'code',
  })

  if (created) {
    await ctx.db.patch(invite._id, { uses: invite.uses + 1 })
    await createInviteNotification(ctx, {
      userId: user._id,
      title: 'Bondfire invite accepted',
      body: `"${bondfire.creatorName ?? 'Someone'}" is ready to watch.`,
      data: {
        claimId,
        bondfireId,
        campId: bondfire.campId,
        source: 'code',
      },
    })
  }

  return { type: 'bondfire' as const, bondfireId, claimId }
}

export const markInviteSeen = mutation({
  args: {
    bondfireId: v.id('bondfires'),
  },
  handler: async (ctx, args) => {
    const userId = await auth.getUserId(ctx)
    if (!userId) {
      return { updated: 0 }
    }

    const claims = await ctx.db
      .query('inviteClaims')
      .withIndex('by_bondfire_claimer', (q) =>
        q.eq('bondfireId', args.bondfireId).eq('claimerId', userId),
      )
      .collect()

    let updated = 0
    for (const claim of claims) {
      if (!claim.seen) {
        await ctx.db.patch(claim._id, { seen: true })
        updated += 1
      }
    }

    return { updated }
  },
})

export const dismissInvite = mutation({
  args: {
    claimId: v.id('inviteClaims'),
  },
  handler: async (ctx, args) => {
    const userId = await auth.getUserId(ctx)
    if (!userId) {
      throwUserError('Not authenticated')
    }

    const claim = await ctx.db.get(args.claimId)
    if (!claim || claim.claimerId !== userId) {
      throwUserError('Invite not found')
    }

    await ctx.db.patch(args.claimId, { dismissed: true })
    return { dismissed: true }
  },
})

export const listUnseenInvites = query({
  args: {},
  handler: async (ctx) => {
    const userId = await auth.getUserId(ctx)
    if (!userId) {
      return []
    }

    const claims = await ctx.db
      .query('inviteClaims')
      .withIndex('by_claimer_unseen', (q) =>
        q.eq('claimerId', userId).eq('seen', false).eq('dismissed', false),
      )
      .order('desc')
      .collect()

    const rows = await Promise.all(
      claims.map(async (claim) => {
        const [bondfire, camp, sender] = await Promise.all([
          claim.bondfireId ? ctx.db.get(claim.bondfireId) : Promise.resolve(null),
          claim.campId ? ctx.db.get(claim.campId) : Promise.resolve(null),
          ctx.db.get(claim.senderId),
        ])

        return {
          claim,
          bondfire,
          camp,
          sender: sender
            ? {
                _id: sender._id,
                displayName: sender.displayName,
                name: sender.name,
                photoUrl: sender.photoUrl,
              }
            : null,
        }
      }),
    )

    return rows.filter((row) => row.bondfire || row.camp)
  },
})

export const backfillBondfireInvites = internalMutation({
  args: {
    dryRun: v.optional(v.boolean()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = args.limit ?? 500
    const legacyInvites = await ctx.db.query('bondfireInvites').take(limit)
    let inserted = 0
    let skipped = 0

    for (const invite of legacyInvites) {
      const existing = await ctx.db
        .query('inviteClaims')
        .withIndex('by_bondfire_claimer', (q) =>
          q.eq('bondfireId', invite.bondfireId).eq('claimerId', invite.recipientId),
        )
        .first()

      if (existing) {
        skipped += 1
        continue
      }

      if (!args.dryRun) {
        await ctx.db.insert('inviteClaims', {
          bondfireId: invite.bondfireId,
          senderId: invite.senderId,
          claimerId: invite.recipientId,
          source: 'direct',
          seen: invite.seen,
          dismissed: false,
          createdAt: invite.createdAt,
        })
      }
      inserted += 1
    }

    return {
      scanned: legacyInvites.length,
      inserted,
      skipped,
      remainingMayExist: legacyInvites.length === limit,
      dryRun: !!args.dryRun,
    }
  },
})

export const sendDirectInviteNotification = internalAction({
  args: {
    bondfireId: v.id('bondfires'),
    recipientId: v.id('users'),
    senderName: v.string(),
    bondfireCreatorName: v.string(),
    campId: v.optional(v.id('camps')),
  },
  handler: async (ctx, args) => {
    await ctx.runAction(internal.sendNotification.sendToUser, {
      userId: args.recipientId,
      title: `${args.senderName} shared a bondfire with you`,
      body: `"${args.bondfireCreatorName}" - tap to watch`,
      category: 'membership',
      data: {
        type: 'bondfire_invite',
        bondfireId: args.bondfireId,
        screen: `/bondfire/${args.bondfireId}`,
        campId: args.campId,
      },
    })
  },
})

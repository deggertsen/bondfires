import { v } from 'convex/values'
import { internal } from './_generated/api'
import type { Doc, Id } from './_generated/dataModel'
import type { MutationCtx, QueryCtx } from './_generated/server'
import {
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from './_generated/server'
import { enforceDirectInviteLimit, enforceInviteAttemptLimit } from './abuseLimits'
import {
  assertUserCanAccessCamp,
  assertUsersShareAgeBand,
  isUserEligibleForCamp,
} from './agePolicy'
import { auth } from './auth'
import { buildViewerVisibilityContext, isBondfireVisibleToViewer } from './bondfireVisibility'
import { redeemCampInviteHandler } from './camps'
import { throwUserError, withUserFacingErrors } from './errors'
import { assertUsersCanShareHearth } from './familyRelationships'
import {
  findReusableInviteCode,
  generateAndInsertInviteCode,
  isInviteCodeClaimable,
  normalizeInviteCode,
} from './inviteCodes'
import { getLatestResponsePlayback } from './lib/latestResponsePlayback'
import {
  canViewPersonalBondfire,
  ensureActivePersonalBondfireParticipant,
} from './personalBondfireAccess'
import {
  isPersonalInviteAvailable,
  redeemInviteHandler as redeemPersonalBondfireInviteHandler,
} from './personalBondfires'
import { assertUsersMayInteract, getBlockedUserIds, isEitherUserBlocked } from './userSafety'

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
    if (!camp) throwUserError('Camp not found')
    assertUserCanAccessCamp(sender, camp)
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
    bondfireId?: Id<'bondfires'>
    title: string
    body: string
    data: Record<string, unknown>
  },
) {
  return await ctx.db.insert('notifications', {
    userId: args.userId,
    bondfireId: args.bondfireId,
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
  if (bondfire.personalCampId) {
    await assertUsersCanShareHearth(ctx, sender._id, recipient._id)
  } else {
    await assertUsersShareAgeBand(ctx, sender._id, recipient._id)
  }
  if (bondfire.campId) {
    const camp = await ctx.db.get(bondfire.campId)
    if (!camp) throwUserError('Camp not found')
    assertUserCanAccessCamp(sender, camp)
    assertUserCanAccessCamp(recipient, camp)
  }
  await assertUsersMayInteract(ctx, sender._id, args.recipientId)
  await enforceDirectInviteLimit(ctx, sender._id)

  // Hearth fires gate playback on personalBondfireParticipants. A claim +
  // notification without this row sends invitees to "isn't available".
  if (bondfire.personalCampId) {
    await ensureActivePersonalBondfireParticipant(ctx, {
      bondfire,
      userId: args.recipientId,
      errorAudience: 'owner',
    })
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
    bondfireId: args.bondfireId,
    title,
    body,
    data: {
      claimId,
      senderId: sender._id,
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

    // Hearth fires must use personal-bondfire codes — redeeming a plain
    // 'bondfire' code only creates a claim and leaves the invitee unable to
    // open the fire (participant-gated visibility).
    const parentType = bondfire.personalCampId ? 'personal-bondfire' : 'bondfire'

    const result =
      (await findReusableInviteCode(ctx, {
        parentType,
        parentId: args.bondfireId,
        createdBy: sender._id,
      })) ??
      (await generateAndInsertInviteCode(ctx, {
        parentType,
        parentId: args.bondfireId,
        createdBy: sender._id,
        expiresInDays: 7,
      }))

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
  await enforceInviteAttemptLimit(ctx, user._id)
  const code = normalizeInviteCode(rawCode)
  const now = Date.now()
  if (!code || code.length > 128) return { type: 'invalid' as const }

  const invite = await ctx.db
    .query('inviteCodes')
    .withIndex('by_code', (q) => q.eq('code', code))
    .first()
  if (!invite) {
    return { type: 'invalid' as const }
  }
  if (!isInviteCodeClaimable(invite, now)) {
    return { type: 'invalid' as const }
  }
  if (await isEitherUserBlocked(ctx, user._id, invite.createdBy)) {
    return { type: 'invalid' as const }
  }

  // Family links require a dedicated consent screen. Resolving the generic
  // invite route must never accept the relationship implicitly.
  if (invite.parentType === 'family-connection') {
    return { type: 'family-connection' as const, code }
  }

  if (invite.parentType === 'camp') {
    const result = await redeemCampInviteHandler(ctx, code, { rateLimitAlreadyConsumed: true })
    if ('invalid' in result) return { type: 'invalid' as const }
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
    const result = await redeemPersonalBondfireInviteHandler(ctx, code, {
      rateLimitAlreadyConsumed: true,
    })
    if ('invalid' in result) return { type: 'invalid' as const }
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
        bondfireId: result.bondfireId,
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
    return { type: 'invalid' as const }
  }

  if (!bondfire.personalCampId) {
    const viewer = await buildViewerVisibilityContext(ctx, user._id)
    // Evaluate the access this claim would grant before creating any artifacts.
    // Camp age/lifecycle rules and block/moderation checks still apply.
    viewer.claimedBondfireIds.add(bondfire._id)
    if (!(await isBondfireVisibleToViewer(ctx, bondfire, viewer))) {
      return { type: 'invalid' as const }
    }
  }

  // Legacy / mis-typed hearth codes (parentType 'bondfire' on a personal
  // fire) still need a participant row or the invitee hits "isn't available".
  if (bondfire.personalCampId) {
    const personalCamp = await ctx.db.get(bondfire.personalCampId)
    if (!personalCamp || personalCamp.status !== 'active') {
      return { type: 'invalid' as const }
    }
    if (!(await isPersonalInviteAvailable(ctx, bondfire, user._id))) {
      return { type: 'invalid' as const }
    }
    await ensureActivePersonalBondfireParticipant(ctx, {
      bondfire,
      userId: user._id,
      errorAudience: 'invitee',
    })
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
      bondfireId,
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
    const blockedUserIds = await getBlockedUserIds(ctx, userId)

    const claims = await ctx.db
      .query('inviteClaims')
      .withIndex('by_claimer_unseen', (q) =>
        q.eq('claimerId', userId).eq('seen', false).eq('dismissed', false),
      )
      .order('desc')
      .collect()
    const viewer = await buildViewerVisibilityContext(ctx, userId)

    const rows = await Promise.all(
      claims.map(async (claim) => {
        if (blockedUserIds.has(claim.senderId)) return null
        const [bondfire, camp, sender, latestResponse] = await Promise.all([
          claim.bondfireId ? ctx.db.get(claim.bondfireId) : Promise.resolve(null),
          claim.campId ? ctx.db.get(claim.campId) : Promise.resolve(null),
          ctx.db.get(claim.senderId),
          claim.bondfireId
            ? getLatestResponsePlayback(ctx, claim.bondfireId)
            : Promise.resolve(null),
        ])

        return {
          claim,
          bondfire: bondfire
            ? {
                ...bondfire,
                latestResponseBondfireVideoId: latestResponse?.bondfireVideoId,
                latestResponseMuxPlaybackId: latestResponse?.muxPlaybackId,
                latestResponseMuxPlaybackPolicy: latestResponse?.muxPlaybackPolicy,
              }
            : null,
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

    return (
      await Promise.all(
        rows.map(async (row) => {
          if (!row) return null
          if (!row.bondfire) {
            return row.camp && viewer.user && isUserEligibleForCamp(viewer.user, row.camp)
              ? row
              : null
          }
          if (!(await isBondfireVisibleToViewer(ctx, row.bondfire, viewer))) return null
          // Don't surface hearth invites the viewer can't open yet (claim
          // without participant → "isn't available" dead end).
          if (row.bondfire.personalCampId) {
            const canView = await canViewPersonalBondfire(ctx, {
              bondfire: row.bondfire,
              userId,
            })
            if (!canView) return null
          }
          return row
        }),
      )
    ).filter((row): row is NonNullable<typeof row> => row !== null)
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
    // Draft discard / bondfire delete can race a runAfter(0) push. Skip if the
    // fire or invite claim is already gone so we don't send a dead deep link.
    const stillValid = await ctx.runQuery(internal.inviteClaims.isDirectInvitePushValid, {
      bondfireId: args.bondfireId,
      recipientId: args.recipientId,
    })
    if (!stillValid) {
      return
    }

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

export const isDirectInvitePushValid = internalQuery({
  args: {
    bondfireId: v.id('bondfires'),
    recipientId: v.id('users'),
  },
  handler: async (ctx, args) => {
    const bondfire = await ctx.db.get(args.bondfireId)
    if (!bondfire) {
      return false
    }

    const claim = await ctx.db
      .query('inviteClaims')
      .withIndex('by_bondfire_claimer', (q) =>
        q.eq('bondfireId', args.bondfireId).eq('claimerId', args.recipientId),
      )
      .first()

    if (!claim || claim.dismissed === true) {
      return false
    }

    if (bondfire.personalCampId) {
      return await canViewPersonalBondfire(ctx, {
        bondfire,
        userId: args.recipientId,
      })
    }

    return true
  },
})

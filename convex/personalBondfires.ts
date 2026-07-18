import { v } from 'convex/values'
import { internal } from './_generated/api'
import type { Doc, Id } from './_generated/dataModel'
import type { MutationCtx, QueryCtx } from './_generated/server'
import { internalMutation, mutation, query } from './_generated/server'
import { auth } from './auth'
import {
  assertVideoDurationWithinTierLimit,
  getEntitlementSubscriptionTier,
  PAID_TIERS,
} from './entitlements'
import { throwUserError, withUserFacingErrors } from './errors'
import { deleteBondfireInviteArtifacts } from './inviteArtifacts'
import { createDirectInviteHandler } from './inviteClaims'
import {
  findReusableInviteCode,
  generateAndInsertInviteCode,
  normalizeInviteCode,
} from './inviteCodes'
import {
  canViewPersonalBondfire,
  ensureActivePersonalBondfireParticipant,
  getActivePersonalBondfireParticipantCount,
  getPersonalBondfireParticipant,
  getPersonalBondfireParticipantCap,
} from './personalBondfireAccess'

// ── Constants ──────────────────────────────────────────────────────────────

/** Drafts with no recording are cleaned up after this long. */
const DRAFT_BONDFIRE_TTL_MS = 24 * 60 * 60 * 1000

/** Same cap as CompletionScreen's title editor. */
const MAX_TITLE_LENGTH = 80

/** Upper bound on email invites per send — mirrors MAX_EMAIL_INVITES in
 * PreRecordingInviteScreen. Keeps one mutation call from fanning out an
 * unbounded number of Resend emails. */
const MAX_EMAIL_INVITES = 10

/** Recent Connections: interactions within this window count. */
const RECENT_CONNECTION_WINDOW_MS = 30 * 24 * 60 * 60 * 1000
const RECENT_CONNECTIONS_LIMIT = 20
const RECENT_CONNECTION_BONDFIRE_SCAN_LIMIT = 25
const RECENT_CONNECTION_PARTICIPATION_SCAN_LIMIT = 25
const CLOSE_CIRCLE_LIMIT = 8

/** Batch size per cleanup cron run. */
const DRAFT_CLEANUP_BATCH_SIZE = 50

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

async function findDraftBondfireForUser(ctx: QueryCtx | MutationCtx, userId: Id<'users'>) {
  return await ctx.db
    .query('bondfires')
    .withIndex('by_user', (q) => q.eq('userId', userId))
    .filter((q) => q.eq(q.field('status'), 'draft'))
    .first()
}

async function ensureDraftInviteCode(
  ctx: MutationCtx,
  bondfireId: Id<'bondfires'>,
  userId: Id<'users'>,
) {
  return (
    (await findReusableInviteCode(ctx, {
      parentType: 'personal-bondfire',
      parentId: bondfireId,
      createdBy: userId,
    })) ??
    (await generateAndInsertInviteCode(ctx, {
      parentType: 'personal-bondfire',
      parentId: bondfireId,
      createdBy: userId,
      expiresInDays: 7,
    }))
  )
}

function normalizeTitle(title: string | undefined): string | undefined {
  const trimmed = title?.trim().slice(0, MAX_TITLE_LENGTH)
  return trimmed || undefined
}

function isDraftExpired(draft: Pick<Doc<'bondfires'>, 'draftExpiresAt'>, now: number): boolean {
  return draft.draftExpiresAt === undefined || draft.draftExpiresAt <= now
}

function normalizeInviteEmail(rawEmail: string): string {
  const email = rawEmail.trim().toLowerCase()
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throwUserError('Enter a valid email address.')
  }
  return email
}

/**
 * Delete a draft bondfire and everything hanging off it: participants,
 * invite codes (invalidating outstanding links), invite claims, and any
 * live session left by an interrupted recording attempt.
 */
async function deleteDraftBondfireCascade(ctx: MutationCtx, bondfire: Doc<'bondfires'>) {
  const participants = await ctx.db
    .query('personalBondfireParticipants')
    .withIndex('by_bondfire_status', (q) => q.eq('bondfireId', bondfire._id))
    .collect()
  for (const participant of participants) {
    await ctx.db.delete(participant._id)
  }

  await deleteBondfireInviteArtifacts(ctx, bondfire._id)

  if (bondfire.liveSessionId) {
    await ctx.db.delete(bondfire.liveSessionId)
  }

  await ctx.db.delete(bondfire._id)

  // No bondfireCount decrement: drafts were never counted (the count is added
  // at activation, when a recording attaches — see videos.ts).
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

// ── Pre-recording draft flow ───────────────────────────────────────────────

/**
 * Create a Hearth bondfire in `draft` status from the pre-recording invite
 * screen: no video fields yet, an invite code up front, and a 24h cleanup
 * deadline. One draft at a time — if the user already has one, it is returned
 * instead (so a double-tap or a lazy share-link creation can't fork the flow).
 */
export const createDraftBondfire = mutation({
  args: {
    title: v.optional(v.string()),
  },
  handler: (ctx, args) =>
    withUserFacingErrors(
      'personalBondfires.createDraftBondfire',
      'Something went wrong setting up your Bondfire. Please try again.',
      async () => {
        const user = await getCurrentUser(ctx)
        const now = Date.now()

        const tier = await getEntitlementSubscriptionTier(ctx, user._id)
        if (!PAID_TIERS.includes(tier)) {
          throwUserError('A Hearth requires a Plus, Premium, or Pro subscription.')
        }

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

        const existingDraft = await findDraftBondfireForUser(ctx, user._id)
        if (existingDraft && isDraftExpired(existingDraft, now)) {
          // The hourly cleanup can lag the exact deadline. Do not revive a
          // stale draft that may be swept while the owner is recording.
          await deleteDraftBondfireCascade(ctx, existingDraft)
        } else if (existingDraft) {
          // Keep the resumed draft's title in sync with what the screen shows,
          // whether or not the user also sends invites (which is the only
          // other place the title gets persisted).
          const title = normalizeTitle(args.title)
          if (title && title !== existingDraft.title) {
            await ctx.db.patch(existingDraft._id, { title, updatedAt: now })
          }
          const existingCode = await ensureDraftInviteCode(ctx, existingDraft._id, user._id)
          return { bondfireId: existingDraft._id, inviteCode: existingCode.code, resumed: true }
        }

        const bondfireId = await ctx.db.insert('bondfires', {
          userId: user._id,
          creatorName: user.displayName ?? user.name,
          personalCampId: personalCamp._id,
          title: normalizeTitle(args.title),
          frozen: false,
          status: 'draft',
          draftExpiresAt: now + DRAFT_BONDFIRE_TTL_MS,
          // 'pending' drives the existing "waiting to start recording" detail
          // screen for invited participants, and is never swept by the stuck-
          // record reconciler (it only scans processing/waiting_for_upload).
          videoStatus: 'pending',
          muxPlaybackPolicy: 'signed',
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

        // bondfireCount deliberately not incremented here — drafts hold no
        // recording, and the recount paths only count playable records. The
        // activation paths in videos.ts add the count when the recording
        // attaches.

        const code = await ensureDraftInviteCode(ctx, bondfireId, user._id)
        return { bondfireId, inviteCode: code.code, resumed: false }
      },
    ),
})

/**
 * Fire the audience selection for a draft bondfire: in-app recipients (and
 * emails that match existing accounts) become active participants and get a
 * direct invite + push; unknown emails get an invite-code email via Resend.
 * Also persists the final title from the pre-recording screen.
 */
export const sendDraftInvites = mutation({
  args: {
    bondfireId: v.id('bondfires'),
    recipientIds: v.array(v.id('users')),
    emails: v.array(v.string()),
    title: v.optional(v.string()),
  },
  handler: (ctx, args) =>
    withUserFacingErrors(
      'personalBondfires.sendDraftInvites',
      'Something went wrong sending your invites. Please try again.',
      async () => {
        const user = await getCurrentUser(ctx)
        const now = Date.now()

        if (args.emails.length > MAX_EMAIL_INVITES) {
          throwUserError(`You can invite up to ${MAX_EMAIL_INVITES} people by email at a time.`)
        }

        const bondfire = await getPersonalBondfireOrThrow(ctx, args.bondfireId)
        if (bondfire.userId !== user._id) {
          throwUserError('Only the bondfire owner can send invites.')
        }
        if (bondfire.status !== 'draft') {
          throwUserError('This bondfire is no longer a draft.')
        }
        await assertPersonalCampActive(
          ctx,
          bondfire.personalCampId,
          'Your hearth is currently frozen. Please re-subscribe to reactivate it.',
        )

        const title = normalizeTitle(args.title)
        if (title && title !== bondfire.title) {
          await ctx.db.patch(args.bondfireId, { title, updatedAt: now })
        }

        // Emails that match an existing account get a direct invite instead
        // of an email; the rest get the invite code via Resend.
        const recipientIds = new Set<Id<'users'>>(args.recipientIds)
        recipientIds.delete(user._id)
        const newUserEmails: string[] = []
        for (const rawEmail of args.emails) {
          const email = normalizeInviteEmail(rawEmail)
          const existingUser = await ctx.db
            .query('users')
            .withIndex('email', (q) => q.eq('email', email))
            .first()
          if (existingUser) {
            if (existingUser._id !== user._id) {
              recipientIds.add(existingUser._id)
            }
          } else if (!newUserEmails.includes(email)) {
            newUserEmails.push(email)
          }
        }

        // Everyone invited in-app becomes an active participant now, so the
        // audience exists before the recording does. Enforce the tier cap
        // across current actives plus everyone being added.
        const tier = await getEntitlementSubscriptionTier(ctx, user._id)
        if (!PAID_TIERS.includes(tier)) {
          throwUserError('A Hearth requires a Plus, Premium, or Pro subscription.')
        }
        const cap = getPersonalBondfireParticipantCap(tier)
        // Serialize concurrent invite mutations on the bondfire row.
        await ctx.db.patch(args.bondfireId, { updatedAt: now })
        const activeCount = await getActivePersonalBondfireParticipantCount(ctx, args.bondfireId)
        const toAdd: Array<{
          recipientId: Id<'users'>
          participant: Doc<'personalBondfireParticipants'> | null
        }> = []
        for (const recipientId of recipientIds) {
          const participant = await getPersonalBondfireParticipant(ctx, {
            bondfireId: args.bondfireId,
            userId: recipientId,
          })
          if (participant?.status !== 'active') {
            toAdd.push({ recipientId, participant })
          }
        }
        if (activeCount + toAdd.length > cap) {
          if (tier === 'plus') {
            throwUserError('Upgrade to Premium or Pro to invite more people to your Hearth.')
          }
          throwUserError('This fire is full.')
        }

        for (const { recipientId, participant } of toAdd) {
          if (participant) {
            await ctx.db.patch(participant._id, {
              status: 'active',
              joinedAt: now,
              leftAt: undefined,
              removedAt: undefined,
              removedBy: undefined,
              updatedAt: now,
            })
          } else {
            await ctx.db.insert('personalBondfireParticipants', {
              bondfireId: args.bondfireId,
              userId: recipientId,
              status: 'active',
              joinedAt: now,
              createdAt: now,
              updatedAt: now,
            })
          }
          await createDirectInviteHandler(ctx, {
            bondfireId: args.bondfireId,
            recipientId,
          })
        }

        const code = await ensureDraftInviteCode(ctx, args.bondfireId, user._id)
        for (const email of newUserEmails) {
          await ctx.scheduler.runAfter(0, internal.sendNotification.sendHearthInviteEmail, {
            to: email,
            inviterName: user.displayName ?? user.name ?? 'Someone',
            bondfireTitle: title ?? bondfire.title,
            code: code.code,
          })
        }

        // Deliberately no invited/emailed breakdown: for a single submitted
        // email those counts would reveal whether an account exists for it.
        return { inviteCode: code.code }
      },
    ),
})

/**
 * Discard a draft bondfire (the "Discard" side of the resume prompt).
 * Invalidates its invite codes and claims.
 */
export const discardDraftBondfire = mutation({
  args: {
    bondfireId: v.id('bondfires'),
  },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx)

    const bondfire = await ctx.db.get(args.bondfireId)
    if (!bondfire || bondfire.userId !== user._id) {
      throwUserError('Bondfire not found')
    }
    if (bondfire.status !== 'draft') {
      throwUserError('This bondfire is no longer a draft.')
    }

    await deleteDraftBondfireCascade(ctx, bondfire)
  },
})

/**
 * Hourly cron: delete draft bondfires whose 24h recording window lapsed,
 * invalidating their invite codes and claims. Draft activation happens inline
 * in videos.ts (`createPendingMuxVideo` / `createLinkedMuxLiveSession`).
 */
export const cleanupExpiredDrafts = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now()
    const expired = await ctx.db
      .query('bondfires')
      .withIndex('by_status', (q) => q.eq('status', 'draft').lte('draftExpiresAt', now))
      .take(DRAFT_CLEANUP_BATCH_SIZE)

    for (const bondfire of expired) {
      await deleteDraftBondfireCascade(ctx, bondfire)
    }

    // A backlog larger than one batch drains via immediate re-runs instead of
    // silently waiting for the next hourly tick.
    if (expired.length === DRAFT_CLEANUP_BATCH_SIZE) {
      await ctx.scheduler.runAfter(0, internal.personalBondfires.cleanupExpiredDrafts, {})
    }

    return { deleted: expired.length }
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
    const activeCount = await getActivePersonalBondfireParticipantCount(ctx, args.bondfireId)
    const tier = await getEntitlementSubscriptionTier(ctx, user._id)
    if (!PAID_TIERS.includes(tier)) {
      throwUserError('A Hearth requires a Plus, Premium, or Pro subscription.')
    }
    const cap = getPersonalBondfireParticipantCap(tier)

    if (activeCount >= cap) {
      if (tier === 'plus') {
        throwUserError('Upgrade to Premium or Pro to invite more people to your Hearth.')
      }
      throwUserError('This fire is full.')
    }

    const result =
      (await findReusableInviteCode(ctx, {
        parentType: 'personal-bondfire',
        parentId: args.bondfireId,
        createdBy: user._id,
      })) ??
      (await generateAndInsertInviteCode(ctx, {
        parentType: 'personal-bondfire',
        parentId: args.bondfireId,
        createdBy: user._id,
        expiresInDays: 7,
      }))

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

  // Draft bondfires are joinable: an invitee lands on the "waiting to start
  // recording" screen (videoStatus 'pending') and is already in the audience
  // when the owner goes live — same experience as a directly-invited user.
  await assertPersonalCampActive(
    ctx,
    bondfire.personalCampId,
    'The hearth is currently unavailable. The owner may have cancelled their subscription.',
  )

  const participant = await ensureActivePersonalBondfireParticipant(ctx, {
    bondfire,
    userId: user._id,
    errorAudience: 'invitee',
  })
  if (!participant.added) {
    return { bondfireId: bondfire._id, alreadyJoined: true }
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

    await deleteBondfireInviteArtifacts(ctx, args.bondfireId)

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
    const activeCount = await getActivePersonalBondfireParticipantCount(ctx, bondfire._id)
    const owner = await ctx.db.get(bondfire.userId)
    const ownerTier = owner ? await getEntitlementSubscriptionTier(ctx, owner._id) : 'free'
    const cap = getPersonalBondfireParticipantCap(ownerTier)
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
 * The current user's in-progress draft bondfire, if any. Drives the
 * resume/discard prompt on the create screen.
 */
export const getMyDraftBondfire = query({
  args: {},
  handler: async (ctx) => {
    const userId = await auth.getUserId(ctx)
    if (!userId) {
      return null
    }

    const draft = await findDraftBondfireForUser(ctx, userId)
    if (!draft || isDraftExpired(draft, Date.now())) {
      return null
    }

    return {
      _id: draft._id,
      title: draft.title,
      createdAt: draft.createdAt,
      draftExpiresAt: draft.draftExpiresAt,
      participantCount: await getActivePersonalBondfireParticipantCount(ctx, draft._id),
    }
  },
})

type InviteCandidate = {
  _id: Id<'users'>
  displayName?: string
  name?: string
  photoUrl?: string
}

function toInviteCandidate(user: Doc<'users'>): InviteCandidate {
  return {
    _id: user._id,
    displayName: user.displayName,
    name: user.name,
    photoUrl: user.photoUrl,
  }
}

/**
 * People the user can invite from the pre-recording screen: their Close
 * Circle pins plus Recent Connections — anyone they shared a Hearth bondfire
 * with (participants and responders, either direction) in the last 30 days,
 * newest interaction first, capped at 20.
 */
export const getInviteCandidates = query({
  args: {},
  handler: async (ctx) => {
    const userId = await auth.getUserId(ctx)
    if (!userId) {
      return { closeCircle: [], recentConnections: [], participantCap: 2 }
    }

    const tier = await getEntitlementSubscriptionTier(ctx, userId)
    const participantCap = getPersonalBondfireParticipantCap(tier)

    const pins = await ctx.db
      .query('closeCirclePins')
      .withIndex('by_owner', (q) => q.eq('ownerId', userId))
      .take(CLOSE_CIRCLE_LIMIT)
    const closeCircleUsers = (
      await Promise.all(pins.map((pin) => ctx.db.get(pin.pinnedUserId)))
    ).filter((user): user is Doc<'users'> => user !== null)
    const closeCircleIds = new Set(closeCircleUsers.map((user) => user._id))

    const cutoff = Date.now() - RECENT_CONNECTION_WINDOW_MS
    const latestByUser = new Map<Id<'users'>, number>()
    const bump = (candidateId: Id<'users'>, timestamp: number) => {
      if (candidateId === userId || timestamp < cutoff) {
        return
      }
      latestByUser.set(candidateId, Math.max(latestByUser.get(candidateId) ?? 0, timestamp))
    }

    // People in the user's own recent bondfires: participants + responders.
    const myBondfires = await ctx.db
      .query('bondfires')
      .withIndex('by_user', (q) => q.eq('userId', userId))
      .order('desc')
      .take(RECENT_CONNECTION_BONDFIRE_SCAN_LIMIT)
    for (const bondfire of myBondfires) {
      const participants = await ctx.db
        .query('personalBondfireParticipants')
        .withIndex('by_bondfire_status', (q) =>
          q.eq('bondfireId', bondfire._id).eq('status', 'active'),
        )
        .collect()
      for (const participant of participants) {
        bump(participant.userId, participant.joinedAt)
      }

      const responses = await ctx.db
        .query('bondfireVideos')
        .withIndex('by_bondfire', (q) => q.eq('bondfireId', bondfire._id))
        .collect()
      for (const response of responses) {
        bump(response.userId, response.createdAt)
      }
    }

    // Owners and co-participants from Hearth bondfires the user joined. The
    // original owner-only scan above covers invitations sent by this user;
    // this reverse lookup is what makes "recent connections" bidirectional.
    const myParticipations = await ctx.db
      .query('personalBondfireParticipants')
      .withIndex('by_user', (q) => q.eq('userId', userId).gte('joinedAt', cutoff))
      .order('desc')
      .take(RECENT_CONNECTION_PARTICIPATION_SCAN_LIMIT)
    for (const participation of myParticipations) {
      const bondfire = await ctx.db.get(participation.bondfireId)
      if (!bondfire) continue

      bump(bondfire.userId, participation.joinedAt)
      if (participation.status !== 'active') continue

      const coParticipants = await ctx.db
        .query('personalBondfireParticipants')
        .withIndex('by_bondfire_status', (q) =>
          q.eq('bondfireId', bondfire._id).eq('status', 'active'),
        )
        .collect()
      for (const coParticipant of coParticipants) {
        bump(coParticipant.userId, Math.max(participation.joinedAt, coParticipant.joinedAt))
      }
    }

    // Creators of bondfires the user recently responded to.
    const myResponses = await ctx.db
      .query('bondfireVideos')
      .withIndex('by_user', (q) => q.eq('userId', userId).gte('createdAt', cutoff))
      .order('desc')
      .take(50)
    for (const response of myResponses) {
      const bondfire = await ctx.db.get(response.bondfireId)
      if (bondfire) {
        bump(bondfire.userId, response.createdAt)
      }
    }

    const recentIds = [...latestByUser.entries()]
      .filter(([candidateId]) => !closeCircleIds.has(candidateId))
      .sort((a, b) => b[1] - a[1])
      .slice(0, RECENT_CONNECTIONS_LIMIT)
      .map(([candidateId]) => candidateId)
    const recentUsers = (
      await Promise.all(recentIds.map((candidateId) => ctx.db.get(candidateId)))
    ).filter((user): user is Doc<'users'> => user !== null)

    return {
      closeCircle: closeCircleUsers.map(toInviteCandidate),
      recentConnections: recentUsers.map(toInviteCandidate),
      participantCap,
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
        participantCount: await getActivePersonalBondfireParticipantCount(ctx, bondfire._id),
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

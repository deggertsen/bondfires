import type { Id } from '../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../_generated/server'

/** maintenanceJobRuns.job. Readers use the activity index only after this completes. */
export const THREAD_MEMBERSHIP_JOB = 'thread-membership-index'

export async function threadMembershipIndexReady(ctx: QueryCtx | MutationCtx) {
  const run = await ctx.db
    .query('maintenanceJobRuns')
    .withIndex('by_job', (q) => q.eq('job', THREAD_MEMBERSHIP_JOB))
    .first()
  return run?.status === 'complete'
}

async function ensureThreadMember(
  ctx: MutationCtx,
  userId: Id<'users'>,
  bondfireId: Id<'bondfires'>,
  lastActivityAt: number,
) {
  const existing = await ctx.db
    .query('threadMemberships')
    .withIndex('by_user_bondfire', (q) => q.eq('userId', userId).eq('bondfireId', bondfireId))
    .unique()
  if (!existing) {
    await ctx.db.insert('threadMemberships', { userId, bondfireId, lastActivityAt })
    return
  }
  if (existing.lastActivityAt < lastActivityAt) {
    await ctx.db.patch(existing._id, { lastActivityAt })
  }
}

/**
 * Remember that this user can see the thread, and optionally move every
 * participant's copy of lastActivityAt forward. Drafts stay off the index;
 * activation records the owner once a recording exists. Pending responses
 * pass bump:false so the thread shows up without sorting above playable activity.
 */
export async function recordThreadParticipant(
  ctx: MutationCtx,
  args: {
    userId: Id<'users'>
    bondfireId: Id<'bondfires'>
    activityAt: number
    bump: boolean
  },
) {
  const bondfire = await ctx.db.get(args.bondfireId)
  if (!bondfire || bondfire.status === 'draft') return
  const current = Math.max(bondfire.threadLastActivityAt ?? 0, bondfire.createdAt)
  const activityAt = args.bump ? Math.max(current, args.activityAt) : current
  await ensureThreadMember(ctx, args.userId, args.bondfireId, activityAt)
  if (!args.bump || activityAt <= (bondfire.threadLastActivityAt ?? 0)) return
  await ctx.db.patch(bondfire._id, { threadLastActivityAt: activityAt })
  const members = await ctx.db
    .query('threadMemberships')
    .withIndex('by_bondfire', (q) => q.eq('bondfireId', args.bondfireId))
    .collect()
  for (const member of members) {
    if (member.lastActivityAt < activityAt) {
      await ctx.db.patch(member._id, { lastActivityAt: activityAt })
    }
  }
}

export async function deleteThreadMemberships(ctx: MutationCtx, bondfireId: Id<'bondfires'>) {
  const members = await ctx.db
    .query('threadMemberships')
    .withIndex('by_bondfire', (q) => q.eq('bondfireId', bondfireId))
    .collect()
  for (const member of members) await ctx.db.delete(member._id)
}

/** Drop a responder whose last response just disappeared. Owners stay. */
export async function releaseThreadParticipant(
  ctx: MutationCtx,
  userId: Id<'users'>,
  bondfireId: Id<'bondfires'>,
) {
  const bondfire = await ctx.db.get(bondfireId)
  if (!bondfire || bondfire.userId === userId) return
  const remaining = await ctx.db
    .query('bondfireVideos')
    .withIndex('by_bondfire_user', (q) => q.eq('bondfireId', bondfireId).eq('userId', userId))
    .first()
  if (remaining) return
  const membership = await ctx.db
    .query('threadMemberships')
    .withIndex('by_user_bondfire', (q) => q.eq('userId', userId).eq('bondfireId', bondfireId))
    .unique()
  if (membership) await ctx.db.delete(membership._id)
}

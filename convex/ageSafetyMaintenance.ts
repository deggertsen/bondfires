import { v } from 'convex/values'
import { internal } from './_generated/api'
import { internalMutation } from './_generated/server'
import { getCampAgeBand, getPersonalCampAgeBand, getUserAgeBand } from './agePolicy'

const PAGE_SIZE = 100
const AGE_BAND_REASON = 'Age-group access changed; membership disabled automatically.'

/**
 * Zero-downtime production backfill. Existing standard camps intentionally
 * become adult-only. Unknown historical audiences are never inferred from the
 * current owner age because that could expose old content across the boundary.
 */
export const backfillAgeBands = internalMutation({
  args: { cursor: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query('camps')
      .paginate({ cursor: args.cursor ?? null, numItems: PAGE_SIZE })
    let updated = 0
    for (const camp of page.page) {
      if (!camp.ageBand) {
        await ctx.db.patch(camp._id, { ageBand: 'adult', updatedAt: Date.now() })
        updated++
      }
    }
    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.ageSafetyMaintenance.backfillAgeBands, {
        cursor: page.continueCursor,
      })
    }
    return { scanned: page.page.length, updated, done: page.isDone }
  },
})

export const backfillPersonalCampAgeBands = internalMutation({
  args: { cursor: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query('personalCamps')
      .paginate({ cursor: args.cursor ?? null, numItems: PAGE_SIZE })
    let updated = 0
    for (const camp of page.page) {
      if (!camp.ageBand) {
        await ctx.db.patch(camp._id, { ageBand: 'adult', updatedAt: Date.now() })
        updated++
      }
    }
    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.ageSafetyMaintenance.backfillPersonalCampAgeBands, {
        cursor: page.continueCursor,
      })
    }
    return { scanned: page.page.length, updated, done: page.isDone }
  },
})

/** Birthday-safe cleanup for camp memberships. Reads already deny immediately. */
export const reconcileCampMemberships = internalMutation({
  args: { cursor: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query('campMembers')
      .paginate({ cursor: args.cursor ?? null, numItems: PAGE_SIZE })
    let disabled = 0
    const changedCampIds = new Set<(typeof page.page)[number]['campId']>()
    for (const membership of page.page) {
      if (membership.status !== 'active' && membership.status !== 'pending') continue
      const [user, camp] = await Promise.all([
        ctx.db.get(membership.userId),
        ctx.db.get(membership.campId),
      ])
      if (!user || !camp || getUserAgeBand(user) !== getCampAgeBand(camp)) {
        const now = Date.now()
        await ctx.db.patch(membership._id, {
          status: 'rejected',
          moderationReason: AGE_BAND_REASON,
          rejectedAt: now,
          updatedAt: now,
        })
        changedCampIds.add(membership.campId)
        disabled++
      }
    }
    for (const campId of changedCampIds) {
      const active = await ctx.db
        .query('campMembers')
        .withIndex('by_camp_status', (q) => q.eq('campId', campId).eq('status', 'active'))
        .collect()
      await ctx.db.patch(campId, { activeMemberCount: active.length, updatedAt: Date.now() })
    }
    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.ageSafetyMaintenance.reconcileCampMemberships, {
        cursor: page.continueCursor,
      })
    }
    return { scanned: page.page.length, disabled, done: page.isDone }
  },
})

/** Remove stale Hearth participants after birthdays or a legacy-data backfill. */
export const reconcileHearthParticipants = internalMutation({
  args: { cursor: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query('personalBondfireParticipants')
      .paginate({ cursor: args.cursor ?? null, numItems: PAGE_SIZE })
    let removed = 0
    for (const participant of page.page) {
      if (participant.status !== 'active') continue
      const [user, bondfire] = await Promise.all([
        ctx.db.get(participant.userId),
        ctx.db.get(participant.bondfireId),
      ])
      const personalCamp = bondfire?.personalCampId
        ? await ctx.db.get(bondfire.personalCampId)
        : null
      const owner = bondfire ? await ctx.db.get(bondfire.userId) : null
      const band = personalCamp ? getPersonalCampAgeBand(personalCamp) : null
      if (
        !user ||
        !owner ||
        !band ||
        getUserAgeBand(user) !== band ||
        getUserAgeBand(owner) !== band
      ) {
        const now = Date.now()
        await ctx.db.patch(participant._id, {
          status: 'removed',
          removedAt: now,
          updatedAt: now,
        })
        removed++
      }
    }
    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.ageSafetyMaintenance.reconcileHearthParticipants, {
        cursor: page.continueCursor,
      })
    }
    return { scanned: page.page.length, removed, done: page.isDone }
  },
})

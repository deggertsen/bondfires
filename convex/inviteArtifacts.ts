import type { Id } from './_generated/dataModel'
import type { MutationCtx } from './_generated/server'

/**
 * Remove every invite artifact that can outlive a deleted bondfire.
 *
 * Both invite-code parent types are included because older Hearth share paths
 * minted plain `bondfire` codes. Notifications are keyed by bondfire so batch
 * retention and account-deletion jobs do not need to scan recipients' inboxes.
 */
export async function deleteBondfireInviteArtifacts(ctx: MutationCtx, bondfireId: Id<'bondfires'>) {
  const [bondfireCodes, personalBondfireCodes, claims, legacyInvites, notifications] =
    await Promise.all([
      ctx.db
        .query('inviteCodes')
        .withIndex('by_parent', (q) => q.eq('parentType', 'bondfire').eq('parentId', bondfireId))
        .collect(),
      ctx.db
        .query('inviteCodes')
        .withIndex('by_parent', (q) =>
          q.eq('parentType', 'personal-bondfire').eq('parentId', bondfireId),
        )
        .collect(),
      ctx.db
        .query('inviteClaims')
        .withIndex('by_bondfire_claimer', (q) => q.eq('bondfireId', bondfireId))
        .collect(),
      ctx.db
        .query('bondfireInvites')
        .withIndex('by_bondfire_recipient', (q) => q.eq('bondfireId', bondfireId))
        .collect(),
      ctx.db
        .query('notifications')
        .withIndex('by_bondfire', (q) => q.eq('bondfireId', bondfireId))
        .collect(),
    ])

  for (const notification of notifications) {
    await ctx.db.delete(notification._id)
  }

  for (const code of [...bondfireCodes, ...personalBondfireCodes]) {
    await ctx.db.delete(code._id)
  }
  for (const claim of claims) {
    await ctx.db.delete(claim._id)
  }
  for (const invite of legacyInvites) {
    await ctx.db.delete(invite._id)
  }
}

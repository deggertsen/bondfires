import type { Doc } from './_generated/dataModel'
import { internalAction, type MutationCtx } from './_generated/server'

type MediaKind = Doc<'retentionMedia'>['kind']
export async function enqueueRetentionMedia(ctx: MutationCtx, kind: MediaKind, externalId: string) {
  const existing = await ctx.db
    .query('retentionMedia')
    .withIndex('by_external', (q) => q.eq('kind', kind).eq('externalId', externalId))
    .first()
  if (!existing) {
    await ctx.db.insert('retentionMedia', {
      kind,
      externalId,
      attempts: 0,
      nextAttemptAt: Date.now(),
    })
  }
}

/** Compatibility for jobs queued before retirement. Preserve the external
 * resource ledger for operator cleanup; never claim that assets were deleted. */
export const drain = internalAction({
  args: {},
  handler: async () => ({ processed: 0, failed: 0, retired: true }),
})

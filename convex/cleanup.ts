import { internalMutation } from './_generated/server'
import { startRetentionSweep } from './bondfireRetention'

/**
 * Archived Camps use the same atomic claim / durable cleanup as thread
 * retention. The old independent Mux and DB snapshots are intentionally gone.
 */
export const dailyCleanupArchivedCamps = internalMutation({
  args: {},
  handler: async (ctx) => await startRetentionSweep(ctx, 'camp'),
})

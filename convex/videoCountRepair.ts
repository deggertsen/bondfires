import { v } from 'convex/values'
import { internal } from './_generated/api'
import { internalMutation } from './_generated/server'
import { isPlayableVideoRecord } from './bondfires'

// ── videoCount repair / drift monitor ───────────────────────────────────────
//
// bondfire.videoCount is denormalized and maintained by
// countResponse/uncountResponse (responseCounts.ts). This job makes drift a
// monitored, self-healing invariant instead of a silent UX bug:
//
// 1. Backfills `countedAt` on legacy rows (created before the marker existed)
//    that are playable, and clears it from errored rows.
// 2. Recomputes videoCount = 1 (spark) + counted responses, patching and
//    logging a `video:count_drift` event whenever the stored value disagrees.
//
// Runs daily via crons.ts and self-paginates through the bondfires table so
// each mutation stays small. Safe to run at any time, any number of times.
// Run it once manually (dashboard → repairVideoCounts {}) right after
// deploying the countedAt change to heal pre-existing drift immediately.

const DEFAULT_BATCH_SIZE = 50

export const repairVideoCounts = internalMutation({
  args: {
    cursor: v.optional(v.string()),
    batchSize: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const batchSize = args.batchSize ?? DEFAULT_BATCH_SIZE
    const page = await ctx.db
      .query('bondfires')
      .paginate({ numItems: batchSize, cursor: args.cursor ?? null })

    let repaired = 0

    for (const bondfire of page.page) {
      const videos = await ctx.db
        .query('bondfireVideos')
        .withIndex('by_bondfire', (q) => q.eq('bondfireId', bondfire._id))
        .collect()

      let countedResponses = 0
      for (const video of videos) {
        const status = video.videoStatus ?? 'ready'

        if (status === 'errored') {
          if (video.countedAt !== undefined) {
            await ctx.db.patch(video._id, { countedAt: undefined })
          }
          continue
        }

        if (video.countedAt === undefined && isPlayableVideoRecord(video)) {
          // Legacy row counted under the old scheme (or a row whose counting
          // webhook raced the deploy) — adopt it into the marker system.
          await ctx.db.patch(video._id, { countedAt: video.createdAt })
        }

        if (video.countedAt !== undefined || isPlayableVideoRecord(video)) {
          countedResponses += 1
        }
      }

      const expected = 1 + countedResponses
      if (bondfire.videoCount !== expected) {
        repaired += 1
        await ctx.db.patch(bondfire._id, {
          videoCount: expected,
          updatedAt: Date.now(),
        })
        await ctx.db.insert('clientLogs', {
          level: 'warn',
          event: 'video:count_drift',
          message: 'bondfire.videoCount disagreed with counted response rows',
          data: {
            bondfireId: bondfire._id,
            stored: bondfire.videoCount,
            expected,
            responses: videos.length,
          },
          platform: 'server',
          createdAt: Date.now(),
        })
      }
    }

    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.videoCountRepair.repairVideoCounts, {
        cursor: page.continueCursor,
        batchSize,
      })
    }

    return { processed: page.page.length, repaired, isDone: page.isDone }
  },
})

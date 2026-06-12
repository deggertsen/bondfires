import type { Doc } from './_generated/dataModel'
import type { MutationCtx } from './_generated/server'

// ── Response counting ────────────────────────────────────────────────────────
//
// bondfire.videoCount and user.responseCount are denormalized counters. Every
// increment/decrement flows through these two helpers, keyed on the response
// row's `countedAt` marker, so retried webhooks, the stale-session reaper,
// client cancels, and account deletion are all idempotent by construction.
//
// A response is counted when it first becomes watchable:
// - live responses: at the video.live_stream.active webhook
// - upload responses: at markRecordReady (asset.ready webhook / VOD poller)
// - addResponse: immediately, since the row is inserted already 'ready'
//
// It is uncounted when it transitions to 'errored' or is deleted. Legacy rows
// (created before countedAt existed) are healed by the repairVideoCounts
// migration/cron, which backfills countedAt and recomputes videoCount from
// the rows themselves.

/** Count a response toward its bondfire and responder. No-op if already counted. */
export async function countResponse(ctx: MutationCtx, video: Doc<'bondfireVideos'>) {
  if (video.countedAt !== undefined) {
    return
  }

  const now = Date.now()
  await ctx.db.patch(video._id, { countedAt: now })

  const [bondfire, user] = await Promise.all([
    ctx.db.get(video.bondfireId),
    ctx.db.get(video.userId),
  ])

  if (bondfire) {
    await ctx.db.patch(video.bondfireId, {
      videoCount: bondfire.videoCount + 1,
      updatedAt: now,
    })
  }

  if (user) {
    await ctx.db.patch(video.userId, {
      responseCount: (user.responseCount ?? 0) + 1,
      updatedAt: now,
    })
  }
}

/**
 * Remove a previously counted response from its bondfire and responder.
 * No-op if the row was never counted (or already uncounted), so calling it
 * from multiple terminal paths (errored webhook → cancel retry → delete)
 * can't double-decrement.
 */
export async function uncountResponse(ctx: MutationCtx, video: Doc<'bondfireVideos'>) {
  if (video.countedAt === undefined) {
    return
  }

  const now = Date.now()
  await ctx.db.patch(video._id, { countedAt: undefined })

  const [bondfire, user] = await Promise.all([
    ctx.db.get(video.bondfireId),
    ctx.db.get(video.userId),
  ])

  if (bondfire) {
    await ctx.db.patch(video.bondfireId, {
      videoCount: Math.max(1, bondfire.videoCount - 1),
      updatedAt: now,
    })
  }

  if (user) {
    await ctx.db.patch(video.userId, {
      responseCount: Math.max(0, (user.responseCount ?? 0) - 1),
      updatedAt: now,
    })
  }
}

import { v } from 'convex/values'
import { query } from './_generated/server'
import { auth } from './auth'
import { buildViewerVisibilityContext, isBondfireVisibleToViewer } from './bondfireVisibility'

export const getByBondfireId = query({
  args: { bondfireId: v.id('bondfires') },
  handler: async (ctx, args) => {
    const bondfire = await ctx.db.get(args.bondfireId)
    if (!bondfire?.liveSessionId) {
      return null
    }
    const viewer = await buildViewerVisibilityContext(ctx, await auth.getUserId(ctx))
    if (!(await isBondfireVisibleToViewer(ctx, bondfire, viewer))) {
      return null
    }

    return await ctx.db.get(bondfire.liveSessionId)
  },
})

export const listMyActive = query({
  args: {},
  handler: async (ctx) => {
    const userId = await auth.getUserId(ctx)
    if (!userId) {
      return []
    }

    const sessions = await ctx.db
      .query('liveSessions')
      .withIndex('by_user', (q) => q.eq('userId', userId))
      .order('desc')
      .take(20)

    // 'ending' is intentionally excluded: those sessions were cleanly stopped
    // and are finalizing their recorded VOD on Mux. The screen's orphan-sweep
    // cancels whatever this returns with reason 'crash_recovery' — cancelling an
    // 'ending' session there destroys the just-recorded video before Mux saves
    // it. Truly stuck 'ending' sessions are reclaimed by the 5-minute stale cron.
    return sessions.filter((session) => ['created', 'starting', 'live'].includes(session.status))
  },
})

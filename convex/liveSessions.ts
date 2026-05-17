import { v } from 'convex/values'
import { query } from './_generated/server'
import { auth } from './auth'

export const getByBondfireId = query({
  args: { bondfireId: v.id('bondfires') },
  handler: async (ctx, args) => {
    const bondfire = await ctx.db.get(args.bondfireId)
    if (!bondfire?.liveSessionId) {
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

    return sessions.filter((session) =>
      ['created', 'starting', 'live', 'ending'].includes(session.status),
    )
  },
})

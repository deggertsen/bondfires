import { v } from 'convex/values'
import { mutation, query } from './_generated/server'

/**
 * Public configuration that the app can read without authentication.
 * Used for things like minimum-app-version gating.
 */

// ----------------------------------------------------------------
// Query: get min app version
// ----------------------------------------------------------------

export const getMinVersion = query({
  handler: async (ctx) => {
    const config = await ctx.db
      .query('publicConfig')
      .withIndex('by_key', (q) => q.eq('key', 'minAppVersion'))
      .first()

    return config?.value ?? null
  },
})

// ----------------------------------------------------------------
// Mutation: admin upsert config
// ----------------------------------------------------------------

export const setMinVersion = mutation({
  args: {
    version: v.string(),
  },
  handler: async (ctx, args) => {
    // Find existing
    const existing = await ctx.db
      .query('publicConfig')
      .withIndex('by_key', (q) => q.eq('key', 'minAppVersion'))
      .first()

    if (existing) {
      await ctx.db.patch(existing._id, {
        value: args.version,
        updatedAt: Date.now(),
      })
    } else {
      await ctx.db.insert('publicConfig', {
        key: 'minAppVersion',
        value: args.version,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
    }

    return { success: true, minAppVersion: args.version }
  },
})

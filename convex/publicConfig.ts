import { v } from 'convex/values'
import { mutation, query } from './_generated/server'

/**
 * Public configuration that the app can read without authentication.
 * Used for things like minimum-app-version gating and update policy.
 */

// ----------------------------------------------------------------
// Query: get update config
// ----------------------------------------------------------------

export const getUpdateConfig = query({
  handler: async (ctx) => {
    const [minVersionDoc, updatePriorityDoc] = await Promise.all([
      ctx.db
        .query('publicConfig')
        .withIndex('by_key', (q) => q.eq('key', 'minAppVersion'))
        .first(),
      ctx.db
        .query('publicConfig')
        .withIndex('by_key', (q) => q.eq('key', 'updatePriority'))
        .first(),
    ])

    return {
      minAppVersion: minVersionDoc?.value ?? null,
      // "flexible" = background download (Android), "immediate" = blocking modal
      updatePriority: updatePriorityDoc?.value === 'flexible' ? 'flexible' : 'immediate',
    }
  },
})

// ----------------------------------------------------------------
// Query: get min app version only (backward compat)
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
// Mutation: set min app version + update priority
// ----------------------------------------------------------------

export const setMinVersion = mutation({
  args: {
    version: v.string(),
    updatePriority: v.optional(v.union(v.literal('flexible'), v.literal('immediate'))),
  },
  handler: async (ctx, args) => {
    const updatePriority = args.updatePriority ?? 'immediate'

    // Upsert minAppVersion
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

    // Upsert updatePriority. The release script omits this arg, which should reset to immediate.
    const existingPriority = await ctx.db
      .query('publicConfig')
      .withIndex('by_key', (q) => q.eq('key', 'updatePriority'))
      .first()

    if (existingPriority) {
      await ctx.db.patch(existingPriority._id, {
        value: updatePriority,
        updatedAt: Date.now(),
      })
    } else {
      await ctx.db.insert('publicConfig', {
        key: 'updatePriority',
        value: updatePriority,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
    }

    return { success: true, minAppVersion: args.version, updatePriority }
  },
})

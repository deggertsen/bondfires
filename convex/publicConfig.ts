import { v } from 'convex/values'
import type { MutationCtx, QueryCtx } from './_generated/server'
import { mutation, query } from './_generated/server'
import { auth } from './auth'
import { normalizeAppVersion, type UpdatePriority } from './lib/appVersion'

function normalizeUpdatePriority(value: string | undefined): UpdatePriority {
  return value === 'flexible' ? 'flexible' : 'immediate'
}

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
      updatePriority: normalizeUpdatePriority(updatePriorityDoc?.value),
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

async function requireAdmin(ctx: QueryCtx | MutationCtx) {
  const currentUserId = await auth.getUserId(ctx)
  if (!currentUserId) {
    throw new Error('Not authenticated')
  }

  const currentUser = await ctx.db.get(currentUserId)
  if (!currentUser || (currentUser.role !== 'admin' && currentUser.isAdmin !== true)) {
    throw new Error('Admin access required')
  }

  return currentUser
}

/**
 * Admin-only view of update policy for the profile management UI.
 * The app-wide update gate continues to use the intentionally public query above.
 */
export const getAdminUpdateConfig = query({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx)

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
      updatePriority: normalizeUpdatePriority(updatePriorityDoc?.value),
      updatedAt: Math.max(minVersionDoc?.updatedAt ?? 0, updatePriorityDoc?.updatedAt ?? 0) || null,
    }
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
    const currentUser = await requireAdmin(ctx)
    const version = normalizeAppVersion(args.version)
    const updatePriority = args.updatePriority ?? 'immediate'
    const now = Date.now()

    // Upsert minAppVersion
    const existing = await ctx.db
      .query('publicConfig')
      .withIndex('by_key', (q) => q.eq('key', 'minAppVersion'))
      .first()

    if (existing) {
      await ctx.db.patch(existing._id, {
        value: version,
        updatedAt: now,
      })
    } else {
      await ctx.db.insert('publicConfig', {
        key: 'minAppVersion',
        value: version,
        createdAt: now,
        updatedAt: now,
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
        updatedAt: now,
      })
    } else {
      await ctx.db.insert('publicConfig', {
        key: 'updatePriority',
        value: updatePriority,
        createdAt: now,
        updatedAt: now,
      })
    }

    await ctx.db.insert('adminAuditLog', {
      adminId: currentUser._id,
      action: 'public_config_update',
      targetType: 'config',
      targetId: 'minimum-app-version',
      metadata: {
        previousVersion: existing?.value,
        newVersion: version,
        previousUpdatePriority: existingPriority?.value,
        newUpdatePriority: updatePriority,
      },
      createdAt: now,
    })

    return { success: true, minAppVersion: version, updatePriority, updatedAt: now }
  },
})

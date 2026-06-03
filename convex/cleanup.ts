import { v } from 'convex/values'
import { internal } from './_generated/api'
import type { Id } from './_generated/dataModel'
import { internalAction, internalMutation, internalQuery } from './_generated/server'

/** 30 days in milliseconds — retention window before hard-deleting archived camps. */
const ARCHIVE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000

// ── Internal Query: Find camps past retention ──

export const listArchivedCampsPastRetention = internalQuery({
  handler: async (ctx) => {
    const now = Date.now()
    const cutoff = now - ARCHIVE_RETENTION_MS

    const allCamps = await ctx.db.query('camps').collect()
    return allCamps.filter(
      (camp) =>
        camp.status === 'archived' &&
        camp.isLaunchCamp !== true &&
        camp.archivedAt !== undefined &&
        camp.archivedAt <= cutoff,
    )
  },
})

// ── Internal Query: Collect Mux asset IDs from a camp's bondfires ──

export const getArchivedCampMuxAssets = internalQuery({
  args: {
    campId: v.id('camps'),
  },
  handler: async (ctx, args) => {
    const bondfires = await ctx.db
      .query('bondfires')
      .withIndex('by_camp', (q) => q.eq('campId', args.campId))
      .collect()

    const muxAssetIds: string[] = []

    for (const bondfire of bondfires) {
      if (bondfire.muxAssetId) {
        muxAssetIds.push(bondfire.muxAssetId)
      }

      const responses = await ctx.db
        .query('bondfireVideos')
        .withIndex('by_bondfire', (q) => q.eq('bondfireId', bondfire._id))
        .collect()

      for (const response of responses) {
        if (response.muxAssetId) {
          muxAssetIds.push(response.muxAssetId)
        }
      }
    }

    return muxAssetIds
  },
})

// ── Internal Action: Delete Mux assets for camps past retention ──

/**
 * Deletes Mux video assets for all bondfires in camps past the 30-day retention window.
 * Must run as an action (not mutation) because it makes external HTTP calls.
 */
export const deleteArchivedCampMuxAssets = internalAction({
  args: {
    campIds: v.array(v.id('camps')),
  },
  handler: async (ctx, args) => {
    let deleted = 0
    let missing = 0

    const config = getCleanupMuxConfig()

    for (const campId of args.campIds) {
      const muxAssetIds = await ctx.runQuery(internal.cleanup.getArchivedCampMuxAssets, {
        campId,
      })

      for (const assetId of muxAssetIds) {
        try {
          const response = await fetch(`https://api.mux.com/video/v1/assets/${assetId}`, {
            method: 'DELETE',
            headers: {
              Accept: 'application/json',
              Authorization: getMuxAuthorizationHeader(config.tokenId, config.tokenSecret),
            },
          })

          if (response.status === 404) {
            missing += 1
          } else if (response.ok) {
            deleted += 1
          } else {
            console.warn(`[cleanup] Mux delete failed for asset ${assetId}: ${response.status}`)
          }
        } catch (err) {
          console.warn(`[cleanup] Mux delete error for asset ${assetId}:`, err)
        }
      }
    }

    console.warn(`[cleanup] Mux assets: ${deleted} deleted, ${missing} missing`)
    return { deletedMuxAssets: deleted, missingMuxAssets: missing }
  },
})

// ── Internal Mutation: Delete all Convex data for archived camps ──

export const deleteArchivedCampData = internalMutation({
  args: {
    campIds: v.array(v.id('camps')),
  },
  handler: async (ctx, args) => {
    if (args.campIds.length === 0) {
      return { cleaned: 0, totalBondfires: 0, totalMemberships: 0, totalInvites: 0 }
    }

    let totalBondfires = 0
    let totalMemberships = 0
    let totalInvites = 0
    let cleaned = 0

    for (const campId of args.campIds) {
      const camp = await ctx.db.get(campId)
      if (!camp) continue

      // Safety: never delete launch camps
      if (camp.isLaunchCamp === true) {
        console.warn(`[cleanup] Skipping launch camp ${camp.slug} (${camp._id})`)
        continue
      }

      // Safety: only delete archived camps past retention
      if (camp.status !== 'archived') {
        console.warn(`[cleanup] Skipping non-archived camp ${camp.slug} (${camp._id})`)
        continue
      }

      // Delete all bondfires and their response videos
      const bondfires = await ctx.db
        .query('bondfires')
        .withIndex('by_camp', (q) => q.eq('campId', camp._id))
        .collect()

      for (const bondfire of bondfires) {
        // Delete response videos
        const responses = await ctx.db
          .query('bondfireVideos')
          .withIndex('by_bondfire', (q) => q.eq('bondfireId', bondfire._id))
          .collect()

        for (const response of responses) {
          await ctx.db.delete(response._id)
        }

        // Delete live session if present
        if (bondfire.liveSessionId) {
          await ctx.db.delete(bondfire.liveSessionId)
        }

        await ctx.db.delete(bondfire._id)
      }

      totalBondfires += bondfires.length

      // Delete all memberships
      const memberships = await ctx.db
        .query('campMembers')
        .withIndex('by_camp', (q) => q.eq('campId', camp._id))
        .collect()

      for (const membership of memberships) {
        await ctx.db.delete(membership._id)
      }

      totalMemberships += memberships.length

      // Delete all invites
      const invites = await ctx.db
        .query('campInvites')
        .withIndex('by_camp', (q) => q.eq('campId', camp._id))
        .collect()

      for (const invite of invites) {
        await ctx.db.delete(invite._id)
      }

      totalInvites += invites.length

      // Delete the camp itself
      await ctx.db.delete(camp._id)
      cleaned += 1

      console.warn(
        `[cleanup] Deleted archived camp ${camp.slug} (${camp._id}): ${bondfires.length} bondfires, ${memberships.length} memberships, ${invites.length} invites`,
      )
    }

    console.warn(
      `[cleanup] Summary: ${cleaned} camps cleaned, ${totalBondfires} bondfires, ${totalMemberships} memberships, ${totalInvites} invites`,
    )

    return {
      cleaned,
      totalBondfires,
      totalMemberships,
      totalInvites,
    }
  },
})

// ── Daily Cleanup Action (called by cron) ──

/**
 * Orchestrates the daily cleanup of archived camps past the 30-day retention window.
 * 1. Finds camps past retention
 * 2. Deletes their Mux video assets
 * 3. Deletes their Convex data (bondfires, memberships, invites, camp record)
 */
export const dailyCleanupArchivedCamps = internalAction({
  handler: async (
    ctx,
  ): Promise<{
    cleaned: number
    deletedMuxAssets?: number
    missingMuxAssets?: number
    totalBondfires?: number
    totalMemberships?: number
    totalInvites?: number
  }> => {
    const camps: Array<{ _id: Id<'camps'>; [key: string]: unknown }> = await ctx.runQuery(
      internal.cleanup.listArchivedCampsPastRetention,
    )

    if (camps.length === 0) {
      return { cleaned: 0 }
    }

    const campIds: Array<Id<'camps'>> = camps.map((c: { _id: Id<'camps'> }) => c._id)

    // Step 1: Delete Mux assets (must happen before deleting Convex records)
    const muxResult: { deletedMuxAssets: number; missingMuxAssets: number } = await ctx.runAction(
      internal.cleanup.deleteArchivedCampMuxAssets,
      {
        campIds,
      },
    )

    // Step 2: Delete all Convex data
    const dataResult: {
      cleaned: number
      totalBondfires: number
      totalMemberships: number
      totalInvites: number
    } = await ctx.runMutation(internal.cleanup.deleteArchivedCampData, {
      campIds,
    })

    return { ...muxResult, ...dataResult }
  },
})

// ── Helpers ──

function getCleanupMuxConfig() {
  const tokenId = process.env.MUX_TOKEN_ID
  const tokenSecret = process.env.MUX_TOKEN_SECRET

  if (!tokenId || !tokenSecret) {
    throw new Error('Mux is not configured. Please set MUX_TOKEN_ID and MUX_TOKEN_SECRET.')
  }

  return { tokenId, tokenSecret }
}

function getMuxAuthorizationHeader(tokenId: string, tokenSecret: string): string {
  return `Basic ${Buffer.from(`${tokenId}:${tokenSecret}`).toString('base64')}`
}

import { v } from 'convex/values'
import { internal } from './_generated/api'
import { internalAction, internalMutation, internalQuery } from './_generated/server'

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

// ── Internal Mutation: Delete a single archived camp + all its data ──

export const deleteArchivedCampData = internalMutation({
  args: {
    campIds: v.array(v.id('camps')),
  },
  handler: async (ctx, args) => {
    if (args.campIds.length === 0) {
      return { cleaned: 0 }
    }

    const results: { campId: string; bondfiresDeleted: number; membershipsDeleted: number }[] = []
    let totalBondfires = 0
    let totalMemberships = 0

    for (const campId of args.campIds) {
      const camp = await ctx.db.get(campId)
      if (!camp) continue
      // Collect and delete all bondfires in the camp (and their responses)
      const bondfires = await ctx.db
        .query('bondfires')
        .withIndex('by_camp', (q) => q.eq('campId', camp._id))
        .collect()

      let bondfiresInCamp = 0
      for (const bondfire of bondfires) {
        // Delete response videos for this bondfire
        const responses = await ctx.db
          .query('bondfireVideos')
          .withIndex('by_bondfire', (q) => q.eq('bondfireId', bondfire._id))
          .collect()

        for (const response of responses) {
          await ctx.db.delete(response._id)
        }

        // Delete any associated live sessions
        if (bondfire.liveSessionId) {
          await ctx.db.delete(bondfire.liveSessionId)
        }

        await ctx.db.delete(bondfire._id)
        bondfiresInCamp += 1
      }

      // Also find bondfireVideos that reference this camp's bondfires
      // (these should be covered by the bondfire iteration above, but just in case)
      // Delete any bondfireVideos that are orphaned (bondfireId no longer exists)

      // Delete all memberships for the camp
      const memberships = await ctx.db
        .query('campMembers')
        .withIndex('by_camp', (q) => q.eq('campId', camp._id))
        .collect()

      let membershipsInCamp = 0
      for (const membership of memberships) {
        await ctx.db.delete(membership._id)
        membershipsInCamp += 1
      }

      // Delete camp invites
      const invites = await ctx.db
        .query('campInvites')
        .withIndex('by_camp', (q) => q.eq('campId', camp._id))
        .collect()
      for (const invite of invites) {
        await ctx.db.delete(invite._id)
      }

      // Delete the camp itself
      await ctx.db.delete(camp._id)

      results.push({
        campId: camp._id,
        bondfiresDeleted: bondfiresInCamp,
        membershipsDeleted: membershipsInCamp,
      })

      totalBondfires += bondfiresInCamp
      totalMemberships += membershipsInCamp

      console.warn(
        `[cleanup] Deleted archived camp ${camp.slug} (${camp._id}): ${bondfiresInCamp} bondfires, ${membershipsInCamp} memberships`,
      )
    }

    console.warn(
      `[cleanup] Summary: ${args.campIds.length} camps cleaned, ${totalBondfires} bondfires deleted, ${totalMemberships} memberships deleted`,
    )

    return {
      cleaned: args.campIds.length,
      totalBondfires,
      totalMemberships,
      details: results,
    }
  },
})

// ── Internal Action: Mux asset cleanup for archived camps ──

/**
 * Delete Mux assets for bondfires and bondfireVideos in camps past retention.
 * This must run as an action (not mutation) because it makes external HTTP calls.
 */
export const deleteArchivedCampMuxAssets = internalAction({
  handler: async (ctx) => {
    const camps = await ctx.runQuery(internal.cleanup.listArchivedCampsPastRetention)

    if (camps.length === 0) {
      return { deletedMuxAssets: 0, missingMuxAssets: 0 }
    }

    // Collect all muxAssetIds from bondfires and bondfireVideos in these camps
    const muxAssetIds: string[] = []

    for (const camp of camps) {
      const bondfires = await ctx.runQuery(internal.cleanup.getArchivedCampMuxAssets, {
        campId: camp._id,
      })
      muxAssetIds.push(...bondfires)
    }

    // Deduplicate
    const uniqueAssetIds = [...new Set(muxAssetIds.filter(Boolean))]

    const config = getCleanupMuxConfig()
    let deleted = 0
    let missing = 0
    let failed = 0

    for (const assetId of uniqueAssetIds) {
      try {
        const response = await fetch(`https://api.mux.com/video/v1/assets/${assetId}`, {
          method: 'DELETE',
          headers: {
            Accept: 'application/json',
            Authorization: `Basic ${btoa(`${config.tokenId}:${config.tokenSecret}`)}`,
          },
        })

        if (response.status === 404) {
          missing += 1
        } else if (response.ok) {
          deleted += 1
        } else {
          failed += 1
          console.warn(`[cleanup] Mux delete failed for asset ${assetId}: ${response.status}`)
        }
      } catch (err) {
        failed += 1
        console.warn(`[cleanup] Mux delete error for asset ${assetId}:`, err)
      }
    }

    console.warn(
      `[cleanup] Mux assets: ${deleted} deleted, ${missing} missing, ${failed} failed, ${uniqueAssetIds.length} total`,
    )
    if (failed > 0) {
      throw new Error(`Failed to delete ${failed} Mux asset${failed === 1 ? '' : 's'}`)
    }

    return { deletedMuxAssets: deleted, missingMuxAssets: missing }
  },
})

/** Collect muxAssetIds from bondfires and bondfireVideos in a specific camp. */
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

/** Get Mux config for cleanup actions. */
function getCleanupMuxConfig() {
  const tokenId = process.env.MUX_TOKEN_ID
  const tokenSecret = process.env.MUX_TOKEN_SECRET

  if (!tokenId || !tokenSecret) {
    throw new Error('Mux is not configured. Please set MUX_TOKEN_ID and MUX_TOKEN_SECRET.')
  }

  return { tokenId, tokenSecret }
}

// ── Daily Cleanup Action (called by cron) ──

export const dailyCleanupArchivedCamps = internalAction({
  handler: async (
    ctx,
  ): Promise<{
    deletedMuxAssets?: number
    missingMuxAssets?: number
    cleaned: number
    totalBondfires?: number
    totalMemberships?: number
  }> => {
    // First, find all camps past retention
    const camps = await ctx.runQuery(internal.cleanup.listArchivedCampsPastRetention)
    if (camps.length === 0) {
      return { cleaned: 0 }
    }
    const campIds = camps.map((c) => c._id)

    // Step 1: Delete Mux assets for camps past retention
    const muxResult = await ctx.runAction(internal.cleanup.deleteArchivedCampMuxAssets, {})
    console.warn(`[cleanup] Mux cleanup done: ${JSON.stringify(muxResult)}`)

    // Step 2: Delete all Convex data (bondfires, memberships, camps)
    const dataResult = await ctx.runMutation(internal.cleanup.deleteArchivedCampData, { campIds })
    console.warn(`[cleanup] Data cleanup done: ${JSON.stringify(dataResult)}`)

    return { ...muxResult, ...dataResult }
  },
})

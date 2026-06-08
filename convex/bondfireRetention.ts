/**
 * Bondfire-level video retention enforcement.
 *
 * Replaces the old per-video personalCampRetention system with a simpler model:
 * a bondfire (spark + all responses) stays alive as long as ANY video within it
 * was created within the last 30 days. Once the newest video crosses the 30-day
 * threshold, the entire bondfire is deleted — spark, all responses, live sessions,
 * and Mux assets.
 *
 * Premium and Pro owners have unlimited retention and are always skipped.
 * Free users who previously had Plus also get 30-day expiry (tier checked at
 * enforcement time, not creation time).
 *
 * Live bondfires (spark or any response currently live/streaming) are skipped
 * to avoid interrupting active broadcasts.
 *
 * TODO: As traffic grows, increase cron frequency beyond daily to avoid large
 * batch backlogs (e.g. run every 6 hours, then every hour).
 */

import { v } from 'convex/values'
import { internal } from './_generated/api'
import type { Id } from './_generated/dataModel'
import { internalAction, internalMutation, internalQuery } from './_generated/server'
import {
  getEntitlementSubscriptionTier,
  BONDFIRE_RETENTION_MS,
  TIER_RANK,
} from './entitlements'

const MUX_API_BASE_URL = 'https://api.mux.com/video/v1'

/** Maximum bondfires to process in one cron invocation. */
const MAX_BONDFIRES_PER_RUN = 200

type ExpiredBondfire = {
  bondfireId: Id<'bondfires'>
  muxAssetIds: string[]
  responseVideoIds: Array<Id<'bondfireVideos'>>
  liveSessionIds: Array<Id<'liveSessions'>>
}

type RetentionStats = {
  bondfiresChecked: number
  bondfiresSkippedLive: number
  bondfiresSkippedUnlimitedRetention: number
  bondfiresSkippedNotExpired: number
}

type RetentionResult = RetentionStats & {
  bondfiresDeleted: number
  responseVideosDeleted: number
  muxAssetsDeleted: number
  muxAssetsMissing: number
  muxAssetsFailed: number
  remainingMayExist: boolean
}

// ── Helpers ──

function tierHasUnlimitedRetention(tier: string): boolean {
  return TIER_RANK[tier as keyof typeof TIER_RANK] >= TIER_RANK.premium
}

function getMuxAuthorizationHeader(): string {
  const tokenId = process.env.MUX_TOKEN_ID
  const tokenSecret = process.env.MUX_TOKEN_SECRET

  if (!tokenId || !tokenSecret) {
    throw new Error(
      'Mux is not configured. Please set MUX_TOKEN_ID and MUX_TOKEN_SECRET in Convex environment variables.',
    )
  }

  return `Basic ${btoa(`${tokenId}:${tokenSecret}`)}`
}

async function deleteMuxAsset(assetId: string): Promise<'deleted' | 'missing'> {
  const response = await fetch(`${MUX_API_BASE_URL}/assets/${assetId}`, {
    method: 'DELETE',
    headers: {
      Accept: 'application/json',
      Authorization: getMuxAuthorizationHeader(),
    },
  })

  if (response.status === 404) {
    return 'missing'
  }

  if (!response.ok) {
    const message = await response.text()
    throw new Error(`Mux asset delete failed: ${response.status} ${message}`)
  }

  return 'deleted'
}

function isLiveVideo(record: { videoStatus?: string }): boolean {
  return record.videoStatus === 'live'
}

// ── Internal Query: Find expired bondfires ──

export const findExpiredBondfires = internalQuery({
  handler: async (ctx): Promise<{
    expired: ExpiredBondfire[]
    stats: RetentionStats
    remainingMayExist: boolean
  }> => {
    const cutoff = Date.now() - BONDFIRE_RETENTION_MS
    const stats: RetentionStats = {
      bondfiresChecked: 0,
      bondfiresSkippedLive: 0,
      bondfiresSkippedUnlimitedRetention: 0,
      bondfiresSkippedNotExpired: 0,
    }

    // Walk all bondfires. At small scale this is fine; at larger scale we'd
    // paginate or use an index on most-recent-activity.
    const allBondfires = await ctx.db.query('bondfires').collect()
    const expired: ExpiredBondfire[] = []
    let remainingMayExist = false

    for (const bondfire of allBondfires) {
      if (expired.length >= MAX_BONDFIRES_PER_RUN) {
        remainingMayExist = true
        break
      }

      stats.bondfiresChecked++

      // Skip live bondfires
      if (isLiveVideo(bondfire)) {
        stats.bondfiresSkippedLive++
        continue
      }

      // Check owner's tier
      const tier = await getEntitlementSubscriptionTier(ctx, bondfire.userId)
      if (tierHasUnlimitedRetention(tier)) {
        stats.bondfiresSkippedUnlimitedRetention++
        continue
      }

      // Collect all response videos for this bondfire
      const responses = await ctx.db
        .query('bondfireVideos')
        .withIndex('by_bondfire', (q) => q.eq('bondfireId', bondfire._id))
        .collect()

      // Check if any response is currently live
      const anyResponseLive = responses.some(isLiveVideo)
      if (anyResponseLive) {
        stats.bondfiresSkippedLive++
        continue
      }

      // Find the newest createdAt across spark + all responses
      let newestActivity = bondfire.createdAt
      for (const response of responses) {
        if (response.createdAt > newestActivity) {
          newestActivity = response.createdAt
        }
      }

      // If the newest video is still within the window, the bondfire stays
      if (newestActivity >= cutoff) {
        stats.bondfiresSkippedNotExpired++
        continue
      }

      // Expired — collect all Mux asset IDs and record IDs for deletion
      const muxAssetIds: string[] = []
      if (bondfire.muxAssetId) {
        muxAssetIds.push(bondfire.muxAssetId)
      }

      const responseVideoIds: Array<Id<'bondfireVideos'>> = []
      const liveSessionIds: Array<Id<'liveSessions'>> = []

      for (const response of responses) {
        if (response.muxAssetId) {
          muxAssetIds.push(response.muxAssetId)
        }
        responseVideoIds.push(response._id)
        if (response.liveSessionId) {
          liveSessionIds.push(response.liveSessionId)
        }
      }

      if (bondfire.liveSessionId) {
        liveSessionIds.push(bondfire.liveSessionId)
      }

      expired.push({
        bondfireId: bondfire._id,
        muxAssetIds: [...new Set(muxAssetIds.filter(Boolean))],
        responseVideoIds,
        liveSessionIds,
      })
    }

    return { expired, stats, remainingMayExist }
  },
})

// ── Internal Mutation: Delete Convex records for expired bondfires ──

export const deleteExpiredBondfireRecords = internalMutation({
  args: {
    bondfires: v.array(
      v.object({
        bondfireId: v.id('bondfires'),
        responseVideoIds: v.array(v.id('bondfireVideos')),
        liveSessionIds: v.array(v.id('liveSessions')),
      }),
    ),
  },
  handler: async (ctx, args) => {
    let bondfiresDeleted = 0
    let responseVideosDeleted = 0

    for (const { bondfireId, responseVideoIds, liveSessionIds } of args.bondfires) {
      // Verify the bondfire still exists (could have been deleted since query)
      const bondfire = await ctx.db.get(bondfireId)
      if (!bondfire) continue

      // Delete live sessions
      for (const liveSessionId of liveSessionIds) {
        const session = await ctx.db.get(liveSessionId)
        if (session) {
          await ctx.db.delete(liveSessionId)
        }
      }

      // Delete response videos
      for (const videoId of responseVideoIds) {
        const video = await ctx.db.get(videoId)
        if (video) {
          await ctx.db.delete(videoId)
          responseVideosDeleted++
        }
      }

      // Delete the bondfire itself (spark)
      await ctx.db.delete(bondfireId)
      bondfiresDeleted++
    }

    return { bondfiresDeleted, responseVideosDeleted }
  },
})

// ── Internal Action: Enforce retention ──

export const enforceBondfireRetention = internalAction({
  handler: async (ctx): Promise<RetentionResult> => {
    const { expired, stats, remainingMayExist } = await ctx.runQuery(
      internal.bondfireRetention.findExpiredBondfires,
    )

    if (expired.length === 0) {
      return {
        ...stats,
        bondfiresDeleted: 0,
        responseVideosDeleted: 0,
        muxAssetsDeleted: 0,
        muxAssetsMissing: 0,
        muxAssetsFailed: 0,
        remainingMayExist,
      }
    }

    // Step 1: Delete Mux assets (must run as action — external HTTP calls)
    const allMuxAssetIds = [
      ...new Set(expired.flatMap((b) => b.muxAssetIds).filter(Boolean)),
    ]
    const deletableMuxAssetIds = new Set<string>()
    let muxAssetsDeleted = 0
    let muxAssetsMissing = 0
    let muxAssetsFailed = 0

    for (const assetId of allMuxAssetIds) {
      try {
        const result = await deleteMuxAsset(assetId)
        deletableMuxAssetIds.add(assetId)
        if (result === 'missing') {
          muxAssetsMissing++
        } else {
          muxAssetsDeleted++
        }
      } catch (err) {
        muxAssetsFailed++
        console.error(`[bondfireRetention] Failed to delete Mux asset ${assetId}:`, err)
      }
    }

    // Step 2: Only delete Convex records for bondfires whose Mux assets were
    // successfully deleted (or were already missing). This prevents orphaning
    // Mux assets that we failed to delete.
    const safeToDelete = expired.filter((bf) =>
      bf.muxAssetIds.every((id) => deletableMuxAssetIds.has(id)),
    )

    const { bondfiresDeleted, responseVideosDeleted } =
      safeToDelete.length > 0
        ? await ctx.runMutation(internal.bondfireRetention.deleteExpiredBondfireRecords, {
            bondfires: safeToDelete.map((bf) => ({
              bondfireId: bf.bondfireId,
              responseVideoIds: bf.responseVideoIds,
              liveSessionIds: bf.liveSessionIds,
            })),
          })
        : { bondfiresDeleted: 0, responseVideosDeleted: 0 }

    console.warn(
      `[bondfireRetention] Run complete: ${bondfiresDeleted} bondfires deleted, ` +
        `${responseVideosDeleted} response videos, ` +
        `${muxAssetsDeleted} Mux assets deleted, ` +
        `${muxAssetsMissing} Mux assets already missing, ` +
        `${muxAssetsFailed} Mux deletes failed`,
    )

    return {
      ...stats,
      bondfiresDeleted,
      responseVideosDeleted,
      muxAssetsDeleted,
      muxAssetsMissing,
      muxAssetsFailed,
      remainingMayExist:
        remainingMayExist || safeToDelete.length < expired.length,
    }
  },
})

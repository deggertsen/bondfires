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
import {
  internalAction,
  internalMutation,
  internalQuery,
  type MutationCtx,
} from './_generated/server'
import {
  BONDFIRE_RETENTION_MS,
  getEntitlementSubscriptionTier,
  type SubscriptionTier,
  TIER_RANK,
} from './entitlements'

const MUX_API_BASE_URL = 'https://api.mux.com/video/v1'

/** Maximum bondfires to process in one cron invocation. */
const MAX_BONDFIRES_PER_RUN = 200

type ExpiredBondfire = {
  bondfireId: Id<'bondfires'>
  muxAssetIds: string[]
}

type RetentionStats = {
  bondfiresChecked: number
  bondfiresSkippedLive: number
  bondfiresSkippedUnlimitedRetention: number
  bondfiresSkippedNotExpired: number
}

type ExpiredBondfireBatch = {
  expired: ExpiredBondfire[]
  stats: RetentionStats
  remainingMayExist: boolean
}

type RetentionResult = RetentionStats & {
  bondfiresDeleted: number
  bondfiresSkippedAssetDrift: number
  responseVideosDeleted: number
  muxAssetsDeleted: number
  muxAssetsMissing: number
  muxAssetsFailed: number
  remainingMayExist: boolean
}

// ── Helpers ──

function tierHasUnlimitedRetention(tier: SubscriptionTier): boolean {
  return TIER_RANK[tier] >= TIER_RANK.premium
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

function isPlayableVideoRecord(record: {
  videoStatus?: string
  muxPlaybackId?: string
  muxLivePlaybackId?: string
  expiresAt?: number
}): boolean {
  if (record.expiresAt !== undefined && record.expiresAt <= Date.now()) {
    return false
  }

  const status = record.videoStatus ?? 'ready'
  return (
    (status === 'ready' && !!record.muxPlaybackId) ||
    (status === 'live' && !!record.muxLivePlaybackId)
  )
}

function collectMuxAssetIds(records: Array<{ muxAssetId?: string }>): string[] {
  return [
    ...new Set(
      records
        .map((record) => record.muxAssetId)
        .filter((assetId): assetId is string => assetId !== undefined),
    ),
  ]
}

async function deleteWatchEventsForVideo(ctx: MutationCtx, videoId: string) {
  const watchEvents = await ctx.db
    .query('watchEvents')
    .withIndex('by_video', (q) => q.eq('videoId', videoId))
    .collect()

  for (const watchEvent of watchEvents) {
    await ctx.db.delete(watchEvent._id)
  }
}

async function deleteLiveSessionIfExists(ctx: MutationCtx, liveSessionId: Id<'liveSessions'>) {
  const liveSession = await ctx.db.get(liveSessionId)
  if (liveSession) {
    await ctx.db.delete(liveSessionId)
  }
}

// ── Internal Query: Find expired bondfires ──

export const findExpiredBondfires = internalQuery({
  handler: async (ctx): Promise<ExpiredBondfireBatch> => {
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

      for (const response of responses) {
        if (response.muxAssetId) {
          muxAssetIds.push(response.muxAssetId)
        }
      }

      expired.push({
        bondfireId: bondfire._id,
        muxAssetIds: [...new Set(muxAssetIds.filter(Boolean))],
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
        muxAssetIds: v.array(v.string()),
      }),
    ),
  },
  handler: async (ctx, args) => {
    let bondfiresDeleted = 0
    let bondfiresSkippedAssetDrift = 0
    let responseVideosDeleted = 0
    const affectedUsers = new Set<Id<'users'>>()
    const affectedCamps = new Set<Id<'camps'>>()
    const deletedBondfireIds = new Set<Id<'bondfires'>>()

    for (const { bondfireId, muxAssetIds } of args.bondfires) {
      const bondfire = await ctx.db.get(bondfireId)
      if (!bondfire) continue

      const responses = await ctx.db
        .query('bondfireVideos')
        .withIndex('by_bondfire', (q) => q.eq('bondfireId', bondfireId))
        .collect()

      // Mux deletion has already happened. At this point, only skip if a new
      // asset appeared that this run did not delete; otherwise finishing the
      // Convex cleanup is safer than preserving records that point at deleted assets.
      const expectedMuxAssetIds = new Set(muxAssetIds)
      const currentMuxAssetIds = collectMuxAssetIds([bondfire, ...responses])
      if (!currentMuxAssetIds.every((assetId) => expectedMuxAssetIds.has(assetId))) {
        bondfiresSkippedAssetDrift++
        // Drift means a new asset appeared after we computed the delete set, so
        // we skip to avoid orphaning an undeleted Mux asset. But the expired
        // assets were ALREADY deleted by the action — so this bondfire can be
        // left pointing at deleted assets (an unreachable orphan that violates
        // "expired bondfires are removed entirely"). Log it loudly so we can see
        // whether this race actually happens before reworking the handshake.
        await ctx.db.insert('clientLogs', {
          userId: bondfire.userId,
          level: 'warn',
          event: 'bondfire:failed:retention_asset_drift',
          message: `Retention skipped ${bondfireId} after Mux asset drift; bondfire may now be orphaned`,
          data: {
            reason: 'retention_asset_drift',
            bondfireId,
            videoStatus: bondfire.videoStatus,
            expectedMuxAssetIds: [...expectedMuxAssetIds],
            currentMuxAssetIds,
            createdAt: bondfire.createdAt,
            ageMs: Date.now() - bondfire.createdAt,
          },
          platform: 'server',
          createdAt: Date.now(),
        })
        continue
      }

      affectedUsers.add(bondfire.userId)
      if (bondfire.campId) {
        affectedCamps.add(bondfire.campId)
      }

      for (const response of responses) {
        affectedUsers.add(response.userId)
        await deleteWatchEventsForVideo(ctx, response._id)

        const responseReports = await ctx.db
          .query('reports')
          .withIndex('by_bondfire_video', (q) => q.eq('bondfireVideoId', response._id))
          .collect()
        for (const report of responseReports) {
          await ctx.db.delete(report._id)
        }

        if (response.liveSessionId) {
          await deleteLiveSessionIfExists(ctx, response.liveSessionId)
        }
        await ctx.db.delete(response._id)
        responseVideosDeleted++
      }

      if (bondfire.personalCampId) {
        const participants = await ctx.db
          .query('personalBondfireParticipants')
          .withIndex('by_bondfire_status', (q) => q.eq('bondfireId', bondfireId))
          .collect()
        for (const participant of participants) {
          await ctx.db.delete(participant._id)
        }

        const invites = await ctx.db
          .query('inviteCodes')
          .withIndex('by_parent', (q) =>
            q.eq('parentType', 'personal-bondfire').eq('parentId', bondfireId),
          )
          .collect()
        for (const invite of invites) {
          await ctx.db.delete(invite._id)
        }
      }

      const threadReads = await ctx.db
        .query('bondfireThreadReads')
        .withIndex('by_bondfire', (q) => q.eq('bondfireId', bondfireId))
        .collect()
      for (const read of threadReads) {
        await ctx.db.delete(read._id)
      }

      const bondfireInvites = await ctx.db
        .query('bondfireInvites')
        .withIndex('by_bondfire_recipient', (q) => q.eq('bondfireId', bondfireId))
        .collect()
      for (const invite of bondfireInvites) {
        await ctx.db.delete(invite._id)
      }

      await deleteWatchEventsForVideo(ctx, bondfireId)

      const reports = await ctx.db
        .query('reports')
        .withIndex('by_bondfire', (q) => q.eq('bondfireId', bondfireId))
        .collect()
      for (const report of reports) {
        await ctx.db.delete(report._id)
      }

      if (bondfire.liveSessionId) {
        await deleteLiveSessionIfExists(ctx, bondfire.liveSessionId)
      }

      await ctx.db.delete(bondfireId)
      bondfiresDeleted++
      deletedBondfireIds.add(bondfireId)
    }

    if (deletedBondfireIds.size > 0) {
      const users = await ctx.db.query('users').collect()
      for (const user of users) {
        if (!user.pinnedBondfireIds?.some((id) => deletedBondfireIds.has(id))) {
          continue
        }

        await ctx.db.patch(user._id, {
          pinnedBondfireIds: user.pinnedBondfireIds.filter((id) => !deletedBondfireIds.has(id)),
          updatedAt: Date.now(),
        })
      }
    }

    for (const userId of affectedUsers) {
      const user = await ctx.db.get(userId)
      if (!user) {
        continue
      }

      const [userBondfires, userResponses] = await Promise.all([
        ctx.db
          .query('bondfires')
          .withIndex('by_user', (q) => q.eq('userId', userId))
          .collect(),
        ctx.db
          .query('bondfireVideos')
          .withIndex('by_user', (q) => q.eq('userId', userId))
          .collect(),
      ])

      await ctx.db.patch(userId, {
        bondfireCount: userBondfires.filter(isPlayableVideoRecord).length,
        responseCount: userResponses.filter(isPlayableVideoRecord).length,
        updatedAt: Date.now(),
      })
    }

    for (const campId of affectedCamps) {
      const camp = await ctx.db.get(campId)
      if (!camp) {
        continue
      }

      const campBondfires = await ctx.db
        .query('bondfires')
        .withIndex('by_camp', (q) => q.eq('campId', campId))
        .collect()

      await ctx.db.patch(campId, {
        bondfireCount: campBondfires.filter(isPlayableVideoRecord).length,
        updatedAt: Date.now(),
      })
    }

    return { bondfiresDeleted, bondfiresSkippedAssetDrift, responseVideosDeleted }
  },
})

// ── Internal Action: Enforce retention ──

export const enforceBondfireRetention = internalAction({
  handler: async (ctx): Promise<RetentionResult> => {
    const { expired, stats, remainingMayExist }: ExpiredBondfireBatch = await ctx.runQuery(
      internal.bondfireRetention.findExpiredBondfires,
    )

    if (expired.length === 0) {
      return {
        ...stats,
        bondfiresDeleted: 0,
        bondfiresSkippedAssetDrift: 0,
        responseVideosDeleted: 0,
        muxAssetsDeleted: 0,
        muxAssetsMissing: 0,
        muxAssetsFailed: 0,
        remainingMayExist,
      }
    }

    // Step 1: Delete Mux assets (must run as action — external HTTP calls)
    const allMuxAssetIds = [...new Set(expired.flatMap((b) => b.muxAssetIds).filter(Boolean))]
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

    const { bondfiresDeleted, bondfiresSkippedAssetDrift, responseVideosDeleted } =
      safeToDelete.length > 0
        ? await ctx.runMutation(internal.bondfireRetention.deleteExpiredBondfireRecords, {
            bondfires: safeToDelete.map((bf) => ({
              bondfireId: bf.bondfireId,
              muxAssetIds: bf.muxAssetIds,
            })),
          })
        : { bondfiresDeleted: 0, bondfiresSkippedAssetDrift: 0, responseVideosDeleted: 0 }

    console.warn(
      `[bondfireRetention] Run complete: ${bondfiresDeleted} bondfires deleted, ` +
        `${responseVideosDeleted} response videos, ` +
        `${bondfiresSkippedAssetDrift} skipped after asset drift, ` +
        `${muxAssetsDeleted} Mux assets deleted, ` +
        `${muxAssetsMissing} Mux assets already missing, ` +
        `${muxAssetsFailed} Mux deletes failed`,
    )

    return {
      ...stats,
      bondfiresDeleted,
      bondfiresSkippedAssetDrift,
      responseVideosDeleted,
      muxAssetsDeleted,
      muxAssetsMissing,
      muxAssetsFailed,
      remainingMayExist:
        remainingMayExist || safeToDelete.length < expired.length || bondfiresSkippedAssetDrift > 0,
    }
  },
})

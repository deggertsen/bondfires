/**
 * Personal Camp Video Retention Cron
 *
 * Scheduled function that enforces video retention policies for personal camps:
 * - Plus / Premium: Bondfire response videos older than 30 days are deleted
 * - Pro: Unlimited retention (skipped entirely)
 *
 * Only response videos and their Mux assets are deleted — bondfire shells
 * and participant data persist.
 */

import { v } from 'convex/values'
import { internalAction, internalMutation, internalQuery } from './_generated/server'
import type { Id } from './_generated/dataModel'
import { TIER_RANK } from './entitlements'
import { internal } from './_generated/api'

/** Retention window for Plus/Premium personal camps (30 days). */
const PERSONAL_CAMP_RETENTION_MS = 30 * 24 * 60 * 60 * 1000

/** Maximum number of personal camps to process per cron invocation. */
const MAX_CAMPS_PER_RUN = 50

/** Maximum number of videos to delete per personal camp per run. */
const MAX_VIDEOS_PER_CAMP = 200

// ── Types ──

type PersonalCampRetentionResult = {
  campsChecked: number
  campsSkippedPro: number
  campsSkippedNoVideos: number
  videosDeleted: number
  muxAssetsDeleted: number
  muxAssetsMissing: number
  remainingMayExist: boolean
}

type RetentionDeletion = {
  bondfireId: Id<'bondfires'>
  videoIds: Id<'bondfireVideos'>
  muxAssetIds: string[]
}

// ── Internal Query: Build the list of deletions for this run ──

export const buildDeletionBatch = internalQuery({
  handler: async (ctx): Promise<{
    deletions: RetentionDeletion[]
    stats: { campsChecked: number; campsSkippedPro: number; campsSkippedNoVideos: number }
    remainingMayExist: boolean
  }> => {
    const now = Date.now()
    const cutoff = now - PERSONAL_CAMP_RETENTION_MS

    const personalCamps = await ctx.db
      .query('personalCamps')
      .filter((q) => q.eq(q.field('status'), 'active'))
      .take(MAX_CAMPS_PER_RUN)

    let campsChecked = 0
    let campsSkippedPro = 0
    let campsSkippedNoVideos = 0
    const deletions: RetentionDeletion[] = []

    for (const camp of personalCamps) {
      campsChecked++

      // Determine owner tier
      const owner = await ctx.db.get(camp.ownerId)
      let ownerTier: string = 'free'

      if (owner?.forcedTier) {
        ownerTier = owner.forcedTier
      } else {
        const subscriptions = await ctx.db
          .query('subscriptions')
          .withIndex('by_user', (q) => q.eq('userId', camp.ownerId))
          .collect()

        const activeSubs = subscriptions.filter(
          (sub) =>
            sub.verificationStatus === 'verified' &&
            (sub.status === 'active' || sub.status === 'trialing') &&
            (!sub.currentPeriodEnd || sub.currentPeriodEnd > now),
        )

        ownerTier = activeSubs.reduce(
          (highest, sub) =>
            TIER_RANK[sub.tier as keyof typeof TIER_RANK] >
            TIER_RANK[highest as keyof typeof TIER_RANK]
              ? sub.tier
              : highest,
          'free',
        )
      }

      // Pro has unlimited retention — skip entirely
      if (TIER_RANK[ownerTier as keyof typeof TIER_RANK] >= TIER_RANK.pro) {
        campsSkippedPro++
        continue
      }

      // Find all bondfires in this personal camp
      const bondfires = await ctx.db
        .query('bondfires')
        .withIndex('by_personal_camp', (q) => q.eq('personalCampId', camp._id))
        .collect()

      if (bondfires.length === 0) {
        campsSkippedNoVideos++
        continue
      }

      // For each bondfire, find response videos older than cutoff
      for (const bondfire of bondfires) {
        const allVideos = await ctx.db
          .query('bondfireVideos')
          .withIndex('by_bondfire', (q) => q.eq('bondfireId', bondfire._id))
          .collect()

        const expiredVideos = allVideos
          .filter((v) => v.createdAt < cutoff)
          .slice(0, MAX_VIDEOS_PER_CAMP)

        if (expiredVideos.length > 0) {
          deletions.push({
            bondfireId: bondfire._id,
            videoIds: expiredVideos.map((v) => v._id),
            muxAssetIds: expiredVideos
              .map((v) => v.muxAssetId)
              .filter((id): id is string => id !== undefined),
          })
        }
      }
    }

    return {
      deletions,
      stats: { campsChecked, campsSkippedPro, campsSkippedNoVideos },
      remainingMayExist: personalCamps.length >= MAX_CAMPS_PER_RUN,
    }
  },
})

// ── Internal Mutation: Delete expired video records ──

export const deleteExpiredVideoRecords = internalMutation({
  args: {
    deletions: v.array(
      v.object({
        bondfireId: v.id('bondfires'),
        videoIds: v.array(v.id('bondfireVideos')),
      }),
    ),
  },
  handler: async (ctx, args) => {
    const now = Date.now()
    let videosDeleted = 0
    const affectedUsers = new Set<Id<'users'>>()

    for (const { bondfireId, videoIds } of args.deletions) {
      for (const videoId of videoIds) {
        const video = await ctx.db.get(videoId)
        if (!video) continue

        affectedUsers.add(video.userId)
        await ctx.db.delete(videoId)
        videosDeleted++
      }

      // Update bondfire videoCount after deletions
      const bondfire = await ctx.db.get(bondfireId)
      if (bondfire) {
        const remainingVideos = await ctx.db
          .query('bondfireVideos')
          .withIndex('by_bondfire', (q) => q.eq('bondfireId', bondfireId))
          .collect()

        // videoCount includes the main video (bondfire itself if it has a playbackId) + responses
        const mainVideoCount = bondfire.muxPlaybackId ? 1 : 0
        const newVideoCount = mainVideoCount + remainingVideos.length

        if (newVideoCount !== bondfire.videoCount) {
          await ctx.db.patch(bondfireId, {
            videoCount: newVideoCount,
            updatedAt: now,
          })
        }
      }
    }

    // Update affected users' response counts
    for (const userId of affectedUsers) {
      const userResponses = await ctx.db
        .query('bondfireVideos')
        .withIndex('by_user', (q) => q.eq('userId', userId))
        .collect()

      const playableCount = userResponses.filter((v) => {
        if (v.expiresAt !== undefined && v.expiresAt <= now) return false
        const status = v.videoStatus ?? 'ready'
        return (
          (status === 'ready' && !!v.muxPlaybackId) ||
          (status === 'live' && !!v.muxLivePlaybackId)
        )
      }).length

      await ctx.db.patch(userId, {
        responseCount: playableCount,
        updatedAt: now,
      })
    }

    return { videosDeleted }
  },
})

// ── Internal Query: Get Mux configuration ──

export const getMuxConfig = internalQuery({
  handler: async () => {
    const tokenId = process.env.MUX_TOKEN_ID
    const tokenSecret = process.env.MUX_TOKEN_SECRET

    if (!tokenId || !tokenSecret) {
      throw new Error('MUX_TOKEN_ID and MUX_TOKEN_SECRET must be set')
    }

    return { tokenId, tokenSecret }
  },
})

// ── Scheduled Action: Main entry point ──

export const enforcePersonalCampRetention = internalAction({
  handler: async (ctx): Promise<PersonalCampRetentionResult> => {
    const { deletions, stats, remainingMayExist } = await ctx.runQuery(
      internal.personalCampRetention.buildDeletionBatch,
    )

    if (deletions.length === 0) {
      return {
        ...stats,
        videosDeleted: 0,
        muxAssetsDeleted: 0,
        muxAssetsMissing: 0,
        remainingMayExist,
      }
    }

    // Collect all unique Mux asset IDs to delete
    const allMuxAssetIds = [...new Set(deletions.flatMap((d) => d.muxAssetIds))]

    // Delete Mux assets via the Mux API
    let muxAssetsDeleted = 0
    let muxAssetsMissing = 0

    if (allMuxAssetIds.length > 0) {
      const muxConfig = await ctx.runQuery(internal.personalCampRetention.getMuxConfig)
      const auth = Buffer.from(`${muxConfig.tokenId}:${muxConfig.tokenSecret}`).toString('base64')

      for (const assetId of allMuxAssetIds) {
        try {
          const response = await fetch(`https://api.mux.com/video/v1/assets/${assetId}`, {
            method: 'DELETE',
            headers: {
              Accept: 'application/json',
              Authorization: `Basic ${auth}`,
            },
          })

          if (response.status === 404) {
            muxAssetsMissing++
          } else if (response.ok) {
            muxAssetsDeleted++
          } else {
            const message = await response.text()
            console.error(
              `[personalCampRetention] Mux delete failed for ${assetId}: ${response.status} ${message}`,
            )
          }
        } catch (err) {
          console.error(`[personalCampRetention] Error deleting Mux asset ${assetId}:`, err)
        }
      }
    }

    // Delete video records from the database
    const { videosDeleted } = await ctx.runMutation(
      internal.personalCampRetention.deleteExpiredVideoRecords,
      {
        deletions: deletions.map((d) => ({
          bondfireId: d.bondfireId,
          videoIds: d.videoIds,
        })),
      },
    )

    return {
      ...stats,
      videosDeleted,
      muxAssetsDeleted,
      muxAssetsMissing,
      remainingMayExist,
    }
  },
})

/**
 * Daily retention enforcement for personal camp response videos.
 *
 * Plus owners get 30 days of response-video storage. Premium and Pro owners
 * keep unlimited storage, matching the subscription entitlement copy.
 *
 * Bondfire shells and participant rows are preserved; only expired response
 * videos, their live-session rows, and their Mux assets are removed.
 */

import { v } from 'convex/values'
import { internal } from './_generated/api'
import type { Id } from './_generated/dataModel'
import { internalAction, internalMutation, internalQuery } from './_generated/server'
import {
  getEntitlementSubscriptionTier,
  PLUS_PRIVATE_RETENTION_MS,
  type SubscriptionTier,
  TIER_RANK,
} from './entitlements'

const MUX_API_BASE_URL = 'https://api.mux.com/video/v1'

/** Maximum response records to delete in one cron invocation. */
const MAX_RESPONSE_VIDEOS_PER_RUN = 200

/** Prevents one busy bondfire from monopolizing the whole daily run. */
const MAX_RESPONSE_VIDEOS_PER_BONDFIRE = 50

type RetentionDeletion = {
  bondfireId: Id<'bondfires'>
  videoIds: Array<Id<'bondfireVideos'>>
}

type RetentionCandidate = {
  bondfireId: Id<'bondfires'>
  videoId: Id<'bondfireVideos'>
  muxAssetId?: string
}

type PersonalCampRetentionStats = {
  campsChecked: number
  campsSkippedUnlimitedRetention: number
  campsSkippedNoExpiredVideos: number
}

type PersonalCampRetentionResult = PersonalCampRetentionStats & {
  videosDeleted: number
  muxAssetsDeleted: number
  muxAssetsMissing: number
  muxAssetsFailed: number
  remainingMayExist: boolean
}

function tierHasUnlimitedPersonalCampRetention(tier: SubscriptionTier) {
  return TIER_RANK[tier] >= TIER_RANK.premium
}

function isPlayableVideoRecord(record: {
  videoStatus?: string
  muxPlaybackId?: string
  muxLivePlaybackId?: string
  expiresAt?: number
}) {
  if (record.expiresAt !== undefined && record.expiresAt <= Date.now()) {
    return false
  }

  const status = record.videoStatus ?? 'ready'
  return (
    (status === 'ready' && !!record.muxPlaybackId) ||
    (status === 'live' && !!record.muxLivePlaybackId)
  )
}

function getMuxAuthorizationHeader() {
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

function groupCandidates(candidates: RetentionCandidate[]): RetentionDeletion[] {
  const byBondfire = new Map<Id<'bondfires'>, RetentionDeletion>()

  for (const candidate of candidates) {
    const existing = byBondfire.get(candidate.bondfireId)
    const deletion =
      existing ??
      ({
        bondfireId: candidate.bondfireId,
        videoIds: [],
      } satisfies RetentionDeletion)

    deletion.videoIds.push(candidate.videoId)

    byBondfire.set(candidate.bondfireId, deletion)
  }

  return [...byBondfire.values()]
}

export const buildDeletionBatch = internalQuery({
  handler: async (
    ctx,
  ): Promise<{
    cutoff: number
    candidates: RetentionCandidate[]
    stats: PersonalCampRetentionStats
    remainingMayExist: boolean
  }> => {
    const cutoff = Date.now() - PLUS_PRIVATE_RETENTION_MS
    const personalCamps = await ctx.db
      .query('personalCamps')
      .filter((q) => q.eq(q.field('status'), 'active'))
      .collect()

    const candidates: RetentionCandidate[] = []
    const stats: PersonalCampRetentionStats = {
      campsChecked: 0,
      campsSkippedUnlimitedRetention: 0,
      campsSkippedNoExpiredVideos: 0,
    }
    let remainingMayExist = false

    for (const camp of personalCamps) {
      if (candidates.length >= MAX_RESPONSE_VIDEOS_PER_RUN) {
        remainingMayExist = true
        break
      }

      stats.campsChecked += 1

      const ownerTier = await getEntitlementSubscriptionTier(ctx, camp.ownerId)
      if (tierHasUnlimitedPersonalCampRetention(ownerTier)) {
        stats.campsSkippedUnlimitedRetention += 1
        continue
      }

      let campExpiredVideoCount = 0
      const bondfires = await ctx.db
        .query('bondfires')
        .withIndex('by_personal_camp', (q) => q.eq('personalCampId', camp._id))
        .collect()

      for (const bondfire of bondfires) {
        if (candidates.length >= MAX_RESPONSE_VIDEOS_PER_RUN) {
          remainingMayExist = true
          break
        }

        const expiredVideos = (
          await ctx.db
            .query('bondfireVideos')
            .withIndex('by_bondfire', (q) => q.eq('bondfireId', bondfire._id))
            .collect()
        ).filter((video) => video.createdAt < cutoff)

        if (expiredVideos.length === 0) {
          continue
        }

        campExpiredVideoCount += expiredVideos.length

        const remainingRunCapacity = MAX_RESPONSE_VIDEOS_PER_RUN - candidates.length
        const videosForBondfire = expiredVideos.slice(
          0,
          Math.min(MAX_RESPONSE_VIDEOS_PER_BONDFIRE, remainingRunCapacity),
        )

        if (videosForBondfire.length < expiredVideos.length) {
          remainingMayExist = true
        }

        for (const video of videosForBondfire) {
          candidates.push({
            bondfireId: bondfire._id,
            videoId: video._id,
            muxAssetId: video.muxAssetId,
          })
        }
      }

      if (campExpiredVideoCount === 0) {
        stats.campsSkippedNoExpiredVideos += 1
      }
    }

    return {
      cutoff,
      candidates,
      stats,
      remainingMayExist,
    }
  },
})

export const deleteExpiredVideoRecords = internalMutation({
  args: {
    cutoff: v.number(),
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
    const affectedBondfires = new Set<Id<'bondfires'>>()
    const affectedUsers = new Set<Id<'users'>>()

    for (const { bondfireId, videoIds } of args.deletions) {
      for (const videoId of videoIds) {
        const video = await ctx.db.get(videoId)
        if (!video || video.bondfireId !== bondfireId || video.createdAt >= args.cutoff) {
          continue
        }

        affectedBondfires.add(bondfireId)
        affectedUsers.add(video.userId)

        if (video.liveSessionId) {
          await ctx.db.delete(video.liveSessionId)
        }
        await ctx.db.delete(videoId)
        videosDeleted += 1
      }
    }

    for (const bondfireId of affectedBondfires) {
      const bondfire = await ctx.db.get(bondfireId)
      if (!bondfire) {
        continue
      }

      const remainingVideos = await ctx.db
        .query('bondfireVideos')
        .withIndex('by_bondfire', (q) => q.eq('bondfireId', bondfireId))
        .collect()

      const newVideoCount = 1 + remainingVideos.length
      if (newVideoCount !== bondfire.videoCount) {
        await ctx.db.patch(bondfireId, {
          videoCount: newVideoCount,
          updatedAt: now,
        })
      }
    }

    for (const userId of affectedUsers) {
      const user = await ctx.db.get(userId)
      if (!user) {
        continue
      }

      const userResponses = await ctx.db
        .query('bondfireVideos')
        .withIndex('by_user', (q) => q.eq('userId', userId))
        .collect()

      await ctx.db.patch(userId, {
        responseCount: userResponses.filter(isPlayableVideoRecord).length,
        updatedAt: now,
      })
    }

    return { videosDeleted }
  },
})

export const enforcePersonalCampRetention = internalAction({
  handler: async (ctx): Promise<PersonalCampRetentionResult> => {
    const { cutoff, candidates, stats, remainingMayExist } = await ctx.runQuery(
      internal.personalCampRetention.buildDeletionBatch,
    )

    if (candidates.length === 0) {
      return {
        ...stats,
        videosDeleted: 0,
        muxAssetsDeleted: 0,
        muxAssetsMissing: 0,
        muxAssetsFailed: 0,
        remainingMayExist,
      }
    }

    const uniqueMuxAssetIds = [
      ...new Set(
        candidates
          .map((candidate) => candidate.muxAssetId)
          .filter((assetId): assetId is string => assetId !== undefined),
      ),
    ]
    const deletableMuxAssetIds = new Set<string>()
    let muxAssetsDeleted = 0
    let muxAssetsMissing = 0
    let muxAssetsFailed = 0

    for (const assetId of uniqueMuxAssetIds) {
      try {
        const result = await deleteMuxAsset(assetId)
        deletableMuxAssetIds.add(assetId)
        if (result === 'missing') {
          muxAssetsMissing += 1
        } else {
          muxAssetsDeleted += 1
        }
      } catch (err) {
        muxAssetsFailed += 1
        console.error(`[personalCampRetention] Failed to delete Mux asset ${assetId}:`, err)
      }
    }

    const recordsReadyToDelete = candidates.filter(
      (candidate) => !candidate.muxAssetId || deletableMuxAssetIds.has(candidate.muxAssetId),
    )
    const safeDeletions = groupCandidates(recordsReadyToDelete).map((deletion) => ({
      bondfireId: deletion.bondfireId,
      videoIds: deletion.videoIds,
    }))

    const { videosDeleted } =
      safeDeletions.length > 0
        ? await ctx.runMutation(internal.personalCampRetention.deleteExpiredVideoRecords, {
            cutoff,
            deletions: safeDeletions,
          })
        : { videosDeleted: 0 }

    return {
      ...stats,
      videosDeleted,
      muxAssetsDeleted,
      muxAssetsMissing,
      muxAssetsFailed,
      remainingMayExist: remainingMayExist || recordsReadyToDelete.length < candidates.length,
    }
  },
})

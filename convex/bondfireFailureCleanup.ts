/**
 * Centralized failure handling for bondfires whose video is broken or abandoned.
 *
 * Product invariant (owner): a bondfire whose video never became — or can no
 * longer be — playable must NOT remain reachable. Users should never open a
 * bondfire and hit the "This Bondfire isn't available" dead end. When we remove
 * such a bondfire we ALWAYS first capture a high-severity forensic record so we
 * keep the evidence needed to root-cause *why* the recording failed.
 *
 * Hard deletion is gated behind `HARD_DELETE_FAILED_BONDFIRES`. It defaults to
 * `false` ("observe" mode): we log loudly via `clientLogs` (level `error`,
 * `bondfire:failed:*`) but never delete, so we can confirm our detection is
 * correct against real prod telemetry before enabling irreversible deletion.
 * These `bondfire:failed:*` events are exempt from the clientLogs purge
 * (see `clientLogs.purgeOld`) so the forensic trail survives the 30-day window.
 */

import { v } from 'convex/values'
import type { Doc, Id } from './_generated/dataModel'
import { internalAction, type MutationCtx } from './_generated/server'

export type BondfireFailureReason =
  /** Mux marked the asset errored (rejected/processing failure). */
  | 'recording_errored'
  /** A live session ended without ever producing a playable stream/VOD. */
  | 'live_never_watchable'
  /** Stuck in `waiting_for_upload` past the Mux upload window with no asset. */
  | 'upload_abandoned'
  /** Recording exceeded the allowed duration and was rejected. */
  | 'duration_limit_exceeded'

/**
 * Master switch for irreversible deletion of failed bondfires.
 *
 * Keep this `false` until the `bondfire:failed:*` forensic telemetry confirms
 * our detection only fires on genuinely-broken bondfires. Flipping to `true`
 * makes the same code paths delete the bondfire (spark + responses + Mux assets)
 * after the forensic record is written.
 */
export const HARD_DELETE_FAILED_BONDFIRES = false

/** Forensic prefix used for both logging and purge-exemption matching. */
export const BONDFIRE_FAILURE_EVENT_PREFIX = 'bondfire:failed:'

function bondfireForensicSnapshot(bondfire: Doc<'bondfires'>) {
  return {
    bondfireId: bondfire._id,
    userId: bondfire.userId,
    campId: bondfire.campId,
    personalCampId: bondfire.personalCampId,
    videoStatus: bondfire.videoStatus,
    muxUploadId: bondfire.muxUploadId,
    muxAssetId: bondfire.muxAssetId,
    muxAssetStatus: bondfire.muxAssetStatus,
    muxPlaybackId: bondfire.muxPlaybackId,
    muxLiveStreamId: bondfire.muxLiveStreamId,
    muxLivePlaybackId: bondfire.muxLivePlaybackId,
    liveSessionId: bondfire.liveSessionId,
    durationMs: bondfire.durationMs,
    videoCount: bondfire.videoCount,
    createdAt: bondfire.createdAt,
    updatedAt: bondfire.updatedAt,
    ageMs: Date.now() - bondfire.createdAt,
  }
}

/**
 * Capture a high-severity forensic record for a failed/abandoned bondfire.
 * Always invoked before any deletion so the evidence outlives the record.
 */
export async function recordBondfireFailure(
  ctx: MutationCtx,
  bondfire: Doc<'bondfires'>,
  reason: BondfireFailureReason,
  detail?: Record<string, unknown>,
): Promise<void> {
  const snapshot = bondfireForensicSnapshot(bondfire)

  let liveSession: Doc<'liveSessions'> | null = null
  if (bondfire.liveSessionId) {
    liveSession = await ctx.db.get(bondfire.liveSessionId)
  }

  await ctx.db.insert('clientLogs', {
    userId: bondfire.userId,
    level: 'error',
    event: `${BONDFIRE_FAILURE_EVENT_PREFIX}${reason}`,
    message: `Bondfire ${bondfire._id} failed (${reason}); ${
      HARD_DELETE_FAILED_BONDFIRES ? 'deleting record' : 'observe-only (not deleting)'
    }`,
    data: {
      reason,
      willDelete: HARD_DELETE_FAILED_BONDFIRES,
      ...snapshot,
      liveSession: liveSession
        ? {
            status: liveSession.status,
            startedAt: liveSession.startedAt,
            endedAt: liveSession.endedAt,
            errorMessage: liveSession.errorMessage,
            muxLiveStreamId: liveSession.muxLiveStreamId,
          }
        : null,
      ...(detail ?? {}),
    },
    platform: 'server',
    appVersion: undefined,
    sessionId: undefined,
    retention: 'forensic',
    createdAt: Date.now(),
  })
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

/**
 * Cascade-delete a single bondfire and everything attached to it (responses,
 * watch events, reports, thread reads, invites, personal participants, live
 * sessions), then repair the creator/camp counters and pinned lists.
 *
 * Mirrors the per-bondfire cascade in `bondfireRetention.deleteExpiredBondfireRecords`.
 * Returns the Mux asset IDs that the caller should delete from Mux (HTTP, so it
 * must happen in an action, not here).
 *
 * `preserveLiveSessionId` keeps that one live session row alive so the caller
 * can still stamp its cancel/end forensics on it afterwards.
 */
export async function purgeBondfireConvexRecords(
  ctx: MutationCtx,
  bondfire: Doc<'bondfires'>,
  options?: { preserveLiveSessionId?: Id<'liveSessions'> },
): Promise<{ muxAssetIds: string[] }> {
  const bondfireId = bondfire._id
  const muxAssetIds = new Set<string>()
  if (bondfire.muxAssetId) muxAssetIds.add(bondfire.muxAssetId)

  const responses = await ctx.db
    .query('bondfireVideos')
    .withIndex('by_bondfire', (q) => q.eq('bondfireId', bondfireId))
    .collect()

  const affectedUsers = new Set<Id<'users'>>([bondfire.userId])

  for (const response of responses) {
    if (response.muxAssetId) muxAssetIds.add(response.muxAssetId)
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
      const liveSession = await ctx.db.get(response.liveSessionId)
      if (liveSession) await ctx.db.delete(response.liveSessionId)
    }
    await ctx.db.delete(response._id)
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

  const bondfireInviteCodes = await ctx.db
    .query('inviteCodes')
    .withIndex('by_parent', (q) => q.eq('parentType', 'bondfire').eq('parentId', bondfireId))
    .collect()
  for (const inviteCode of bondfireInviteCodes) {
    await ctx.db.delete(inviteCode._id)
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

  const inviteClaims = await ctx.db
    .query('inviteClaims')
    .withIndex('by_bondfire_claimer', (q) => q.eq('bondfireId', bondfireId))
    .collect()
  for (const claim of inviteClaims) {
    await ctx.db.delete(claim._id)
  }

  await deleteWatchEventsForVideo(ctx, bondfireId)

  const reports = await ctx.db
    .query('reports')
    .withIndex('by_bondfire', (q) => q.eq('bondfireId', bondfireId))
    .collect()
  for (const report of reports) {
    await ctx.db.delete(report._id)
  }

  if (bondfire.liveSessionId && bondfire.liveSessionId !== options?.preserveLiveSessionId) {
    const liveSession = await ctx.db.get(bondfire.liveSessionId)
    if (liveSession) await ctx.db.delete(bondfire.liveSessionId)
  }

  // Remove from every user's pinned list.
  const usersWithPin = await ctx.db.query('users').collect()
  for (const user of usersWithPin) {
    if (!user.pinnedBondfireIds?.some((id) => id === bondfireId)) continue
    await ctx.db.patch(user._id, {
      pinnedBondfireIds: user.pinnedBondfireIds.filter((id) => id !== bondfireId),
      updatedAt: Date.now(),
    })
  }

  await ctx.db.delete(bondfireId)

  // Recount affected users by re-querying playable records (matches retention).
  for (const userId of affectedUsers) {
    const user = await ctx.db.get(userId)
    if (!user) continue
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

  if (bondfire.campId) {
    const campId = bondfire.campId
    const camp = await ctx.db.get(campId)
    if (camp) {
      const campBondfires = await ctx.db
        .query('bondfires')
        .withIndex('by_camp', (q) => q.eq('campId', campId))
        .collect()
      await ctx.db.patch(campId, {
        bondfireCount: campBondfires.filter(isPlayableVideoRecord).length,
        updatedAt: Date.now(),
      })
    }
  }

  return { muxAssetIds: [...muxAssetIds] }
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

/**
 * A Hearth bondfire born from the pre-recording invite flow. `draftExpiresAt`
 * is intentionally kept after activation so failure/cancel paths can identify
 * these rows and revert them instead of destroying the invited audience.
 */
export function isDraftBornPersonalBondfire(bondfire: Doc<'bondfires'>): boolean {
  return Boolean(bondfire.personalCampId) && bondfire.draftExpiresAt !== undefined
}

/**
 * Put a draft-born Hearth bondfire back into `draft` after a failed or
 * cancelled recording attempt: strip every video/live field so it's pristine,
 * keep the participants and invite codes (the whole point of the invite-first
 * flow), and give back the `bondfireCount` that activation added. The original
 * `draftExpiresAt` still stands, so an abandoned draft is cleaned up on the
 * original 24h schedule.
 *
 * Returns any Mux asset IDs that were attached, so the caller can schedule
 * their deletion (HTTP, so it must happen in an action).
 */
export async function revertBondfireToDraft(
  ctx: MutationCtx,
  bondfire: Doc<'bondfires'>,
): Promise<{ muxAssetIds: string[] }> {
  const muxAssetIds = bondfire.muxAssetId ? [bondfire.muxAssetId] : []

  await ctx.db.patch(bondfire._id, {
    status: 'draft',
    videoStatus: 'pending',
    liveSessionId: undefined,
    muxUploadId: undefined,
    muxAssetId: undefined,
    muxAssetStatus: undefined,
    muxPlaybackId: undefined,
    muxLiveStreamId: undefined,
    muxLivePlaybackId: undefined,
    durationMs: undefined,
    width: undefined,
    height: undefined,
    updatedAt: Date.now(),
  })

  if (bondfire.status !== 'draft') {
    const owner = await ctx.db.get(bondfire.userId)
    if (owner) {
      await ctx.db.patch(owner._id, {
        bondfireCount: Math.max(0, (owner.bondfireCount ?? 1) - 1),
        updatedAt: Date.now(),
      })
    }
  }

  return { muxAssetIds }
}

/**
 * Handle a bondfire (spark) whose video has terminally failed or been abandoned.
 *
 * ALWAYS writes a forensic record first. A draft-born Hearth bondfire is then
 * reverted to `draft` (regardless of the hard-delete flag — reverting is a
 * recovery, not a deletion) so its invited audience survives and the owner can
 * retry recording. Otherwise, only when `HARD_DELETE_FAILED_BONDFIRES` is
 * enabled, cascade-deletes the bondfire.
 *
 * Returns the Mux asset IDs the caller must delete from Mux (in an action)
 * whenever `deleted` or `reverted` is true.
 *
 * No-ops for non-spark records — only bondfire (spark) failures orphan a
 * reachable detail route; response failures are handled by their own paths.
 */
export async function handleFailedBondfire(
  ctx: MutationCtx,
  bondfire: Doc<'bondfires'>,
  reason: BondfireFailureReason,
  detail?: Record<string, unknown>,
): Promise<{ deleted: boolean; reverted: boolean; muxAssetIds: string[] }> {
  await recordBondfireFailure(ctx, bondfire, reason, detail)

  if (isDraftBornPersonalBondfire(bondfire)) {
    const { muxAssetIds } = await revertBondfireToDraft(ctx, bondfire)
    return { deleted: false, reverted: true, muxAssetIds }
  }

  if (!HARD_DELETE_FAILED_BONDFIRES) {
    return { deleted: false, reverted: false, muxAssetIds: [] }
  }

  const { muxAssetIds } = await purgeBondfireConvexRecords(ctx, bondfire)
  return { deleted: true, reverted: false, muxAssetIds }
}

const MUX_API_BASE_URL = 'https://api.mux.com/video/v1'

function getMuxAuthorizationHeader(): string {
  const tokenId = process.env.MUX_TOKEN_ID
  const tokenSecret = process.env.MUX_TOKEN_SECRET
  if (!tokenId || !tokenSecret) {
    throw new Error('Mux is not configured (MUX_TOKEN_ID / MUX_TOKEN_SECRET).')
  }
  return `Basic ${btoa(`${tokenId}:${tokenSecret}`)}`
}

/**
 * Best-effort deletion of Mux assets left behind by a purged failed bondfire.
 * Scheduled from the mutation paths (which can't make HTTP calls) only when a
 * hard delete actually removed records. A 404 is expected and ignored.
 */
export const deleteFailedBondfireMuxAssets = internalAction({
  args: { assetIds: v.array(v.string()) },
  handler: async (_ctx, args) => {
    for (const assetId of args.assetIds) {
      try {
        const response = await fetch(`${MUX_API_BASE_URL}/assets/${assetId}`, {
          method: 'DELETE',
          headers: { Accept: 'application/json', Authorization: getMuxAuthorizationHeader() },
        })
        if (!response.ok && response.status !== 404) {
          console.error(
            `[bondfireFailureCleanup] Mux asset delete failed ${assetId}: ${response.status}`,
          )
        }
      } catch (err) {
        console.error(`[bondfireFailureCleanup] Mux asset delete threw ${assetId}:`, err)
      }
    }
  },
})

import { paginationOptsValidator } from 'convex/server'
import { v } from 'convex/values'
import { internal } from './_generated/api'
import type { Doc, Id } from './_generated/dataModel'
import { internalAction, internalMutation, internalQuery, type QueryCtx } from './_generated/server'
import { isUserEligibleForCamp } from './agePolicy'
import {
  buildViewerVisibilityContext,
  isBondfireVisibleToViewer,
  isUserContentVisibleToViewer,
  type ViewerVisibilityContext,
} from './bondfireVisibility'
import { isModeratedContentVisible } from './contentSafety'
import { getPlayableVideoPlayback } from './lib/latestResponsePlayback'
import { canStartMaintenanceRun, isExpectedMaintenancePage } from './lib/maintenanceRuns'
import { digestSingleBody } from './lib/notificationCopy'
import { boundedInteger } from './lib/queryBounds'
import { DEFAULT_DIGEST_WINDOW_HOUR, resolveNotificationPrefs } from './notifications'
import { canViewPersonalBondfire } from './personalBondfireAccess'

// ── Daily digest + 72h nudge ──
//
// One digest push per user per day, sent in the user's local digest
// window, covering unwatched activity in threads they participate in.
// A final 72h nudge fires only when the user hasn't opened the app at
// all since the activity (lastActiveAt kill switch). Copy stays concrete
// ("3 videos waiting"), never guilt-based.
//
// Bookkeeping lives in notificationDeliveries with prefixed videoKeys
// (`digest:{videoId}`, `nudge:{videoId}`), so each video appears in at
// most one digest and at most one nudge, ever.

// Default digest window hour lives in notifications.ts
// (DEFAULT_DIGEST_WINDOW_HOUR, currently 17 = 5pm local). Users can
// change theirs via notifications.updatePreferences.

/** Activity must be at least this old before it appears in a digest. */
const DIGEST_MIN_AGE_MS = 20 * 60 * 60 * 1000

/** Activity older than this is no longer digested (nudge handles stragglers). */
const DIGEST_MAX_AGE_MS = 96 * 60 * 60 * 1000

/** Digested items still unwatched after this long are nudge candidates. */
const NUDGE_AFTER_MS = 72 * 60 * 60 * 1000

/** Threads / items caps to bound per-user work. */
const MAX_THREADS = 75
const MAX_ITEMS = 30
const MAX_PER_THREAD_VIDEO_READS = MAX_ITEMS * 4
const MAX_DIGEST_RESPONSE_READS = 600
const MAX_DIGEST_ROOT_READS = 300
const MAX_PRIOR_DIGEST_DELIVERIES = MAX_ITEMS * 4
const DIGEST_TOKEN_BATCH_SIZE = 100
const DIGEST_TOKEN_BATCH_MAX = 100
const DIGEST_SWEEP_LEASE_MS = 50 * 60 * 1000
const DIGEST_SWEEP_JOB = 'hourly-digest'

const DIGEST_THREAD_KEY = 'digest'
const NUDGE_THREAD_KEY = 'nudge'

interface DigestItem {
  videoId: string
  bondfireId: Id<'bondfires'>
  creatorName: string | null
  title: string | null
  // 'response' = a reply video in a thread you participate in; 'bondfire' = a
  // new camp fire (the root video) surfaced to camp members.
  kind: 'response' | 'bondfire'
  summary?: string | null
}

interface PushUser {
  userId: Id<'users'>
  timezone: string | null
  digestHour: number
}

async function canReceiveBondfireActivity(
  ctx: QueryCtx,
  userId: Id<'users'>,
  bondfire: Doc<'bondfires'>,
  viewer: ViewerVisibilityContext,
): Promise<boolean> {
  if (!isModeratedContentVisible(bondfire.moderationStatus, { isOwner: false, isAdmin: false }))
    return false
  if (!(await isBondfireVisibleToViewer(ctx, bondfire, viewer))) return false
  if (bondfire.personalCampId) {
    return await canViewPersonalBondfire(ctx, { bondfire, userId })
  }
  if (!bondfire.campId) return bondfire.userId === userId

  const [user, camp, membership] = await Promise.all([
    ctx.db.get(userId),
    ctx.db.get(bondfire.campId),
    ctx.db
      .query('campMembers')
      .withIndex('by_user_camp', (q) =>
        q.eq('userId', userId).eq('campId', bondfire.campId as Id<'camps'>),
      )
      .first(),
  ])
  return (
    user !== null &&
    camp !== null &&
    membership?.status === 'active' &&
    !membership.muted &&
    isUserEligibleForCamp(user, camp)
  )
}

type PushUsersPage = {
  page: PushUser[]
  continueCursor: string
  isDone: boolean
  tokensRead: number
}

type DigestSweepStats = {
  tokensRead: number
  usersChecked: number
  usersInWindow: number
  usersMissingTimezone: number
}

const EMPTY_DIGEST_SWEEP_STATS: DigestSweepStats = {
  tokensRead: 0,
  usersChecked: 0,
  usersInWindow: 0,
  usersMissingTimezone: 0,
}

function readDigestSweepStats(value: unknown): DigestSweepStats {
  if (!value || typeof value !== 'object') return { ...EMPTY_DIGEST_SWEEP_STATS }
  const stats = value as Partial<DigestSweepStats>
  return {
    tokensRead: stats.tokensRead ?? 0,
    usersChecked: stats.usersChecked ?? 0,
    usersInWindow: stats.usersInWindow ?? 0,
    usersMissingTimezone: stats.usersMissingTimezone ?? 0,
  }
}

/**
 * Local hour for an IANA timezone, falling back to UTC when the timezone
 * is missing or the runtime can't resolve it.
 */
function getLocalHour(timezone: string | null, date: Date): number {
  if (!timezone) return date.getUTCHours()
  try {
    const formatted = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour: 'numeric',
      hour12: false,
    }).format(date)
    const hour = Number.parseInt(formatted, 10)
    return Number.isNaN(hour) ? date.getUTCHours() : hour % 24
  } catch {
    return date.getUTCHours()
  }
}

/** Distinct push-capable users with their best-known timezone and
 * preferred digest window hour. */
export const listPushUsersPage = internalQuery({
  args: { paginationOpts: paginationOptsValidator },
  handler: async (ctx, args) => {
    const numItems = boundedInteger(args.paginationOpts.numItems, {
      defaultValue: DIGEST_TOKEN_BATCH_SIZE,
      min: 1,
      max: DIGEST_TOKEN_BATCH_MAX,
      name: 'paginationOpts.numItems',
    })
    const tokenPage = await ctx.db.query('deviceTokens').paginate({
      ...args.paginationOpts,
      numItems,
      maximumRowsRead: DIGEST_TOKEN_BATCH_MAX,
      maximumBytesRead: 2_000_000,
    })
    const byUser = new Map<Id<'users'>, string | null>()
    for (const token of tokenPage.page) {
      const existing = byUser.get(token.userId)
      // Prefer any token that knows its timezone.
      if (existing === undefined || (existing === null && token.timezone)) {
        byUser.set(token.userId, token.timezone ?? null)
      }
    }

    const users: PushUser[] = await Promise.all(
      [...byUser.entries()].map(async ([userId, timezone]) => {
        const user = await ctx.db.get(userId)
        return {
          userId,
          timezone,
          digestHour: user
            ? resolveNotificationPrefs(user.notificationPrefs).digestWindowHour
            : DEFAULT_DIGEST_WINDOW_HOUR,
        }
      }),
    )
    return { ...tokenPage, page: users, tokensRead: tokenPage.page.length }
  },
})

/**
 * Unwatched activity in threads the user participates in, old enough to
 * digest, not yet digested, respecting camp mute and read markers.
 */
export const collectDigestItems = internalQuery({
  args: { userId: v.id('users') },
  handler: async (ctx, args): Promise<DigestItem[]> => {
    const now = Date.now()
    const viewer = await buildViewerVisibilityContext(ctx, args.userId)
    if (
      !viewer.user ||
      viewer.user.accountDeletionStatus ||
      viewer.user.moderationStatus === 'suspended'
    )
      return []
    const newestAllowed = now - DIGEST_MIN_AGE_MS
    const oldestAllowed = now - DIGEST_MAX_AGE_MS

    // ── Threads the user participates in ──
    const threadIds = new Set<Id<'bondfires'>>()

    const ownBondfires = await ctx.db
      .query('bondfires')
      .withIndex('by_user', (q) => q.eq('userId', args.userId))
      .order('desc')
      .take(MAX_THREADS)
    for (const bondfire of ownBondfires) {
      threadIds.add(bondfire._id)
    }

    const ownResponses = await ctx.db
      .query('bondfireVideos')
      .withIndex('by_user', (q) => q.eq('userId', args.userId))
      .order('desc')
      .take(MAX_THREADS * 2)
    for (const response of ownResponses) {
      threadIds.add(response.bondfireId)
    }

    const hearthParticipations = await ctx.db
      .query('personalBondfireParticipants')
      .withIndex('by_user_status', (q) => q.eq('userId', args.userId).eq('status', 'active'))
      .order('desc')
      .take(MAX_THREADS)
    for (const participation of hearthParticipations) {
      threadIds.add(participation.bondfireId)
    }

    // ── Collect unwatched activity per thread ──
    const items: DigestItem[] = []
    let remainingResponseReads = MAX_DIGEST_RESPONSE_READS

    for (const bondfireId of [...threadIds].slice(0, MAX_THREADS)) {
      if (items.length >= MAX_ITEMS || remainingResponseReads === 0) break

      const bondfire = await ctx.db.get(bondfireId)
      if (!bondfire) continue
      if (!(await canReceiveBondfireActivity(ctx, args.userId, bondfire, viewer))) continue
      // Cheap freshness gate: updatedAt is bumped on every new video.
      if (bondfire.updatedAt < oldestAllowed) continue

      const readMarker = await ctx.db
        .query('bondfireThreadReads')
        .withIndex('by_user_bondfire', (q) =>
          q.eq('userId', args.userId).eq('bondfireId', bondfireId),
        )
        .first()
      const lastReadAt = readMarker?.lastReadAt ?? 0

      const videos = await ctx.db
        .query('bondfireVideos')
        .withIndex('by_bondfire', (q) => q.eq('bondfireId', bondfireId))
        .order('desc')
        .take(Math.min(MAX_PER_THREAD_VIDEO_READS, remainingResponseReads))
      remainingResponseReads -= videos.length

      for (const video of videos) {
        if (items.length >= MAX_ITEMS) break
        if (video.userId === args.userId) continue
        if (!isModeratedContentVisible(video.moderationStatus, { isOwner: false, isAdmin: false }))
          continue
        if (!(await isUserContentVisibleToViewer(ctx, video.userId, viewer))) continue
        if (video.expiresAt !== undefined && video.expiresAt <= now) continue
        if (video.videoStatus !== 'ready' && video.videoStatus !== 'live') continue
        if (video.createdAt > newestAllowed || video.createdAt < oldestAllowed) continue
        // The user opened the thread after this video landed — they saw
        // it and chose. Don't nag.
        if (video.createdAt <= lastReadAt) continue

        const watched = await ctx.db
          .query('watchEvents')
          .withIndex('by_user_video', (q) => q.eq('userId', args.userId).eq('videoId', video._id))
          .first()
        if (watched) continue

        const alreadyDigested = await ctx.db
          .query('notificationDeliveries')
          .withIndex('by_video_user', (q) =>
            q.eq('videoKey', `digest:${video._id}`).eq('userId', args.userId),
          )
          .first()
        if (alreadyDigested) continue

        items.push({
          videoId: video._id,
          bondfireId,
          creatorName: video.creatorName ?? null,
          title: bondfire.title ?? null,
          kind: 'response',
          summary: video.summary ?? null,
        })
      }
    }

    // ── New camp bondfires for members ──
    // Responses above are scoped to threads the user has joined. New camp
    // fires, by contrast, should reach every active, non-muted member — the
    // same audience as the spark push — so members are reminded of fresh
    // bondfires even before anyone has responded. The root bondfire video
    // lives in the `bondfires` table, which the response loop never scans.
    const campMemberships = await ctx.db
      .query('campMembers')
      .withIndex('by_user', (q) => q.eq('userId', args.userId).eq('status', 'active'))
      .take(MAX_THREADS)

    let remainingRootReads = MAX_DIGEST_ROOT_READS
    for (const membership of campMemberships) {
      if (items.length >= MAX_ITEMS || remainingRootReads === 0) break
      if (membership.muted) continue
      const [user, camp] = await Promise.all([
        ctx.db.get(args.userId),
        ctx.db.get(membership.campId),
      ])
      if (!user || !camp || !isUserEligibleForCamp(user, camp)) continue

      const campBondfires = await ctx.db
        .query('bondfires')
        .withIndex('by_camp', (q) =>
          q.eq('campId', membership.campId).gte('createdAt', oldestAllowed),
        )
        .order('desc')
        .take(Math.min(MAX_THREADS, remainingRootReads))
      remainingRootReads -= campBondfires.length

      for (const bondfire of campBondfires) {
        if (items.length >= MAX_ITEMS) break
        if (bondfire.userId === args.userId) continue
        if (!(await canReceiveBondfireActivity(ctx, args.userId, bondfire, viewer))) continue
        if (bondfire.videoStatus !== 'ready' && bondfire.videoStatus !== 'live') continue
        if (bondfire.createdAt > newestAllowed || bondfire.createdAt < oldestAllowed) continue
        // Only nudge about fires nobody has answered yet — the goal is to
        // surface unanswered camp bondfires, not announce every new one.
        // videoCount baselines at 1 (the root video); >1 means it has replies.
        if (bondfire.videoCount > 1) continue

        const readMarker = await ctx.db
          .query('bondfireThreadReads')
          .withIndex('by_user_bondfire', (q) =>
            q.eq('userId', args.userId).eq('bondfireId', bondfire._id),
          )
          .first()
        if (readMarker && readMarker.lastReadAt >= bondfire.createdAt) continue

        const watched = await ctx.db
          .query('watchEvents')
          .withIndex('by_user_video', (q) =>
            q.eq('userId', args.userId).eq('videoId', bondfire._id),
          )
          .first()
        if (watched) continue

        const alreadyDigested = await ctx.db
          .query('notificationDeliveries')
          .withIndex('by_video_user', (q) =>
            q.eq('videoKey', `digest:${bondfire._id}`).eq('userId', args.userId),
          )
          .first()
        if (alreadyDigested) continue

        items.push({
          videoId: bondfire._id,
          bondfireId: bondfire._id,
          creatorName: bondfire.creatorName ?? null,
          title: bondfire.title ?? null,
          kind: 'bondfire',
          summary: bondfire.summary ?? null,
        })
      }
    }

    return items
  },
})

/**
 * Previously digested items that are 72h+ old, still unwatched, never
 * nudged, in threads the user still hasn't opened.
 */
export const collectNudgeItems = internalQuery({
  args: { userId: v.id('users') },
  handler: async (ctx, args): Promise<DigestItem[]> => {
    const now = Date.now()
    const viewer = await buildViewerVisibilityContext(ctx, args.userId)
    if (
      !viewer.user ||
      viewer.user.accountDeletionStatus ||
      viewer.user.moderationStatus === 'suspended'
    )
      return []

    const digestDeliveries = await ctx.db
      .query('notificationDeliveries')
      .withIndex('by_user_thread', (q) =>
        q.eq('userId', args.userId).eq('threadKey', DIGEST_THREAD_KEY),
      )
      .order('desc')
      .take(MAX_PRIOR_DIGEST_DELIVERIES)

    const items: DigestItem[] = []

    for (const delivery of digestDeliveries) {
      if (items.length >= MAX_ITEMS) break
      if (now - delivery.sentAt < NUDGE_AFTER_MS) continue

      const videoId = delivery.videoKey.replace(/^digest:/, '')

      const alreadyNudged = await ctx.db
        .query('notificationDeliveries')
        .withIndex('by_video_user', (q) =>
          q.eq('videoKey', `nudge:${videoId}`).eq('userId', args.userId),
        )
        .first()
      if (alreadyNudged) continue

      // videoId references either a response (bondfireVideos) or, for new-camp
      // -fire digests, a root bondfire. Both tables carry creatorName/createdAt.
      const doc = (await ctx.db.get(videoId as Id<'bondfireVideos'>)) as
        | Doc<'bondfireVideos'>
        | Doc<'bondfires'>
        | null
      if (!doc) continue
      if (!getPlayableVideoPlayback({ ...doc, _id: undefined })) continue
      if (!isModeratedContentVisible(doc.moderationStatus, { isOwner: false, isAdmin: false }))
        continue
      if (!(await isUserContentVisibleToViewer(ctx, doc.userId, viewer))) continue

      const watched = await ctx.db
        .query('watchEvents')
        .withIndex('by_user_video', (q) => q.eq('userId', args.userId).eq('videoId', videoId))
        .first()
      if (watched) continue

      let parentBondfireId: Id<'bondfires'>
      let title: string | null
      let kind: 'response' | 'bondfire'
      if ('bondfireId' in doc) {
        parentBondfireId = doc.bondfireId
        const parent = await ctx.db.get(parentBondfireId)
        if (!parent || !(await canReceiveBondfireActivity(ctx, args.userId, parent, viewer)))
          continue
        title = parent?.title ?? null
        kind = 'response'
      } else {
        // New-camp-fire digest: drop it if the fire has since been answered —
        // the nudge is for *unanswered* fires, matching the digest gate.
        if (doc.videoCount > 1) continue
        parentBondfireId = doc._id
        if (!(await canReceiveBondfireActivity(ctx, args.userId, doc, viewer))) continue
        title = doc.title ?? null
        kind = 'bondfire'
      }

      const readMarker = await ctx.db
        .query('bondfireThreadReads')
        .withIndex('by_user_bondfire', (q) =>
          q.eq('userId', args.userId).eq('bondfireId', parentBondfireId),
        )
        .first()
      if (readMarker && readMarker.lastReadAt >= doc.createdAt) continue

      items.push({
        videoId,
        bondfireId: parentBondfireId,
        creatorName: doc.creatorName ?? null,
        title,
        kind,
      })
    }

    return items
  },
})

export const getUserLastActiveAt = internalQuery({
  args: { userId: v.id('users') },
  handler: async (ctx, args): Promise<number | null> => {
    const user = await ctx.db.get(args.userId)
    return user?.lastActiveAt ?? null
  },
})

/**
 * Claim digest/nudge delivery keys for one user. Atomic, so a re-run of
 * the sweep can't double-send. Returns the keys actually claimed.
 */
export const claimUserDeliveries = internalMutation({
  args: {
    userId: v.id('users'),
    videoKeys: v.array(v.string()),
    threadKey: v.string(),
  },
  handler: async (ctx, args): Promise<string[]> => {
    const now = Date.now()
    const claimed: string[] = []

    for (const videoKey of args.videoKeys) {
      const existing = await ctx.db
        .query('notificationDeliveries')
        .withIndex('by_video_user', (q) => q.eq('videoKey', videoKey).eq('userId', args.userId))
        .first()
      if (existing) continue

      await ctx.db.insert('notificationDeliveries', {
        userId: args.userId,
        videoKey,
        threadKey: args.threadKey,
        sentAt: now,
      })
      claimed.push(videoKey)
    }

    return claimed
  },
})

/** Run the digest (and, failing that, the nudge) for one user. */
export const runDigestForUser = internalAction({
  args: { userId: v.id('users') },
  handler: async (ctx, args): Promise<{ sent: 'digest' | 'nudge' | null }> => {
    // ── Digest ──
    const digestItems: DigestItem[] = await ctx.runQuery(internal.digest.collectDigestItems, {
      userId: args.userId,
    })

    if (digestItems.length > 0) {
      const claimedKeys: string[] = await ctx.runMutation(internal.digest.claimUserDeliveries, {
        userId: args.userId,
        videoKeys: digestItems.map((item) => `digest:${item.videoId}`),
        threadKey: DIGEST_THREAD_KEY,
      })

      const claimedItems = digestItems.filter((item) =>
        claimedKeys.includes(`digest:${item.videoId}`),
      )

      if (claimedItems.length > 0) {
        const single = claimedItems.length === 1 ? claimedItems[0] : null
        const body = single
          ? digestSingleBody(single)
          : `${claimedItems.length} new videos waiting in your Bondfires`

        await ctx.runAction(internal.sendNotification.sendToUser, {
          userId: args.userId,
          title: 'Waiting for you',
          body,
          category: 'reminder',
          data: {
            type: 'digest',
            bondfireId: single?.bondfireId,
          },
        })

        return { sent: 'digest' }
      }
    }

    // ── 72h nudge — only when no digest went out today ──
    // Kill switch: any app open within the window cancels the nudge. A
    // missing lastActiveAt means we can't tell, so stay silent.
    const lastActiveAt: number | null = await ctx.runQuery(internal.digest.getUserLastActiveAt, {
      userId: args.userId,
    })
    if (lastActiveAt === null || Date.now() - lastActiveAt < NUDGE_AFTER_MS) {
      return { sent: null }
    }

    const nudgeItems: DigestItem[] = await ctx.runQuery(internal.digest.collectNudgeItems, {
      userId: args.userId,
    })
    if (nudgeItems.length === 0) {
      return { sent: null }
    }

    const claimedNudgeKeys: string[] = await ctx.runMutation(internal.digest.claimUserDeliveries, {
      userId: args.userId,
      videoKeys: nudgeItems.map((item) => `nudge:${item.videoId}`),
      threadKey: NUDGE_THREAD_KEY,
    })

    const claimedNudgeItems = nudgeItems.filter((item) =>
      claimedNudgeKeys.includes(`nudge:${item.videoId}`),
    )
    if (claimedNudgeItems.length === 0) {
      return { sent: null }
    }

    const single = claimedNudgeItems.length === 1 ? claimedNudgeItems[0] : null
    const body = single
      ? `A video from ${single.creatorName ?? 'someone'} is still waiting for you`
      : `${claimedNudgeItems.length} videos are still waiting in your Bondfires`

    await ctx.runAction(internal.sendNotification.sendToUser, {
      userId: args.userId,
      title: 'Still waiting',
      body,
      category: 'reminder',
      data: {
        type: 'nudge',
        bondfireId: single?.bondfireId,
      },
    })

    return { sent: 'nudge' }
  },
})

export const startDigestSweep = internalMutation({
  args: { runId: v.string(), sweepStartedAt: v.number() },
  handler: async (ctx, args) => {
    const now = Date.now()
    const existing = await ctx.db
      .query('maintenanceJobRuns')
      .withIndex('by_job', (q) => q.eq('job', DIGEST_SWEEP_JOB))
      .unique()
    if (existing && !canStartMaintenanceRun(existing, now, DIGEST_SWEEP_LEASE_MS)) {
      return { started: false, activeRunId: existing.runId }
    }

    const run = {
      job: DIGEST_SWEEP_JOB,
      runId: args.runId,
      status: 'running' as const,
      cursor: undefined,
      startedAt: args.sweepStartedAt,
      updatedAt: now,
      completedAt: undefined,
      error: undefined,
      pagesProcessed: 0,
      stats: EMPTY_DIGEST_SWEEP_STATS,
    }
    if (existing) await ctx.db.replace(existing._id, run)
    else await ctx.db.insert('maintenanceJobRuns', run)

    await ctx.scheduler.runAfter(0, internal.digest.runHourlySweepPage, {
      runId: args.runId,
      sweepStartedAt: args.sweepStartedAt,
    })
    return { started: true, activeRunId: args.runId }
  },
})

export const checkpointDigestSweep = internalMutation({
  args: {
    runId: v.string(),
    sweepStartedAt: v.number(),
    processedCursor: v.optional(v.string()),
    nextCursor: v.string(),
    isDone: v.boolean(),
    tokensRead: v.number(),
    usersChecked: v.number(),
    usersMissingTimezone: v.number(),
    userIdsInWindow: v.array(v.id('users')),
  },
  handler: async (ctx, args) => {
    const run = await ctx.db
      .query('maintenanceJobRuns')
      .withIndex('by_job', (q) => q.eq('job', DIGEST_SWEEP_JOB))
      .unique()
    if (
      !run ||
      run.runId !== args.runId ||
      run.status !== 'running' ||
      !isExpectedMaintenancePage(run.cursor, args.processedCursor)
    ) {
      return { accepted: false }
    }

    for (const userId of args.userIdsInWindow) {
      await ctx.scheduler.runAfter(0, internal.digest.runDigestForUser, { userId })
    }

    const previous = readDigestSweepStats(run.stats)
    const stats: DigestSweepStats = {
      tokensRead: previous.tokensRead + args.tokensRead,
      usersChecked: previous.usersChecked + args.usersChecked,
      usersInWindow: previous.usersInWindow + args.userIdsInWindow.length,
      usersMissingTimezone: previous.usersMissingTimezone + args.usersMissingTimezone,
    }
    const now = Date.now()
    await ctx.db.patch(run._id, {
      cursor: args.isDone ? undefined : args.nextCursor,
      status: args.isDone ? 'complete' : 'running',
      completedAt: args.isDone ? now : undefined,
      updatedAt: now,
      pagesProcessed: run.pagesProcessed + 1,
      stats,
    })

    if (args.isDone) {
      await ctx.scheduler.runAfter(0, internal.serverTelemetry.recordServerEvent, {
        level: 'info',
        event: 'digest:sweep',
        message: 'Hourly digest sweep completed',
        data: {
          runId: args.runId,
          pagesProcessed: run.pagesProcessed + 1,
          ...stats,
          localUtcHour: new Date(args.sweepStartedAt).getUTCHours(),
        },
      })
    } else {
      await ctx.scheduler.runAfter(0, internal.digest.runHourlySweepPage, {
        runId: args.runId,
        cursor: args.nextCursor,
        sweepStartedAt: args.sweepStartedAt,
      })
    }
    return { accepted: true }
  },
})

export const failDigestSweep = internalMutation({
  args: { runId: v.string(), processedCursor: v.optional(v.string()), error: v.string() },
  handler: async (ctx, args) => {
    const run = await ctx.db
      .query('maintenanceJobRuns')
      .withIndex('by_job', (q) => q.eq('job', DIGEST_SWEEP_JOB))
      .unique()
    if (
      !run ||
      run.runId !== args.runId ||
      run.status !== 'running' ||
      !isExpectedMaintenancePage(run.cursor, args.processedCursor)
    ) {
      return false
    }
    const error = args.error.slice(0, 500)
    await ctx.db.patch(run._id, { status: 'failed', error, updatedAt: Date.now() })
    await ctx.scheduler.runAfter(0, internal.serverTelemetry.recordServerEvent, {
      level: 'error',
      event: 'digest:sweep_failed',
      message: 'Hourly digest sweep failed',
      data: { runId: args.runId, pagesProcessed: run.pagesProcessed, error },
    })
    return true
  },
})

export const runHourlySweepPage = internalAction({
  args: {
    runId: v.string(),
    cursor: v.optional(v.string()),
    sweepStartedAt: v.number(),
  },
  handler: async (ctx, args): Promise<{ accepted: boolean }> => {
    try {
      const page: PushUsersPage = await ctx.runQuery(internal.digest.listPushUsersPage, {
        paginationOpts: {
          cursor: args.cursor ?? null,
          numItems: DIGEST_TOKEN_BATCH_SIZE,
        },
      })
      const sweepTime = new Date(args.sweepStartedAt)
      const userIdsInWindow: Id<'users'>[] = []
      let usersMissingTimezone = 0
      for (const user of page.page) {
        if (!user.timezone) usersMissingTimezone++
        if (getLocalHour(user.timezone, sweepTime) === user.digestHour) {
          userIdsInWindow.push(user.userId)
        }
      }
      return await ctx.runMutation(internal.digest.checkpointDigestSweep, {
        runId: args.runId,
        sweepStartedAt: args.sweepStartedAt,
        processedCursor: args.cursor,
        nextCursor: page.continueCursor,
        isDone: page.isDone,
        tokensRead: page.tokensRead,
        usersChecked: page.page.length,
        usersMissingTimezone,
        userIdsInWindow,
      })
    } catch (error) {
      await ctx.runMutation(internal.digest.failDigestSweep, {
        runId: args.runId,
        processedCursor: args.cursor,
        error: error instanceof Error ? error.message : String(error),
      })
      throw error
    }
  },
})

/** Hourly entry point. The durable mutation rejects overlapping active runs. */
export const runHourlySweep = internalAction({
  args: {},
  handler: async (
    ctx,
  ): Promise<{
    started: boolean
    runId: string
    scheduled: number
    usersChecked: number
    usersInWindow: number
  }> => {
    const sweepStartedAt = Date.now()
    const runId = `${sweepStartedAt}-${Math.random().toString(36).slice(2, 10)}`
    const result: { started: boolean; activeRunId: string } = await ctx.runMutation(
      internal.digest.startDigestSweep,
      {
        runId,
        sweepStartedAt,
      },
    )
    return {
      started: result.started,
      runId: result.activeRunId,
      scheduled: 0,
      usersChecked: 0,
      usersInWindow: 0,
    }
  },
})

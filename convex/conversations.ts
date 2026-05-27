import { v } from 'convex/values'
import type { Doc, Id } from './_generated/dataModel'
import type { QueryCtx } from './_generated/server'
import { mutation, query } from './_generated/server'
import { auth } from './auth'
import { throwUserError } from './errors'

type ThreadParticipant = {
  user: PublicUser
  latestAt: number
  videoCount: number
  isPinned: boolean
}

type ThreadSummary = Doc<'bondfires'> & {
  camp: Doc<'camps'> | null
  lastActivityAt: number
  unread: boolean
  participants: ThreadParticipant[]
}

type PublicUser = {
  _id: Id<'users'>
  displayName?: string
  name?: string
  photoUrl?: string
}

const DEFAULT_THREAD_LIMIT = 50
const MAX_THREAD_LIMIT = 80
const THREAD_CANDIDATE_MULTIPLIER = 4
const CLOSE_CIRCLE_LIMIT = 8
const CLOSE_CIRCLE_THREAD_CANDIDATE_LIMIT = 80
const THREAD_RESPONSE_SUMMARY_LIMIT = 250

function toPublicUser(user: Doc<'users'>): PublicUser {
  return {
    _id: user._id,
    displayName: user.displayName,
    name: user.name,
    photoUrl: user.photoUrl,
  }
}

function clampLimit(limit: number | undefined) {
  return Math.min(Math.max(limit ?? DEFAULT_THREAD_LIMIT, 1), MAX_THREAD_LIMIT)
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

async function getVisibleCampIds(ctx: QueryCtx, userId: Id<'users'>) {
  const memberships = await ctx.db
    .query('campMembers')
    .withIndex('by_user', (q) => q.eq('userId', userId).eq('status', 'active'))
    .collect()

  return new Set(memberships.map((membership) => membership.campId))
}

async function isBondfireVisibleToViewer(
  ctx: QueryCtx,
  bondfire: Doc<'bondfires'>,
  memberCampIds: Set<Id<'camps'>>,
) {
  if (!bondfire.campId) {
    return true
  }

  const camp = await ctx.db.get(bondfire.campId)
  if (!camp || camp.status !== 'active') {
    return false
  }

  if (camp.access !== 'invite') {
    return true
  }
  return memberCampIds.has(camp._id)
}

async function getParticipantMap(
  ctx: QueryCtx,
  bondfire: Doc<'bondfires'>,
  args?: { responseLimit?: number },
) {
  const participants = new Map<Id<'users'>, { latestAt: number; videoCount: number }>()
  participants.set(bondfire.userId, { latestAt: bondfire.createdAt, videoCount: 1 })

  const responseQuery = ctx.db
    .query('bondfireVideos')
    .withIndex('by_bondfire', (q) => q.eq('bondfireId', bondfire._id))
    .order('desc')
  const responses = args?.responseLimit
    ? await responseQuery.take(args.responseLimit)
    : await responseQuery.collect()

  for (const response of responses.filter(isPlayableVideoRecord)) {
    const current = participants.get(response.userId)
    participants.set(response.userId, {
      latestAt: Math.max(current?.latestAt ?? 0, response.createdAt),
      videoCount: (current?.videoCount ?? 0) + 1,
    })
  }

  return participants
}

async function getParticipantThreadIds(ctx: QueryCtx, userId: Id<'users'>, candidateLimit: number) {
  const threadIds = new Set<Id<'bondfires'>>()

  const ownBondfires = await ctx.db
    .query('bondfires')
    .withIndex('by_user', (q) => q.eq('userId', userId))
    .order('desc')
    .take(candidateLimit)
  for (const bondfire of ownBondfires) {
    threadIds.add(bondfire._id)
  }

  const responses = await ctx.db
    .query('bondfireVideos')
    .withIndex('by_user', (q) => q.eq('userId', userId))
    .order('desc')
    .take(candidateLimit)
  for (const response of responses) {
    threadIds.add(response.bondfireId)
  }

  return threadIds
}

async function getPinnedUserIds(ctx: QueryCtx, ownerId: Id<'users'>) {
  const pins = await ctx.db
    .query('closeCirclePins')
    .withIndex('by_owner', (q) => q.eq('ownerId', ownerId))
    .collect()

  return new Set(pins.map((pin) => pin.pinnedUserId))
}

function getThreadActivityAt(
  bondfire: Doc<'bondfires'>,
  participantMap: Map<Id<'users'>, { latestAt: number; videoCount: number }>,
) {
  return Math.max(
    bondfire.createdAt,
    ...[...participantMap.values()].map((entry) => entry.latestAt),
  )
}

async function buildThreadSummary(
  ctx: QueryCtx,
  args: {
    bondfire: Doc<'bondfires'>
    viewerId: Id<'users'>
    pinnedUserIds: Set<Id<'users'>>
  },
): Promise<ThreadSummary | null> {
  const participantMap = await getParticipantMap(ctx, args.bondfire, {
    responseLimit: THREAD_RESPONSE_SUMMARY_LIMIT,
  })
  const participantUsers = await Promise.all(
    [...participantMap.keys()].map((userId) => ctx.db.get(userId)),
  )
  const participants = participantUsers.flatMap((user) => {
    if (!user) {
      return []
    }

    const participation = participantMap.get(user._id)
    if (!participation) {
      return []
    }

    return [
      {
        user: toPublicUser(user),
        latestAt: participation.latestAt,
        videoCount: participation.videoCount,
        isPinned: args.pinnedUserIds.has(user._id),
      },
    ]
  })

  const lastActivityAt = getThreadActivityAt(args.bondfire, participantMap)
  const readMarker = await ctx.db
    .query('bondfireThreadReads')
    .withIndex('by_user_bondfire', (q) =>
      q.eq('userId', args.viewerId).eq('bondfireId', args.bondfire._id),
    )
    .first()
  const lastViewerActivityAt = participantMap.get(args.viewerId)?.latestAt ?? 0
  const unread =
    lastActivityAt > (readMarker?.lastReadAt ?? 0) && lastActivityAt > lastViewerActivityAt
  const camp = args.bondfire.campId ? await ctx.db.get(args.bondfire.campId) : null

  return {
    ...args.bondfire,
    camp,
    lastActivityAt,
    unread,
    participants: participants.sort((a, b) => b.latestAt - a.latestAt),
  }
}

async function listSharedThreads(
  ctx: QueryCtx,
  args: {
    viewerId: Id<'users'>
    pinnedUserId: Id<'users'>
    memberCampIds: Set<Id<'camps'>>
    pinnedUserIds: Set<Id<'users'>>
    limit: number
    candidateLimit: number
  },
) {
  const [viewerThreadIds, pinnedThreadIds] = await Promise.all([
    getParticipantThreadIds(ctx, args.viewerId, args.candidateLimit),
    getParticipantThreadIds(ctx, args.pinnedUserId, args.candidateLimit),
  ])
  const sharedThreadIds = [...viewerThreadIds].filter((threadId) => pinnedThreadIds.has(threadId))

  const threads: ThreadSummary[] = []
  for (const threadId of sharedThreadIds) {
    const bondfire = await ctx.db.get(threadId)
    if (!bondfire || !isPlayableVideoRecord(bondfire)) {
      continue
    }
    if (!(await isBondfireVisibleToViewer(ctx, bondfire, args.memberCampIds))) {
      continue
    }

    const summary = await buildThreadSummary(ctx, {
      bondfire,
      viewerId: args.viewerId,
      pinnedUserIds: args.pinnedUserIds,
    })
    if (summary) {
      threads.push(summary)
    }
  }

  return threads.sort((a, b) => b.lastActivityAt - a.lastActivityAt).slice(0, args.limit)
}

async function listVisiblePrivateCampThreadsByUser(
  ctx: QueryCtx,
  args: {
    viewerId: Id<'users'>
    ownerId: Id<'users'>
    memberCampIds: Set<Id<'camps'>>
    pinnedUserIds: Set<Id<'users'>>
    limit: number
    candidateLimit: number
  },
) {
  const ownedBondfires = await ctx.db
    .query('bondfires')
    .withIndex('by_user', (q) => q.eq('userId', args.ownerId))
    .order('desc')
    .take(args.candidateLimit)

  const threads: ThreadSummary[] = []
  for (const bondfire of ownedBondfires) {
    if (!bondfire.campId || !isPlayableVideoRecord(bondfire)) {
      continue
    }

    const camp = await ctx.db.get(bondfire.campId)
    if (!camp || camp.access !== 'invite' || !args.memberCampIds.has(camp._id)) {
      continue
    }

    const summary = await buildThreadSummary(ctx, {
      bondfire,
      viewerId: args.viewerId,
      pinnedUserIds: args.pinnedUserIds,
    })
    if (summary) {
      threads.push(summary)
    }
  }

  return threads.sort((a, b) => b.lastActivityAt - a.lastActivityAt).slice(0, args.limit)
}

export const listMyFires = query({
  args: {
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const userId = await auth.getUserId(ctx)
    if (!userId) {
      return []
    }

    const limit = clampLimit(args.limit)
    const candidateLimit = limit * THREAD_CANDIDATE_MULTIPLIER
    const [threadIds, memberCampIds, pinnedUserIds] = await Promise.all([
      getParticipantThreadIds(ctx, userId, candidateLimit),
      getVisibleCampIds(ctx, userId),
      getPinnedUserIds(ctx, userId),
    ])

    const threads: ThreadSummary[] = []
    for (const threadId of threadIds) {
      const bondfire = await ctx.db.get(threadId)
      if (!bondfire || !isPlayableVideoRecord(bondfire)) {
        continue
      }
      if (!(await isBondfireVisibleToViewer(ctx, bondfire, memberCampIds))) {
        continue
      }

      const summary = await buildThreadSummary(ctx, { bondfire, viewerId: userId, pinnedUserIds })
      if (summary) {
        threads.push(summary)
      }
    }

    return threads.sort((a, b) => b.lastActivityAt - a.lastActivityAt).slice(0, limit)
  },
})

export const listCloseCircle = query({
  args: {},
  handler: async (ctx) => {
    const userId = await auth.getUserId(ctx)
    if (!userId) {
      return []
    }

    const [pins, memberCampIds, pinnedUserIds] = await Promise.all([
      ctx.db
        .query('closeCirclePins')
        .withIndex('by_owner', (q) => q.eq('ownerId', userId))
        .take(CLOSE_CIRCLE_LIMIT),
      getVisibleCampIds(ctx, userId),
      getPinnedUserIds(ctx, userId),
    ])

    const entries = []
    for (const pin of pins) {
      const user = await ctx.db.get(pin.pinnedUserId)
      if (!user) {
        continue
      }

      const [sharedThreads, privateCampThreads] = await Promise.all([
        listSharedThreads(ctx, {
          viewerId: userId,
          pinnedUserId: pin.pinnedUserId,
          memberCampIds,
          pinnedUserIds,
          limit: 3,
          candidateLimit: CLOSE_CIRCLE_THREAD_CANDIDATE_LIMIT,
        }),
        listVisiblePrivateCampThreadsByUser(ctx, {
          viewerId: userId,
          ownerId: pin.pinnedUserId,
          memberCampIds,
          pinnedUserIds,
          limit: 3,
          candidateLimit: CLOSE_CIRCLE_THREAD_CANDIDATE_LIMIT,
        }),
      ])
      const threadsById = new Map<Id<'bondfires'>, ThreadSummary>()
      for (const thread of [...sharedThreads, ...privateCampThreads]) {
        threadsById.set(thread._id, thread)
      }
      const threads = [...threadsById.values()].sort((a, b) => b.lastActivityAt - a.lastActivityAt)

      entries.push({
        pin,
        user: toPublicUser(user),
        sharedThreads,
        privateCampThreads,
        primaryThread: threads[0] ?? null,
      })
    }

    return entries
  },
})

export const markThreadRead = mutation({
  args: {
    bondfireId: v.id('bondfires'),
  },
  handler: async (ctx, args) => {
    const userId = await auth.getUserId(ctx)
    if (!userId) {
      throwUserError('Not authenticated')
    }

    const bondfire = await ctx.db.get(args.bondfireId)
    if (!bondfire) {
      throwUserError('Bondfire not found')
    }

    const participantMap = await getParticipantMap(ctx, bondfire)
    if (!participantMap.has(userId)) {
      throwUserError('Only thread participants can mark this Bondfire read')
    }

    const now = Date.now()
    const existing = await ctx.db
      .query('bondfireThreadReads')
      .withIndex('by_user_bondfire', (q) =>
        q.eq('userId', userId).eq('bondfireId', args.bondfireId),
      )
      .first()

    if (existing) {
      await ctx.db.patch(existing._id, {
        lastReadAt: now,
        updatedAt: now,
      })
      return existing._id
    }

    return await ctx.db.insert('bondfireThreadReads', {
      userId,
      bondfireId: args.bondfireId,
      lastReadAt: now,
      createdAt: now,
      updatedAt: now,
    })
  },
})

export const pinPerson = mutation({
  args: {
    userId: v.id('users'),
  },
  handler: async (ctx, args) => {
    const ownerId = await auth.getUserId(ctx)
    if (!ownerId) {
      throwUserError('Not authenticated')
    }
    if (ownerId === args.userId) {
      throwUserError('You cannot pin yourself')
    }

    const pinnedUser = await ctx.db.get(args.userId)
    if (!pinnedUser) {
      throwUserError('User not found')
    }

    const existing = await ctx.db
      .query('closeCirclePins')
      .withIndex('by_owner_pinned', (q) => q.eq('ownerId', ownerId).eq('pinnedUserId', args.userId))
      .first()
    if (existing) {
      return existing._id
    }

    const pins = await ctx.db
      .query('closeCirclePins')
      .withIndex('by_owner', (q) => q.eq('ownerId', ownerId))
      .collect()
    if (pins.length >= 8) {
      throwUserError('Close Circle is full')
    }

    const now = Date.now()
    const nextOrder = pins.reduce((highest, pin) => Math.max(highest, pin.order), -1) + 1
    return await ctx.db.insert('closeCirclePins', {
      ownerId,
      pinnedUserId: args.userId,
      order: nextOrder,
      createdAt: now,
      updatedAt: now,
    })
  },
})

export const unpinPerson = mutation({
  args: {
    userId: v.id('users'),
  },
  handler: async (ctx, args) => {
    const ownerId = await auth.getUserId(ctx)
    if (!ownerId) {
      throwUserError('Not authenticated')
    }

    const existing = await ctx.db
      .query('closeCirclePins')
      .withIndex('by_owner_pinned', (q) => q.eq('ownerId', ownerId).eq('pinnedUserId', args.userId))
      .first()
    if (!existing) {
      return { removed: false }
    }

    await ctx.db.delete(existing._id)
    return { removed: true }
  },
})

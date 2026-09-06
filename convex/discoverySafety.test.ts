import { describe, expect, it } from 'vitest'
import type { Doc, Id } from './_generated/dataModel'
import type { QueryCtx } from './_generated/server'
import {
  isBondfireVisibleToViewer,
  isUserContentVisibleToViewer,
  type ViewerVisibilityContext,
} from './bondfireVisibility'
import { decorateCampListPage } from './camps'
import { getLatestResponsePlayback } from './lib/latestResponsePlayback'

const userId = 'viewer' as Id<'users'>
const creatorId = 'creator' as Id<'users'>
const campId = 'camp' as Id<'camps'>
const bondfireId = 'bondfire' as Id<'bondfires'>
const camp = {
  _id: campId,
  name: 'Camp',
  status: 'active',
  access: 'invite',
  ageBand: 'adult',
} as Doc<'camps'>
function viewer(): ViewerVisibilityContext {
  return {
    userId,
    user: { _id: userId, birthDate: '2000-01-01' } as Doc<'users'>,
    tier: 'free',
    memberCampIds: new Set(),
    claimedBondfireIds: new Set(),
    blockedUserIds: new Set(),
    isAdmin: false,
    campCache: new Map([[campId, Promise.resolve(camp)]]),
    userCache: new Map(),
  }
}

describe('paginated discovery safety', () => {
  it('does not let existing camp membership bypass teen/adult isolation', () => {
    const user = { _id: userId, birthDate: '2000-01-01' } as Doc<'users'>
    const membership = { campId, userId, status: 'active' } as Doc<'campMembers'>
    const context = {
      user,
      userTier: 'free' as const,
      memberships: [membership],
      membershipsByCamp: new Map([[campId, membership]]),
    }
    expect(decorateCampListPage([{ ...camp, ageBand: 'teen' }], context, false)).toEqual([])
    expect(
      decorateCampListPage([{ ...camp, ageBand: 'teen' }], { ...context, user: null }, false),
    ).toEqual([])
    expect(decorateCampListPage([camp], context, false)).toHaveLength(1)
  })

  it.each(['membership', 'invite'] as const)(
    'checks the target when the %s context is full',
    async (grant) => {
      const context = viewer()
      context.membershipContextTruncated = grant === 'membership'
      context.inviteContextTruncated = grant === 'invite'
      const ctx = {
        db: { query: () => ({ withIndex: () => ({ first: async () => ({ status: 'active' }) }) }) },
      } as unknown as QueryCtx
      const bondfire = { _id: bondfireId, userId, campId } as Doc<'bondfires'>
      expect(await isBondfireVisibleToViewer(ctx, bondfire, context)).toBe(true)
    },
  )

  it('checks blocks by user pair without loading an entire block list', async () => {
    const context = viewer()
    context.blockChecks = new Map()
    const ctx = {
      db: {
        query: () => ({ withIndex: () => ({ first: async () => ({ blockerId: creatorId }) }) }),
      },
    } as unknown as QueryCtx
    expect(await isUserContentVisibleToViewer(ctx, creatorId, context)).toBe(false)
  })

  it('omits held and blocked response thumbnails and caps the scan', async () => {
    const context = viewer()
    context.blockedUserIds.add(creatorId)
    const responses = [
      {
        _id: 'held',
        userId: creatorId,
        videoStatus: 'ready',
        muxPlaybackId: 'held-url',
        moderationStatus: 'pending_review',
      },
      {
        _id: 'blocked',
        userId: creatorId,
        videoStatus: 'ready',
        muxPlaybackId: 'blocked-url',
        moderationStatus: 'approved',
      },
      {
        _id: 'visible',
        userId,
        videoStatus: 'ready',
        muxPlaybackId: 'visible-url',
        moderationStatus: 'approved',
      },
    ]
    let scanSize = 0
    const ctx = {
      db: {
        query: () => ({
          withIndex: () => ({
            order: () => ({
              take: async (size: number) => {
                scanSize = size
                return responses
              },
            }),
          }),
        }),
      },
    } as unknown as QueryCtx
    expect(await getLatestResponsePlayback(ctx, bondfireId, context)).toMatchObject({
      muxPlaybackId: 'visible-url',
    })
    expect(scanSize).toBeLessThanOrEqual(10)
  })
})

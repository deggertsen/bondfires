import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Doc, Id } from './_generated/dataModel'
import type { MutationCtx } from './_generated/server'
import { buildViewerVisibilityContext, type ViewerVisibilityContext } from './bondfireVisibility'
import { resolveVisibleWatchTarget } from './watchEvents'

vi.mock('./bondfireVisibility', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./bondfireVisibility')>()),
  buildViewerVisibilityContext: vi.fn(),
}))

describe('watch target safety authorization', () => {
  const viewerId = 'viewer' as Id<'users'>
  const creatorId = 'creator' as Id<'users'>
  const bondfireId = 'bondfire' as Id<'bondfires'>
  const responseId = 'response' as Id<'bondfireVideos'>
  let viewer: ViewerVisibilityContext
  let creator: Doc<'users'>
  let response: Doc<'bondfireVideos'>
  let ctx: MutationCtx

  beforeEach(() => {
    creator = { _id: creatorId } as Doc<'users'>
    response = {
      _id: responseId,
      userId: creatorId,
      bondfireId,
      videoStatus: 'ready',
      muxPlaybackId: 'playback',
      durationMs: 10000,
      moderationStatus: 'approved',
    } as Doc<'bondfireVideos'>
    viewer = {
      userId: viewerId,
      user: { _id: viewerId } as Doc<'users'>,
      tier: 'free',
      memberCampIds: new Set(),
      claimedBondfireIds: new Set(),
      blockedUserIds: new Set(),
      isAdmin: false,
      campCache: new Map(),
      userCache: new Map(),
    }
    vi.mocked(buildViewerVisibilityContext).mockResolvedValue(viewer)
    ctx = {
      db: {
        normalizeId: (_table: string, id: string) => id,
        get: async (id: string) =>
          id === responseId
            ? response
            : id === creatorId
              ? creator
              : id === bondfireId
                ? { _id: bondfireId, userId: viewerId }
                : null,
      },
    } as unknown as MutationCtx
  })

  const target = { videoType: 'response' as const, videoId: responseId }
  it('accepts a visible response', async () => {
    expect(await resolveVisibleWatchTarget(ctx, target, viewerId)).toEqual({ durationMs: 10000 })
  })
  it.each(['pending_review', 'removed'] as const)(
    'rejects %s responses even when the parent is visible',
    async (status) => {
      response.moderationStatus = status
      expect(await resolveVisibleWatchTarget(ctx, target, viewerId)).toBeNull()
    },
  )
  it('rejects a response from a blocked creator', async () => {
    viewer.blockedUserIds.add(creatorId)
    expect(await resolveVisibleWatchTarget(ctx, target, viewerId)).toBeNull()
  })
  it('rejects a response from a suspended creator', async () => {
    creator.moderationStatus = 'suspended'
    expect(await resolveVisibleWatchTarget(ctx, target, viewerId)).toBeNull()
  })
})

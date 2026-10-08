/// <reference types="vite/client" />
import { convexTest } from 'convex-test'
import { describe, expect, it } from 'vitest'
import { api } from './_generated/api'
import type { Doc } from './_generated/dataModel'
import schema from './schema'

const modules = import.meta.glob('./**/*.ts')

async function fixture(provider: 'segment' | 'mux', videoStatus: 'ready' | 'live') {
  const t = convexTest(schema, modules)
  const ids = await t.run(async (ctx) => {
    const ownerId = await ctx.db.insert('users', { gender: 'other' })
    const viewerId = await ctx.db.insert('users', { gender: 'other' })
    const now = Date.now()
    const segmentRecordingId = await ctx.db.insert('segmentRecordings', {
      userId: ownerId,
      localId: 'watch-test',
      status: videoStatus === 'ready' ? 'ready' : 'uploading',
      segmentCount: 1,
      duration: 10,
      maxDuration: 60,
      createdAt: now,
      updatedAt: now,
    })
    const media =
      provider === 'segment'
        ? { segmentRecordingId }
        : videoStatus === 'ready'
          ? { muxPlaybackId: 'vod' }
          : { muxLivePlaybackId: 'live' }
    const video = {
      userId: ownerId,
      videoStatus,
      ...media,
      durationMs: 10000,
      createdAt: now,
    }
    const bondfireId = await ctx.db.insert('bondfires', {
      ...video,
      videoCount: 2,
      updatedAt: now,
    })
    const responseId = await ctx.db.insert('bondfireVideos', {
      ...video,
      bondfireId,
      sequenceNumber: 1,
    })
    return { bondfireId, responseId, viewerId }
  })
  return { t, ids, viewer: t.withIdentity({ subject: ids.viewerId }) }
}

describe.each(['bondfire', 'response'] as const)('%s watch event persistence', (videoType) => {
  for (const provider of ['segment', 'mux'] as const) {
    it.each(['ready', 'live'] as const)(
      `records %s ${provider} playback and exposes watched state in the thread`,
      async (videoStatus) => {
        const { viewer, ids } = await fixture(provider, videoStatus)
        const videoId = videoType === 'bondfire' ? ids.bondfireId : ids.responseId
        const threadWatched = async () => {
          const thread = await viewer.query(api.bondfires.getWithVideos, {
            bondfireId: ids.bondfireId,
          })
          return videoType === 'bondfire'
            ? thread?.watchedByViewer
            : thread?.videos.find((video) => video._id === videoId)?.watchedByViewer
        }

        expect(await threadWatched()).toBe(false)
        expect(
          await viewer.mutation(api.watchEvents.record, {
            videoType,
            videoId,
            eventType: 'start',
            positionMs: 0,
          }),
        ).toEqual({ recorded: true, profileViewCounted: true })
        // Starting a video no longer marks it watched; finishing it does.
        expect(await threadWatched()).toBe(false)
        expect(
          await viewer.mutation(api.watchEvents.record, {
            videoType,
            videoId,
            eventType: 'milestone_25',
            positionMs: 2500,
          }),
        ).toEqual({ recorded: true, profileViewCounted: false })
        expect(
          await viewer.query(api.watchEvents.hasWatched, {
            videoId,
            eventType: 'milestone_25',
          }),
        ).toBe(true)
        expect(await threadWatched()).toBe(false)
        expect(
          await viewer.mutation(api.watchEvents.record, {
            videoType,
            videoId,
            eventType: 'complete',
            positionMs: 9000,
          }),
        ).toEqual({ recorded: true, profileViewCounted: false })
        expect(await threadWatched()).toBe(true)
      },
    )
  }

  it('preserves a legacy start when a new milestone is recorded', async () => {
    const { t, viewer, ids } = await fixture('segment', 'ready')
    const videoId = videoType === 'bondfire' ? ids.bondfireId : ids.responseId
    await t.run((ctx) =>
      ctx.db.insert('watchEvents', {
        userId: ids.viewerId,
        videoType,
        videoId,
        eventType: 'start',
        positionMs: 0,
        // A late deployment must preserve all pre-deployment views too.
        createdAt: Date.UTC(2027, 0, 1),
      }),
    )
    expect(
      await viewer.mutation(api.watchEvents.record, {
        videoType,
        videoId,
        eventType: 'milestone_25',
        positionMs: 2500,
      }),
    ).toEqual({ recorded: true, profileViewCounted: false })
    const thread = await viewer.query(api.bondfires.getWithVideos, { bondfireId: ids.bondfireId })
    expect(
      videoType === 'bondfire' ? thread?.watchedByViewer : thread?.videos[0].watchedByViewer,
    ).toBe(true)
    const events = await t.run((ctx) => ctx.db.query('watchEvents').collect())
    expect(events.find((event) => event.eventType === 'milestone_25')?.completionRequired).toBe(
      true,
    )
  })

  const unavailable: { name: string; patch: Partial<Doc<'bondfireVideos'>> }[] = [
    { name: 'missing media', patch: { segmentRecordingId: undefined } },
    { name: 'uploading', patch: { videoStatus: 'waiting_for_upload' } },
    { name: 'failed', patch: { videoStatus: 'errored' } },
    { name: 'expired', patch: { expiresAt: 0 } },
    { name: 'removed', patch: { moderationStatus: 'removed' } },
  ]
  it.each(unavailable)('does not mark $name segmented videos watched', async ({ patch }) => {
    const { t, viewer, ids } = await fixture('segment', 'ready')
    const videoId = videoType === 'bondfire' ? ids.bondfireId : ids.responseId
    await t.run((ctx) => ctx.db.patch(videoId, patch))
    expect(
      await viewer.mutation(api.watchEvents.record, {
        videoType,
        videoId,
        eventType: 'start',
        positionMs: 0,
      }),
    ).toEqual({ recorded: false, reason: 'unavailable' })
    expect(await viewer.query(api.watchEvents.hasWatched, { videoId })).toBe(false)
  })
})

import { describe, expect, it } from 'vitest'
import type { Id } from '../../../../convex/_generated/dataModel'
import {
  getBondfireThumbnailPlayback,
  getCachedBondfireThumbnail,
  getPendingBondfireThumbnails,
} from '../../lib/bondfireThumbnails'

describe('getBondfireThumbnailPlayback', () => {
  it('resolves a live-only spark with its signed policy and parent authorization ID', () => {
    const fire = {
      _id: 'bondfire-1',
      videoStatus: 'live',
      muxLivePlaybackId: 'live-id',
      muxPlaybackPolicy: 'signed' as const,
    }
    expect(getBondfireThumbnailPlayback(fire)).toEqual({
      cacheKey: 'bondfire-1:live-id',
      muxPlaybackId: 'live-id',
      muxPlaybackPolicy: 'signed',
    })
    expect(getPendingBondfireThumbnails([fire], {}, new Set())[0].request).toMatchObject({
      bondfireId: 'bondfire-1',
      muxPlaybackId: 'live-id',
      muxPlaybackPolicy: 'signed',
    })
    expect(getBondfireThumbnailPlayback({ ...fire, videoStatus: 'processing' })).toBeNull()
    expect(getBondfireThumbnailPlayback({ ...fire, muxPlaybackId: 'vod-id' })?.muxPlaybackId).toBe(
      'vod-id',
    )
  })
  it('prefers the latest response and keeps its playback policy', () => {
    expect(
      getBondfireThumbnailPlayback({
        _id: 'bondfire-1',
        muxPlaybackId: 'spark-id',
        muxPlaybackPolicy: 'signed',
        latestResponseBondfireVideoId: 'response-1' as Id<'bondfireVideos'>,
        latestResponseMuxPlaybackId: 'response-id',
      }),
    ).toEqual({
      bondfireVideoId: 'response-1',
      cacheKey: 'bondfire-1:response-id',
      muxPlaybackId: 'response-id',
      muxPlaybackPolicy: undefined,
    })
  })

  it('falls back to the spark when there is no playable response', () => {
    expect(
      getBondfireThumbnailPlayback({
        _id: 'bondfire-1',
        muxPlaybackId: 'spark-id',
        muxPlaybackPolicy: 'signed',
      }),
    ).toEqual({
      cacheKey: 'bondfire-1:spark-id',
      muxPlaybackId: 'spark-id',
      muxPlaybackPolicy: 'signed',
    })
  })

  it('changes the cache entry when a newer response arrives', () => {
    const urls = {
      'bondfire-1:old-response': 'old-thumbnail',
      'bondfire-1:new-response': 'new-thumbnail',
    }

    expect(
      getCachedBondfireThumbnail(
        { _id: 'bondfire-1', latestResponseMuxPlaybackId: 'old-response' },
        urls,
      ),
    ).toBe('old-thumbnail')
    expect(
      getCachedBondfireThumbnail(
        { _id: 'bondfire-1', latestResponseMuxPlaybackId: 'new-response' },
        urls,
      ),
    ).toBe('new-thumbnail')
  })
})

describe('getPendingBondfireThumbnails', () => {
  it('builds one ordered request batch for the visible window', () => {
    expect(
      getPendingBondfireThumbnails(
        [
          {
            _id: 'bondfire-1',
            muxPlaybackId: 'spark-id',
            muxPlaybackPolicy: 'signed',
          },
          {
            _id: 'bondfire-2',
            latestResponseBondfireVideoId: 'response-2' as Id<'bondfireVideos'>,
            latestResponseMuxPlaybackId: 'response-id',
          },
        ],
        {},
        new Set(),
      ),
    ).toEqual([
      {
        bondfireId: 'bondfire-1',
        cacheKey: 'bondfire-1:spark-id',
        request: {
          muxPlaybackId: 'spark-id',
          muxPlaybackPolicy: 'signed',
          bondfireId: 'bondfire-1',
          bondfireVideoId: undefined,
        },
      },
      {
        bondfireId: 'bondfire-2',
        cacheKey: 'bondfire-2:response-id',
        request: {
          muxPlaybackId: 'response-id',
          muxPlaybackPolicy: undefined,
          bondfireId: undefined,
          bondfireVideoId: 'response-2',
        },
      },
    ])
  })

  it('skips cached, loading, missing, and duplicate playback entries', () => {
    const duplicate = { _id: 'bondfire-1', muxPlaybackId: 'playback-1' }

    expect(
      getPendingBondfireThumbnails(
        [
          duplicate,
          duplicate,
          { _id: 'bondfire-2', muxPlaybackId: 'playback-2' },
          { _id: 'bondfire-3', muxPlaybackId: 'playback-3' },
          { _id: 'bondfire-4' },
        ],
        { 'bondfire-2:playback-2': null },
        new Set(['bondfire-3:playback-3']),
      ).map((item) => item.cacheKey),
    ).toEqual(['bondfire-1:playback-1'])
  })
})

import { describe, expect, it } from 'vitest'
import type { Id } from '../../../../convex/_generated/dataModel'
import {
  getBondfireThumbnailPlayback,
  getCachedBondfireThumbnail,
} from '../../lib/bondfireThumbnails'

describe('getBondfireThumbnailPlayback', () => {
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

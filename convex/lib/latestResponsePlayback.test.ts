import { describe, expect, it } from 'vitest'
import type { Id } from '../_generated/dataModel'
import { getPlayableVideoPlayback } from './latestResponsePlayback'

describe('getPlayableVideoPlayback', () => {
  it('uses VOD playback for ready and legacy response records', () => {
    expect(
      getPlayableVideoPlayback({
        _id: 'response-1' as Id<'bondfireVideos'>,
        videoStatus: 'ready',
        muxPlaybackId: 'vod-id',
        muxPlaybackPolicy: 'signed',
      }),
    ).toEqual({
      bondfireVideoId: 'response-1',
      muxPlaybackId: 'vod-id',
      muxPlaybackPolicy: 'signed',
    })
    expect(getPlayableVideoPlayback({ muxPlaybackId: 'legacy-id' })).toEqual({
      bondfireVideoId: undefined,
      muxPlaybackId: 'legacy-id',
      muxPlaybackPolicy: undefined,
    })
  })

  it('uses live playback only while a response is live', () => {
    expect(
      getPlayableVideoPlayback({
        videoStatus: 'live',
        muxLivePlaybackId: 'live-id',
        muxPlaybackId: 'old-vod-id',
      }),
    ).toEqual({
      bondfireVideoId: undefined,
      muxPlaybackId: 'live-id',
      muxPlaybackPolicy: undefined,
    })
  })

  it('skips expired and non-playable responses', () => {
    expect(
      getPlayableVideoPlayback(
        { videoStatus: 'ready', muxPlaybackId: 'expired', expiresAt: 10 },
        10,
      ),
    ).toBeNull()
    expect(
      getPlayableVideoPlayback({ videoStatus: 'processing', muxPlaybackId: 'not-ready' }),
    ).toBeNull()
    expect(getPlayableVideoPlayback({ videoStatus: 'ready' })).toBeNull()
  })
})

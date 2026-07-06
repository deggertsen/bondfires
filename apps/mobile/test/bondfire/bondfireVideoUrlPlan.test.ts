import { describe, expect, it } from 'vitest'
import type { BondfireDetailData } from '../../app/(main)/bondfire/_lib/bondfireDetailHelpers'
import {
  buildVideoUrlTargets,
  missingUrlRequests,
  shouldLoadMainVideoUrls,
  urlsFromCache,
} from '../../app/(main)/bondfire/_lib/bondfireVideoUrlPlan'

function makeBondfire(overrides: Record<string, unknown> = {}) {
  return {
    _id: 'bf1',
    userId: 'user1',
    videoStatus: 'ready',
    muxPlaybackId: 'main-playback',
    muxPlaybackPolicy: 'signed',
    videos: [],
    ...overrides,
  } as unknown as BondfireDetailData
}

function makeResponse(overrides: Record<string, unknown> = {}) {
  return {
    _id: 'resp1',
    userId: 'user2',
    videoStatus: 'ready',
    muxPlaybackId: 'resp1-playback',
    muxPlaybackPolicy: 'signed',
    ...overrides,
  }
}

describe('buildVideoUrlTargets', () => {
  it('keeps positions aligned when a middle response is not playable', () => {
    const bondfire = makeBondfire({
      videos: [
        makeResponse({ _id: 'resp1', muxPlaybackId: 'resp1-playback' }),
        makeResponse({ _id: 'resp2', muxPlaybackId: undefined, videoStatus: 'pending' }),
        makeResponse({ _id: 'resp3', muxPlaybackId: 'resp3-playback' }),
      ],
    })

    const targets = buildVideoUrlTargets(bondfire)

    expect(targets).toHaveLength(4)
    expect(targets[1].request?.muxPlaybackId).toBe('resp1-playback')
    // The unplayable video holds its slot instead of shifting later videos up
    expect(targets[2].cacheKey).toBeNull()
    expect(targets[2].request).toBeNull()
    expect(targets[3].request?.muxPlaybackId).toBe('resp3-playback')
    expect(targets[3].request?.bondfireVideoId).toBe('resp3')
  })

  it('uses the live playback id for live videos', () => {
    const bondfire = makeBondfire({
      videoStatus: 'live',
      muxLivePlaybackId: 'main-live-playback',
      videos: [
        makeResponse({
          _id: 'resp1',
          videoStatus: 'live',
          muxPlaybackId: undefined,
          muxLivePlaybackId: 'resp1-live-playback',
        }),
      ],
    })

    const targets = buildVideoUrlTargets(bondfire)

    expect(targets[0].request?.muxPlaybackId).toBe('main-live-playback')
    expect(targets[0].isLive).toBe(true)
    expect(targets[1].request?.muxPlaybackId).toBe('resp1-live-playback')
    expect(targets[1].isLive).toBe(true)
  })

  it('produces a null main target when the main video is not ready', () => {
    const bondfire = makeBondfire({
      videoStatus: 'pending',
      videos: [makeResponse()],
    })

    expect(shouldLoadMainVideoUrls(bondfire)).toBe(false)
    const targets = buildVideoUrlTargets(bondfire)
    expect(targets[0].cacheKey).toBeNull()
  })
})

describe('urlsFromCache', () => {
  it('returns cached URLs immediately and null for unfetched videos', () => {
    const bondfire = makeBondfire({
      videos: [makeResponse({ _id: 'resp1' }), makeResponse({ _id: 'resp2' })],
    })
    const targets = buildVideoUrlTargets(bondfire)
    const cache = new Map([[targets[0].cacheKey as string, 'https://stream.mux.com/main.m3u8']])

    expect(urlsFromCache(targets, cache)).toEqual(['https://stream.mux.com/main.m3u8', null, null])
  })

  it('preserves other videos when one video changes status (no blanking)', () => {
    const before = makeBondfire({
      videos: [
        makeResponse({ _id: 'resp1' }),
        makeResponse({ _id: 'resp2', videoStatus: 'live', muxLivePlaybackId: 'resp2-live' }),
      ],
    })
    const beforeTargets = buildVideoUrlTargets(before)
    const cache = new Map(
      beforeTargets.map((target, index) => [target.cacheKey as string, `url-${index}`]),
    )

    // resp2's live stream ends: its playback id changes, everything else stays
    const after = makeBondfire({
      videos: [
        makeResponse({ _id: 'resp1' }),
        makeResponse({ _id: 'resp2', videoStatus: 'ready', muxPlaybackId: 'resp2-vod' }),
      ],
    })
    const afterTargets = buildVideoUrlTargets(after)

    expect(urlsFromCache(afterTargets, cache)).toEqual(['url-0', 'url-1', null])
    const missing = missingUrlRequests(afterTargets, cache)
    expect(missing).toHaveLength(1)
    expect(missing[0].request.muxPlaybackId).toBe('resp2-vod')
  })

  it('appends the DVR start parameter for live videos', () => {
    const bondfire = makeBondfire({
      videoStatus: 'live',
      muxLivePlaybackId: 'main-live',
    })
    const targets = buildVideoUrlTargets(bondfire)
    const cache = new Map([
      [targets[0].cacheKey as string, 'https://stream.mux.com/main-live.m3u8?token=abc'],
    ])

    expect(urlsFromCache(targets, cache)).toEqual([
      'https://stream.mux.com/main-live.m3u8?token=abc&start=0',
    ])
  })
})

describe('missingUrlRequests', () => {
  it('skips cached, in-flight, unplayable, and duplicate entries', () => {
    const bondfire = makeBondfire({
      videos: [
        makeResponse({ _id: 'resp1' }),
        makeResponse({ _id: 'resp2', muxPlaybackId: 'resp2-playback' }),
        makeResponse({ _id: 'resp3', muxPlaybackId: undefined, videoStatus: 'pending' }),
      ],
    })
    const targets = buildVideoUrlTargets(bondfire)
    const cache = new Map([[targets[1].cacheKey as string, 'cached-url']])
    const inFlight = new Set([targets[2].cacheKey as string])

    const missing = missingUrlRequests(targets, cache, inFlight)

    expect(missing.map((entry) => entry.request.muxPlaybackId)).toEqual(['main-playback'])
  })
})

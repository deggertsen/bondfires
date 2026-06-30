import { describe, expect, it, vi } from 'vitest'
import type { BondfireDetailData } from '../../app/(main)/bondfire/_lib/bondfireDetailHelpers'
import {
  buildBondfireVideoItems,
  clampVideoIndex,
  formatTime,
  getResponseVideoScrollIndex,
  withLiveDvrStart,
} from '../../app/(main)/bondfire/_lib/bondfireDetailHelpers'

vi.mock('react-native', () => ({
  Dimensions: {
    get: () => ({ width: 390 }),
  },
}))

describe('bondfireDetailHelpers', () => {
  it('clamps video indexes into the available range', () => {
    expect(clampVideoIndex(undefined, 3)).toBe(0)
    expect(clampVideoIndex(Number.NaN, 3)).toBe(0)
    expect(clampVideoIndex(-2, 3)).toBe(0)
    expect(clampVideoIndex(1.8, 3)).toBe(1)
    expect(clampVideoIndex(8, 3)).toBe(2)
    expect(clampVideoIndex(2, 0)).toBe(0)
  })

  it('formats elapsed milliseconds as m:ss', () => {
    expect(formatTime(0)).toBe('0:00')
    expect(formatTime(61_000)).toBe('1:01')
    expect(formatTime(10 * 60 * 1000 + 9_000)).toBe('10:09')
  })

  it('resolves a response video id to its playback scroll index', () => {
    const bondfireData = {
      videos: [{ _id: 'response-1' }, { _id: 'response-2' }],
    } as unknown as BondfireDetailData

    expect(getResponseVideoScrollIndex(bondfireData, 'response-1')).toBe(1)
    expect(getResponseVideoScrollIndex(bondfireData, 'response-2')).toBe(2)
    expect(getResponseVideoScrollIndex(bondfireData, 'missing-response')).toBeNull()
    expect(getResponseVideoScrollIndex(bondfireData, undefined)).toBeNull()
  })

  it('adds live DVR start without dropping existing query params', () => {
    expect(withLiveDvrStart('https://example.com/video.m3u8', false)).toBe(
      'https://example.com/video.m3u8',
    )
    expect(withLiveDvrStart('https://example.com/video.m3u8', true)).toBe(
      'https://example.com/video.m3u8?start=0',
    )
    expect(withLiveDvrStart('https://example.com/video.m3u8?token=abc', true)).toBe(
      'https://example.com/video.m3u8?token=abc&start=0',
    )
  })

  it('builds playback items from a bondfire and its playable responses', () => {
    const bondfireData = {
      _id: 'bondfire-1',
      _creationTime: 1700000000000,
      userId: 'user-1',
      creatorName: 'Ada',
      videoStatus: 'live',
      videos: [
        {
          _id: 'response-1',
          _creationTime: 1700000060000,
          userId: 'user-2',
          creatorName: 'Grace',
          videoStatus: 'ready',
        },
      ],
    } as unknown as BondfireDetailData

    expect(buildBondfireVideoItems(bondfireData, ['main-url', 'response-url'])).toEqual([
      {
        key: 'bondfire-1',
        bondfireId: 'bondfire-1',
        bondfireVideoId: undefined,
        url: 'main-url',
        videoOwnerId: 'user-1',
        creatorName: 'Ada',
        isMainVideo: true,
        responseIndex: undefined,
        isLive: true,
        createdAt: 1700000000000,
      },
      {
        key: 'response-1',
        bondfireId: undefined,
        bondfireVideoId: 'response-1',
        url: 'response-url',
        videoOwnerId: 'user-2',
        creatorName: 'Grace',
        isMainVideo: false,
        responseIndex: 1,
        isLive: false,
        createdAt: 1700000060000,
      },
    ])
  })
})

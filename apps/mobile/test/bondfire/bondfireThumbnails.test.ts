import { describe, expect, it } from 'vitest'
import type { Id } from '../../../../convex/_generated/dataModel'
import {
  getBondfireThumbnailPlayback,
  getCachedBondfireThumbnail,
  getPendingBondfireThumbnails,
} from '../../lib/bondfireThumbnails'

describe('R2 thumbnail references', () => {
  it('requests a spark by record ID without provider credentials or IDs', () => {
    const fire = { _id: 'bondfire-1', videoStatus: 'ready' }
    expect(getBondfireThumbnailPlayback(fire)).toEqual({ cacheKey: 'bondfire:bondfire-1' })
    expect(getPendingBondfireThumbnails([fire], {}, new Set())[0].request).toEqual({
      bondfireId: 'bondfire-1',
    })
    expect(getBondfireThumbnailPlayback({ ...fire, videoStatus: 'processing' })).toBeNull()
  })
  it('keeps both the response reference and the spark fallback', () => {
    const fire = {
      _id: 'bondfire-1',
      latestResponseBondfireVideoId: 'response-1' as Id<'bondfireVideos'>,
    }
    expect(getPendingBondfireThumbnails([fire], {}, new Set())[0]).toEqual({
      bondfireId: 'bondfire-1',
      cacheKey: 'bondfire-1:response:response-1',
      request: { bondfireId: 'bondfire-1', bondfireVideoId: 'response-1' },
    })
  })
  it('changes cache entries when a new response arrives', () => {
    const urls = { 'fire:response:old': 'old-thumbnail', 'fire:response:new': 'new-thumbnail' }
    for (const id of ['old', 'new'])
      expect(
        getCachedBondfireThumbnail(
          { _id: 'fire', latestResponseBondfireVideoId: id as Id<'bondfireVideos'> },
          urls,
        ),
      ).toBe(`${id}-thumbnail`)
  })
  it('skips cached, loading, unplayable and duplicate references', () => {
    const duplicate = { _id: 'one' }
    expect(
      getPendingBondfireThumbnails(
        [
          duplicate,
          duplicate,
          { _id: 'two' },
          { _id: 'three' },
          { _id: 'four', videoStatus: 'processing' },
        ],
        { 'bondfire:two': null },
        new Set(['bondfire:three']),
      ).map((item) => item.cacheKey),
    ).toEqual(['bondfire:one'])
  })
})

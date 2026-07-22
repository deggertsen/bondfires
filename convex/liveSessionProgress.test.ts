import { describe, expect, it } from 'vitest'
import { assessLiveSessionProgress } from './liveSessionProgress'

describe('assessLiveSessionProgress', () => {
  it('treats a never-started session as safe to cancel', () => {
    expect(
      assessLiveSessionProgress({
        status: 'created',
        startedAt: null,
      }),
    ).toEqual({ hadAsset: false, hadProgressed: false })
  })

  it('treats a live session as progressed even before any asset exists', () => {
    expect(assessLiveSessionProgress({ status: 'live', startedAt: null }).hadProgressed).toBe(true)
  })

  it('treats an ingest-confirmed session as progressed regardless of status', () => {
    // startedAt is stamped by the live_stream.active webhook; a crash right
    // after can leave status 'starting' with real footage already at Mux.
    expect(assessLiveSessionProgress({ status: 'starting', startedAt: 1_000 }).hadProgressed).toBe(
      true,
    )
  })

  it('treats any recorded/active/recent asset id as progressed', () => {
    expect(assessLiveSessionProgress({ status: 'created', muxRecordedAssetId: 'a' })).toEqual({
      hadAsset: true,
      hadProgressed: true,
    })
    expect(
      assessLiveSessionProgress({ status: 'created', muxActiveAssetId: 'b' }).hadProgressed,
    ).toBe(true)
    expect(
      assessLiveSessionProgress({ status: 'created', muxRecentAssetId: 'c' }).hadProgressed,
    ).toBe(true)
  })

  it('treats an ending session as progressed', () => {
    expect(assessLiveSessionProgress({ status: 'ending' }).hadProgressed).toBe(true)
  })
})

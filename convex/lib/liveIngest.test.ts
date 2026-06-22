import { describe, expect, it } from 'vitest'
import type { Doc } from '../_generated/dataModel'
import { classifyMuxIngest, localIngestSource } from './liveIngest'

// Minimal liveSessions doc — localIngestSource only reads the fields below, so
// we cast a partial rather than fabricate every column.
function session(overrides: Partial<Doc<'liveSessions'>>): Doc<'liveSessions'> {
  return {
    status: 'created',
    ...overrides,
  } as Doc<'liveSessions'>
}

describe('localIngestSource', () => {
  it('returns null when the row has no ingest evidence', () => {
    expect(localIngestSource(session({ status: 'created' }))).toBeNull()
    expect(localIngestSource(session({ status: 'starting' }))).toBeNull()
  })

  it('treats startedAt as the strongest evidence', () => {
    expect(localIngestSource(session({ startedAt: 123 }))).toBe('started_at')
  })

  it('recognizes each asset id field', () => {
    expect(localIngestSource(session({ muxRecordedAssetId: 'a' }))).toBe('recorded_asset')
    expect(localIngestSource(session({ muxActiveAssetId: 'a' }))).toBe('active_asset')
    expect(localIngestSource(session({ muxRecentAssetId: 'a' }))).toBe('recent_asset')
  })

  it('treats a live status as evidence', () => {
    expect(localIngestSource(session({ status: 'live' }))).toBe('status_live')
  })

  it('prefers startedAt over other evidence (deterministic source)', () => {
    expect(
      localIngestSource(session({ startedAt: 1, muxActiveAssetId: 'a', status: 'live' })),
    ).toBe('started_at')
  })

  it('does not treat ending/ended/errored statuses as live evidence on their own', () => {
    expect(localIngestSource(session({ status: 'ending' }))).toBeNull()
    expect(localIngestSource(session({ status: 'ended' }))).toBeNull()
    expect(localIngestSource(session({ status: 'errored' }))).toBeNull()
  })
})

describe('classifyMuxIngest', () => {
  it("returns 'unknown' when Mux is unreachable (never destroy a maybe-recording)", () => {
    expect(classifyMuxIngest({ reachable: false })).toEqual({
      status: 'unknown',
      source: 'mux_unreachable',
    })
  })

  it('confirms on an active asset id', () => {
    expect(
      classifyMuxIngest({ reachable: true, status: 'idle', activeAssetId: 'asset_1' }),
    ).toEqual({ status: 'confirmed', source: 'mux_active_asset' })
  })

  it('confirms on a recent asset id', () => {
    expect(
      classifyMuxIngest({ reachable: true, status: 'idle', recentAssetIds: ['asset_1'] }),
    ).toEqual({ status: 'confirmed', source: 'mux_recent_asset' })
  })

  it("confirms on an 'active' status", () => {
    expect(classifyMuxIngest({ reachable: true, status: 'active' })).toEqual({
      status: 'confirmed',
      source: 'mux_status_active',
    })
  })

  it("returns 'empty' when reachable but idle with no assets", () => {
    expect(classifyMuxIngest({ reachable: true, status: 'idle', recentAssetIds: [] })).toEqual({
      status: 'empty',
      source: 'mux_idle',
    })
  })

  it("returns 'unknown' when Mux omits a status", () => {
    expect(classifyMuxIngest({ reachable: true })).toEqual({
      status: 'unknown',
      source: 'mux_status_missing',
    })
  })

  it('prefers asset evidence over status when both could apply', () => {
    expect(
      classifyMuxIngest({ reachable: true, status: 'active', activeAssetId: 'asset_1' }),
    ).toEqual({ status: 'confirmed', source: 'mux_active_asset' })
  })
})

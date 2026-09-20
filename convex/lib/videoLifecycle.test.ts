import { describe, expect, it } from 'vitest'
import {
  canResumeUnrecordedDraft,
  getSegmentVideoStatus,
  getVideoLifecycle,
  isPlayableVideoRecord,
} from './videoLifecycle'

describe('recording lifecycle policy', () => {
  it.each([
    ['pending', 'awaiting_recording', false],
    ['waiting_for_upload', 'uploading', false],
    ['processing', 'uploading', false],
    ['live', 'live', true],
    ['ready', 'ready', true],
    ['awaiting_recovery', 'recovering', false],
    ['errored', 'failed', false],
  ] as const)('%s has state %s and feed eligibility %s', (videoStatus, phase, inFeed) => {
    const record = { videoStatus, segmentRecordingId: 'recording' }
    expect(getVideoLifecycle(record)).toBe(phase)
    expect(isPlayableVideoRecord(record)).toBe(inFeed)
  })
  it('requires a playback source and treats draft expiry independently of the cleanup cron', () => {
    expect(isPlayableVideoRecord({ videoStatus: 'live' })).toBe(false)
    expect(isPlayableVideoRecord({ videoStatus: 'ready', muxPlaybackId: 'vod' })).toBe(true)
    expect(isPlayableVideoRecord({ videoStatus: 'live', muxLivePlaybackId: 'live' })).toBe(true)
    const draft = { status: 'draft', videoStatus: 'pending', draftExpiresAt: 100 }
    expect(canResumeUnrecordedDraft(draft, 99)).toBe(true)
    expect(canResumeUnrecordedDraft(draft, 100)).toBe(false)
    expect(getVideoLifecycle(draft, 100)).toBe('expired')
    expect(canResumeUnrecordedDraft({ ...draft, segmentRecordingId: 'existing' }, 99)).toBe(false)
    expect(
      getVideoLifecycle(
        { ...draft, status: 'live', videoStatus: 'live', segmentRecordingId: 'existing' },
        101,
      ),
    ).toBe('live')
  })
  it('publishes a contiguous prefix or completed short clip, never an empty or revoked recording', () => {
    const record = { status: 'uploading', initChecksum: 'a', segmentCount: 1, duration: 4 }
    expect(getSegmentVideoStatus(record)).toBe('waiting_for_upload')
    expect(getSegmentVideoStatus({ ...record, duration: 8, segmentCount: 2 })).toBe('live')
    expect(getSegmentVideoStatus({ ...record, finalCount: 1 })).toBe('ready')
    expect(getSegmentVideoStatus({ ...record, finalCount: 2 })).toBe('waiting_for_upload')
    expect(getSegmentVideoStatus({ ...record, finalCount: 0, segmentCount: 0 })).toBe(
      'waiting_for_upload',
    )
    expect(getSegmentVideoStatus({ ...record, initChecksum: undefined, finalCount: 1 })).toBe(
      'waiting_for_upload',
    )
    expect(getSegmentVideoStatus({ ...record, status: 'cancelled', finalCount: 1 })).toBe('errored')
  })
})

it('enforces expiry when used as an Array.filter predicate', () => {
  const expired = {
    videoStatus: 'ready',
    segmentRecordingId: 'recording',
    expiresAt: Date.now() - 1,
  }
  expect([expired].filter(isPlayableVideoRecord)).toEqual([])
})

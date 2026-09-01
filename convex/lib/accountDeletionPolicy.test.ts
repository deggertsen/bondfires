import { describe, expect, it } from 'vitest'
import {
  ACCOUNT_DELETION_MAX_RETRY_DELAY_MS,
  ACCOUNT_DELETION_USER_STAGES,
  accountDeletionRetryDelay,
  collectMuxDeletionTargets,
  nextAccountDeletionStage,
} from './accountDeletionPolicy'

describe('account deletion policy', () => {
  it('walks every cleanup stage in order and finishes at finalize', () => {
    let stage: string | undefined
    const visited: string[] = []
    for (let index = 0; index < ACCOUNT_DELETION_USER_STAGES.length; index += 1) {
      stage = nextAccountDeletionStage(stage)
      visited.push(stage)
    }
    expect(visited).toEqual(ACCOUNT_DELETION_USER_STAGES)
    expect(nextAccountDeletionStage('finalize')).toBe('finalize')
  })

  it('uses bounded exponential retry delays', () => {
    expect(accountDeletionRetryDelay(0)).toBe(1_000)
    expect(accountDeletionRetryDelay(1)).toBe(2_000)
    expect(accountDeletionRetryDelay(20)).toBe(ACCOUNT_DELETION_MAX_RETRY_DELAY_MS)
    expect(accountDeletionRetryDelay(-1)).toBe(1_000)
  })

  it('collects every Mux asset and live-stream pointer', () => {
    expect(
      collectMuxDeletionTargets(
        {
          muxUploadId: 'upload',
          muxAssetId: 'primary',
          muxLiveStreamId: 'video-stream',
        },
        {
          muxLiveStreamId: 'session-stream',
          muxActiveAssetId: 'active',
          muxRecentAssetId: 'recent',
          muxRecordedAssetId: 'recorded',
        },
      ),
    ).toEqual({
      directUploads: ['upload'],
      assets: ['primary', 'active', 'recent', 'recorded'],
      liveStreams: ['video-stream', 'session-stream'],
    })
  })

  it('deduplicates pointers shared by video and session records', () => {
    expect(
      collectMuxDeletionTargets(
        { muxAssetId: 'same', muxLiveStreamId: 'same-stream' },
        {
          muxLiveStreamId: 'same-stream',
          muxActiveAssetId: 'same',
          muxRecordedAssetId: 'same',
        },
      ),
    ).toEqual({ directUploads: [], assets: ['same'], liveStreams: ['same-stream'] })
  })

  it('returns empty targets for database-only drafts', () => {
    expect(collectMuxDeletionTargets({}, null)).toEqual({
      directUploads: [],
      assets: [],
      liveStreams: [],
    })
  })
})

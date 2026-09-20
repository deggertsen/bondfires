import { createElement } from 'react'
// @ts-expect-error react-test-renderer does not ship TypeScript declarations.
import { act, create } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('react-native', () => ({
  Platform: { OS: 'android' },
  AppState: { currentState: 'active' },
}))
vi.mock('expo-file-system/legacy', () => ({ getFreeDiskStorageAsync: vi.fn() }))
vi.mock('../../../../packages/app/src/services/localBackupSweep', () => ({
  deleteLocalBackupsForSession: vi.fn(),
  getLocalBackupSessionStats: vi.fn(),
}))
vi.mock('../../../../packages/app/src/utils/networkTransport', () => ({
  assessNetworkTransport: vi.fn().mockResolvedValue({ type: 'WIFI', isConnected: true }),
}))
vi.mock('../../../../packages/app/src/utils/liveAbrPrior', () => ({
  readLiveAbrPrior: () => null,
  writeLiveAbrPrior: vi.fn(),
}))
vi.mock('../../../../packages/app/src/store/uploadQueue.store', () => ({
  uploadQueueStore$: { tasks: { peek: () => [] } },
}))
vi.mock('../../../../packages/app/src/services/telemetry', () => ({
  telemetry: {
    breadcrumb: vi.fn(),
    setCrashBreadcrumb: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

import {
  type LivePublisherNativeModule,
  useLivePublisher,
} from '../../../../packages/app/src/hooks/useLivePublisher'
import { telemetry } from '../../../../packages/app/src/services/telemetry'
import { livePublishActions } from '../../../../packages/app/src/store/livePublish.store'
import { recordingActions } from '../../../../packages/app/src/store/recording.store'

describe('live audio experiment telemetry', () => {
  let renderer: ReturnType<typeof create> | undefined
  let publisherHook: ReturnType<typeof useLivePublisher>

  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubEnv('EXPO_PUBLIC_LOCAL_BACKUP_RECORDING', '0')
    vi.clearAllMocks()
    livePublishActions.reset()
    recordingActions.reset()
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  })
  afterEach(async () => {
    await act(async () => renderer?.unmount())
    renderer = undefined
    vi.useRealTimers()
    vi.unstubAllEnvs()
  })

  it.each(['camcorder', 'voice_communication', undefined])(
    'carries the resolved native source (%s), including older builds without it',
    async (audioSource) => {
      const publisher: LivePublisherNativeModule = {
        startPreview: vi.fn(),
        start: vi.fn().mockResolvedValue({ localBackupArmed: false }),
        stop: vi.fn(),
        swapCamera: vi.fn(),
        setMuted: vi.fn(),
        setVideoQuality: vi.fn(),
        addListener: vi.fn().mockReturnValue({ remove: vi.fn() }),
        getStats: vi.fn().mockResolvedValue({
          bitrateBps: 1_500_000,
          rttMs: 0,
          droppedFrames: 0,
          statsSupported: 1,
          audioRoute: 'builtin',
          ...(audioSource ? { audioSource } : {}),
        }),
      }
      const options = {
        publisher,
        createLiveStream: vi.fn().mockResolvedValue({
          liveSessionId: 'session',
          liveStreamId: 'stream',
          recordId: 'record',
          recordType: 'bondfire',
          ingest: { rtmpsUrl: 'rtmps://example.test/live', streamKey: 'test' },
        }),
        endLiveStream: vi.fn(),
        cancelLiveStream: vi.fn(),
        confirmLiveSessionLocalBackup: vi.fn(),
      }
      function Harness() {
        publisherHook = useLivePublisher(options)
        return null
      }
      await act(async () => {
        renderer = create(createElement(Harness))
      })
      await act(async () => {
        await publisherHook.provision({ personalCamp: true })
        await publisherHook.connect()
        livePublishActions.setStatus('live')
      })
      await act(async () => vi.advanceTimersByTimeAsync(5_000))

      expect(telemetry.breadcrumb).toHaveBeenCalledWith(
        'live:stats_sample',
        expect.objectContaining({
          sessionId: 'session',
          audioRoute: 'builtin',
          audioSource,
        }),
      )
      expect(telemetry.warn).not.toHaveBeenCalledWith(
        'live:stats',
        expect.anything(),
        expect.anything(),
      )
    },
  )
})

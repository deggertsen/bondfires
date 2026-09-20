import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Id } from './_generated/dataModel'
import type { ActionCtx } from './_generated/server'

vi.mock('./auth', () => ({ auth: { getUserId: vi.fn().mockResolvedValue('owner') } }))

import { createLiveBackupDirectUpload, createMuxDirectUpload } from './videos'

function handler<Args>(fn: unknown) {
  return (fn as { _handler: (ctx: ActionCtx, args: Args) => Promise<unknown> })._handler
}

const createUpload = handler<{
  filename: string
  contentType: string
  isResponse: boolean
  personalCamp: boolean
}>(createMuxDirectUpload)
const createBackup = handler<{
  filename: string
  contentType: string
  liveSessionId: Id<'liveSessions'>
}>(createLiveBackupDirectUpload)

describe.each(['direct', 'live backup'] as const)('%s upload audio normalization', (path) => {
  beforeEach(() => {
    vi.stubEnv('MUX_TOKEN_ID', 'test')
    vi.stubEnv('MUX_TOKEN_SECRET', 'test')
    vi.stubEnv('MUX_VIDEO_QUALITY', 'basic')
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  it.each([
    [undefined, true],
    ['true', true],
    ['1', true],
    ['false', false],
    ['0', false],
    [' FALSE ', false],
    ['', true],
    ['invalid', true],
  ])(
    'sends normalize_audio=%s → %s without changing access or captions',
    async (flag, expected) => {
      vi.stubEnv('MUX_NORMALIZE_AUDIO', flag)
      const fetch = vi
        .fn()
        .mockResolvedValue(
          new Response(
            JSON.stringify({ data: { id: 'upload-test', url: 'https://upload.example' } }),
          ),
        )
      vi.stubGlobal('fetch', fetch)
      const ctx = {
        runQuery: vi.fn(),
        runMutation: vi.fn().mockResolvedValue({
          recordId: 'record',
          recordType: 'bondfire',
          playbackPolicy: 'signed',
        }),
      } as unknown as ActionCtx
      const file = { filename: 'recording.mp4', contentType: 'video/mp4' }

      if (path === 'direct') {
        await createUpload(ctx, { ...file, isResponse: false, personalCamp: true })
      } else {
        await createBackup(ctx, { ...file, liveSessionId: 'session' as Id<'liveSessions'> })
      }

      expect(fetch).toHaveBeenCalledOnce()
      const [url, request] = fetch.mock.calls[0]
      expect(url).toBe('https://api.mux.com/video/v1/uploads')
      expect(request.method).toBe('POST')
      const settings = JSON.parse(request.body).new_asset_settings
      expect(settings).toMatchObject({
        normalize_audio: expected,
        playback_policies: ['signed'],
        video_quality: 'basic',
      })
      expect(settings.inputs[0].generated_subtitles).toHaveLength(1)
      expect(JSON.parse(settings.passthrough).userId).toBe('owner')
    },
  )
})

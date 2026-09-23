import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ActionCtx } from './_generated/server'

vi.mock('./auth', () => ({ auth: { getUserId: vi.fn().mockResolvedValue('owner') } }))

import { auth } from './auth'
import { createLiveStream, createMuxDirectUpload } from './videos'

function handler(fn: unknown) {
  return (fn as { _handler: (ctx: ActionCtx, args: unknown) => Promise<unknown> })._handler
}

describe.each([
  [
    'direct upload',
    createMuxDirectUpload,
    { filename: 'video.mp4', contentType: 'video/mp4', isResponse: false },
  ],
  ['live stream', createLiveStream, { isResponse: false }],
])('retired Mux %s', (_name, fn, args) => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.mocked(auth.getUserId).mockResolvedValue('owner' as never)
  })

  it('asks installed clients to upgrade before any API call or database write', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const ctx = { runQuery: vi.fn(), runMutation: vi.fn() } as unknown as ActionCtx
    await expect(handler(fn)(ctx, args)).rejects.toThrow('Please update Bondfires')
    expect(fetch).not.toHaveBeenCalled()
    expect(ctx.runQuery).not.toHaveBeenCalled()
    expect(ctx.runMutation).not.toHaveBeenCalled()
  })

  it('retains the authentication boundary', async () => {
    vi.mocked(auth.getUserId).mockResolvedValue(null)
    await expect(handler(fn)({} as ActionCtx, args)).rejects.toThrow('Not authenticated')
  })
})

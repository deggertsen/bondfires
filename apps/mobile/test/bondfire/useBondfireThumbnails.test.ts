import { observable } from '@legendapp/state'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useBondfireThumbnails } from '../../lib/useBondfireThumbnails'

const request = vi.hoisted(() => vi.fn())
vi.mock('convex/react', () => ({ useAction: () => request }))
vi.mock('@legendapp/state/react', () => ({
  useObservable: (value: Record<string, unknown>) => observable(value),
}))
vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  useRef: (current: unknown) => ({ current }),
  useCallback: (callback: unknown) => callback,
}))

describe('thumbnail batch lifecycle', () => {
  beforeEach(() => request.mockReset())
  const fire = { _id: 'fire', muxPlaybackId: 'vod' }

  it('retries after transient failure instead of permanently caching the fallback', async () => {
    request
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce([{ thumbnailUrl: 'recovered' }])
    const onBatchError = vi.fn()
    const hook = useBondfireThumbnails({ enabled: true, onBatchError })
    await hook.ensureThumbnailUrls([fire])
    expect(hook.thumbnailUrls$.peek()).toEqual({})
    expect(onBatchError).toHaveBeenCalledOnce()
    await hook.ensureThumbnailUrls([fire])
    expect(hook.thumbnailUrls$.peek()).toEqual({ 'fire:vod': 'recovered' })
    expect(request).toHaveBeenCalledTimes(2)
  })

  it('deduplicates in-flight work and preserves a successful null result', async () => {
    let finish: (result: unknown) => void = () => {}
    request.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    const hook = useBondfireThumbnails({ enabled: true })
    const first = hook.ensureThumbnailUrls([fire])
    await hook.ensureThumbnailUrls([fire])
    expect(request).toHaveBeenCalledOnce()
    finish([{ thumbnailUrl: null }])
    await first
    await hook.ensureThumbnailUrls([fire])
    expect(request).toHaveBeenCalledOnce()
    expect(hook.thumbnailUrls$.peek()).toEqual({ 'fire:vod': null })
  })

  it('does not let an old generation repopulate the cache or unlock newer requests', async () => {
    let oldDone: (result: unknown) => void = () => {},
      newDone: (result: unknown) => void = () => {}
    request
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            oldDone = resolve
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            newDone = resolve
          }),
      )
    const hook = useBondfireThumbnails({ enabled: true })
    const old = hook.ensureThumbnailUrls([fire])
    hook.resetThumbnailUrls()
    const fresh = hook.ensureThumbnailUrls([fire])
    oldDone([{ thumbnailUrl: 'stale' }])
    await old
    expect(hook.thumbnailUrls$.peek()).toEqual({})
    await hook.ensureThumbnailUrls([fire])
    expect(request).toHaveBeenCalledTimes(2)
    newDone([{ thumbnailUrl: 'fresh' }])
    await fresh
    expect(hook.thumbnailUrls$.peek()).toEqual({ 'fire:vod': 'fresh' })
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { telemetry } from '../../../packages/app/src/services/telemetry'
import {
  retryPendingUploads,
  uploadStatus$,
  uploadStatusActions,
  uploadStatusStore$,
} from '../../../packages/app/src/store/uploadStatus.store'
import { describeUploadStatus } from '../../../packages/app/src/utils/uploadStatus'

vi.mock('../../../packages/app/src/services/telemetry', () => ({
  telemetry: { breadcrumb: vi.fn(), warn: vi.fn() },
}))

const paused = {
  localId: 'capture',
  isResponse: false,
  paused: true,
  failure: 'unavailable' as const,
}
const unregister: Array<() => void> = []
function register(handler: Parameters<typeof uploadStatusActions.registerRetryHandler>[1]) {
  unregister.push(uploadStatusActions.registerRetryHandler('segment', handler))
}
function deferred() {
  let resolve!: (outcome: 'started' | 'busy' | 'skipped') => void
  const promise = new Promise<'started' | 'busy' | 'skipped'>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
function copy() {
  const status = uploadStatus$.get()
  if (status.kind === 'idle') throw new Error('expected a visible upload status')
  return describeUploadStatus(status)
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  uploadStatusActions.setSegmentJobs([paused])
})
afterEach(() => {
  for (const cleanup of unregister.splice(0)) cleanup()
  uploadStatusActions.setSegmentJobs([])
  vi.useRealTimers()
})

describe('upload retry feedback', () => {
  it('acknowledges immediately and keeps a fast failure readable before showing its cause', async () => {
    register(() => 'started')
    const retry = retryPendingUploads()
    expect(copy().title).toBe('Retrying now…')
    await retry
    await vi.advanceTimersByTimeAsync(1199)
    expect(copy().actionLabel).toBe('Retrying…')
    await vi.advanceTimersByTimeAsync(1)
    expect(copy()).toEqual({
      title: 'Retrying upload',
      message: 'Server unavailable, still saved on this phone.',
      actionLabel: 'Retry now',
    })
  })

  it('keeps following a slow pass after repeated taps, without starting another pass', async () => {
    const pass = deferred()
    const handler = vi.fn(() => pass.promise)
    register(handler)
    const first = retryPendingUploads()
    await vi.advanceTimersByTimeAsync(5000)
    expect(copy().title).toBe('Retrying now…')
    expect(await retryPendingUploads()).toBe('busy')
    expect(copy().title).toBe('Retry already in progress')
    await vi.advanceTimersByTimeAsync(5000)
    expect(copy().title).toBe('Retry already in progress')
    expect(handler).toHaveBeenCalledOnce()
    pass.resolve('started')
    await first
    await vi.advanceTimersByTimeAsync(0)
    expect(copy().actionLabel).toBe('Retry now')
  })

  it('keeps a second tap readable even if the original pass finishes immediately afterwards', async () => {
    const pass = deferred()
    register(() => pass.promise)
    const first = retryPendingUploads()
    await vi.advanceTimersByTimeAsync(1000)
    await retryPendingUploads()
    pass.resolve('started')
    await first
    await vi.advanceTimersByTimeAsync(3199)
    expect(copy().title).toBe('Retry already in progress')
    await vi.advanceTimersByTimeAsync(1)
    expect(copy().actionLabel).toBe('Retry now')
  })

  it('acknowledges an automatic pass already holding the queue lock', async () => {
    register(() => 'busy')
    expect(await retryPendingUploads()).toBe('busy')
    expect(copy().title).toBe('Retry already in progress')
    await vi.advanceTimersByTimeAsync(3200)
    expect(copy().actionLabel).toBe('Retry now')
  })

  it.each(['missing', 'skipped', 'throws'] as const)(
    'does not claim a retry started when the handler is %s',
    async (kind) => {
      if (kind === 'skipped') register(() => 'skipped')
      if (kind === 'throws') {
        register(() => {
          throw new Error('https://media.test?token=secret')
        })
      }
      expect(await retryPendingUploads()).toBe('skipped')
      expect(copy().title).toBe("Couldn't start retry")
      expect(copy().actionLabel).toBe('Retry now')
      expect(JSON.stringify(vi.mocked(telemetry.warn).mock.calls)).not.toContain('secret')
      await vi.advanceTimersByTimeAsync(3200)
      expect(copy().title).toBe('Retrying upload')
    },
  )

  it('cancels the old notice timer when another retry starts', async () => {
    const pass = deferred()
    register(vi.fn().mockReturnValueOnce('started').mockReturnValueOnce(pass.promise))
    await retryPendingUploads()
    await vi.advanceTimersByTimeAsync(1000)
    const next = retryPendingUploads()
    await vi.advanceTimersByTimeAsync(5000)
    expect(copy().title).toBe('Retrying now…')
    pass.resolve('started')
    await next
    await vi.advanceTimersByTimeAsync(0)
    expect(uploadStatusStore$.retryNotice.get()).toBeNull()
  })

  it('ignores a late result after the queue is cleared and another account retries', async () => {
    const oldPass = deferred()
    const newPass = deferred()
    register(vi.fn().mockReturnValueOnce(oldPass.promise).mockReturnValueOnce(newPass.promise))
    const first = retryPendingUploads()
    uploadStatusActions.setSegmentJobs([])
    expect(uploadStatusStore$.retryNotice.get()).toBeNull()
    uploadStatusActions.setSegmentJobs([{ ...paused, localId: 'other-account' }])
    const second = retryPendingUploads()
    oldPass.resolve('busy')
    await first
    await vi.advanceTimersByTimeAsync(5000)
    expect(copy().title).toBe('Retrying now…')
    newPass.resolve('started')
    await second
    await vi.advanceTimersByTimeAsync(0)
    expect(uploadStatusStore$.retryNotice.get()).toBeNull()
  })

  it('clears the timer when the last job completes', async () => {
    register(() => 'started')
    await retryPendingUploads()
    uploadStatusActions.setSegmentJobs([])
    expect(uploadStatusStore$.retryNotice.get()).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  type UploadCompletionStatus,
  waitForUploadCompletion,
} from '../../../packages/app/src/utils/waitForUploadCompletion'

const ready = { uploadStatus: 'ready', isReady: true, isFailed: false }
const pending = { uploadStatus: 'processing', isReady: false, isFailed: false }

describe('upload completion subscription', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())
  it('settles cached completion without starting another recovery job', async () => {
    const unsubscribe = vi.fn()
    const startRecovery = vi.fn()
    await expect(
      waitForUploadCompletion({
        subscribe: (onStatus) => {
          onStatus(ready)
          return unsubscribe
        },
        startRecovery,
      }),
    ).resolves.toEqual(ready)
    expect(startRecovery).not.toHaveBeenCalled()
    expect(unsubscribe).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })
  it('handles duplicate updates and cleans up once when the webhook completes', async () => {
    let update!: (status: UploadCompletionStatus) => void
    const unsubscribe = vi.fn()
    const startRecovery = vi.fn().mockResolvedValue(undefined)
    const result = waitForUploadCompletion({
      subscribe: (onStatus) => {
        update = onStatus
        return unsubscribe
      },
      startRecovery,
    })
    update(pending)
    update(pending)
    expect(startRecovery).toHaveBeenCalledOnce()
    update(ready)
    update(pending)
    await expect(result).resolves.toEqual(ready)
    expect(unsubscribe).toHaveBeenCalledOnce()
  })
  it('times out without polling and releases the subscription for a later resume', async () => {
    const unsubscribe = vi.fn()
    const startRecovery = vi.fn().mockResolvedValue(undefined)
    const result = waitForUploadCompletion({ subscribe: () => unsubscribe, startRecovery })
    const assertion = expect(result).rejects.toThrow('still processing')
    await vi.advanceTimersByTimeAsync(15 * 60_000)
    await assertion
    expect(unsubscribe).toHaveBeenCalledOnce()
    expect(startRecovery).toHaveBeenCalledOnce()
  })
  it('propagates recovery setup failures and removes the listener', async () => {
    const unsubscribe = vi.fn()
    await expect(
      waitForUploadCompletion({
        subscribe: () => unsubscribe,
        startRecovery: async () => {
          throw new Error('offline')
        },
      }),
    ).rejects.toThrow('offline')
    expect(unsubscribe).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })
  it('reports terminal processing failures without resolving successfully', async () => {
    const unsubscribe = vi.fn()
    await expect(
      waitForUploadCompletion({
        subscribe: (onStatus) => {
          onStatus({ ...pending, isFailed: true })
          return unsubscribe
        },
        startRecovery: vi.fn(),
      }),
    ).rejects.toThrow('failed to process')
    expect(unsubscribe).toHaveBeenCalledOnce()
  })
})

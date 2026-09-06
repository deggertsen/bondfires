import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('expo-constants', () => ({ default: { expoConfig: { version: 'test' } } }))
vi.mock('expo-device', () => ({
  modelName: null,
  osVersion: null,
  osName: null,
  manufacturer: null,
  brand: null,
}))
vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  AppState: { addEventListener: vi.fn() },
}))
vi.mock('react-native-mmkv', () => ({
  createMMKV: () => ({ getString: vi.fn(), set: vi.fn(), remove: vi.fn() }),
}))

import { TelemetryLogger } from '../../../packages/app/src/services/telemetry'

describe('telemetry batching', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })
  function setup(send = vi.fn().mockResolvedValue(undefined)) {
    const logger = new TelemetryLogger()
    // Global error/console interception is unrelated to scheduling under test.
    for (const method of [
      'installGlobalErrorHandler',
      'installRejectionTracker',
      'installMemoryWarningListener',
      'installConsoleOverrides',
    ] as const) {
      vi.spyOn(logger as unknown as Record<string, () => void>, method).mockImplementation(
        () => undefined,
      )
    }
    logger.init({ create: vi.fn(), createBatch: send })
    return { logger, send }
  }
  it('does no periodic work when empty and batches routine logs after 60 seconds', async () => {
    const { logger, send } = setup()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(send).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    logger.breadcrumb('first')
    await vi.advanceTimersByTimeAsync(30_000)
    logger.breadcrumb('second')
    await vi.advanceTimersByTimeAsync(29_999)
    expect(send).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(send).toHaveBeenCalledOnce()
    expect(send.mock.calls[0][0].entries).toHaveLength(2)
    expect(vi.getTimerCount()).toBe(0)
  })
  it('flushes a nearly full queue before dropping entries', async () => {
    const { logger, send } = setup()
    await Promise.resolve()
    for (let i = 0; i < 80; i++) logger.breadcrumb(`event-${i}`)
    await vi.advanceTimersByTimeAsync(1)
    expect(send.mock.calls.flatMap(([args]) => args.entries)).toHaveLength(80)
  })
  it('retains failed batches for the next scheduled attempt', async () => {
    const send = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined)
    const { logger } = setup(send)
    await Promise.resolve()
    logger.breadcrumb('retain-me')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(send).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(send).toHaveBeenCalledTimes(2)
    expect(send.mock.calls[1][0].entries[0].event).toBe('retain-me')
  })
})

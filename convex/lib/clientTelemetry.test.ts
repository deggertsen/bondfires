import { describe, expect, it } from 'vitest'
import {
  CLIENT_LOG_LIMITS,
  reserveClientLogRateLimit,
  validateClientLogBatch,
  validateClientLogEntry,
} from './clientTelemetry'

const now = 1_800_000_000_000

function entry(overrides: Record<string, unknown> = {}) {
  return {
    event: 'recording:started',
    message: 'Recording started',
    platform: 'ios' as const,
    createdAt: now,
    ...overrides,
  }
}

describe('client telemetry validation', () => {
  it('accepts a bounded JSON-compatible entry', () => {
    expect(() =>
      validateClientLogEntry(
        entry({
          data: { durationMs: 42, route: ['feed', 'recording'] },
          appVersion: '1.2.3',
          sessionId: 'c5356f4d-b7af-4c9b-b8f8-2a76c013449c',
          device: { modelName: 'iPhone', osVersion: '26.0' },
        }),
        now,
      ),
    ).not.toThrow()
  })

  it('enforces UTF-8 byte limits rather than UTF-16 character counts', () => {
    expect(() =>
      validateClientLogEntry(entry({ event: '🔥'.repeat(CLIENT_LOG_LIMITS.eventBytes / 4) }), now),
    ).not.toThrow()
    expect(() =>
      validateClientLogEntry(
        entry({ event: '🔥'.repeat(CLIENT_LOG_LIMITS.eventBytes / 4 + 1) }),
        now,
      ),
    ).toThrow('event exceeds')
    expect(() => validateClientLogEntry(entry({ event: '' }), now)).toThrow('event cannot be empty')
  })

  it.each([
    ['message', { message: 'm'.repeat(CLIENT_LOG_LIMITS.messageBytes + 1) }],
    ['appVersion', { appVersion: 'v'.repeat(CLIENT_LOG_LIMITS.appVersionBytes + 1) }],
    ['sessionId', { sessionId: 's'.repeat(CLIENT_LOG_LIMITS.sessionIdBytes + 1) }],
    [
      'device.modelName',
      { device: { modelName: 'd'.repeat(CLIENT_LOG_LIMITS.deviceFieldBytes + 1) } },
    ],
  ])('rejects an oversized %s', (_name, overrides) => {
    expect(() => validateClientLogEntry(entry(overrides), now)).toThrow('exceeds')
  })

  it('rejects oversized, excessively deep, complex, and non-JSON data', () => {
    expect(() =>
      validateClientLogEntry(entry({ data: 'x'.repeat(CLIENT_LOG_LIMITS.dataBytes + 1) }), now),
    ).toThrow('data exceeds')

    let deep: Record<string, unknown> = {}
    for (let i = 0; i <= CLIENT_LOG_LIMITS.dataDepth; i++) deep = { child: deep }
    expect(() => validateClientLogEntry(entry({ data: deep }), now)).toThrow('maximum depth')

    expect(() =>
      validateClientLogEntry(
        entry({ data: Array.from({ length: CLIENT_LOG_LIMITS.dataNodes }, () => null) }),
        now,
      ),
    ).toThrow('value limit')

    expect(() => validateClientLogEntry(entry({ data: { invalid: Number.NaN } }), now)).toThrow(
      'finite JSON-compatible',
    )
    expect(() => validateClientLogEntry(entry({ data: new Uint8Array([1, 2]) }), now)).toThrow(
      'JSON-compatible',
    )
  })

  it('accepts clock skew inside the window and rejects stale or future timestamps', () => {
    expect(() =>
      validateClientLogEntry(entry({ createdAt: now - CLIENT_LOG_LIMITS.timestampPastMs }), now),
    ).not.toThrow()
    expect(() =>
      validateClientLogEntry(entry({ createdAt: now + CLIENT_LOG_LIMITS.timestampFutureMs }), now),
    ).not.toThrow()
    expect(() =>
      validateClientLogEntry(
        entry({ createdAt: now - CLIENT_LOG_LIMITS.timestampPastMs - 1 }),
        now,
      ),
    ).toThrow('too old')
    expect(() =>
      validateClientLogEntry(
        entry({ createdAt: now + CLIENT_LOG_LIMITS.timestampFutureMs + 1 }),
        now,
      ),
    ).toThrow('future')
    expect(() => validateClientLogEntry(entry({ createdAt: now + 0.5 }), now)).toThrow(
      'safe integer timestamp',
    )
  })

  it('requires a non-empty batch and enforces the batch cap atomically', () => {
    expect(() => validateClientLogBatch([], now)).toThrow('cannot be empty')
    expect(() =>
      validateClientLogBatch(
        Array.from({ length: CLIENT_LOG_LIMITS.batchEntries }, () => entry()),
        now,
      ),
    ).not.toThrow()
    expect(() =>
      validateClientLogBatch(
        Array.from({ length: CLIENT_LOG_LIMITS.batchEntries + 1 }, () => entry()),
        now,
      ),
    ).toThrow('Cannot batch more')
    expect(() => validateClientLogBatch([entry(), entry({ event: '' })], now)).toThrow(
      'event cannot be empty',
    )
  })
})

describe('client telemetry rate limiting', () => {
  it('reserves entries within both fixed windows', () => {
    const first = reserveClientLogRateLimit(null, now, 20)
    expect(first).toEqual({
      minuteWindowStartedAt: now,
      minuteCount: 20,
      hourWindowStartedAt: now,
      hourCount: 20,
    })

    expect(reserveClientLogRateLimit(first, now + 10_000, 20)).toMatchObject({
      minuteWindowStartedAt: now,
      minuteCount: 40,
      hourWindowStartedAt: now,
      hourCount: 40,
    })
  })

  it('rejects minute and hourly capacity overruns', () => {
    expect(() =>
      reserveClientLogRateLimit(
        {
          minuteWindowStartedAt: now,
          minuteCount: CLIENT_LOG_LIMITS.entriesPerMinute,
          hourWindowStartedAt: now,
          hourCount: CLIENT_LOG_LIMITS.entriesPerMinute,
        },
        now + 1,
        1,
      ),
    ).toThrow('rate limit exceeded')

    expect(() =>
      reserveClientLogRateLimit(
        {
          minuteWindowStartedAt: now - 60_000,
          minuteCount: CLIENT_LOG_LIMITS.entriesPerMinute,
          hourWindowStartedAt: now,
          hourCount: CLIENT_LOG_LIMITS.entriesPerHour,
        },
        now,
        1,
      ),
    ).toThrow('hourly rate limit exceeded')
  })

  it('resets windows at their boundary and after server clock rollback', () => {
    const existing = {
      minuteWindowStartedAt: now,
      minuteCount: CLIENT_LOG_LIMITS.entriesPerMinute,
      hourWindowStartedAt: now,
      hourCount: 500,
    }
    expect(reserveClientLogRateLimit(existing, now + 60_000, 1)).toMatchObject({
      minuteWindowStartedAt: now + 60_000,
      minuteCount: 1,
      hourWindowStartedAt: now,
      hourCount: 501,
    })
    expect(reserveClientLogRateLimit(existing, now - 1, 1)).toEqual({
      minuteWindowStartedAt: now - 1,
      minuteCount: 1,
      hourWindowStartedAt: now - 1,
      hourCount: 1,
    })
  })

  it('rejects invalid reservations', () => {
    expect(() => reserveClientLogRateLimit(null, now, 0)).toThrow('positive integer')
    expect(() => reserveClientLogRateLimit(null, now, 1.5)).toThrow('positive integer')
  })
})

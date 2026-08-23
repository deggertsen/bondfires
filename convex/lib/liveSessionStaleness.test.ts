import { describe, expect, it } from 'vitest'
import { shouldReapLiveSession } from './liveSessionStaleness'

const MINUTE = 60_000
const NOW = 20 * 60 * MINUTE

function stale(status: 'created' | 'starting' | 'live' | 'ending', overrides = {}) {
  return shouldReapLiveSession({
    status,
    createdAt: NOW - 10 * MINUTE,
    updatedAt: NOW - 6 * MINUTE,
    now: NOW,
    staleAfterMs: 5 * MINUTE,
    pendingMaxAgeMs: 5 * MINUTE,
    ...overrides,
  })
}

describe('live session staleness', () => {
  it('does not reap a live recording just because client heartbeats paused', () => {
    expect(stale('live')).toBe(false)
  })

  it('protects native capture before Mux activates when a local backup is confirmed', () => {
    expect(stale('created', { localBackupAvailable: true })).toBe(false)
    expect(stale('starting', { localBackupAvailable: true })).toBe(false)
  })

  it('still reaps abandoned previews and ending sessions promptly', () => {
    expect(stale('created')).toBe(true)
    expect(stale('ending')).toBe(true)
  })

  it('retains an absolute backstop beyond Mux maximum continuous duration', () => {
    expect(
      stale('live', {
        createdAt: NOW - (12 * 60 + 16) * MINUTE,
      }),
    ).toBe(true)
  })
})

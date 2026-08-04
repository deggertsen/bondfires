import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const memory = new Map<string, string>()

vi.mock('../../../../packages/app/src/utils/storage', () => ({
  mmkvStorage: {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => {
      memory.set(key, value)
    },
    removeItem: (key: string) => {
      memory.delete(key)
    },
    clear: () => {
      memory.clear()
    },
  },
}))

import {
  clearLiveAbrPrior,
  LIVE_ABR_PRIOR_TTL_MS,
  readLiveAbrPrior,
  writeLiveAbrPrior,
} from '../../../../packages/app/src/utils/liveAbrPrior'
import {
  LIVE_AUDIO_BITRATE_BPS,
  LIVE_VIDEO_BITRATE_LADDER,
  tierForMeasuredUplinkBps,
} from '../../../../packages/app/src/utils/liveBitratePolicy'
import {
  beginLiveUplinkProbe,
  cancelLiveUplinkProbe,
  convexHttpSiteUrl,
  LIVE_UPLINK_PROBE_TIMEOUT_TIER,
  liveUplinkProbeUrl,
  resetLiveUplinkProbeForTests,
  resolveLiveStartBitrate,
  setLiveUplinkProbeResultForTests,
} from '../../../../packages/app/src/utils/liveUplinkProbe'

describe('tierForMeasuredUplinkBps', () => {
  it('maps strong uplinks to the ceiling and weak ones to the floor', () => {
    expect(tierForMeasuredUplinkBps(5_000_000)).toBe(0)
    expect(tierForMeasuredUplinkBps(0)).toBe(3)
    expect(tierForMeasuredUplinkBps(-1)).toBe(3)
  })

  it('applies congestion headroom before selecting a rung', () => {
    // Barely enough raw bits for tier 1 without headroom must not open there.
    const bareTier1 = LIVE_VIDEO_BITRATE_LADDER[1] + LIVE_AUDIO_BITRATE_BPS
    expect(tierForMeasuredUplinkBps(bareTier1)).toBeGreaterThan(1)

    // With headroom (usable = uplink * 0.7), need uplink >= target / 0.7.
    const withHeadroom = Math.ceil(bareTier1 / 0.7)
    expect(tierForMeasuredUplinkBps(withHeadroom)).toBe(1)
  })
})

describe('liveAbrPrior', () => {
  beforeEach(() => {
    memory.clear()
  })

  it('round-trips a remembered tier', () => {
    writeLiveAbrPrior({ tier: 2, transportType: 'WIFI', now: 1_000 })
    expect(readLiveAbrPrior({ now: 1_000, transportType: 'WIFI' })).toMatchObject({
      tier: 2,
      bitrateBps: LIVE_VIDEO_BITRATE_LADDER[2],
      transportType: 'WIFI',
    })
  })

  it('expires after the soft TTL', () => {
    writeLiveAbrPrior({ tier: 1, now: 1_000 })
    expect(readLiveAbrPrior({ now: 1_000 + LIVE_ABR_PRIOR_TTL_MS + 1 })).toBeNull()
  })

  it('invalidates when the transport type changes', () => {
    writeLiveAbrPrior({ tier: 1, transportType: 'WIFI', now: 1_000 })
    expect(readLiveAbrPrior({ now: 1_000, transportType: 'CELLULAR' })).toBeNull()
    expect(readLiveAbrPrior({ now: 1_000, transportType: 'WIFI' })?.tier).toBe(1)
  })

  it('can be cleared', () => {
    writeLiveAbrPrior({ tier: 3, now: 1_000 })
    clearLiveAbrPrior()
    expect(readLiveAbrPrior({ now: 1_000 })).toBeNull()
  })
})

describe('resolveLiveStartBitrate', () => {
  beforeEach(() => {
    memory.clear()
    resetLiveUplinkProbeForTests()
  })

  afterEach(() => {
    resetLiveUplinkProbeForTests()
  })

  it('prefers a completed probe over the remembered prior', () => {
    writeLiveAbrPrior({ tier: 3, now: 1_000 })
    setLiveUplinkProbeResultForTests({
      status: 'completed',
      uplinkBps: 4_000_000,
      tier: 0,
      elapsedMs: 400,
      bytes: 256_000,
    })
    expect(resolveLiveStartBitrate({ now: 1_000, transportType: 'WIFI' })).toMatchObject({
      source: 'probe',
      tier: 0,
      bitrateBps: LIVE_VIDEO_BITRATE_LADDER[0],
    })
  })

  it('uses the timeout tier when the probe could not finish', () => {
    setLiveUplinkProbeResultForTests({
      status: 'timed_out',
      tier: LIVE_UPLINK_PROBE_TIMEOUT_TIER,
      elapsedMs: 2_000,
      bytes: 256_000,
    })
    expect(resolveLiveStartBitrate({ now: 1_000 })).toMatchObject({
      source: 'probe_timeout',
      tier: LIVE_UPLINK_PROBE_TIMEOUT_TIER,
    })
  })

  it('falls back to the prior, then the default ceiling', () => {
    expect(resolveLiveStartBitrate({ now: 1_000 }).source).toBe('default')
    writeLiveAbrPrior({ tier: 2, transportType: 'WIFI', now: 1_000 })
    expect(resolveLiveStartBitrate({ now: 1_000, transportType: 'WIFI' })).toMatchObject({
      source: 'prior',
      tier: 2,
    })
  })

  it('ignores a cancelled probe and uses the prior', () => {
    writeLiveAbrPrior({ tier: 1, now: 1_000 })
    setLiveUplinkProbeResultForTests({
      status: 'cancelled',
      tier: 0,
      elapsedMs: 100,
      bytes: 256_000,
    })
    expect(resolveLiveStartBitrate({ now: 1_000 })).toMatchObject({
      source: 'prior',
      tier: 1,
    })
  })
})

describe('liveUplinkProbe helpers', () => {
  afterEach(() => {
    resetLiveUplinkProbeForTests()
  })

  it('maps convex.cloud URLs onto the HTTP site host', () => {
    expect(convexHttpSiteUrl('https://ideal-akita-27.convex.cloud')).toBe(
      'https://ideal-akita-27.convex.site',
    )
    expect(liveUplinkProbeUrl('https://ideal-akita-27.convex.cloud')).toBe(
      'https://ideal-akita-27.convex.site/live/uplink-probe',
    )
    expect(liveUplinkProbeUrl('')).toBeNull()
  })

  it('records a completed probe from fetch and cancels in-flight work', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }))
    const now = vi.spyOn(Date, 'now')
    now.mockReturnValueOnce(1_000).mockReturnValue(1_100) // 100ms upload
    beginLiveUplinkProbe({
      probeUrl: 'https://example.convex.site/live/uplink-probe',
      bytes: 256 * 1024,
      timeoutMs: 2_000,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    await vi.waitFor(() => {
      expect(resolveLiveStartBitrate().source).toBe('probe')
    })
    // 256KiB in 100ms ≈ 21 Mbps → ceiling
    expect(resolveLiveStartBitrate().tier).toBe(0)

    // Cancel with nothing in flight is a no-op that preserves the result.
    cancelLiveUplinkProbe()
    expect(resolveLiveStartBitrate().source).toBe('probe')
    now.mockRestore()
  })
})

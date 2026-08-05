/**
 * Opportunistic uplink probe for live start-tier selection.
 *
 * Runs during pre-connect in parallel with camera preview / Mux provision.
 * Record tap never awaits it: if a result is ready we use it; otherwise we
 * fall back to the remembered ABR prior, then the 2.5 Mbps ceiling.
 *
 * Measurement: POST a fixed payload to a Convex HTTP action that discards the
 * body. Completing within the budget yields bits/sec → ladder tier. Timing out
 * means the link could not push ~256KiB in ~2s → survival floor. Cancelling
 * for record tap marks the instance cancelled so a half-finished upload does
 * not steal uplink from RTMP.
 *
 * Probe state is deliberately instance-owned. The app can keep more than one
 * create screen mounted, so a module-global controller lets a blurred screen
 * cancel or reuse the focused screen's measurement.
 */

import { readLiveAbrPrior } from './liveAbrPrior'
import {
  type LiveVideoBitrateTier,
  ladderBitrate,
  tierForMeasuredUplinkBps,
} from './liveBitratePolicy'

/** Fixed body size — small enough to finish on a healthy link within the budget. */
export const LIVE_UPLINK_PROBE_BYTES = 256 * 1024

/** Hard cap so a hung probe cannot outlive framing. */
export const LIVE_UPLINK_PROBE_TIMEOUT_MS = 2_000

/**
 * Could not finish the probe body in time → treat as weak uplink. 256KiB in
 * 2s already needs ~1.05 Mbps before RTMP/audio overhead, so only the survival
 * floor is defensible.
 */
export const LIVE_UPLINK_PROBE_TIMEOUT_TIER: LiveVideoBitrateTier = 3

export type LiveUplinkProbeStatus = 'completed' | 'timed_out' | 'cancelled' | 'failed'

export interface LiveUplinkProbeResult {
  status: LiveUplinkProbeStatus
  /** Present when status === 'completed'. */
  uplinkBps?: number
  tier: LiveVideoBitrateTier
  elapsedMs: number
  bytes: number
}

export interface LiveUplinkProbeHandle {
  /** Abort this probe only. A completed result is preserved. */
  cancel(): void
  /** Return the latest terminal result without waiting. */
  getResult(): LiveUplinkProbeResult | null
}

export type LiveStartBitrateSource = 'probe' | 'probe_timeout' | 'prior' | 'default'

export interface LiveStartBitrate {
  tier: LiveVideoBitrateTier
  bitrateBps: number
  source: LiveStartBitrateSource
  probe?: LiveUplinkProbeResult
}

/** Derive the HTTP Actions host from the Convex deployment URL. */
export function convexHttpSiteUrl(convexCloudUrl: string): string | null {
  const trimmed = convexCloudUrl.trim().replace(/\/$/, '')
  if (!trimmed) return null
  if (trimmed.endsWith('.convex.site')) return trimmed
  if (trimmed.endsWith('.convex.cloud')) {
    return trimmed.replace(/\.convex\.cloud$/, '.convex.site')
  }
  return null
}

export function liveUplinkProbeUrl(convexCloudUrl: string): string | null {
  const site = convexHttpSiteUrl(convexCloudUrl)
  return site ? `${site}/live/uplink-probe` : null
}

function buildProbeBody(bytes: number): ArrayBuffer {
  // TLS does not compress request bodies; zeroes avoid a large string allocation.
  return new ArrayBuffer(bytes)
}

/**
 * Kick off one independently owned probe. The caller keeps the returned handle
 * and cancels only that instance during effect cleanup or record tap.
 */
export function beginLiveUplinkProbe(args: {
  probeUrl: string
  bytes?: number
  timeoutMs?: number
  fetchImpl?: typeof fetch
}): LiveUplinkProbeHandle {
  const bytes = args.bytes ?? LIVE_UPLINK_PROBE_BYTES
  const timeoutMs = args.timeoutMs ?? LIVE_UPLINK_PROBE_TIMEOUT_MS
  const controller = new AbortController()
  const startedAt = Date.now()
  const fetchImpl = args.fetchImpl ?? fetch
  let result: LiveUplinkProbeResult | null = null
  let settled = false
  let abortReason: 'timeout' | 'cancelled' | null = null

  const finishAbort = (reason: 'timeout' | 'cancelled') => {
    if (settled || abortReason) return
    abortReason = reason
    result = {
      status: reason === 'timeout' ? 'timed_out' : 'cancelled',
      tier: reason === 'timeout' ? LIVE_UPLINK_PROBE_TIMEOUT_TIER : 0,
      elapsedMs: Math.max(1, Date.now() - startedAt),
      bytes,
    }
    try {
      controller.abort()
    } catch {
      // ignore
    }
  }

  const timeoutId = setTimeout(() => {
    finishAbort('timeout')
  }, timeoutMs)

  void (async () => {
    try {
      const response = await fetchImpl(args.probeUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
        },
        body: buildProbeBody(bytes),
        signal: controller.signal,
      })

      // Some fetch implementations can still resolve after abort. The timeout
      // or record tap owns the terminal result once it fires.
      if (abortReason) return

      const elapsedMs = Math.max(1, Date.now() - startedAt)
      if (!response.ok) {
        result = {
          status: 'failed',
          tier: LIVE_UPLINK_PROBE_TIMEOUT_TIER,
          elapsedMs,
          bytes,
        }
        return
      }

      const uplinkBps = (bytes * 8) / (elapsedMs / 1000)
      result = {
        status: 'completed',
        uplinkBps,
        tier: tierForMeasuredUplinkBps(uplinkBps),
        elapsedMs,
        bytes,
      }
    } catch {
      if (abortReason) return

      result = {
        status: 'failed',
        tier: LIVE_UPLINK_PROBE_TIMEOUT_TIER,
        elapsedMs: Math.max(1, Date.now() - startedAt),
        bytes,
      }
    } finally {
      settled = true
      clearTimeout(timeoutId)
    }
  })()

  return {
    cancel: () => finishAbort('cancelled'),
    getResult: () => result,
  }
}

/**
 * Pick the encoder start tier for a live connect/start.
 * Priority: completed probe → timed-out probe → remembered prior → ceiling.
 */
export function resolveLiveStartBitrate(args?: {
  transportType?: string | null
  now?: number
  probeResult?: LiveUplinkProbeResult | null
}): LiveStartBitrate {
  const probe = args?.probeResult ?? null

  if (probe?.status === 'completed') {
    return {
      tier: probe.tier,
      bitrateBps: ladderBitrate(probe.tier),
      source: 'probe',
      probe,
    }
  }

  if (probe?.status === 'timed_out') {
    return {
      tier: probe.tier,
      bitrateBps: ladderBitrate(probe.tier),
      source: 'probe_timeout',
      probe,
    }
  }

  const prior = readLiveAbrPrior({
    now: args?.now,
    transportType: args?.transportType,
  })
  if (prior) {
    return {
      tier: prior.tier,
      bitrateBps: prior.bitrateBps,
      source: 'prior',
      probe: probe ?? undefined,
    }
  }

  return {
    tier: 0,
    bitrateBps: ladderBitrate(0),
    source: 'default',
    probe: probe ?? undefined,
  }
}

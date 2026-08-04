/**
 * Opportunistic uplink probe for live start-tier selection.
 *
 * Runs during pre-connect in parallel with camera preview / Mux provision.
 * Record tap never awaits it: if a result is ready we use it; otherwise we
 * fall back to the remembered ABR prior, then the 2.5 Mbps ceiling.
 *
 * Measurement: POST a fixed payload to a Convex HTTP action that discards the
 * body. Completing within the budget yields bits/sec → ladder tier. Timing out
 * means the link could not push ~256KB in ~2s (<~1 Mbps) → survival-adjacent
 * tier. Cancelling for record tap discards the result so a half-finished upload
 * does not steal uplink from RTMP.
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
 * Could not finish the probe body in time → treat as weak uplink. 256KB in 2s
 * needs ~1 Mbps; the ladder's 1.0 Mbps rung (tier 2) is the conservative start.
 */
export const LIVE_UPLINK_PROBE_TIMEOUT_TIER: LiveVideoBitrateTier = 2

export type LiveUplinkProbeStatus = 'completed' | 'timed_out' | 'cancelled' | 'failed'

export interface LiveUplinkProbeResult {
  status: LiveUplinkProbeStatus
  /** Present when status === 'completed'. */
  uplinkBps?: number
  tier: LiveVideoBitrateTier
  elapsedMs: number
  bytes: number
}

export type LiveStartBitrateSource = 'probe' | 'probe_timeout' | 'prior' | 'default'

export interface LiveStartBitrate {
  tier: LiveVideoBitrateTier
  bitrateBps: number
  source: LiveStartBitrateSource
  probe?: LiveUplinkProbeResult
}

type ActiveProbe = {
  controller: AbortController
  generation: number
  /** Why this probe was aborted, if it was. */
  abortReason?: 'timeout' | 'cancelled'
}

let activeProbe: ActiveProbe | null = null
let completedResult: LiveUplinkProbeResult | null = null
let probeGeneration = 0

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
  // Zeros compress poorly enough over TLS framing and avoid allocating strings.
  return new ArrayBuffer(bytes)
}

/**
 * Kick off a probe. Replaces any in-flight probe. Safe to call repeatedly from
 * the pre-connect effect — only the latest generation can publish a result.
 */
export function beginLiveUplinkProbe(args: {
  probeUrl: string
  bytes?: number
  timeoutMs?: number
  fetchImpl?: typeof fetch
}): void {
  // Keep a useful finished result across focus flickers — restarting would
  // throw away the only signal we have before record tap.
  if (completedResult?.status === 'completed' || completedResult?.status === 'timed_out') {
    return
  }

  cancelLiveUplinkProbe()
  completedResult = null

  const bytes = args.bytes ?? LIVE_UPLINK_PROBE_BYTES
  const timeoutMs = args.timeoutMs ?? LIVE_UPLINK_PROBE_TIMEOUT_MS
  const generation = ++probeGeneration
  const controller = new AbortController()
  activeProbe = { controller, generation }
  const probe = activeProbe

  const startedAt = Date.now()
  const fetchImpl = args.fetchImpl ?? fetch
  const timeoutId = setTimeout(() => {
    if (activeProbe?.generation === generation) {
      activeProbe.abortReason = 'timeout'
    }
    controller.abort()
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

      if (generation !== probeGeneration) {
        return
      }

      const elapsedMs = Math.max(1, Date.now() - startedAt)
      if (!response.ok) {
        completedResult = {
          status: 'failed',
          tier: LIVE_UPLINK_PROBE_TIMEOUT_TIER,
          elapsedMs,
          bytes,
        }
        return
      }

      const uplinkBps = (bytes * 8) / (elapsedMs / 1000)
      completedResult = {
        status: 'completed',
        uplinkBps,
        tier: tierForMeasuredUplinkBps(uplinkBps),
        elapsedMs,
        bytes,
      }
    } catch {
      if (generation !== probeGeneration) {
        return
      }

      const elapsedMs = Math.max(1, Date.now() - startedAt)
      const abortReason = probe.abortReason

      if (abortReason === 'timeout') {
        completedResult = {
          status: 'timed_out',
          tier: LIVE_UPLINK_PROBE_TIMEOUT_TIER,
          elapsedMs,
          bytes,
        }
        return
      }

      if (abortReason === 'cancelled') {
        completedResult = {
          status: 'cancelled',
          tier: 0,
          elapsedMs,
          bytes,
        }
        return
      }

      completedResult = {
        status: 'failed',
        tier: LIVE_UPLINK_PROBE_TIMEOUT_TIER,
        elapsedMs,
        bytes,
      }
    } finally {
      clearTimeout(timeoutId)
      if (activeProbe?.generation === generation) {
        activeProbe = null
      }
    }
  })()
}

/** Abort an in-flight probe (record tap). Completed results are left alone. */
export function cancelLiveUplinkProbe(): void {
  if (!activeProbe) {
    return
  }
  const { controller, generation } = activeProbe
  activeProbe.abortReason = 'cancelled'
  activeProbe = null
  // Bump generation so a late timeout handler cannot overwrite a cancel.
  if (generation === probeGeneration) {
    probeGeneration++
  }
  try {
    controller.abort()
  } catch {
    // ignore
  }
}

export function getLiveUplinkProbeResult(): LiveUplinkProbeResult | null {
  return completedResult
}

/** Test helper — reset module state between cases. */
export function resetLiveUplinkProbeForTests(): void {
  cancelLiveUplinkProbe()
  completedResult = null
  probeGeneration = 0
}

/** Test helper — inject a completed result without fetching. */
export function setLiveUplinkProbeResultForTests(result: LiveUplinkProbeResult | null): void {
  completedResult = result
  activeProbe = null
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
  const probe = args?.probeResult !== undefined ? args.probeResult : completedResult

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

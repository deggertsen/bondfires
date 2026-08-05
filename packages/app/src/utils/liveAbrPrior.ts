/**
 * Remembered ABR start prior for live recording.
 *
 * When a preflight uplink probe has not finished by record tap, we fall back
 * to the tier the previous session settled on rather than always opening at
 * 2.5 Mbps. Soft TTL + optional transport-type match keep a cafe-Wi‑Fi floor
 * from permanently kneecapping a later home session.
 */

import {
  clampLiveVideoBitrateTier,
  type LiveVideoBitrateTier,
  ladderBitrate,
} from './liveBitratePolicy'
import { mmkvStorage } from './storage'

const PRIOR_STORAGE_KEY = 'live:abrPrior:v1'
export const LIVE_ABR_PRIOR_TTL_MS = 24 * 60 * 60 * 1000

export interface LiveAbrPrior {
  tier: LiveVideoBitrateTier
  bitrateBps: number
  updatedAt: number
  transportType?: string
}

export function readLiveAbrPrior(args?: {
  now?: number
  transportType?: string | null
  ttlMs?: number
}): LiveAbrPrior | null {
  const raw = mmkvStorage.getItem(PRIOR_STORAGE_KEY)
  if (!raw) {
    return null
  }

  let parsed: Partial<LiveAbrPrior>
  try {
    parsed = JSON.parse(raw) as Partial<LiveAbrPrior>
  } catch {
    mmkvStorage.removeItem(PRIOR_STORAGE_KEY)
    return null
  }

  if (typeof parsed.tier !== 'number' || typeof parsed.updatedAt !== 'number') {
    mmkvStorage.removeItem(PRIOR_STORAGE_KEY)
    return null
  }

  const now = args?.now ?? Date.now()
  const ttlMs = args?.ttlMs ?? LIVE_ABR_PRIOR_TTL_MS
  if (now - parsed.updatedAt > ttlMs) {
    return null
  }

  const priorTransport = parsed.transportType
  const currentTransport = args?.transportType
  if (
    priorTransport &&
    currentTransport &&
    priorTransport !== 'UNKNOWN' &&
    currentTransport !== 'UNKNOWN' &&
    priorTransport !== currentTransport
  ) {
    return null
  }

  const tier = clampLiveVideoBitrateTier(parsed.tier)
  return {
    tier,
    bitrateBps: ladderBitrate(tier),
    updatedAt: parsed.updatedAt,
    transportType: typeof priorTransport === 'string' ? priorTransport : undefined,
  }
}

export function writeLiveAbrPrior(args: {
  tier: LiveVideoBitrateTier
  transportType?: string | null
  now?: number
}): LiveAbrPrior {
  const tier = clampLiveVideoBitrateTier(args.tier)
  const prior: LiveAbrPrior = {
    tier,
    bitrateBps: ladderBitrate(tier),
    updatedAt: args.now ?? Date.now(),
    transportType: args.transportType ?? undefined,
  }
  mmkvStorage.setItem(PRIOR_STORAGE_KEY, JSON.stringify(prior))
  return prior
}

export function clearLiveAbrPrior(): void {
  mmkvStorage.removeItem(PRIOR_STORAGE_KEY)
}

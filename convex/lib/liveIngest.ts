import type { Doc } from '../_generated/dataModel'

// Tri-state ingest classification for a live recording session.
//
// We deliberately distinguish "Mux confirmed the stream was empty" (safe to
// hard-delete the record) from "we could not reach Mux to confirm" (must NOT
// destroy a possibly-real recording — demote it and let the reaper reconcile).
export type IngestEvidence = {
  status: 'confirmed' | 'empty' | 'unknown'
  source: string
}

// Evidence already persisted on our row. All of these are set by Mux's
// authoritative webhooks (live_stream.active / asset events), never by an early
// client-side "live" signal, so they are trustworthy ingest proof.
export function localIngestSource(session: Doc<'liveSessions'>): string | null {
  if (session.startedAt) return 'started_at'
  if (session.muxRecordedAssetId) return 'recorded_asset'
  if (session.muxActiveAssetId) return 'active_asset'
  if (session.muxRecentAssetId) return 'recent_asset'
  if (session.status === 'live') return 'status_live'
  return null
}

// Pure classification of a Mux live-stream read. `reachable: false` means the
// Mux API call failed or the stream is gone — we cannot prove emptiness, so we
// return 'unknown' and the caller preserves the record.
export function classifyMuxIngest(input: {
  reachable: boolean
  status?: string
  activeAssetId?: string
  recentAssetIds?: string[]
}): IngestEvidence {
  if (!input.reachable) {
    return { status: 'unknown', source: 'mux_unreachable' }
  }

  if (input.activeAssetId) return { status: 'confirmed', source: 'mux_active_asset' }
  if ((input.recentAssetIds?.length ?? 0) > 0) {
    return { status: 'confirmed', source: 'mux_recent_asset' }
  }
  if (input.status === 'active') return { status: 'confirmed', source: 'mux_status_active' }

  // Mux answered and reports no asset and a non-active status: the stream
  // genuinely never received media.
  return { status: 'empty', source: `mux_${input.status ?? 'unknown'}` }
}

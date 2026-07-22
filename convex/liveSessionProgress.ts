/**
 * Whether a live session ever made real progress — went live, started
 * ingesting, or produced a Mux asset. Progress decides cancel-vs-finalize:
 * cancelling a progressed session destroys a real (possibly partial)
 * recording, which is exactly the recording-loss class of bug, so callers
 * must finalize progressed sessions instead of deleting them.
 */
export function assessLiveSessionProgress(liveSession: {
  status: string
  startedAt?: number | null
  muxRecordedAssetId?: string | null
  muxActiveAssetId?: string | null
  muxRecentAssetId?: string | null
}) {
  const hadAsset = Boolean(
    liveSession.muxRecordedAssetId ?? liveSession.muxActiveAssetId ?? liveSession.muxRecentAssetId,
  )
  const hadProgressed =
    liveSession.status === 'live' ||
    liveSession.status === 'ending' ||
    Boolean(liveSession.startedAt) ||
    hadAsset

  return { hadAsset, hadProgressed }
}

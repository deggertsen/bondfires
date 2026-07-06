import { telemetry } from '@bondfires/app'
import { useEffect, useRef } from 'react'
import type { BondfireDetailData } from './bondfireDetailHelpers'
import {
  buildVideoUrlTargets,
  missingUrlRequests,
  shouldLoadMainVideoUrls,
  urlPrefetchWindow,
  urlsFromCache,
  type VideoUrlRequest,
  type VideoUrlTarget,
} from './bondfireVideoUrlPlan'

type GetVideoUrlsBatch = (args: { items: VideoUrlRequest[] }) => Promise<{ hdUrl: string }[]>

export function useBondfireVideoUrls({
  bondfireData,
  currentVideoIndex,
  getVideoUrlsBatch,
  setVideoUrls,
}: {
  bondfireData: BondfireDetailData | null | undefined
  currentVideoIndex: number
  getVideoUrlsBatch: GetVideoUrlsBatch
  setVideoUrls: (urls: (string | null)[]) => void
}) {
  // URLs live for the whole screen visit (signed tokens last 12h). Keyed per
  // video identity so a status change on one video (new response, live ending)
  // refetches only that video instead of blanking the whole set mid-playback.
  const cacheRef = useRef<Map<string, string>>(new Map())
  const inFlightRef = useRef<Set<string>>(new Set())
  const latestTargetsRef = useRef<VideoUrlTarget[]>([])
  const warnedMissingPlaybackIdRef = useRef<string | null>(null)
  const disposedRef = useRef(false)

  useEffect(() => {
    disposedRef.current = false
    return () => {
      disposedRef.current = true
    }
  }, [])

  useEffect(() => {
    if (!bondfireData) {
      latestTargetsRef.current = []
      setVideoUrls([])
      return
    }

    const targets = buildVideoUrlTargets(bondfireData)
    latestTargetsRef.current = targets
    setVideoUrls(urlsFromCache(targets, cacheRef.current))

    if (!shouldLoadMainVideoUrls(bondfireData)) return

    if (targets[0]?.cacheKey === null && warnedMissingPlaybackIdRef.current !== bondfireData._id) {
      warnedMissingPlaybackIdRef.current = bondfireData._id
      telemetry.warn('video:urls:missing_playback_id', 'No playback ID for bondfire', {
        bondfireId: bondfireData._id,
        videoStatus: bondfireData.videoStatus,
      })
    }

    const missing = missingUrlRequests(
      targets,
      cacheRef.current,
      inFlightRef.current,
      urlPrefetchWindow(currentVideoIndex, targets.length),
    )
    if (missing.length === 0) return

    for (const entry of missing) inFlightRef.current.add(entry.cacheKey)
    getVideoUrlsBatch({ items: missing.map((entry) => entry.request) })
      .then((results) => {
        missing.forEach((entry, index) => {
          const url = results[index]?.hdUrl
          if (url) cacheRef.current.set(entry.cacheKey, url)
        })
        if (disposedRef.current) return
        // Resolve against the latest targets, not this effect run's: a newer
        // run may have already replaced them (and skipped these in-flight
        // keys), and its own batch won't re-deliver these URLs.
        setVideoUrls(urlsFromCache(latestTargetsRef.current, cacheRef.current))
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        telemetry.error('video:urls:failed', message, {
          bondfireId: bondfireData._id,
          requestedCount: missing.length,
        })
      })
      .finally(() => {
        for (const entry of missing) inFlightRef.current.delete(entry.cacheKey)
      })
  }, [bondfireData, currentVideoIndex, getVideoUrlsBatch, setVideoUrls])
}

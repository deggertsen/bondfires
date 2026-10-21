import { telemetry } from '@bondfires/app'
import { useAction } from 'convex/react'
import { useEffect, useMemo, useReducer, useRef } from 'react'
import { api } from '../../../../../../convex/_generated/api'
import type { BondfireDetailData } from './bondfireDetailHelpers'
import {
  buildVideoUrlTargets,
  missingUrlRequests,
  shouldLoadMainVideoUrls,
  urlPrefetchWindow,
  urlsFromCache,
  type VideoPlaybackUrls,
  type VideoUrlRequest,
} from './bondfireVideoUrlPlan'

type GetVideoUrlsBatch = (args: {
  items: VideoUrlRequest[]
}) => Promise<{ hdUrl: string; captionsUrl?: string }[]>

export function useBondfireVideoUrls({
  bondfireData,
  currentVideoIndex,
  getVideoUrlsBatch,
}: {
  bondfireData: BondfireDetailData | null | undefined
  currentVideoIndex: number
  getVideoUrlsBatch: GetVideoUrlsBatch
}) {
  const getCapability = useAction(api.segmentMedia.capability)
  // URLs live for the whole screen visit (signed tokens last 12h). Keyed per
  // video identity so a status change on one video (new response, live ending)
  // refetches only that video instead of blanking the whole set mid-playback.
  const cacheRef = useRef<Map<string, VideoPlaybackUrls>>(new Map())
  const inFlightRef = useRef<Set<string>>(new Set())
  const [, refreshUrls] = useReducer((version: number) => version + 1, 0)
  const targets = useMemo(
    () => (bondfireData ? buildVideoUrlTargets(bondfireData) : []),
    [bondfireData],
  )
  const warnedMissingPlaybackIdRef = useRef<string | null>(null)
  const disposedRef = useRef(false)

  useEffect(() => {
    disposedRef.current = false
    return () => {
      disposedRef.current = true
    }
  }, [])

  useEffect(() => {
    if (!bondfireData) return

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
    void (async () => {
      const imported = missing.filter(
        (entry): entry is { cacheKey: string; request: VideoUrlRequest } =>
          !('segmentRecordingId' in entry.request),
      )
      const importedResults = imported.length
        ? await getVideoUrlsBatch({ items: imported.map((entry) => entry.request) })
        : []
      return Promise.all(
        missing.map(async (entry) => {
          if ('segmentRecordingId' in entry.request) {
            const grant = await getCapability({
              recordingId: entry.request.segmentRecordingId,
              operation: 'read',
            })
            return {
              hdUrl: `${grant.baseUrl}/index.m3u8?token=${encodeURIComponent(grant.token)}`,
              captionsUrl: `${grant.baseUrl}/captions.vtt?token=${encodeURIComponent(grant.token)}`,
            }
          }
          return importedResults[imported.findIndex((item) => item.cacheKey === entry.cacheKey)]
        }),
      )
    })()
      .then((results) => {
        missing.forEach((entry, index) => {
          const result = results[index]
          if (result?.hdUrl) {
            cacheRef.current.set(entry.cacheKey, {
              url: result.hdUrl,
              captionsUrl: result.captionsUrl,
            })
          }
        })
        if (disposedRef.current) return
        refreshUrls()
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
  }, [bondfireData, targets, currentVideoIndex, getVideoUrlsBatch, getCapability])

  // Resolve during render, never publish an index-based array from an effect:
  // prepending a page must not briefly attach the old URLs to different videos.
  return urlsFromCache(targets, cacheRef.current)
}

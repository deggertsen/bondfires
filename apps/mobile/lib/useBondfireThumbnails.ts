import { useAction } from 'convex/react'
import { useCallback, useRef, useState } from 'react'
import { api } from '../../../convex/_generated/api'
import {
  type BondfireThumbnailFields,
  getPendingBondfireThumbnails,
  type PendingBondfireThumbnail,
} from './bondfireThumbnails'

type ThumbnailBondfire = BondfireThumbnailFields & { _id: string }

type UseBondfireThumbnailsOptions = {
  enabled: boolean
  onBatchError?: (error: unknown, pending: PendingBondfireThumbnail[]) => void
}

/**
 * Loads a visible window of thumbnail URLs in one Convex action and publishes
 * the completed window in one React state update. A generation guard prevents
 * stale requests from repopulating the cache after a refresh or camp change.
 */
export function useBondfireThumbnails({ enabled, onBatchError }: UseBondfireThumbnailsOptions) {
  const getThumbnailUrlsBatch = useAction(api.videos.getThumbnailUrlsBatch)
  const [thumbnailUrls, setThumbnailUrls] = useState<Record<string, string | null | undefined>>({})
  const thumbnailUrlsRef = useRef(thumbnailUrls)
  const loadingKeysRef = useRef<Set<string>>(new Set())
  const generationRef = useRef(0)
  const onBatchErrorRef = useRef(onBatchError)
  onBatchErrorRef.current = onBatchError

  const ensureThumbnailUrls = useCallback(
    async (bondfires: ThumbnailBondfire[]) => {
      if (!enabled || bondfires.length === 0) return

      const pending = getPendingBondfireThumbnails(
        bondfires,
        thumbnailUrlsRef.current,
        loadingKeysRef.current,
      )
      if (pending.length === 0) return

      const loadingKeys = loadingKeysRef.current
      for (const item of pending) loadingKeys.add(item.cacheKey)
      const generation = generationRef.current

      try {
        const results = await getThumbnailUrlsBatch({
          items: pending.map((item) => item.request),
        })
        if (generation !== generationRef.current) return

        const next = { ...thumbnailUrlsRef.current }
        pending.forEach((item, index) => {
          next[item.cacheKey] = results[index]?.thumbnailUrl ?? null
        })
        thumbnailUrlsRef.current = next
        setThumbnailUrls(next)
      } catch (error) {
        if (generation !== generationRef.current) return

        const next = { ...thumbnailUrlsRef.current }
        for (const item of pending) next[item.cacheKey] = null
        thumbnailUrlsRef.current = next
        setThumbnailUrls(next)
        onBatchErrorRef.current?.(error, pending)
      } finally {
        for (const item of pending) loadingKeys.delete(item.cacheKey)
      }
    },
    [enabled, getThumbnailUrlsBatch],
  )

  const resetThumbnailUrls = useCallback(() => {
    generationRef.current += 1
    loadingKeysRef.current = new Set()
    thumbnailUrlsRef.current = {}
    setThumbnailUrls({})
  }, [])

  return { ensureThumbnailUrls, resetThumbnailUrls, thumbnailUrls }
}

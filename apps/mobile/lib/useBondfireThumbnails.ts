import { batch, type Observable } from '@legendapp/state'
import { useObservable } from '@legendapp/state/react'
import { useAction } from 'convex/react'
import { useCallback, useRef } from 'react'
import { api } from '../../../convex/_generated/api'
import {
  type BondfireThumbnailFields,
  getPendingBondfireThumbnails,
  type PendingBondfireThumbnail,
} from './bondfireThumbnails'

type ThumbnailBondfire = BondfireThumbnailFields & { _id: string }

export type BondfireThumbnailUrls$ = Observable<Record<string, string | null>>

type UseBondfireThumbnailsOptions = {
  enabled: boolean
  onBatchError?: (error: unknown, pending: PendingBondfireThumbnail[]) => void
}

/**
 * Loads a visible window of thumbnail URLs in one Convex action and publishes
 * results to a key-addressable observable. Consumers subscribe to their own
 * cache key, so thumbnail hydration never rerenders the parent list. A
 * generation guard prevents stale requests from repopulating the cache after
 * a refresh or camp change.
 */
export function useBondfireThumbnails({ enabled, onBatchError }: UseBondfireThumbnailsOptions) {
  const getThumbnailUrlsBatch = useAction(api.videos.getThumbnailUrlsBatch)
  const thumbnailUrls$ = useObservable<Record<string, string | null>>({})
  const loadingKeysRef = useRef<Set<string>>(new Set())
  const generationRef = useRef(0)
  const onBatchErrorRef = useRef(onBatchError)
  onBatchErrorRef.current = onBatchError

  const ensureThumbnailUrls = useCallback(
    async (bondfires: ThumbnailBondfire[]) => {
      if (!enabled || bondfires.length === 0) return

      const pending = getPendingBondfireThumbnails(
        bondfires,
        thumbnailUrls$.peek(),
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

        batch(() => {
          pending.forEach((item, index) => {
            thumbnailUrls$[item.cacheKey].set(results[index]?.thumbnailUrl ?? null)
          })
        })
      } catch (error) {
        if (generation !== generationRef.current) return

        batch(() => {
          for (const item of pending) thumbnailUrls$[item.cacheKey].set(null)
        })
        onBatchErrorRef.current?.(error, pending)
      } finally {
        for (const item of pending) loadingKeys.delete(item.cacheKey)
      }
    },
    [enabled, getThumbnailUrlsBatch, thumbnailUrls$],
  )

  const resetThumbnailUrls = useCallback(() => {
    generationRef.current += 1
    loadingKeysRef.current = new Set()
    thumbnailUrls$.set({})
  }, [thumbnailUrls$])

  return { ensureThumbnailUrls, resetThumbnailUrls, thumbnailUrls$ }
}

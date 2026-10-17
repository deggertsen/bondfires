import { useEffect, useRef } from 'react'
import {
  type BondfireDetailData,
  getInitialVideoIndex,
  getResponseDeepLinkState,
  getResponseVideoScrollIndex,
  getRetainedVideoIndex,
} from './bondfireDetailHelpers'
import { getThreadCatchUp, type ThreadCatchUp } from './threadCatchUp'

/** Arrival/deep-link positioning and identity retention as pages change.
 * Loading history must not restart playback or classify unknown rows as watched. */
export function useBondfireThreadPosition({
  data,
  responseId,
  hasOlder,
  currentVideoIndex,
  loadOlder,
  scrollToIndex,
  onArrival,
}: {
  data: BondfireDetailData | null | undefined
  responseId: string | undefined
  hasOlder: boolean
  currentVideoIndex: number
  loadOlder: () => void
  scrollToIndex: (index: number) => void
  onArrival: (catchUp: ThreadCatchUp) => void
}) {
  const arrivalRef = useRef<string | null>(null)
  const previousKeysRef = useRef<string[]>([])
  const state = data ? getResponseDeepLinkState(data, responseId, hasOlder) : 'loading'

  useEffect(() => {
    if (data && responseId && state === 'loading') loadOlder()
  }, [data, responseId, state, loadOlder])

  useEffect(() => {
    if (!data || state === 'loading') return
    const key = `${data._id}:${responseId ?? 'default'}:${state}`
    const nextKeys = [data._id, ...data.videos.map((video) => video._id)]
    const previousKeys = previousKeysRef.current
    previousKeysRef.current = nextKeys
    if (arrivalRef.current === key) {
      const index = getRetainedVideoIndex(previousKeys, nextKeys, currentVideoIndex)
      if (index !== currentVideoIndex) scrollToIndex(index)
      return
    }
    arrivalRef.current = key
    const index = getResponseVideoScrollIndex(data, responseId) ?? getInitialVideoIndex(data)
    onArrival(
      getThreadCatchUp(
        [data, ...data.videos].map((video) => ({
          key: video._id,
          watchedByViewer: video.watchedByViewer ?? false,
        })),
        index,
      ),
    )
    scrollToIndex(index)
  }, [data, responseId, state, currentVideoIndex, scrollToIndex, onArrival])

  return state
}

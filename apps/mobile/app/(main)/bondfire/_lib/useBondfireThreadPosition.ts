import { useObservable, useValue } from '@legendapp/state/react'
import { useCallback, useEffect, useRef } from 'react'
import {
  type BondfireDetailData,
  clampVideoIndex,
  getInitialVideoIndex,
  getResponseVideoScrollIndex,
} from './bondfireDetailHelpers'
import { getThreadCatchUp, type ThreadCatchUp } from './threadCatchUp'

type Position = { arrivalKey: string; videoKey: string; index: number }

/** Keep selection by identity across page prepends and subscription resets.
 * Resolve its index during render so playback and watch events never see the
 * previous page's numeric position paired with the next page's videos. */
export function useBondfireThreadPosition({
  data,
  responseId,
  hasOlder,
  loadOlder,
  scrollToIndex,
  onArrival,
}: {
  data: BondfireDetailData | null | undefined
  responseId: string | undefined
  hasOlder: boolean
  loadOlder: () => void
  scrollToIndex: (index: number) => void
  onArrival: (catchUp: ThreadCatchUp) => void
}) {
  const position$ = useObservable<Position | null>(null)
  const position = useValue(position$)
  const arrivalRef = useRef<string | null>(null)
  const arrivalKey = data ? `${data._id}:${responseId ?? 'default'}` : null
  const selected = position?.arrivalKey === arrivalKey ? position : null
  const target = selected?.videoKey ?? responseId
  const targetIndex = data
    ? target === data._id
      ? 0
      : getResponseVideoScrollIndex(data, target)
    : null
  // Blurring the screen skips its subscriptions. On return, reload bounded
  // pages until the previously selected identity is available again.
  const loading = !data || (!!target && targetIndex === null && hasOlder)
  const state = loading
    ? 'loading'
    : responseId && getResponseVideoScrollIndex(data, responseId) === null
      ? 'unavailable'
      : responseId
        ? 'resolved'
        : 'none'
  const currentVideoIndex = data
    ? (targetIndex ??
      (selected
        ? clampVideoIndex(selected.index, 1 + data.videos.length)
        : getInitialVideoIndex(data)))
    : 0
  const videoKey = data && [data._id, ...data.videos.map((video) => video._id)][currentVideoIndex]
  const ready = !!data && !loading

  useEffect(() => {
    if (data && loading) loadOlder()
  }, [data, loading, loadOlder])

  useEffect(() => {
    if (!ready || !arrivalKey || !videoKey) return
    const previous = position$.peek()
    if (
      previous?.arrivalKey !== arrivalKey ||
      previous.videoKey !== videoKey ||
      previous.index !== currentVideoIndex
    ) {
      position$.set({ arrivalKey, videoKey, index: currentVideoIndex })
    }
    if (arrivalRef.current === arrivalKey) return
    arrivalRef.current = arrivalKey
    onArrival(
      getThreadCatchUp(
        [data, ...data.videos].map((video) => ({
          key: video._id,
          watchedByViewer: video.watchedByViewer ?? false,
        })),
        currentVideoIndex,
      ),
    )
  }, [ready, arrivalKey, videoKey, currentVideoIndex, data, onArrival, position$])

  const previousViewRef = useRef<{ ready: boolean; arrivalKey: string | null }>({
    ready: false,
    arrivalKey: null,
  })
  useEffect(() => {
    const previous = previousViewRef.current
    previousViewRef.current = { ready, arrivalKey }
    if (
      ready &&
      (!previous.ready ||
        previous.arrivalKey !== arrivalKey ||
        selected?.index !== currentVideoIndex)
    ) {
      scrollToIndex(currentVideoIndex)
    }
  }, [ready, arrivalKey, selected?.index, currentVideoIndex, scrollToIndex])

  const onVideoIndexChange = useCallback(
    (index: number) => {
      if (!ready || !arrivalKey) return
      const key = [data._id, ...data.videos.map((video) => video._id)][index]
      if (key) position$.set({ arrivalKey, videoKey: key, index })
    },
    [ready, arrivalKey, data, position$],
  )

  return { state, currentVideoIndex, onVideoIndexChange }
}

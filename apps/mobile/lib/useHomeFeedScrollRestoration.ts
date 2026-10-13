import { type RefObject, useEffect, useRef } from 'react'

type ScrollableFeed = {
  scrollToIndex: (options: { index: number; animated: boolean; viewPosition: number }) => void
}

export function useHomeFeedScrollRestoration({
  ready,
  items,
  listRef,
  getSavedBondfireId,
}: {
  ready: boolean
  items: { _id: string }[] | undefined
  listRef: RefObject<ScrollableFeed | null>
  getSavedBondfireId: () => string | undefined
}) {
  const restored = useRef(false)
  const currentItems = useRef(items)
  currentItems.current = items

  useEffect(() => {
    if (!ready || !listRef.current || !items?.length || restored.current) return
    const savedId = getSavedBondfireId()
    if (!savedId || !items.some((item) => item._id === savedId)) {
      restored.current = true
      return
    }

    const timer = setTimeout(() => {
      // Re-resolve the index: live updates can remove or reorder rows before
      // this timer fires. Only consume restoration when a list is mounted.
      if (!listRef.current) return
      const index = currentItems.current?.findIndex((item) => item._id === savedId) ?? -1
      restored.current = true
      if (index >= 0) {
        listRef.current.scrollToIndex({ index, animated: false, viewPosition: 0.2 })
      }
    }, 0)
    return () => clearTimeout(timer)
  }, [getSavedBondfireId, items, listRef, ready])
}

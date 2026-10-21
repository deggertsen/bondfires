import { batch, type Observable } from '@legendapp/state'
import { useObservable } from '@legendapp/state/react'
import { useCallback } from 'react'
import type { ViewToken } from 'react-native'

export type ReactionRowVisibility$ = Observable<Record<string, boolean>>

/**
 * Which list rows are on screen, by bondfire id, for the reaction chip's
 * fly-in. FlatList mounts rows ahead of the viewport, so a row's first layout
 * cannot say whether anyone saw it; feed this from onViewableItemsChanged and
 * a row flies in when it actually scrolls into view.
 */
export function useReactionRowVisibility() {
  const visible$ = useObservable<Record<string, boolean>>({})

  const updateVisibleRows = useCallback(
    (viewableItems: ViewToken[]) => {
      const next = new Set<string>()
      for (const token of viewableItems) {
        const id = (token.item as { _id?: unknown } | null)?._id
        if (token.isViewable && typeof id === 'string') next.add(id)
      }
      const current = visible$.peek()
      batch(() => {
        for (const id of Object.keys(current)) if (!next.has(id)) visible$[id].delete()
        for (const id of next) if (!current[id]) visible$[id].set(true)
      })
    },
    [visible$],
  )

  return { visibleRows$: visible$, updateVisibleRows }
}

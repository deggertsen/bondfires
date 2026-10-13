export type FeedPageState = 'loading' | 'available' | 'done'

/**
 * Home paints two queries together: the paginated Discover feed and the
 * viewer's participating threads (the Ember Rail plus the "New responses"
 * section). Discover is deduped against those threads, so painting between the
 * two showed the viewer's own fires as Discover rows — sorted
 * smallest-conversation-first — and then reflowed them into the rail once the
 * thread query landed. listMyFires is the heavier of the two (participant maps
 * and per-row watch lookups server-side), so it loses that race on a cold load.
 *
 * Hold the loading state until both settle. `railQueryEnabled` is false while
 * the tab is unfocused or auth has not resolved; the thread query is skipped
 * then and would never resolve, so it must not gate the render.
 */
export function isHomeFeedLoading({
  feedResolved,
  railQueryEnabled,
  railResolved,
}: {
  feedResolved: boolean
  railQueryEnabled: boolean
  railResolved: boolean
}): boolean {
  if (!feedResolved) return true
  return railQueryEnabled && !railResolved
}

/** An empty filtered page does not mean the paginated feed is exhausted. */
export function getHomeFeedEmptyState({
  pageState,
  loadedCount,
  query,
  viewMode,
}: {
  pageState: FeedPageState
  loadedCount: number
  query: string
  viewMode: string
}) {
  if (pageState === 'loading') return 'loading'
  if (pageState === 'available') return 'more'
  if (loadedCount === 0) return 'empty'
  return query.trim() === '' && viewMode === 'discover' ? 'caught-up' : 'no-matches'
}

export type FeedPageState = 'loading' | 'available' | 'done'

/** Wait for both Home sections before rendering a feed deduped against the rail. */
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

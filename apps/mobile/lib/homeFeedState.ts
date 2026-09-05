export type FeedPageState = 'loading' | 'available' | 'done'

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

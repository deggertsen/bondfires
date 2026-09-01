export type PaginationStatus = 'LoadingFirstPage' | 'CanLoadMore' | 'LoadingMore' | 'Exhausted'

/**
 * Visibility rules can remove every row in a database page. Continue bounded
 * server pages until the UI has enough visible rows or the cursor is exhausted.
 */
export function shouldLoadSparsePage(
  status: PaginationStatus,
  visibleCount: number,
  targetCount: number,
): boolean {
  return status === 'CanLoadMore' && visibleCount < targetCount
}

/** Keep first-seen cursor order if reactive index movement repeats a row. */
export function uniqueById<T extends { _id: string }>(items: T[]): T[] {
  const seen = new Set<string>()
  return items.filter((item) => {
    if (seen.has(item._id)) return false
    seen.add(item._id)
    return true
  })
}

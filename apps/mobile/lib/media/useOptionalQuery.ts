import { useQuery_experimental } from 'convex/react'
import type { FunctionArgs, FunctionReference } from 'convex/server'

/** Optional media decorations must not throw into the camera/player boundary.
 * Convex owns argument memoization, subscription changes, and error values.
 */
export function useOptionalQuery<Query extends FunctionReference<'query'>>(
  query: Query,
  args: FunctionArgs<Query> | 'skip',
) {
  const result = useQuery_experimental({ query, args, throwOnError: false })
  return {
    data: result.status === 'success' ? result.data : undefined,
    error: result.status === 'error' ? result.error : undefined,
  }
}

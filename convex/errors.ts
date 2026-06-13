import { ConvexError } from 'convex/values'

export function throwUserError(message: string): never {
  throw new ConvexError(message)
}

/**
 * Runs a handler body and guarantees the client never receives a raw,
 * unactionable "Server Error" (HTTP 500). Expected, user-facing failures thrown
 * via {@link throwUserError} (i.e. `ConvexError`s) pass through unchanged. Any
 * other (unexpected) throw is logged server-side and re-surfaced as a clean
 * `ConvexError` carrying `fallbackMessage`.
 *
 * `console.error` is intentional: it lands in the Convex deployment logs even
 * though the surrounding mutation transaction rolls back when we re-throw, so it
 * is the only durable breadcrumb for the real (unmasked) cause if this ever
 * recurs.
 */
export async function withUserFacingErrors<T>(
  context: string,
  fallbackMessage: string,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn()
  } catch (error) {
    if (error instanceof ConvexError) {
      throw error
    }
    console.error(`[${context}] unexpected error:`, error)
    throw new ConvexError(fallbackMessage)
  }
}

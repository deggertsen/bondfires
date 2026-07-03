import { ConvexError } from 'convex/values'
import { internal } from './_generated/api'
import type { ActionCtx } from './_generated/server'
import { serializeServerLogData } from './serverTelemetry'

export function throwUserError(message: string): never {
  throw new ConvexError(message)
}

/**
 * Runs a mutation handler body and guarantees the client never receives a raw,
 * unactionable "Server Error" (HTTP 500). Expected, user-facing failures thrown
 * via {@link throwUserError} (i.e. `ConvexError`s) pass through unchanged. Any
 * other (unexpected) throw is logged to the Convex deployment console and then
 * re-surfaced as a clean `ConvexError` carrying `fallbackMessage`.
 *
 * Without this, an unexpected throw reaches the client as an opaque "Server
 * Error". Mutation writes roll back when we throw the fallback error, so this
 * helper cannot durably write `clientLogs`; actions should use
 * {@link withUserFacingActionErrors} for durable triage telemetry.
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
    const errorDetail = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    console.error(
      `[${context}] unexpected error:`,
      errorDetail,
      error instanceof Error ? error.stack : '',
    )
    throw new ConvexError(fallbackMessage)
  }
}

/**
 * Action-context counterpart to {@link withUserFacingErrors}. Actions can't
 * write to the DB directly, so the unexpected error is recorded into
 * `clientLogs` via the `recordServerEvent` internal mutation.
 */
export async function withUserFacingActionErrors<T>(
  ctx: ActionCtx,
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
    try {
      await ctx.runMutation(internal.serverTelemetry.recordServerEvent, {
        level: 'error',
        event: `server:error:${context}`,
        message: error instanceof Error ? error.message : String(error),
        data: serializeServerLogData({
          context,
          stack: error instanceof Error ? error.stack : undefined,
        }),
      })
    } catch {
      // Best-effort telemetry; never mask the original failure path.
    }
    throw new ConvexError(fallbackMessage)
  }
}

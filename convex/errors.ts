import { ConvexError } from 'convex/values'
import { internal } from './_generated/api'
import type { ActionCtx, MutationCtx } from './_generated/server'
import { logServerEvent } from './serverTelemetry'

export function throwUserError(message: string): never {
  throw new ConvexError(message)
}

/**
 * Runs a mutation handler body and guarantees the client never receives a raw,
 * unactionable "Server Error" (HTTP 500). Expected, user-facing failures thrown
 * via {@link throwUserError} (i.e. `ConvexError`s) pass through unchanged. Any
 * other (unexpected) throw is logged — both to the Convex deployment console and
 * to the `clientLogs` triage table (with the real message + stack) — and then
 * re-surfaced as a clean `ConvexError` carrying `fallbackMessage`.
 *
 * Without this, an unexpected throw reaches the client as an opaque "Server
 * Error" and the real cause exists only in ephemeral deployment logs. Surfacing
 * it into `clientLogs` means triage sees the actual failure.
 */
export async function withUserFacingErrors<T>(
  ctx: MutationCtx,
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
    await logServerEvent(ctx, {
      level: 'error',
      event: `server:error:${context}`,
      message: error instanceof Error ? error.message : String(error),
      data: { context, stack: error instanceof Error ? error.stack : undefined },
    })
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
        data: { context, stack: error instanceof Error ? error.stack : undefined },
      })
    } catch {
      // Best-effort telemetry; never mask the original failure path.
    }
    throw new ConvexError(fallbackMessage)
  }
}

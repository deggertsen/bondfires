import type { Href } from 'expo-router'
import { createRespondToPath, routes } from './routes'

/**
 * Client mirror of the server participation rule (`assertUserCanParticipateInCamp`
 * in convex/videos.ts): a camp response requires `campMembers.status === 'active'`.
 * Anything else, including no membership row, is rejected at upload time with
 * "Join this camp before sparking here". An invite claim does NOT satisfy it, so
 * callers must pass the membership row's status, never `hasInviteClaim`.
 *
 * Hearth / personal bondfires carry no `campId` and are not camp responses.
 * Archived camps are handled separately by the playback screen's `canRespond`.
 */
export type RespondGateDecision = { kind: 'respond' } | { kind: 'join'; campId: string }

export function decideRespondGate(input: {
  campId: string | null | undefined
  /** Resolved membership status. `null`/`undefined` means no membership row. */
  membershipStatus: string | null | undefined
}): RespondGateDecision {
  if (!input.campId) return { kind: 'respond' }
  if (input.membershipStatus === 'active') return { kind: 'respond' }
  return { kind: 'join', campId: input.campId }
}

/**
 * Where a Respond press should navigate. A `join` decision opens the existing
 * full-screen camp join gate with the respond recorder as its post-join
 * redirect, so an open-camp join continues into the recording the user asked
 * for. Approval and invite-only camps never reach that redirect.
 */
export function respondGateHref(bondfireId: string, decision: RespondGateDecision): Href {
  if (decision.kind === 'join') {
    return routes.campJoinGate(decision.campId, createRespondToPath(bondfireId))
  }
  return routes.createRespondTo(bondfireId)
}

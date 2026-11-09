import type { Doc } from '../../../convex/_generated/dataModel'
import { isCampParticipableStatus } from '../../../convex/campLifecycle'

type RespondContext = {
  bondfire: { campId?: string }
  camp: { status: Doc<'camps'>['status'] } | null
  membership: { status: string } | null
}

export type RespondGateDecision =
  | { kind: 'loading' }
  | { kind: 'unavailable' }
  | { kind: 'respond' }
  | { kind: 'join'; campId: string }

// A missing/inaccessible bondfire is not a Hearth fire. Wait for the query and
// require a visible target before deciding whether camp membership is needed.
export function decideRespondGate(context: RespondContext | null | undefined): RespondGateDecision {
  if (context === undefined) return { kind: 'loading' }
  if (context === null) return { kind: 'unavailable' }
  const campId = context.bondfire.campId
  if (!campId) return { kind: 'respond' }
  if (!context.camp || !isCampParticipableStatus(context.camp.status)) {
    return { kind: 'unavailable' }
  }
  // Invite claims grant viewing access, not permission to upload a response.
  if (context.membership?.status === 'active') return { kind: 'respond' }
  return { kind: 'join', campId }
}

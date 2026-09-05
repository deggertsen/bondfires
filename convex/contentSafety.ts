import type { Doc, Id } from './_generated/dataModel'
import type { MutationCtx, QueryCtx } from './_generated/server'
import { throwUserError } from './errors'

export const CURRENT_TERMS_VERSION = '2026-08-31'
export const CURRENT_COMMUNITY_GUIDELINES_VERSION = '2026-08-31'

type DbCtx = QueryCtx | MutationCtx

export function hasCurrentLegalAcceptance(user: Doc<'users'> | null): boolean {
  return (
    !!user &&
    user.acceptedTermsVersion === CURRENT_TERMS_VERSION &&
    user.acceptedCommunityGuidelinesVersion === CURRENT_COMMUNITY_GUIDELINES_VERSION
  )
}

export async function requireUgcPermission(ctx: DbCtx, userId: Id<'users'>) {
  const user = await ctx.db.get(userId)
  if (!user) throwUserError('User not found')
  if (user.moderationStatus === 'suspended') {
    throwUserError('Your account is suspended from posting. Contact safety@bondfires.org.')
  }
  if (!hasCurrentLegalAcceptance(user)) {
    throwUserError('Accept the current Terms and Community Guidelines before posting')
  }
  return user
}

export function initialModerationStatus(
  camp: Doc<'camps'> | null,
  personalCamp: boolean,
): 'pending_review' | 'approved' {
  // Publicly discoverable UGC is held for human review. Invite-only and Hearth
  // content stays private-by-membership and is immediately available to its
  // intended participants, while remaining reportable and blockable.
  if (!personalCamp && camp && (camp.access === 'open' || camp.access === 'approval')) {
    return 'pending_review'
  }
  return 'approved'
}

export function isModeratedContentVisible(
  status: 'pending_review' | 'approved' | 'removed' | undefined,
  args: { isOwner: boolean; isAdmin: boolean },
) {
  if (status === 'removed') return args.isOwner || args.isAdmin
  if (status === 'pending_review') return args.isOwner || args.isAdmin
  return true
}

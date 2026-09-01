import { mutation, query } from './_generated/server'
import { auth } from './auth'
import {
  CURRENT_COMMUNITY_GUIDELINES_VERSION,
  CURRENT_TERMS_VERSION,
  hasCurrentLegalAcceptance,
} from './contentSafety'
import { throwUserError } from './errors'

export const getAcceptanceStatus = query({
  args: {},
  handler: async (ctx) => {
    const userId = await auth.getUserId(ctx)
    if (!userId) return null
    const user = await ctx.db.get(userId)
    return {
      accepted: hasCurrentLegalAcceptance(user),
      termsVersion: CURRENT_TERMS_VERSION,
      communityGuidelinesVersion: CURRENT_COMMUNITY_GUIDELINES_VERSION,
      acceptedAt: user?.legalAcceptedAt,
    }
  },
})

export const acceptCurrent = mutation({
  args: {},
  handler: async (ctx) => {
    const userId = await auth.getUserId(ctx)
    if (!userId) throwUserError('Not authenticated')
    const now = Date.now()
    await ctx.db.patch(userId, {
      acceptedTermsVersion: CURRENT_TERMS_VERSION,
      acceptedCommunityGuidelinesVersion: CURRENT_COMMUNITY_GUIDELINES_VERSION,
      legalAcceptedAt: now,
      updatedAt: now,
    })
    return { acceptedAt: now }
  },
})

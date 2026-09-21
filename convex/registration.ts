import { v } from 'convex/values'
import { internalQuery, mutation, query } from './_generated/server'
import { getUserIdIncludingDeleting } from './auth'
import { hasCurrentLegalAcceptance } from './contentSafety'
import { throwUserError } from './errors'
import { registrationProfile, canUseApp as userCanUseApp } from './lib/registrationPolicy'

export const canUseApp = internalQuery({
  args: { userId: v.id('users') },
  handler: async (ctx, { userId }) => userCanUseApp(await ctx.db.get(userId)),
})

export const status = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getUserIdIncludingDeleting(ctx)
    const user = userId ? await ctx.db.get(userId) : null
    if (!user || user.accountDeletionStatus) return null
    return {
      pending: user.registrationPending === true,
      firstName: user.firstName ?? '',
      lastName: user.lastName ?? '',
      email: user.email ?? '',
      gender: user.registrationPending ? undefined : user.gender,
      birthDate: user.birthDate ?? '',
      acceptedLegal: hasCurrentLegalAcceptance(user),
    }
  },
})

export const complete = mutation({
  args: {
    firstName: v.string(),
    lastName: v.string(),
    gender: v.union(v.literal('male'), v.literal('female'), v.literal('other')),
    birthDate: v.string(),
    acceptedLegal: v.boolean(),
  },
  handler: async (ctx, args) => {
    const userId = await getUserIdIncludingDeleting(ctx)
    const user = userId ? await ctx.db.get(userId) : null
    if (!user || user.accountDeletionStatus) throwUserError('Not authenticated')
    // Completion is one-time and retry-safe; it cannot change an existing DOB.
    if (user.registrationPending !== true) return
    let profile: ReturnType<typeof registrationProfile>
    try {
      profile = registrationProfile(args)
    } catch (error) {
      throwUserError(error instanceof Error ? error.message : 'Invalid registration details')
    }
    await ctx.db.patch(user._id, { ...profile, updatedAt: Date.now() })
  },
})

export const providers = query({
  args: {},
  handler: () => ({
    google: !!(process.env.AUTH_GOOGLE_ID && process.env.AUTH_GOOGLE_SECRET),
    apple: !!(process.env.AUTH_APPLE_ID && process.env.AUTH_APPLE_SECRET),
  }),
})

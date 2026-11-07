import { v } from 'convex/values'
import { internalQuery, mutation, query } from './_generated/server'
import { getUserIdIncludingDeleting } from './auth'
import { hasCurrentLegalAcceptance } from './contentSafety'
import { throwUserError } from './errors'
import {
  deviceAgeRecheckPatch,
  registrationProfile,
  canUseApp as userCanUseApp,
} from './lib/registrationPolicy'

// Client-reported device range (Apple Declared Age Range / Play Age Signals).
// Same trust level as a client-sent birth date; it is not identity verification.
const deviceAgeRange = v.object({
  source: v.union(v.literal('apple_declared_age_range'), v.literal('play_age_signals')),
  lowerBound: v.optional(v.union(v.number(), v.null())),
  upperBound: v.optional(v.union(v.number(), v.null())),
})

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
      userId: user._id,
      pending: user.registrationPending === true,
      firstName: user.firstName ?? '',
      lastName: user.lastName ?? '',
      email: user.email ?? '',
      gender: user.registrationPending ? undefined : user.gender,
      acceptedLegal: hasCurrentLegalAcceptance(user),
      // Older app versions prefill their birth date field from this and call
      // .trim() on it. Always empty: full birth dates are never sent back.
      birthDate: '',
      ageSource: user.ageSource,
      // Only accounts without a legacy full birth date re-check the device.
      deviceAgeRecheck: user.registrationPending !== true && !user.birthDate,
      deviceAgeCheckedAt: user.deviceAgeCheckedAt,
      ageBlocked: !!user.ageBlockedAt,
      ageBlockedReason: user.ageBlockedAt ? (user.ageBlockedReason ?? 'under_13') : undefined,
    }
  },
})

export const complete = mutation({
  args: {
    firstName: v.string(),
    lastName: v.string(),
    gender: v.union(v.literal('male'), v.literal('female'), v.literal('other')),
    // Phone-first: a device range decides alone; otherwise YYYY-MM is required.
    birthMonth: v.optional(v.string()),
    // Sent only by app versions released before device age ranges (1.0.108
    // and earlier). Reduced to YYYY-MM; a full date is never stored.
    birthDate: v.optional(v.string()),
    deviceAgeRange: v.optional(deviceAgeRange),
    acceptedLegal: v.boolean(),
  },
  handler: async (ctx, args) => {
    const userId = await getUserIdIncludingDeleting(ctx)
    const user = userId ? await ctx.db.get(userId) : null
    if (!user || user.accountDeletionStatus) throwUserError('Not authenticated')
    // Completion is one-time and retry-safe; it cannot change stored age data.
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

/**
 * Launch / foreground device re-check for completed accounts. Lets a 17-year-old
 * become an adult without storing a birthday and blocks a later under-13
 * result. An adult account never moves to the teen band; a teen range blocks it
 * so the person starts over with a teen account. Never sets or clears
 * a legacy birthDate and never accepts a month.
 * Blocked accounts may still call this so a later eligible range can restore
 * access; nothing else can.
 */
export const recheckDeviceAge = mutation({
  args: { expectedUserId: v.id('users'), deviceAgeRange },
  handler: async (ctx, args) => {
    const userId = await getUserIdIncludingDeleting(ctx)
    const user = userId ? await ctx.db.get(userId) : null
    if (!user || user.accountDeletionStatus) throwUserError('Not authenticated')
    // Native prompts and queued mutations can outlive the session that started
    // them. Never apply an earlier account's response to a new session.
    if (user._id !== args.expectedUserId) throwUserError('Account changed. Please try again.')
    const { status, patch } = deviceAgeRecheckPatch(user, args.deviceAgeRange)
    if (status !== 'skipped') await ctx.db.patch(user._id, patch)
    return { status }
  },
})

export const providers = query({
  args: {},
  handler: () => ({
    google: !!(process.env.AUTH_GOOGLE_ID && process.env.AUTH_GOOGLE_SECRET),
    apple: !!(process.env.AUTH_APPLE_ID && process.env.AUTH_APPLE_SECRET),
  }),
})

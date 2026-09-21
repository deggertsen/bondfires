import type { ConvexAuthConfig } from '@convex-dev/auth/server'
import type { MutationCtx } from '../_generated/server'

// Explicit mappings avoid unsupported `image` fields and preserve provider
// identity separately from editable names/email in the application profile.
export function googleProfile(profile: {
  sub: string
  email?: string
  email_verified?: boolean
  hd?: string
  given_name?: string
  family_name?: string
}) {
  if (!profile.email || profile.email_verified !== true) {
    throw new Error('Google must provide a verified email address.')
  }
  return {
    id: profile.sub,
    email: profile.email,
    // Google is not authoritative for third-party mailbox ownership. Such
    // identities may sign in, but must never auto-link by that email.
    emailVerified: profile.email.toLowerCase().endsWith('@gmail.com') || !!profile.hd,
    ...(profile.given_name ? { firstName: profile.given_name } : {}),
    ...(profile.family_name ? { lastName: profile.family_name } : {}),
  }
}

export function appleProfile(
  profile: {
    sub: string
    email?: string
    email_verified?: boolean | string
    user?: { name?: { firstName?: string; lastName?: string } }
  },
  tokens: { refresh_token?: string },
) {
  if (!profile.email || ![true, 'true'].includes(profile.email_verified ?? false)) {
    throw new Error('Apple must provide a verified email address.')
  }
  return {
    id: profile.sub,
    email: profile.email,
    emailVerified: true,
    ...(profile.user?.name?.firstName ? { firstName: profile.user.name.firstName } : {}),
    ...(profile.user?.name?.lastName ? { lastName: profile.user.name.lastName } : {}),
    ...(tokens.refresh_token ? { appleRefreshToken: tokens.refresh_token } : {}),
  }
}

type UserArgs = Parameters<
  NonNullable<NonNullable<ConvexAuthConfig['callbacks']>['createOrUpdateUser']>
>[1]
export async function createOrUpdateAuthUser(ctx: MutationCtx, args: UserArgs) {
  const { profile, provider } = args
  const social = args.type === 'oauth'
  const verified = profile.emailVerified === true
  let userId = args.existingUserId

  // Password signup can link only because this provider always requires a
  // fresh emailed code before issuing a session, including for linked users.
  if (!userId && profile.email && (verified || provider.id === 'password')) {
    const matches = await ctx.db
      .query('users')
      .withIndex('email', (q) => q.eq('email', profile.email))
      .filter((q) => q.neq(q.field('emailVerificationTime'), undefined))
      .take(2)
    if (matches.length > 1) throw new Error('Multiple accounts use this email. Contact support.')
    userId = matches[0]?._id ?? null
  }

  if (userId) {
    const user = await ctx.db.get(userId)
    if (!user || user.accountDeletionStatus) throw new Error('This account is being deleted.')
    // Never overwrite a completed profile, age, legal acceptance, or moderation
    // state on login/linking/reset. Verification only updates verification.
    if (verified && user.email === profile.email) {
      await ctx.db.patch(userId, {
        emailVerificationTime: user.emailVerificationTime ?? Date.now(),
        emailVerified: true,
      })
    }
  } else {
    if (!social && provider.id !== 'password') throw new Error('Unsupported signup method')
    userId = await ctx.db.insert('users', {
      email: profile.email,
      ...(verified ? { emailVerificationTime: Date.now(), emailVerified: true } : {}),
      firstName: typeof profile.firstName === 'string' ? profile.firstName : undefined,
      lastName: typeof profile.lastName === 'string' ? profile.lastName : undefined,
      name: typeof profile.name === 'string' ? profile.name : undefined,
      gender:
        !social && (profile.gender === 'male' || profile.gender === 'female')
          ? profile.gender
          : 'other',
      registrationPending: social,
      ...(!social
        ? {
            birthDate: profile.birthDate as string,
            acceptedTermsVersion: profile.acceptedTermsVersion as string,
            acceptedCommunityGuidelinesVersion:
              profile.acceptedCommunityGuidelinesVersion as string,
            legalAcceptedAt: profile.legalAcceptedAt as number,
          }
        : {}),
      moderationStatus: 'active',
      createdAt: Date.now(),
    })
  }
  if (provider.id === 'apple' && typeof profile.appleRefreshToken === 'string') {
    const credential = await ctx.db
      .query('oauthCredentials')
      .withIndex('by_user', (q) => q.eq('userId', userId))
      .unique()
    if (credential) await ctx.db.patch(credential._id, { refreshToken: profile.appleRefreshToken })
    else
      await ctx.db.insert('oauthCredentials', { userId, refreshToken: profile.appleRefreshToken })
  }
  return userId
}

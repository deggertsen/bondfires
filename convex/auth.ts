import Apple from '@auth/core/providers/apple'
import Google from '@auth/core/providers/google'
import Resend from '@auth/core/providers/resend'
import { Password } from '@convex-dev/auth/providers/Password'
import { convexAuth } from '@convex-dev/auth/server'
import { internal } from './_generated/api'
import type { Id } from './_generated/dataModel'
import type { ActionCtx, MutationCtx, QueryCtx } from './_generated/server'
import { appleProfile, createOrUpdateAuthUser, googleProfile } from './lib/authProfiles'
import { authRedirect, canUseApp, registrationProfile } from './lib/registrationPolicy'

const DEFAULT_EMAIL_FROM = 'Bondfires <support@bondfires.org>'
const VERIFY_EMAIL_SUBJECT = 'Verify your Bondfires account'
const RESET_PASSWORD_SUBJECT = 'Reset your Bondfires password'

// Generate a 6-digit numeric OTP using crypto for security
function generateOTP(): string {
  // Use crypto.getRandomValues for secure random numbers
  const array = new Uint32Array(1)
  crypto.getRandomValues(array)
  // Get a 6-digit number (000000 to 999999)
  const code = (array[0] % 1000000).toString().padStart(6, '0')
  return code
}

// Custom Resend email provider for OTP verification
const ResendOTP = Resend({
  id: 'resend-otp',
  apiKey: process.env.RESEND_API_KEY,
  from: process.env.EMAIL_FROM ?? DEFAULT_EMAIL_FROM,
  maxAge: 15 * 60, // 15 minutes
  // Generate 6-digit numeric OTP instead of long secure token
  generateVerificationToken: generateOTP,
  // Custom email template with OTP code
  async sendVerificationRequest({ identifier: email, token }) {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: process.env.EMAIL_FROM ?? DEFAULT_EMAIL_FROM,
        to: email,
        subject: VERIFY_EMAIL_SUBJECT,
        html: `
          <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
            <h1 style="color: #FF6B35; margin-bottom: 24px;">Bondfires</h1>
            <p style="font-size: 16px; color: #333;">Welcome to Bondfires!</p>
            <p style="font-size: 16px; color: #333;">Please verify your email address by entering this code:</p>
            <div style="background: #f5f5f5; padding: 20px; border-radius: 8px; text-align: center; margin: 24px 0;">
              <span style="font-size: 32px; font-weight: bold; letter-spacing: 4px; color: #FF6B35;">${token}</span>
            </div>
            <p style="font-size: 14px; color: #666;">This code expires in 15 minutes.</p>
            <p style="font-size: 14px; color: #666;">If you didn't create a Bondfires account, you can safely ignore this email.</p>
          </div>
        `,
        text: `Your Bondfires verification code is: ${token}. This code expires in 15 minutes.`,
      }),
    })

    if (!res.ok) {
      const error = await res.text()
      throw new Error(`Failed to send verification email: ${error}`)
    }
  },
})

// Custom Resend email provider for password reset
const ResendPasswordReset = Resend({
  id: 'resend-password-reset',
  apiKey: process.env.RESEND_API_KEY,
  from: process.env.EMAIL_FROM ?? DEFAULT_EMAIL_FROM,
  maxAge: 15 * 60, // 15 minutes
  // Generate 6-digit numeric OTP for password reset
  generateVerificationToken: generateOTP,
  // Custom email template for password reset
  async sendVerificationRequest({ identifier: email, token }) {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: process.env.EMAIL_FROM ?? DEFAULT_EMAIL_FROM,
        to: email,
        subject: RESET_PASSWORD_SUBJECT,
        html: `
          <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
            <h1 style="color: #FF6B35; margin-bottom: 24px;">Bondfires</h1>
            <p style="font-size: 16px; color: #333;">We received a request to reset your password.</p>
            <p style="font-size: 16px; color: #333;">Use this code to set a new password:</p>
            <div style="background: #f5f5f5; padding: 20px; border-radius: 8px; text-align: center; margin: 24px 0;">
              <span style="font-size: 32px; font-weight: bold; letter-spacing: 4px; color: #FF6B35;">${token}</span>
            </div>
            <p style="font-size: 14px; color: #666;">This code expires in 15 minutes.</p>
            <p style="font-size: 14px; color: #666;">If you didn't request a password reset, you can safely ignore this email.</p>
          </div>
        `,
        text: `Your Bondfires password reset code is: ${token}. This code expires in 15 minutes.`,
      }),
    })

    if (!res.ok) {
      const error = await res.text()
      throw new Error(`Failed to send password reset email: ${error}`)
    }
  },
})

// Password provider with email verification, password reset, and profile support
const PasswordWithVerification = Password({
  // Profile fields to include when creating a user.
  // Only requires birthDate during signUp flow.
  profile(params) {
    const email = typeof params.email === 'string' ? params.email.trim() : ''
    if (!email) throw new Error('Email is required')
    return params.flow === 'signUp'
      ? { email, ...registrationProfile(params), moderationStatus: 'active' }
      : { email }
  },
  // Require email verification before allowing sign in
  verify: ResendOTP,
  // Enable password reset via email
  reset: ResendPasswordReset,
})

const authBackend = convexAuth({
  providers: [
    PasswordWithVerification,
    ...(process.env.AUTH_GOOGLE_ID && process.env.AUTH_GOOGLE_SECRET
      ? [Google({ profile: googleProfile })]
      : []),
    ...(process.env.AUTH_APPLE_ID && process.env.AUTH_APPLE_SECRET
      ? [Apple({ profile: appleProfile })]
      : []),
  ],
  callbacks: {
    redirect: async ({ redirectTo }) => authRedirect(redirectTo),
    createOrUpdateUser: (ctx, args) => createOrUpdateAuthUser(ctx as MutationCtx, args),
  },
})

export const { signIn, signOut, store } = authBackend

// Registration/current-user reads need the identity before completion, and
// account deletion needs it after its tombstone commits for safe retries.
// All normal application operations must use the filtered `auth` export below.
export const getUserIdIncludingDeleting = authBackend.auth.getUserId

// Convex Auth JWTs can remain cryptographically valid briefly after their
// refresh session is revoked. Make the deletion tombstone authoritative for
// every query, mutation and action. Pending registrations are also denied
// normal app access until the shared completion mutation succeeds.
export const auth = {
  ...authBackend.auth,
  getUserId: async (ctx: QueryCtx | MutationCtx | ActionCtx): Promise<Id<'users'> | null> => {
    const userId = await getUserIdIncludingDeleting(ctx)
    if (!userId) return null
    const eligible =
      'db' in ctx
        ? canUseApp(await ctx.db.get(userId))
        : await ctx.runQuery(internal.registration.canUseApp, { userId })
    return eligible ? userId : null
  },
}

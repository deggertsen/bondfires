import { convexAuth } from '@convex-dev/auth/server'
import { Password } from '@convex-dev/auth/providers/Password'

export const { auth, signIn, signOut, store } = convexAuth({
  providers: [
    Password({
      // Enable email verification
      verify: async ({ email }) => {
        // In production, send verification email
        // For now, we'll auto-verify
        console.log(`Verification email would be sent to: ${email}`)
      },
      // Password reset
      reset: async ({ email }) => {
        // In production, send password reset email
        console.log(`Password reset email would be sent to: ${email}`)
      },
    }),
  ],
})


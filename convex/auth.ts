import { convexAuth } from '@convex-dev/auth/server'
import { Password } from '@convex-dev/auth/providers/Password'

// Password provider with profile support
const PasswordWithProfile = Password({
  // Profile fields to include when creating a user
  profile(params) {
    return {
      name: params.name as string ?? null,
      email: params.email as string,
    }
  },
})

export const { auth, signIn, signOut, store } = convexAuth({
  providers: [
    PasswordWithProfile,
  ],
})


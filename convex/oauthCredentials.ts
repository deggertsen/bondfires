import { v } from 'convex/values'
import { internal } from './_generated/api'
import { internalAction, internalMutation, internalQuery } from './_generated/server'

export const forDeletion = internalQuery({
  args: { userId: v.id('users') },
  handler: async (ctx, { userId }) => {
    const user = await ctx.db.get(userId)
    if (!user?.accountDeletionStatus) return null
    return await ctx.db
      .query('oauthCredentials')
      .withIndex('by_user', (q) => q.eq('userId', userId))
      .unique()
  },
})
export const remove = internalMutation({
  args: { credentialId: v.id('oauthCredentials') },
  handler: async (ctx, { credentialId }) => {
    await ctx.db.delete(credentialId)
  },
})

// Runs before deleting the user. Failure uses the existing durable deletion
// retry queue, retaining the token until Apple accepts revocation.
export const revokeForDeletion = internalAction({
  args: { userId: v.id('users') },
  handler: async (ctx, args) => {
    const credential = await ctx.runQuery(internal.oauthCredentials.forDeletion, args)
    if (!credential) return
    const clientId = process.env.AUTH_APPLE_ID
    const clientSecret = process.env.AUTH_APPLE_SECRET
    if (!clientId || !clientSecret) throw new Error('Apple revocation configuration missing')
    const response = await fetch('https://appleid.apple.com/auth/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        token: credential.refreshToken,
        token_type_hint: 'refresh_token',
      }),
      signal: AbortSignal.timeout(15_000),
    })
    // Never include provider bodies or credentials in errors/logs.
    if (!response.ok) throw new Error(`Apple revocation failed (${response.status})`)
    await ctx.runMutation(internal.oauthCredentials.remove, { credentialId: credential._id })
  },
})

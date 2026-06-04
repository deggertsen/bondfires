import { v } from 'convex/values'
import type { MutationCtx, QueryCtx } from './_generated/server'
import { mutation } from './_generated/server'
import { auth } from './auth'
import { throwUserError } from './errors'

export const ACCENT_PALETTE = [
  '#FF6B35',
  '#E63946',
  '#F4A261',
  '#2A9D8F',
  '#264653',
  '#6C63FF',
  '#E9C46A',
  '#457B9D',
  '#1D3557',
  '#A8DADC',
] as const

type AccentColor = (typeof ACCENT_PALETTE)[number]

function isValidAccentColor(color: string): color is AccentColor {
  return (ACCENT_PALETTE as readonly string[]).includes(color)
}

async function getCurrentUser(ctx: QueryCtx | MutationCtx) {
  const userId = await auth.getUserId(ctx)
  if (!userId) {
    throwUserError('Not authenticated')
  }

  const user = await ctx.db.get(userId)
  if (!user) {
    throwUserError('User not found')
  }

  return user
}

export const updateCampBranding = mutation({
  args: {
    campId: v.id('camps'),
    coverImageUrl: v.optional(v.string()),
    accentColor: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx)

    const camp = await ctx.db.get(args.campId)
    if (!camp) {
      throwUserError('Camp not found')
    }

    // Only the owner can update branding
    if (camp.ownerId !== user._id) {
      throwUserError('Only the camp owner can update branding')
    }

    // Validate accentColor against the approved palette
    if (args.accentColor !== undefined && !isValidAccentColor(args.accentColor)) {
      throwUserError(`Invalid accent color. Must be one of: ${ACCENT_PALETTE.join(', ')}`)
    }

    // Patch the camp with branding fields
    const patch: Partial<{ coverImageUrl: string; accentColor: string; updatedAt: number }> = {
      updatedAt: Date.now(),
    }

    if (args.coverImageUrl !== undefined) {
      patch.coverImageUrl = args.coverImageUrl
    }

    if (args.accentColor !== undefined) {
      patch.accentColor = args.accentColor
    }

    await ctx.db.patch(args.campId, patch)

    return args.campId
  },
})

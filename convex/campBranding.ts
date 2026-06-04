import { v } from 'convex/values'
import type { Id } from './_generated/dataModel'
import type { MutationCtx } from './_generated/server'
import { mutation } from './_generated/server'
import { auth } from './auth'
import { throwUserError } from './errors'

export const ACCENT_PALETTE = [
  '#FF6B35', // Flame orange
  '#E63946', // Ember red
  '#F4A261', // Warm sand
  '#2A9D8F', // Deep teal
  '#264653', // Dark slate
  '#6C63FF', // Indigo spark
  '#E9C46A', // Golden hour
  '#457B9D', // Cool blue
  '#1D3557', // Midnight
  '#A8DADC', // Soft sky
] as const

type AccentColor = (typeof ACCENT_PALETTE)[number]

function isValidAccentColor(color: string): color is AccentColor {
  return (ACCENT_PALETTE as readonly string[]).includes(color)
}

async function requireCampOwner(ctx: MutationCtx, campId: Id<'camps'>) {
  const userId = await auth.getUserId(ctx)
  if (!userId) {
    throwUserError('Not authenticated')
  }

  const camp = await ctx.db.get(campId)
  if (!camp) {
    throwUserError('Camp not found')
  }

  if (camp.ownerId !== userId) {
    throwUserError('Only the camp owner can update branding')
  }

  return { userId, camp }
}

/** Generate a presigned upload URL for a camp cover image. */
export const generateCampCoverUploadUrl = mutation({
  args: {
    campId: v.id('camps'),
  },
  handler: async (ctx, args) => {
    await requireCampOwner(ctx, args.campId)
    return await ctx.storage.generateUploadUrl()
  },
})

/** Link an uploaded cover image to a camp. */
export const updateCampCoverImage = mutation({
  args: {
    campId: v.id('camps'),
    storageId: v.id('_storage'),
  },
  handler: async (ctx, args) => {
    const { camp } = await requireCampOwner(ctx, args.campId)

    const coverImageUrl = await ctx.storage.getUrl(args.storageId)
    if (!coverImageUrl) {
      throwUserError('Uploaded cover image not found')
    }

    // Delete old cover image if present
    if (camp.coverImageStorageId) {
      await ctx.storage.delete(camp.coverImageStorageId)
    }

    await ctx.db.patch(args.campId, {
      coverImageUrl,
      coverImageStorageId: args.storageId,
      updatedAt: Date.now(),
    })

    return { coverImageUrl }
  },
})

/** Update camp accent color. Validated against the approved palette. */
export const updateCampBranding = mutation({
  args: {
    campId: v.id('camps'),
    accentColor: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireCampOwner(ctx, args.campId)

    if (args.accentColor !== undefined && !isValidAccentColor(args.accentColor)) {
      throwUserError(`Invalid accent color. Must be one of: ${ACCENT_PALETTE.join(', ')}`)
    }

    const patch: Record<string, unknown> = {
      updatedAt: Date.now(),
    }

    if (args.accentColor !== undefined) {
      patch.accentColor = args.accentColor
    }

    await ctx.db.patch(args.campId, patch)

    return args.campId
  },
})

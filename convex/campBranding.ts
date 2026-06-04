import { v } from 'convex/values'
import type { Id } from './_generated/dataModel'
import type { MutationCtx } from './_generated/server'
import { mutation } from './_generated/server'
import { auth } from './auth'
import { ACCENT_PALETTE, type AccentColor, COVER_IMAGE_MAX_BYTES } from './campBrandingConstants'
import { getEntitlementSubscriptionTier, TIER_RANK } from './entitlements'
import { throwUserError } from './errors'

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

  const tier = await getEntitlementSubscriptionTier(ctx, userId)
  if (TIER_RANK[tier] < TIER_RANK.pro) {
    throwUserError('Camp branding is only available for Pro subscribers')
  }

  return { userId, camp }
}

async function validateCoverImage(ctx: MutationCtx, storageId: Id<'_storage'>) {
  const metadata = await ctx.storage.getMetadata(storageId)
  if (!metadata) {
    throwUserError('Uploaded cover image not found')
  }

  if (!metadata.contentType?.startsWith('image/')) {
    await ctx.storage.delete(storageId)
    throwUserError('Cover image must be an image file')
  }

  if (metadata.size > COVER_IMAGE_MAX_BYTES) {
    await ctx.storage.delete(storageId)
    throwUserError('Cover image must be 5MB or smaller')
  }

  const coverImageUrl = await ctx.storage.getUrl(storageId)
  if (!coverImageUrl) {
    throwUserError('Uploaded cover image not found')
  }

  return coverImageUrl
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

    const coverImageUrl = await validateCoverImage(ctx, args.storageId)

    await ctx.db.patch(args.campId, {
      coverImageUrl,
      coverImageStorageId: args.storageId,
      updatedAt: Date.now(),
    })

    if (camp.coverImageStorageId && camp.coverImageStorageId !== args.storageId) {
      await ctx.storage.delete(camp.coverImageStorageId)
    }

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

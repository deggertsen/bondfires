import { v } from 'convex/values'
import type { Id } from './_generated/dataModel'
import type { MutationCtx } from './_generated/server'
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

async function getCurrentUserId(ctx: MutationCtx) {
  const userId = await auth.getUserId(ctx)
  if (!userId) {
    throwUserError('Not authenticated')
  }

  return userId
}

export const generateCampCoverImageUploadUrl = mutation({
  args: {},
  handler: async (ctx) => {
    await getCurrentUserId(ctx)
    return await ctx.storage.generateUploadUrl()
  },
})

type CampBrandingPatch = {
  coverImageUrl?: string | undefined
  coverImageStorageId?: Id<'_storage'> | undefined
  accentColor?: string | undefined
  updatedAt: number
}

export const updateCampBranding = mutation({
  args: {
    campId: v.id('camps'),
    coverImageUrl: v.optional(v.union(v.string(), v.null())),
    coverImageStorageId: v.optional(v.union(v.id('_storage'), v.null())),
    accentColor: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, args) => {
    const userId = await getCurrentUserId(ctx)

    const camp = await ctx.db.get(args.campId)
    if (!camp) {
      throwUserError('Camp not found')
    }

    if (camp.ownerId !== userId) {
      throwUserError('Only the camp owner can update branding')
    }

    if (
      args.accentColor !== undefined &&
      args.accentColor !== null &&
      !isValidAccentColor(args.accentColor)
    ) {
      throwUserError(`Invalid accent color. Must be one of: ${ACCENT_PALETTE.join(', ')}`)
    }

    if (args.coverImageUrl !== undefined && args.coverImageStorageId !== undefined) {
      throwUserError('Provide either coverImageUrl or coverImageStorageId, not both')
    }

    const patch: CampBrandingPatch = {
      updatedAt: Date.now(),
    }
    let storageIdToDelete: Id<'_storage'> | undefined

    if (args.coverImageUrl !== undefined) {
      patch.coverImageUrl = args.coverImageUrl ?? undefined
      patch.coverImageStorageId = undefined
      storageIdToDelete = camp.coverImageStorageId
    }

    if (args.coverImageStorageId !== undefined) {
      if (args.coverImageStorageId === null) {
        patch.coverImageUrl = undefined
        patch.coverImageStorageId = undefined
        storageIdToDelete = camp.coverImageStorageId
      } else {
        const coverImageUrl = await ctx.storage.getUrl(args.coverImageStorageId)
        if (!coverImageUrl) {
          throwUserError('Uploaded cover image not found')
        }

        patch.coverImageUrl = coverImageUrl
        patch.coverImageStorageId = args.coverImageStorageId
        if (camp.coverImageStorageId !== args.coverImageStorageId) {
          storageIdToDelete = camp.coverImageStorageId
        }
      }
    }

    if (args.accentColor !== undefined) {
      patch.accentColor = args.accentColor ?? undefined
    }

    await ctx.db.patch(args.campId, patch)

    if (storageIdToDelete) {
      await ctx.storage.delete(storageIdToDelete)
    }

    return args.campId
  },
})

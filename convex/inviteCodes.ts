import { v } from 'convex/values'
import type { Id } from './_generated/dataModel'
import type { MutationCtx, QueryCtx } from './_generated/server'
import { internalMutation, mutation, query } from './_generated/server'
import { auth } from './auth'
import { throwUserError } from './errors'

// ── Constants ──────────────────────────────────────────────────────────────

/** Consolidated word list from both old systems (camps + personalBondfires). */
const INVITE_WORDS = [
  'amber',
  'ash',
  'aurora',
  'basin',
  'beacon',
  'birch',
  'blaze',
  'bloom',
  'branch',
  'bright',
  'brook',
  'cairn',
  'canyon',
  'cedar',
  'cliff',
  'cloud',
  'coast',
  'copper',
  'dawn',
  'drift',
  'echo',
  'ember',
  'fern',
  'field',
  'flint',
  'forge',
  'frost',
  'glade',
  'gold',
  'grove',
  'harbor',
  'hearth',
  'hill',
  'hollow',
  'iron',
  'kindle',
  'lake',
  'lantern',
  'leaf',
  'maple',
  'meadow',
  'mesa',
  'mist',
  'moon',
  'north',
  'oak',
  'pine',
  'prairie',
  'rain',
  'ridge',
  'river',
  'root',
  'shade',
  'shore',
  'signal',
  'silver',
  'south',
  'spark',
  'spring',
  'star',
  'stone',
  'summit',
  'thicket',
  'timber',
  'torch',
  'trail',
  'valley',
  'watch',
  'west',
  'wild',
  'willow',
  'wind',
  'wood',
] as const

const DEFAULT_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000 // 7 days

/** Parent types for invite codes. */
type InviteParentType = 'bondfire' | 'personal-bondfire' | 'camp'

// ── Helpers ────────────────────────────────────────────────────────────────

function makeInviteCode(seed: string): string {
  let hash = 0
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0
  }

  const first = INVITE_WORDS[hash % INVITE_WORDS.length]
  const second = INVITE_WORDS[Math.floor(hash / INVITE_WORDS.length) % INVITE_WORDS.length]
  const third =
    INVITE_WORDS[
      Math.floor(hash / (INVITE_WORDS.length * INVITE_WORDS.length)) % INVITE_WORDS.length
    ]

  return [first, second, third].join('-')
}

function normalizeInviteCode(code: string): string {
  return code.trim().toLowerCase().replace(/\s+/g, '-').replace(/-+/g, '-')
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

// ── Internal Helpers ───────────────────────────────────────────────────────

/**
 * Generate and insert a unique invite code into the inviteCodes table.
 * Returns the code and its expiry timestamp. Used by camp and personal bondfire
 * create-invite mutations.
 */
export async function generateAndInsertInviteCode(
  ctx: MutationCtx,
  args: {
    parentType: InviteParentType
    parentId: string
    createdBy: Id<'users'>
    expiresInDays?: number
    maxUses?: number
  },
): Promise<{ code: string; expiresAt: number }> {
  const now = Date.now()
  const expiresAt =
    args.expiresInDays !== undefined
      ? now + args.expiresInDays * 24 * 60 * 60 * 1000
      : now + DEFAULT_EXPIRY_MS

  const seed = [args.parentType, args.parentId, now].join('-')
  let code = makeInviteCode(seed)
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const existing = await ctx.db
      .query('inviteCodes')
      .withIndex('by_code', (q) => q.eq('code', code))
      .first()
    if (!existing) {
      break
    }
    code = makeInviteCode([seed, String(attempt + 1)].join('-'))
  }

  const finalExisting = await ctx.db
    .query('inviteCodes')
    .withIndex('by_code', (q) => q.eq('code', code))
    .first()
  if (finalExisting) {
    throwUserError('Could not generate a unique invite code. Please try again.')
  }

  await ctx.db.insert('inviteCodes', {
    code,
    parentType: args.parentType,
    parentId: args.parentId,
    uses: 0,
    maxUses: args.maxUses,
    expiresAt,
    createdBy: args.createdBy,
    createdAt: now,
  })

  return { code, expiresAt }
}

// ── Mutations ──────────────────────────────────────────────────────────────

/**
 * Generate an invite code for any parent type.
 * Used directly for public bondfires, and called internally by camp/personal-bondfire mutations.
 */
export const generateInviteCode = mutation({
  args: {
    parentType: v.string(),
    parentId: v.string(),
    expiresInDays: v.optional(v.number()),
    maxUses: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx)
    return await generateAndInsertInviteCode(ctx, {
      parentType: args.parentType as InviteParentType,
      parentId: args.parentId,
      createdBy: user._id,
      expiresInDays: args.expiresInDays,
      maxUses: args.maxUses,
    })
  },
})

/**
 * Create an invite code for a public bondfire.
 * Wraps generateInviteCode with parentType = 'bondfire'.
 */
export const createBondfireInviteCode = mutation({
  args: {
    bondfireId: v.id('bondfires'),
    expiresInDays: v.optional(v.number()),
    maxUses: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx)
    return await generateAndInsertInviteCode(ctx, {
      parentType: 'bondfire',
      parentId: args.bondfireId,
      createdBy: user._id,
      expiresInDays: args.expiresInDays,
      maxUses: args.maxUses,
    })
  },
})

/**
 * Redeem an invite code. Looks up the code, validates it's not expired or
 * overused, increments the usage counter, and returns the parent type + id.
 *
 * Used by both camp and personal bondfire redemption flows — each caller
 * is responsible for actually performing the join.
 */
export const redeemInviteCode = mutation({
  args: {
    code: v.string(),
  },
  handler: async (ctx, args) => {
    const code = normalizeInviteCode(args.code)
    const now = Date.now()

    const invite = await ctx.db
      .query('inviteCodes')
      .withIndex('by_code', (q) => q.eq('code', code))
      .first()

    if (!invite) {
      throwUserError('Invite not found.')
    }

    if (invite.expiresAt !== undefined && invite.expiresAt <= now) {
      throwUserError('This invite has expired.')
    }

    if (invite.maxUses !== undefined && invite.uses >= invite.maxUses) {
      throwUserError('This invite has already been used.')
    }

    // Increment usage
    await ctx.db.patch(invite._id, {
      uses: invite.uses + 1,
    })

    return {
      parentType: invite.parentType,
      parentId: invite.parentId,
    }
  },
})

// ── Queries ────────────────────────────────────────────────────────────────

/**
 * Get an existing active invite code for a parent, or null if none exists.
 * Used for lazy generation — callers can check if one already exists before creating.
 */
export const getInviteCode = query({
  args: {
    parentType: v.string(),
    parentId: v.string(),
  },
  handler: async (ctx, args) => {
    const now = Date.now()

    const invites = await ctx.db
      .query('inviteCodes')
      .withIndex('by_parent', (q) =>
        q.eq('parentType', args.parentType).eq('parentId', args.parentId),
      )
      .order('desc')
      .take(100)

    // Return the first active (non-expired, not overused) invite, or null
    for (const invite of invites) {
      const expired = invite.expiresAt !== undefined && invite.expiresAt <= now
      const overused = invite.maxUses !== undefined && invite.uses >= invite.maxUses
      if (!expired && !overused) {
        return invite
      }
    }

    return null
  },
})

// ── Internal Mutations ─────────────────────────────────────────────────────

/**
 * Delete invite codes past their expiresAt timestamp.
 * Runs daily via cron (12:30 UTC) to keep the table clean.
 */
export const cleanupExpiredInviteCodes = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now()
    let deleted = 0

    // Scan the by_expires_at index for expired codes
    const expiredCodes = await ctx.db
      .query('inviteCodes')
      .withIndex('by_expires_at', (q) => q.lt('expiresAt', now))
      .take(500)

    for (const code of expiredCodes) {
      await ctx.db.delete(code._id)
      deleted++
    }

    return { deleted, cutoff: now }
  },
})

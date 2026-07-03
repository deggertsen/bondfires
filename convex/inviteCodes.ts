import type { Doc, Id } from './_generated/dataModel'
import type { MutationCtx } from './_generated/server'
import { internalMutation } from './_generated/server'
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

export type ReusableInviteCode = Pick<Doc<'inviteCodes'>, '_id' | 'code' | 'expiresAt'>

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

export function normalizeInviteCode(code: string): string {
  return code.trim().toLowerCase().replace(/\s+/g, '-').replace(/-+/g, '-')
}

export async function findReusableInviteCode(
  ctx: MutationCtx,
  args: {
    parentType: InviteParentType
    parentId: string
    createdBy: Id<'users'>
  },
): Promise<ReusableInviteCode | null> {
  const now = Date.now()
  const inviteCodes = await ctx.db
    .query('inviteCodes')
    .withIndex('by_parent', (q) =>
      q.eq('parentType', args.parentType).eq('parentId', args.parentId),
    )
    .order('desc')
    .take(50)

  return (
    inviteCodes.find(
      (inviteCode) =>
        inviteCode.createdBy === args.createdBy &&
        (inviteCode.expiresAt === undefined || inviteCode.expiresAt > now) &&
        (inviteCode.maxUses === undefined || inviteCode.uses < inviteCode.maxUses),
    ) ?? null
  )
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
    code?: string
    expiresAt?: number
    expiresInDays?: number
    maxUses?: number
  },
): Promise<{ code: string; expiresAt: number }> {
  const now = Date.now()
  const expiresAt =
    args.expiresAt ??
    (args.expiresInDays !== undefined
      ? now + args.expiresInDays * 24 * 60 * 60 * 1000
      : now + DEFAULT_EXPIRY_MS)

  const seed = [args.parentType, args.parentId, now].join('-')
  let code = args.code ? normalizeInviteCode(args.code) : makeInviteCode(seed)

  if (!code) {
    throwUserError('Invite code is required')
  }

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const existing = await ctx.db
      .query('inviteCodes')
      .withIndex('by_code', (q) => q.eq('code', code))
      .first()
    if (!existing) {
      break
    }
    if (args.code) {
      throwUserError('Invite code already exists')
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

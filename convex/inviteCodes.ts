import type { Doc, Id } from './_generated/dataModel'
import type { MutationCtx } from './_generated/server'
import { internalMutation } from './_generated/server'
import { enforceInviteCodeCreationLimit } from './abuseLimits'
import { throwUserError } from './errors'

// ── Constants ──────────────────────────────────────────────────────────────

const DEFAULT_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000 // 7 days
const MIN_EXPIRY_MS = 5 * 60 * 1000
const MAX_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000
const MAX_USES = 1_000
const RANDOM_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'
const RANDOM_CHARACTERS = 20
const SECURE_CODE_PATTERN = /^bf-(?:[a-z0-9]{4}-){4}[a-z0-9]{4}$/
// Legacy three-word codes are low entropy. Existing links remain claimable only
// during this explicit rollout grace, and are never reissued.
export const LEGACY_INVITE_CODE_CUTOFF_MS = Date.UTC(2026, 9, 1)

/** Parent types for invite codes. */
type InviteParentType = 'bondfire' | 'personal-bondfire' | 'camp'

export type ReusableInviteCode = Pick<Doc<'inviteCodes'>, '_id' | 'code' | 'expiresAt'>

// ── Helpers ────────────────────────────────────────────────────────────────

export function generateSecureInviteCode(): string {
  let random = ''
  // Reject the top four byte values so modulo reduction is unbiased for 36 symbols.
  while (random.length < RANDOM_CHARACTERS) {
    const bytes = new Uint8Array(32)
    crypto.getRandomValues(bytes)
    for (const byte of bytes) {
      if (byte >= 252) continue
      random += RANDOM_ALPHABET[byte % RANDOM_ALPHABET.length]
      if (random.length === RANDOM_CHARACTERS) break
    }
  }
  return `bf-${random.match(/.{1,4}/g)?.join('-') ?? random}`
}

export function isSecureInviteCode(code: string): boolean {
  return SECURE_CODE_PATTERN.test(code)
}

export function normalizeInviteCode(code: string): string {
  return code.trim().toLowerCase().replace(/\s+/g, '-').replace(/-+/g, '-')
}

type InviteCodeAvailability = Pick<Doc<'inviteCodes'>, 'code' | 'expiresAt' | 'maxUses' | 'uses'>

export function isInviteCodeClaimable(inviteCode: InviteCodeAvailability, now: number): boolean {
  const secure = isSecureInviteCode(inviteCode.code)
  if (secure && (inviteCode.expiresAt === undefined || !Number.isFinite(inviteCode.expiresAt))) {
    return false
  }
  const effectiveExpiry = secure
    ? inviteCode.expiresAt
    : Math.min(inviteCode.expiresAt ?? LEGACY_INVITE_CODE_CUTOFF_MS, LEGACY_INVITE_CODE_CUTOFF_MS)
  return (
    (effectiveExpiry === undefined || effectiveExpiry > now) &&
    (inviteCode.maxUses === undefined || inviteCode.uses < inviteCode.maxUses)
  )
}

export function isReusableInviteCode(inviteCode: InviteCodeAvailability, now: number): boolean {
  return isSecureInviteCode(inviteCode.code) && isInviteCodeClaimable(inviteCode, now)
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
        inviteCode.createdBy === args.createdBy && isReusableInviteCode(inviteCode, now),
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
    expiresAt?: number
    expiresInDays?: number
    maxUses?: number
  },
): Promise<{ code: string; expiresAt: number }> {
  const now = Date.now()
  if (args.expiresAt !== undefined && args.expiresInDays !== undefined) {
    throwUserError('Choose either an invite expiry date or duration')
  }
  const expiresAt =
    args.expiresAt ??
    (args.expiresInDays !== undefined
      ? now + args.expiresInDays * 24 * 60 * 60 * 1000
      : now + DEFAULT_EXPIRY_MS)
  if (
    !Number.isFinite(expiresAt) ||
    expiresAt < now + MIN_EXPIRY_MS ||
    expiresAt > now + MAX_EXPIRY_MS
  ) {
    throwUserError('Invite expiry must be between 5 minutes and 30 days from now')
  }
  if (
    args.maxUses !== undefined &&
    (!Number.isInteger(args.maxUses) || args.maxUses < 1 || args.maxUses > MAX_USES)
  ) {
    throwUserError(`Invite max uses must be an integer between 1 and ${MAX_USES}`)
  }

  await enforceInviteCodeCreationLimit(ctx, args.createdBy)

  let code = ''
  for (let attempt = 0; attempt < 8; attempt += 1) {
    code = generateSecureInviteCode()
    const existing = await ctx.db
      .query('inviteCodes')
      .withIndex('by_code', (q) => q.eq('code', code))
      .first()
    if (!existing) {
      break
    }
  }

  if (!isSecureInviteCode(code)) throw new Error('Secure invite generation failed')
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

    // Old rows without an expiry cannot be found by the range above. Once the
    // compatibility grace closes, remove a bounded batch on every daily run.
    if (now >= LEGACY_INVITE_CODE_CUTOFF_MS) {
      const legacyWithoutExpiry = await ctx.db
        .query('inviteCodes')
        .withIndex('by_expires_at', (q) => q.eq('expiresAt', undefined))
        .take(500)
      for (const code of legacyWithoutExpiry) {
        await ctx.db.delete(code._id)
        deleted++
      }
    }

    return { deleted, cutoff: now }
  },
})

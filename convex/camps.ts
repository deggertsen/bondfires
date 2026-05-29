import { v } from 'convex/values'
import type { Doc, Id } from './_generated/dataModel'
import type { MutationCtx, QueryCtx } from './_generated/server'
import { internalMutation, mutation, query } from './_generated/server'
import { auth } from './auth'
import { consumeCampSlotForCamp } from './campSlots'
import type { SubscriptionTier } from './entitlements'
import {
  assertCanCreatePrivateCamp,
  assertCanCreatePublicCamp,
  getEntitlementSubscriptionTier,
  PAID_TIERS,
  TIER_RANK,
} from './entitlements'
import { throwUserError } from './errors'

type CampAccess = 'open' | 'approval' | 'invite'
type CampGender = 'male' | 'female' | 'any'
type CampAccessVisibilityMode = 'hide' | 'gate'
type CampVisibilityDeniedReason = 'wrong_gender' | 'tier_too_low' | 'underage' | 'invite_only'
type CampVisibilityResult = {
  visible: boolean
  accessDeniedReason?: string
  accessDeniedCode?: CampVisibilityDeniedReason
}

/** Join-eligibility evaluation result. */
type CampJoinResult = {
  canJoin: boolean
  reason:
    | 'ok'
    | 'wrong_gender'
    | 'tier_too_low'
    | 'underage'
    | 'invite_only'
    | 'approval_required'
    | 'banned'
    | 'already_member'
    | 'not_found'
    | 'private'
}

type CampSeed = {
  slug: string
  name: string
  theme: string
  purpose: string
  icon: string
  color: string
  defaultPrompt: string
  gender: CampGender
  crisisBroadcast?: boolean
  welcomeBroadcast?: boolean
  requiresTradeTags?: boolean
  advisoryGuidelines: readonly string[]
}

const MINIMUM_TIER_REASON: Record<SubscriptionTier, string> = {
  free: 'Requires free tier',
  plus: 'Requires Plus tier',
  premium: 'Requires Premium tier',
  pro: 'Requires Pro tier',
}

const roleValidator = v.union(v.literal('owner'), v.literal('moderator'), v.literal('member'))
const memberStatusValidator = v.union(
  v.literal('pending'),
  v.literal('active'),
  v.literal('banned'),
)
const accessValidator = v.union(v.literal('open'), v.literal('approval'), v.literal('invite'))
const accessVisibilityModeValidator = v.union(v.literal('hide'), v.literal('gate'))

const ALL_TIERS: readonly SubscriptionTier[] = ['free', 'plus', 'premium', 'pro']
const INVITE_WORDS = [
  'amber',
  'ash',
  'canyon',
  'cedar',
  'ember',
  'forge',
  'harbor',
  'iron',
  'lantern',
  'mesa',
  'oak',
  'river',
  'signal',
  'stone',
  'summit',
  'trail',
  'valley',
  'watch',
] as const

const BASE_LAUNCH_CAMPS = [
  {
    slug: 'welcome-fires',
    name: 'Welcome Fires',
    theme: 'Arrival',
    purpose: 'First sparks, introductions, and orientation for new members.',
    icon: 'flame',
    color: '#F97316',
    defaultPrompt: 'Tell the camp who you are and what brought you to Bondfires.',
    welcomeBroadcast: true,
    advisoryGuidelines: [
      'Keep it brief, warm, and specific.',
      'Welcome first-time sparkers generously.',
    ],
  },
  {
    slug: 'victory-fires',
    name: 'Victory Fires',
    theme: 'Wins',
    purpose: 'A place to mark progress, celebrate wins, and let the camp witness momentum.',
    icon: 'trophy',
    color: '#EAB308',
    defaultPrompt: 'What win is worth marking today?',
    advisoryGuidelines: ['Name the win clearly.', 'Share what it cost or what changed.'],
  },
  {
    slug: 'signal-fires',
    name: 'Signal Fires',
    theme: 'Crisis Support',
    purpose: 'Urgent support when someone needs the camp to gather quickly.',
    icon: 'signal',
    color: '#DC2626',
    defaultPrompt: 'What do you need the camp to know right now?',
    crisisBroadcast: true,
    advisoryGuidelines: [
      'Use this camp for real support needs, not general updates.',
      'Respond with care, presence, and practical next steps.',
    ],
  },
  {
    slug: 'the-forge',
    name: 'The Forge',
    theme: 'Accountability',
    purpose: 'Goals, commitments, discipline, and the work of becoming sharper.',
    icon: 'hammer',
    color: '#EA580C',
    defaultPrompt: 'What are you committing to, and what will prove it happened?',
    advisoryGuidelines: [
      'Be specific about the commitment.',
      'Follow up with evidence, not vibes.',
    ],
  },
  {
    slug: 'the-trading-post',
    name: 'The Trading Post',
    theme: 'Needs and Offers',
    purpose: 'Requests, offers, resources, and practical help across the camp.',
    icon: 'handshake',
    color: '#059669',
    defaultPrompt: 'Are you bringing a need or an offer?',
    requiresTradeTags: true,
    advisoryGuidelines: ['Use need/offer tags.', 'Be clear about what action would help.'],
  },
  {
    slug: 'the-raise',
    name: 'The Raise',
    theme: 'Fatherhood',
    purpose: 'Fatherhood, parenting, and the work of raising children well.',
    icon: 'users',
    color: '#2563EB',
    defaultPrompt: 'What part of fatherhood are you carrying today?',
    advisoryGuidelines: ['Protect family privacy.', 'Share from your own seat first.'],
  },
  {
    slug: 'the-pursuit',
    name: 'The Pursuit',
    theme: 'Dating',
    purpose: 'Dating toward long-term partnership with honesty and maturity.',
    icon: 'heart',
    color: '#DB2777',
    defaultPrompt: 'What are you learning about pursuit, partnership, or readiness?',
    advisoryGuidelines: [
      'No objectifying language.',
      'Speak with respect for the person who is not in the room.',
    ],
  },
  {
    slug: 'the-castle',
    name: 'The Castle',
    theme: 'Marriage',
    purpose: 'Marriage, commitment, repair, partnership, and home life.',
    icon: 'castle',
    color: '#7C3AED',
    defaultPrompt: 'What does your marriage or long-term commitment need from you?',
    advisoryGuidelines: [
      'Honor your spouse or partner in how you speak.',
      'Do not turn conflict into spectacle.',
    ],
  },
  {
    slug: 'the-tempering',
    name: 'The Tempering',
    theme: 'Discipline and Recovery',
    purpose: 'Recovery, discipline, temptation, relapse prevention, and resilience.',
    icon: 'shield',
    color: '#0F766E',
    defaultPrompt: 'Where are you being tempered right now?',
    advisoryGuidelines: [
      'No graphic detail that could pull someone else backward.',
      'Name support needs plainly.',
    ],
  },
] as const

function variantName(baseName: string, gender: Exclude<CampGender, 'any'>) {
  return [baseName, ' (', gender === 'male' ? 'Men' : 'Women', ')'].join('')
}

function variantSlug(baseSlug: string, gender: Exclude<CampGender, 'any'>) {
  return [baseSlug, gender === 'male' ? 'men' : 'women'].join('-')
}

function getLaunchCampSeeds(): CampSeed[] {
  const genderedCamps = BASE_LAUNCH_CAMPS.flatMap((camp) =>
    (['male', 'female'] as const).map((gender) => ({
      ...camp,
      slug: variantSlug(camp.slug, gender),
      name: variantName(camp.name, gender),
      gender,
    })),
  )
  const mixedWelcomeCamp = BASE_LAUNCH_CAMPS.filter((camp) => camp.slug === 'welcome-fires').map(
    (camp) => ({
      ...camp,
      gender: 'any' as const,
    }),
  )

  return [...mixedWelcomeCamp, ...genderedCamps]
}

function getArenaSeed(): CampSeed {
  return {
    slug: 'the-arena',
    name: 'The Arena',
    theme: 'Legacy',
    purpose: 'Holding camp for existing bondfires created before camps launched.',
    icon: 'circle',
    color: '#64748B',
    defaultPrompt: 'What is worth bringing to the circle today?',
    gender: 'any',
    advisoryGuidelines: ['Use the current Bondfires community guidelines.'],
  }
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

function normalizeCampSlug(name: string) {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
}

function normalizePrivateCampSlug(name: string, userId: Id<'users'>) {
  const base = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)

  return ['private', base || 'camp', userId.slice(-6)].join('-')
}

function generateInviteCode(seed: string) {
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

function isAdmin(user: Doc<'users'>) {
  return user.isAdmin === true || user.role === 'admin'
}

/** Find the canonical admin user. Prefer the owned inbox, then role, then legacy flag. */
async function findAdminUser(ctx: QueryCtx | MutationCtx): Promise<Doc<'users'> | null> {
  const adminByEmail = await ctx.db
    .query('users')
    .withIndex('email', (q) => q.eq('email', 'admin@bondfires.org'))
    .first()
  if (adminByEmail) return adminByEmail

  const adminByRole = await ctx.db
    .query('users')
    .withIndex('by_role', (q) => q.eq('role', 'admin'))
    .first()
  if (adminByRole) return adminByRole

  const users = await ctx.db.query('users').collect()
  return users.find((u) => u.isAdmin === true) ?? null
}

async function getMembership(
  ctx: QueryCtx | MutationCtx,
  userId: Id<'users'>,
  campId: Id<'camps'>,
) {
  return await ctx.db
    .query('campMembers')
    .withIndex('by_user_camp', (q) => q.eq('userId', userId).eq('campId', campId))
    .first()
}

async function assertCanManageCamp(ctx: QueryCtx | MutationCtx, camp: Doc<'camps'>) {
  const user = await getCurrentUser(ctx)
  if (isAdmin(user)) {
    return user
  }

  const membership = await getMembership(ctx, user._id, camp._id)
  if (
    membership?.status === 'active' &&
    (membership.role === 'owner' || membership.role === 'moderator')
  ) {
    return user
  }

  throwUserError('You do not have permission to manage this camp')
}

async function findCampBySlug(ctx: QueryCtx | MutationCtx, slug: string) {
  return await ctx.db
    .query('camps')
    .withIndex('by_slug', (q) => q.eq('slug', slug))
    .first()
}

// ── Centralized Camp Eligibility Helpers ──────────────────────────────────

function parseBirthDate(birthDate: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(birthDate)
  if (!match) {
    return null
  }

  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const parsed = new Date(Date.UTC(year, month - 1, day))
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    return null
  }

  return { year, month, day }
}

function calculateAge(birthDate: string): number | null {
  const birth = parseBirthDate(birthDate)
  if (!birth) {
    return null
  }

  const today = new Date()
  let age = today.getFullYear() - birth.year
  const monthDelta = today.getMonth() + 1 - birth.month
  if (monthDelta < 0 || (monthDelta === 0 && today.getDate() < birth.day)) {
    age -= 1
  }
  return age
}

function deniedByAccessRule(
  visibilityMode: CampAccessVisibilityMode,
  accessDeniedCode: CampVisibilityDeniedReason,
  accessDeniedReason: string,
): CampVisibilityResult {
  return {
    visible: visibilityMode === 'gate',
    accessDeniedCode,
    accessDeniedReason,
  }
}

function getMinimumTier(tiers: readonly SubscriptionTier[]): SubscriptionTier | undefined {
  return tiers.reduce<SubscriptionTier | undefined>(
    (minimum, tier) => (!minimum || TIER_RANK[tier] < TIER_RANK[minimum] ? tier : minimum),
    undefined,
  )
}

/**
 * Compute camp visibility based on the new rules.access structure.
 *
 * - 'hide' mode rules: user doesn't match → camp is invisible (visible=false)
 * - 'gate' mode rules: user doesn't match → camp is visible but accessDeniedReason is set
 * - Invite-only camps default to hidden for non-members.
 */
function computeVisibility(
  user: { gender?: string; tier: SubscriptionTier; birthDate?: string },
  camp: Doc<'camps'>,
): CampVisibilityResult {
  const access = camp.rules.access

  if (camp.access === 'invite') {
    return deniedByAccessRule('hide', 'invite_only', 'This camp requires an invitation')
  }

  if (access.inviteOnly?.value) {
    return deniedByAccessRule(
      access.inviteOnly.visibilityMode,
      'invite_only',
      'This camp requires an invitation',
    )
  }

  if (access.gender && access.gender.value !== 'any' && user.gender !== access.gender.value) {
    const label = access.gender.value === 'male' ? 'men' : 'women'
    return deniedByAccessRule(
      access.gender.visibilityMode,
      'wrong_gender',
      `This camp is for ${label} only`,
    )
  }

  const age = user.birthDate ? calculateAge(user.birthDate) : null
  if (access.minAge && (age === null || age < access.minAge.value)) {
    return deniedByAccessRule(
      access.minAge.visibilityMode,
      'underage',
      `This camp requires you to be at least ${access.minAge.value}`,
    )
  }
  if (access.maxAge && (age === null || age > access.maxAge.value)) {
    return deniedByAccessRule(
      access.maxAge.visibilityMode,
      'underage',
      `This camp has a maximum age of ${access.maxAge.value}`,
    )
  }

  const allowedTiers = access.allowedTiers?.value ?? []
  if (allowedTiers.length > 0 && !allowedTiers.includes(user.tier)) {
    const minimumTier = getMinimumTier(allowedTiers)
    return deniedByAccessRule(
      access.allowedTiers?.visibilityMode ?? 'hide',
      'tier_too_low',
      minimumTier ? MINIMUM_TIER_REASON[minimumTier] : 'Your membership tier cannot join this camp',
    )
  }

  return { visible: true }
}

/**
 * Evaluate join rules using the rules.access structure.
 */
function evaluateJoinRules(
  camp: Doc<'camps'>,
  user: Doc<'users'>,
  userTier: SubscriptionTier,
  existingMembership: Doc<'campMembers'> | null,
): CampJoinResult {
  if (existingMembership?.status === 'banned') {
    return { canJoin: false, reason: 'banned' }
  }
  if (existingMembership?.status === 'active') {
    return { canJoin: false, reason: 'already_member' }
  }

  // Use computeVisibility for access rule checks
  const visibility = computeVisibility(
    {
      gender: user.gender,
      tier: userTier,
      birthDate: user.birthDate,
    },
    camp,
  )

  if (visibility.accessDeniedCode) {
    return { canJoin: false, reason: visibility.accessDeniedCode }
  }

  return { canJoin: true, reason: 'ok' }
}

/**
 * Compute sort rank for camp list ordering.
 * 0 = joinable/member, 1 = locked but visible, 2 = hidden.
 */
function computeSortRank(
  camp: Doc<'camps'>,
  user: Doc<'users'> | null,
  userTier: SubscriptionTier,
  membership: Doc<'campMembers'> | null,
): number {
  if (membership?.status === 'active') {
    return 0
  }

  if (!user) {
    // Anonymous user — compute visibility without user context
    const visibility = computeVisibility(
      {
        gender: 'other',
        tier: 'free',
        birthDate: undefined,
      },
      camp,
    )
    return visibility.visible ? 0 : 2
  }

  const visibility = computeVisibility(
    {
      gender: user.gender,
      tier: userTier,
      birthDate: user.birthDate,
    },
    camp,
  )

  if (!visibility.visible) {
    return 2
  }
  if (visibility.accessDeniedReason) {
    return 1
  }
  return 0
}

/** Human-readable locked reason from access rules. */
function lockedReason(camp: Doc<'camps'>, userTier: SubscriptionTier): string | undefined {
  const access = camp.rules.access
  if (access.allowedTiers) {
    if (!access.allowedTiers.value.includes(userTier)) {
      const minTier = getMinimumTier(access.allowedTiers.value)
      return minTier ? MINIMUM_TIER_REASON[minTier] : 'Your membership tier cannot join this camp'
    }
  }
  return undefined
}

function isInviteOnlyCamp(camp: Doc<'camps'>): boolean {
  return camp.access === 'invite' || camp.rules.access.inviteOnly?.value === true
}

/** Resolve camp display name — invite-only camps use nameOverride or ownerDisplayName. */
function resolveCampDisplayName(camp: Doc<'camps'>): string {
  if (isInviteOnlyCamp(camp)) {
    return camp.nameOverride ?? camp.ownerDisplayName ?? camp.name
  }
  return camp.name
}

function getJoinMembershipStatus(camp: Doc<'camps'>): 'pending' | 'active' {
  if (camp.access === 'approval') {
    return 'pending'
  }

  return 'active'
}

async function upsertMembership(
  ctx: MutationCtx,
  args: {
    userId: Id<'users'>
    campId: Id<'camps'>
    role?: 'owner' | 'moderator' | 'member'
    status: 'pending' | 'active' | 'banned'
  },
) {
  const now = Date.now()
  const existing = await getMembership(ctx, args.userId, args.campId)
  const patch = {
    role: args.role ?? existing?.role ?? ('member' as const),
    status: args.status,
    muted: existing?.muted ?? false,
    joinedAt: args.status === 'active' ? (existing?.joinedAt ?? now) : existing?.joinedAt,
    requestedAt: args.status === 'pending' ? (existing?.requestedAt ?? now) : existing?.requestedAt,
    approvedAt: args.status === 'active' ? (existing?.approvedAt ?? now) : existing?.approvedAt,
    updatedAt: now,
  }

  if (existing) {
    await ctx.db.patch(existing._id, patch)
    return existing._id
  }

  return await ctx.db.insert('campMembers', {
    userId: args.userId,
    campId: args.campId,
    ...patch,
    createdAt: now,
  })
}

async function refreshActiveMemberCount(ctx: MutationCtx, campId: Id<'camps'>) {
  const activeMembers = await ctx.db
    .query('campMembers')
    .withIndex('by_camp_status', (q) => q.eq('campId', campId).eq('status', 'active'))
    .collect()

  await ctx.db.patch(campId, {
    activeMemberCount: activeMembers.length,
    updatedAt: Date.now(),
  })
}

async function ensureCamp(
  ctx: MutationCtx,
  seed: CampSeed,
  args?: { isLaunchCamp?: boolean; ownerId?: Id<'users'> },
) {
  const now = Date.now()
  const existing = await findCampBySlug(ctx, seed.slug)
  const campFields = {
    slug: seed.slug,
    name: seed.name,
    theme: seed.theme,
    purpose: seed.purpose,
    icon: seed.icon,
    color: seed.color,
    defaultPrompt: seed.defaultPrompt,
    rules: {
      access: {
        gender: { value: seed.gender, visibilityMode: 'hide' as const },
        allowedTiers: { value: [...ALL_TIERS], visibilityMode: 'gate' as const },
      },
      participation: {
        maxDurationMs: 30 * 60 * 1000,
      },
      advisory: {
        guidelines: [...seed.advisoryGuidelines],
        requiresTradeTags: seed.requiresTradeTags ?? false,
      },
    },
    crisisBroadcast: seed.crisisBroadcast ?? false,
    welcomeBroadcast: seed.welcomeBroadcast ?? false,
    access: 'open' as const,
    status: 'active' as const,
    bondfireCount: existing?.bondfireCount ?? 0,
    activeMemberCount: existing?.activeMemberCount ?? 0,
    isLaunchCamp: args?.isLaunchCamp ?? false,
    updatedAt: now,
  }

  if (existing) {
    // Update ownerId if provided and not already set
    const patchFields: Record<string, unknown> = { ...campFields }
    if (args?.ownerId && !existing.ownerId) {
      patchFields.ownerId = args.ownerId
    }
    await ctx.db.patch(existing._id, patchFields)
    return existing._id
  }

  if (!args?.ownerId) {
    throw new Error('ownerId is required when creating a new camp')
  }

  return await ctx.db.insert('camps', {
    ...campFields,
    ownerId: args.ownerId,
    createdAt: now,
  })
}

export const list = query({
  args: {
    includeArchived: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const userId = await auth.getUserId(ctx)
    const memberships = userId
      ? await ctx.db
          .query('campMembers')
          .withIndex('by_user', (q) => q.eq('userId', userId))
          .collect()
      : []

    const membershipsByCamp = new Map(
      memberships.map((membership) => [membership.campId, membership]),
    )

    // Fetch user + tier for visibility evaluation
    const user = userId ? await ctx.db.get(userId) : null
    const userTier =
      user && userId
        ? await getEntitlementSubscriptionTier(ctx, userId)
        : ('free' as SubscriptionTier)

    const camps = await ctx.db.query('camps').collect()

    return camps
      .filter(
        (camp) => args.includeArchived || camp.status === 'active' || camp.status === 'frozen',
      )
      .filter((camp) => {
        // Frozen camps: only visible to active members
        if (camp.status === 'frozen') {
          const membership = membershipsByCamp.get(camp._id)
          return membership?.status === 'active'
        }
        // Active members always see their camps
        const membership = membershipsByCamp.get(camp._id)
        if (membership?.status === 'active') {
          return true
        }
        // Use computeVisibility for non-members
        if (!user) {
          // Anonymous user
          const visibility = computeVisibility(
            {
              gender: 'other',
              tier: 'free',
              birthDate: undefined,
            },
            camp,
          )
          return visibility.visible
        }
        const visibility = computeVisibility(
          {
            gender: user.gender,
            tier: userTier,
            birthDate: user.birthDate,
          },
          camp,
        )
        return visibility.visible
      })
      .map((camp) => {
        const membership = membershipsByCamp.get(camp._id) ?? null
        const rank = computeSortRank(camp, user, userTier, membership)
        const visibility: CampVisibilityResult =
          membership?.status === 'active'
            ? { visible: true }
            : computeVisibility(
                {
                  gender: user?.gender ?? 'other',
                  tier: userTier,
                  birthDate: user?.birthDate,
                },
                camp,
              )
        const reason = visibility.accessDeniedReason ?? lockedReason(camp, userTier)
        return {
          ...camp,
          name: resolveCampDisplayName(camp),
          membership,
          _sortRank: camp.status === 'frozen' ? 1 : rank,
          _lockedReason:
            camp.status === 'frozen'
              ? 'Frozen — upgrade to manage this camp'
              : membership?.status === 'active'
                ? undefined
                : reason,
          frozen: camp.status === 'frozen',
        }
      })
      .filter((camp) => camp._sortRank < 2) // Exclude hidden camps
      .sort((left, right) => {
        // Primary: sort rank (joinable above locked)
        if (left._sortRank !== right._sortRank) {
          return left._sortRank - right._sortRank
        }
        // Secondary: alphabetic
        return left.name.localeCompare(right.name)
      })
  },
})

export const get = query({
  args: {
    campId: v.optional(v.id('camps')),
    slug: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    if (!args.campId && !args.slug) {
      throw new Error('campId or slug is required')
    }

    let camp: Doc<'camps'> | null
    if (args.campId) {
      camp = await ctx.db.get(args.campId)
    } else if (args.slug) {
      camp = await findCampBySlug(ctx, args.slug)
    } else {
      camp = null
    }
    if (!camp) {
      return null
    }
    if (camp.status !== 'active' && camp.status !== 'frozen') {
      return null
    }

    const userId = await auth.getUserId(ctx)
    const membership = userId ? await getMembership(ctx, userId, camp._id) : null

    // Frozen camps: existing members can view but not create content
    if (camp.status === 'frozen') {
      if (!membership || membership.status !== 'active') {
        return null
      }
      return {
        ...camp,
        name: resolveCampDisplayName(camp),
        membership,
        frozen: true,
      }
    }

    // Active members can always get their camps
    if (membership?.status === 'active') {
      return {
        ...camp,
        name: resolveCampDisplayName(camp),
        membership,
      }
    }

    // For non-members, use computeVisibility
    const user = userId ? await ctx.db.get(userId) : null
    const userTier =
      user && userId
        ? await getEntitlementSubscriptionTier(ctx, userId)
        : ('free' as SubscriptionTier)

    const visibility = computeVisibility(
      {
        gender: user?.gender ?? 'other',
        tier: userTier,
        birthDate: user?.birthDate,
      },
      camp,
    )

    if (!visibility.visible) {
      // If camp has hide-mode rules user doesn't match, throw same as not found
      return null
    }

    return {
      ...camp,
      name: resolveCampDisplayName(camp),
      membership,
    }
  },
})

export const listMine = query({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUser(ctx)
    const memberships = await ctx.db
      .query('campMembers')
      .withIndex('by_user', (q) => q.eq('userId', user._id).eq('status', 'active'))
      .collect()

    const camps = await Promise.all(memberships.map((membership) => ctx.db.get(membership.campId)))
    return camps
      .map((camp, index) => (camp ? { ...camp, membership: memberships[index] } : null))
      .filter(
        (camp): camp is NonNullable<typeof camp> =>
          !!camp && (camp.status === 'active' || camp.status === 'frozen'),
      )
      .sort((left, right) => left.name.localeCompare(right.name))
  },
})

export const join = mutation({
  args: {
    campId: v.id('camps'),
  },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx)
    const camp = await ctx.db.get(args.campId)
    if (!camp || (camp.status !== 'active' && camp.status !== 'frozen')) {
      throwUserError('Camp not found')
    }

    // Frozen camps do not accept new members
    if (camp.status === 'frozen') {
      throwUserError('This camp is currently frozen. Upgrade your subscription to manage it.')
    }

    const existing = await getMembership(ctx, user._id, camp._id)
    const userTier = await getEntitlementSubscriptionTier(ctx, user._id)
    const eligibility = evaluateJoinRules(camp, user, userTier, existing)

    if (!eligibility.canJoin) {
      const messages: Record<string, string> = {
        wrong_gender: 'This camp is limited to members who match its gender setting',
        tier_too_low: 'Your subscription tier is too low to join this camp',
        underage: 'You do not meet the age requirement for this camp',
        invite_only: 'This camp requires an invite',
        banned: 'You cannot join this camp',
        already_member: 'You are already a member of this camp',
        private: 'This is a private camp',
      }
      throwUserError(messages[eligibility.reason] ?? 'You cannot join this camp')
    }

    const status = getJoinMembershipStatus(camp)
    const membershipId = await upsertMembership(ctx, {
      userId: user._id,
      campId: camp._id,
      status,
      role: 'member',
    })

    if (status === 'active') {
      await refreshActiveMemberCount(ctx, camp._id)
    }

    return {
      membershipId,
      status,
    }
  },
})

export const requestJoin = mutation({
  args: {
    campId: v.id('camps'),
  },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx)
    const camp = await ctx.db.get(args.campId)
    if (!camp || (camp.status !== 'active' && camp.status !== 'frozen')) {
      throwUserError('Camp not found')
    }

    // Frozen camps do not accept new join requests
    if (camp.status === 'frozen') {
      throwUserError('This camp is currently frozen. Upgrade your subscription to manage it.')
    }

    const existing = await getMembership(ctx, user._id, camp._id)
    const userTier = await getEntitlementSubscriptionTier(ctx, user._id)
    const eligibility = evaluateJoinRules(camp, user, userTier, existing)

    if (!eligibility.canJoin) {
      const messages: Record<string, string> = {
        wrong_gender: 'This camp is limited to members who match its gender setting',
        tier_too_low: 'Your subscription tier is too low to join this camp',
        underage: 'You do not meet the age requirement for this camp',
        invite_only: 'This camp requires an invite',
        banned: 'You cannot join this camp',
        already_member: 'You are already a member of this camp',
        private: 'This is a private camp',
      }
      throwUserError(messages[eligibility.reason] ?? 'You cannot join this camp')
    }

    const status = getJoinMembershipStatus(camp)
    const membershipId = await upsertMembership(ctx, {
      userId: user._id,
      campId: camp._id,
      status,
      role: 'member',
    })

    if (status === 'active') {
      await refreshActiveMemberCount(ctx, camp._id)
    }

    return {
      membershipId,
      status,
    }
  },
})

export const approveMember = mutation({
  args: {
    campId: v.id('camps'),
    userId: v.id('users'),
    role: v.optional(roleValidator),
  },
  handler: async (ctx, args) => {
    const camp = await ctx.db.get(args.campId)
    if (!camp) {
      throwUserError('Camp not found')
    }
    await assertCanManageCamp(ctx, camp)

    const membershipId = await upsertMembership(ctx, {
      userId: args.userId,
      campId: args.campId,
      role: args.role ?? 'member',
      status: 'active',
    })
    await refreshActiveMemberCount(ctx, args.campId)

    return membershipId
  },
})

export const updateMemberStatus = mutation({
  args: {
    campId: v.id('camps'),
    userId: v.id('users'),
    status: memberStatusValidator,
  },
  handler: async (ctx, args) => {
    const camp = await ctx.db.get(args.campId)
    if (!camp) {
      throwUserError('Camp not found')
    }
    await assertCanManageCamp(ctx, camp)

    const membership = await getMembership(ctx, args.userId, args.campId)
    if (!membership) {
      throwUserError('Membership not found')
    }

    await ctx.db.patch(membership._id, {
      status: args.status,
      joinedAt:
        args.status === 'active' ? (membership.joinedAt ?? Date.now()) : membership.joinedAt,
      approvedAt:
        args.status === 'active' ? (membership.approvedAt ?? Date.now()) : membership.approvedAt,
      updatedAt: Date.now(),
    })
    await refreshActiveMemberCount(ctx, args.campId)

    return membership._id
  },
})

export const leave = mutation({
  args: {
    campId: v.id('camps'),
  },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx)
    const membership = await getMembership(ctx, user._id, args.campId)
    if (!membership) {
      return { left: false }
    }

    if (membership.role === 'owner') {
      throwUserError('Camp owners cannot leave their own camp')
    }

    await ctx.db.delete(membership._id)
    await refreshActiveMemberCount(ctx, args.campId)

    return { left: true }
  },
})

export const muteCamp = mutation({
  args: {
    campId: v.id('camps'),
    muted: v.boolean(),
  },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx)
    const membership = await getMembership(ctx, user._id, args.campId)
    if (!membership) {
      throwUserError('You are not a member of this camp')
    }

    await ctx.db.patch(membership._id, {
      muted: args.muted,
      updatedAt: Date.now(),
    })

    return membership._id
  },
})

export const createInvite = mutation({
  args: {
    campId: v.id('camps'),
    code: v.optional(v.string()),
    maxUses: v.optional(v.number()),
    expiresAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const camp = await ctx.db.get(args.campId)
    if (!camp || (camp.status !== 'active' && camp.status !== 'frozen')) {
      throwUserError('Camp not found')
    }

    // Frozen camps cannot create new invites
    if (camp.status === 'frozen') {
      throwUserError('This camp is currently frozen. Upgrade your subscription to manage it.')
    }

    const user = await assertCanManageCamp(ctx, camp)
    let code = (args.code ?? generateInviteCode([camp._id, Date.now()].join('-'))).toLowerCase()

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const existing = await ctx.db
        .query('campInvites')
        .withIndex('by_code', (q) => q.eq('code', code))
        .first()
      if (!existing) {
        break
      }
      if (args.code) {
        throwUserError('Invite code already exists')
      }
      code = generateInviteCode([camp._id, Date.now(), attempt].join('-'))
    }
    const existing = await ctx.db
      .query('campInvites')
      .withIndex('by_code', (q) => q.eq('code', code))
      .first()
    if (existing) {
      throwUserError('Could not generate a unique invite code')
    }

    const inviteId = await ctx.db.insert('campInvites', {
      code,
      campId: camp._id,
      uses: 0,
      maxUses: args.maxUses,
      expiresAt: args.expiresAt,
      createdBy: user._id,
      createdAt: Date.now(),
    })

    return {
      inviteId,
      code,
    }
  },
})

export const redeemInvite = mutation({
  args: {
    code: v.string(),
  },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx)
    const invite = await ctx.db
      .query('campInvites')
      .withIndex('by_code', (q) => q.eq('code', args.code.toLowerCase()))
      .first()

    if (!invite) {
      throwUserError('Invite not found')
    }

    if (invite.expiresAt && invite.expiresAt <= Date.now()) {
      throwUserError('Invite has expired')
    }

    if (invite.maxUses !== undefined && invite.uses >= invite.maxUses) {
      throwUserError('Invite has already been used')
    }

    const camp = await ctx.db.get(invite.campId)
    if (!camp || (camp.status !== 'active' && camp.status !== 'frozen')) {
      throwUserError('Camp not found')
    }

    // Frozen camps do not accept new members via invite
    if (camp.status === 'frozen') {
      throwUserError('This camp is currently frozen. Upgrade your subscription to manage it.')
    }

    const existingMembership = await getMembership(ctx, user._id, camp._id)
    if (existingMembership?.status === 'active') {
      return {
        membershipId: existingMembership._id,
        campId: camp._id,
      }
    }

    const userTier = await getEntitlementSubscriptionTier(ctx, user._id)
    const eligibility = evaluateJoinRules(camp, user, userTier, existingMembership)

    // Invite bypasses invite_only and private — re-check only hard blocks
    if (
      !eligibility.canJoin &&
      eligibility.reason !== 'invite_only' &&
      eligibility.reason !== 'private'
    ) {
      const messages: Record<string, string> = {
        wrong_gender: 'This camp is limited to members who match its gender setting',
        tier_too_low: 'Your subscription tier is too low to join this camp',
        underage: 'You do not meet the age requirement for this camp',
        banned: 'You cannot join this camp',
        already_member: 'You are already a member of this camp',
      }
      throwUserError(messages[eligibility.reason] ?? 'You cannot join this camp')
    }

    const membershipId = await upsertMembership(ctx, {
      userId: user._id,
      campId: camp._id,
      status: 'active',
      role: 'member',
    })

    await ctx.db.patch(invite._id, {
      uses: invite.uses + 1,
    })
    await refreshActiveMemberCount(ctx, camp._id)

    return {
      membershipId,
      campId: camp._id,
    }
  },
})

export const setCampAccess = mutation({
  args: {
    campId: v.id('camps'),
    access: accessValidator,
  },
  handler: async (ctx, args) => {
    const camp = await ctx.db.get(args.campId)
    if (!camp) {
      throwUserError('Camp not found')
    }

    if (camp.status === 'frozen') {
      throwUserError('This camp is currently frozen. Upgrade your subscription to manage it.')
    }

    const user = await getCurrentUser(ctx)
    if (!isAdmin(user) && camp.ownerId !== user._id) {
      throwUserError('Only admins and camp owners can change camp access')
    }

    await ctx.db.patch(args.campId, {
      access: args.access as CampAccess,
      updatedAt: Date.now(),
    })

    return args.campId
  },
})

export const seedLaunchCamps = mutation({
  args: {},
  handler: async (ctx) => {
    const existingCamps = await ctx.db.query('camps').take(1)
    const user = await getCurrentUser(ctx)
    if (existingCamps.length > 0) {
      if (!isAdmin(user)) {
        throw new Error('Only admins can reseed camps')
      }
    }

    const arenaId = await ensureCamp(ctx, getArenaSeed(), {
      isLaunchCamp: false,
      ownerId: user._id,
    })
    const launchCampIds = []
    for (const seed of getLaunchCampSeeds()) {
      launchCampIds.push(await ensureCamp(ctx, seed, { isLaunchCamp: true, ownerId: user._id }))
    }

    return {
      arenaId,
      launchCampIds,
      launchCampCount: launchCampIds.length,
    }
  },
})

/**
 * Admin-only mutation to delete all camps (and their associated data)
 * and re-seed from scratch. Used during the camp rules restructure migration.
 */
export const resetAndReseed = mutation({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUser(ctx)
    if (!isAdmin(user)) {
      throwUserError('Only admins can reset and reseed camps')
    }

    // Delete all data that references camps
    const allCamps = await ctx.db.query('camps').collect()

    for (const camp of allCamps) {
      // Delete bondfires in this camp
      const bondfires = await ctx.db
        .query('bondfires')
        .withIndex('by_camp', (q) => q.eq('campId', camp._id))
        .collect()

      for (const bondfire of bondfires) {
        // Delete response videos for each bondfire
        const videos = await ctx.db
          .query('bondfireVideos')
          .withIndex('by_bondfire', (q) => q.eq('bondfireId', bondfire._id))
          .collect()
        for (const video of videos) {
          await ctx.db.delete(video._id)
        }
        await ctx.db.delete(bondfire._id)
      }

      // Delete camp memberships
      const memberships = await ctx.db
        .query('campMembers')
        .withIndex('by_camp', (q) => q.eq('campId', camp._id))
        .collect()
      for (const membership of memberships) {
        await ctx.db.delete(membership._id)
      }

      // Delete camp invites
      const invites = await ctx.db
        .query('campInvites')
        .withIndex('by_camp', (q) => q.eq('campId', camp._id))
        .collect()
      for (const invite of invites) {
        await ctx.db.delete(invite._id)
      }

      // Delete the camp itself
      await ctx.db.delete(camp._id)
    }

    // Re-seed
    const arenaId = await ensureCamp(ctx, getArenaSeed(), {
      isLaunchCamp: false,
      ownerId: user._id,
    })
    const launchCampIds = []
    for (const seed of getLaunchCampSeeds()) {
      launchCampIds.push(await ensureCamp(ctx, seed, { isLaunchCamp: true, ownerId: user._id }))
    }

    return {
      deletedCamps: allCamps.length,
      arenaId,
      launchCampIds,
      launchCampCount: launchCampIds.length,
    }
  },
})

// Internal version for admin tooling — bypasses authentication check.
// Run via: npx convex run "internal:camps:resetAndReseedAdmin"
export const resetAndReseedAdmin = internalMutation({
  args: {},
  handler: async (ctx) => {
    // Delete all data that references camps
    const allCamps = await ctx.db.query('camps').collect()

    for (const camp of allCamps) {
      const bondfires = await ctx.db
        .query('bondfires')
        .withIndex('by_camp', (q) => q.eq('campId', camp._id))
        .collect()
      for (const bondfire of bondfires) {
        const videos = await ctx.db
          .query('bondfireVideos')
          .withIndex('by_bondfire', (q) => q.eq('bondfireId', bondfire._id))
          .collect()
        for (const video of videos) {
          await ctx.db.delete(video._id)
        }
        await ctx.db.delete(bondfire._id)
      }
      const memberships = await ctx.db
        .query('campMembers')
        .withIndex('by_camp', (q) => q.eq('campId', camp._id))
        .collect()
      for (const membership of memberships) {
        await ctx.db.delete(membership._id)
      }
      const invites = await ctx.db
        .query('campInvites')
        .withIndex('by_camp', (q) => q.eq('campId', camp._id))
        .collect()
      for (const invite of invites) {
        await ctx.db.delete(invite._id)
      }
      await ctx.db.delete(camp._id)
    }

    const adminUser = await ctx.db
      .query('users')
      .withIndex('email', (q) => q.eq('email', 'admin@bondfires.org'))
      .first()
    const ownerId = adminUser?._id ?? (await ctx.db.query('users').first())?._id
    if (!ownerId) throw new Error('No users found to assign as camp owner')

    const arenaId = await ensureCamp(ctx, getArenaSeed(), {
      isLaunchCamp: false,
      ownerId,
    })
    const launchCampIds = []
    for (const seed of getLaunchCampSeeds()) {
      launchCampIds.push(await ensureCamp(ctx, seed, { isLaunchCamp: true, ownerId }))
    }

    return {
      deletedCamps: allCamps.length,
      arenaId,
      launchCampIds,
      launchCampCount: launchCampIds.length,
    }
  },
})

export const assignArenaToUnassignedBondfires = mutation({
  args: {
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx)
    if (!isAdmin(user)) {
      throw new Error('Only admins can run this migration')
    }

    const arena = await findCampBySlug(ctx, 'the-arena')
    if (!arena) {
      throw new Error('Seed camps before assigning legacy bondfires')
    }

    const limit = args.limit ?? 100
    const bondfires = await ctx.db.query('bondfires').take(limit)
    let updated = 0

    for (const bondfire of bondfires) {
      if (bondfire.campId) {
        continue
      }

      await ctx.db.patch(bondfire._id, {
        campId: arena._id,
        updatedAt: Date.now(),
      })
      updated += 1
    }

    const arenaBondfires = await ctx.db
      .query('bondfires')
      .withIndex('by_camp', (q) => q.eq('campId', arena._id))
      .collect()

    await ctx.db.patch(arena._id, {
      bondfireCount: arenaBondfires.length,
      updatedAt: Date.now(),
    })

    return {
      updated,
      remainingMayExist: bondfires.length === limit,
    }
  },
})

/**
 * Create a public camp. Requires Pro subscription and at least 1 available slot.
 * Immediately consumes 1 slot for the first month.
 */
export const createPublicCamp = mutation({
  args: {
    name: v.string(),
    purpose: v.string(),
    defaultPrompt: v.optional(v.string()),
    icon: v.optional(v.string()),
    color: v.optional(v.string()),
    access: v.optional(v.union(v.literal('open'), v.literal('approval'))),
    rules: v.optional(
      v.object({
        access: v.optional(
          v.object({
            gender: v.optional(
              v.object({
                value: v.union(v.literal('male'), v.literal('female'), v.literal('any')),
                visibilityMode: v.optional(v.union(v.literal('hide'), v.literal('gate'))),
              }),
            ),
            allowedTiers: v.optional(
              v.object({
                value: v.optional(
                  v.array(
                    v.union(
                      v.literal('free'),
                      v.literal('plus'),
                      v.literal('premium'),
                      v.literal('pro'),
                    ),
                  ),
                ),
                visibilityMode: v.optional(v.union(v.literal('hide'), v.literal('gate'))),
              }),
            ),
            minAge: v.optional(
              v.object({
                value: v.optional(v.number()),
                visibilityMode: v.optional(v.union(v.literal('hide'), v.literal('gate'))),
              }),
            ),
          }),
        ),
        advisory: v.optional(
          v.object({
            guidelines: v.optional(v.array(v.string())),
          }),
        ),
      }),
    ),
  },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx)

    // Validate Pro subscription and slot balance
    await assertCanCreatePublicCamp(ctx, user._id)

    const name = args.name.trim()
    if (name.length < 3) {
      throwUserError('Camp name must be at least 3 characters')
    }

    const purpose = args.purpose.trim()
    if (purpose.length < 10) {
      throwUserError('Purpose must be at least 10 characters')
    }

    const now = Date.now()
    const slug = normalizeCampSlug(name)

    // Idempotency: slug uniqueness enforced
    const existingSlug = await findCampBySlug(ctx, slug)
    if (existingSlug) {
      throwUserError('A camp with a similar name already exists')
    }

    const campId = await ctx.db.insert('camps', {
      slug,
      name,
      purpose,
      icon: args.icon ?? 'campfire',
      color: args.color ?? '#f97316',
      defaultPrompt: args.defaultPrompt ?? 'What does this camp mean to you?',
      rules: {
        access: {
          gender: args.rules?.access?.gender?.value
            ? {
                value: args.rules.access.gender.value,
                visibilityMode: args.rules.access.gender.visibilityMode ?? 'hide',
              }
            : { value: 'any' as const, visibilityMode: 'hide' as const },
          allowedTiers: args.rules?.access?.allowedTiers?.value
            ? {
                value: [...args.rules.access.allowedTiers.value],
                visibilityMode: args.rules.access.allowedTiers.visibilityMode ?? 'gate',
              }
            : {
                value: [...ALL_TIERS] as const,
                visibilityMode: 'gate' as const,
              },
          minAge:
            args.rules?.access?.minAge?.value !== undefined
              ? {
                  value: args.rules.access.minAge.value,
                  visibilityMode: args.rules.access.minAge.visibilityMode ?? 'gate',
                }
              : undefined,
        },
        participation: {
          maxDurationMs: 30 * 60 * 1000,
        },
        advisory: {
          guidelines: args.rules?.advisory?.guidelines ?? [],
        },
      },
      ownerDisplayName: user.displayName ?? user.name ?? undefined,
      crisisBroadcast: false,
      welcomeBroadcast: false,
      access: args.access ?? 'open',
      status: 'active',
      ownerId: user._id,
      bondfireCount: 0,
      activeMemberCount: 1,
      isLaunchCamp: false,
      createdAt: now,
      updatedAt: now,
    })

    // Create camp membership for the owner
    await upsertMembership(ctx, {
      userId: user._id,
      campId,
      role: 'owner',
      status: 'active',
    })

    // Add admin as moderator
    const adminUser = await findAdminUser(ctx)
    if (adminUser && adminUser._id !== user._id) {
      await upsertMembership(ctx, {
        userId: adminUser._id,
        campId,
        role: 'moderator',
        status: 'active',
      })
      await refreshActiveMemberCount(ctx, campId)
    }

    // Consume 1 slot for the first month in the same transaction.
    await consumeCampSlotForCamp(ctx, {
      userId: user._id,
      campId,
    })

    return campId
  },
})

export const createPrivateCamp = mutation({
  args: {
    name: v.string(),
    purpose: v.optional(v.string()),
    defaultPrompt: v.optional(v.string()),
    color: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx)
    const tier = await assertCanCreatePrivateCamp(ctx, user._id)

    const name = args.name.trim()
    if (name.length < 3) {
      throwUserError('Private camp name must be at least 3 characters')
    }

    const now = Date.now()
    const slug = normalizePrivateCampSlug(name, user._id)

    const existing = await findCampBySlug(ctx, slug)
    if (existing) {
      throwUserError('Private camp already exists')
    }

    const campId = await ctx.db.insert('camps', {
      slug,
      name,
      theme: 'Private Camp',
      purpose:
        args.purpose?.trim() ||
        ['Private camp hosted by', user.displayName ?? user.name ?? 'this member'].join(' '),
      icon: 'lock',
      color: args.color ?? '#334155',
      defaultPrompt:
        args.defaultPrompt ?? 'What do you want your private camp to gather around today?',
      rules: {
        access: {
          gender: { value: 'any', visibilityMode: 'hide' },
          allowedTiers: { value: [...PAID_TIERS], visibilityMode: 'hide' },
        },
        participation: {
          maxDurationMs: tier === 'pro' ? undefined : 30 * 60 * 1000,
        },
        advisory: {
          guidelines: [
            'The camp owner starts new Bondfires here.',
            'Invited members can respond to fires they can access.',
          ],
        },
      },
      nameOverride: name, // Custom name set by owner
      ownerDisplayName: user.displayName ?? user.name ?? undefined, // Default fallback
      crisisBroadcast: false,
      welcomeBroadcast: false,
      access: 'invite',
      status: 'active',
      ownerId: user._id,
      bondfireCount: 0,
      activeMemberCount: 1,
      isLaunchCamp: false,
      createdAt: now,
      updatedAt: now,
    })

    await upsertMembership(ctx, {
      userId: user._id,
      campId,
      role: 'owner',
      status: 'active',
    })

    const adminUser = await findAdminUser(ctx)
    if (adminUser && adminUser._id !== user._id) {
      await upsertMembership(ctx, {
        userId: adminUser._id,
        campId,
        role: 'moderator',
        status: 'active',
      })
      await refreshActiveMemberCount(ctx, campId)
    }

    return campId
  },
})

export const claimInactivePublicCamp = mutation({
  args: {
    campId: v.id('camps'),
  },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx)
    const camp = await ctx.db.get(args.campId)

    if (!camp || camp.access === 'invite' || camp.status !== 'inactive') {
      return { success: false as const, reason: 'not_claimable' as const }
    }

    const tier = await getEntitlementSubscriptionTier(ctx, user._id)
    if (TIER_RANK[tier] < TIER_RANK.pro) {
      return { success: false as const, reason: 'not_pro' as const }
    }

    const slotResult = await consumeCampSlotForCamp(ctx, {
      userId: user._id,
      campId: camp._id,
    })

    if (slotResult.insufficientBalance) {
      return { success: false as const, reason: 'insufficient_slots' as const }
    }

    const previousOwnerId = camp.ownerId
    const now = Date.now()

    await ctx.db.patch(camp._id, {
      ownerId: user._id,
      ownerDisplayName: user.displayName ?? user.name ?? undefined,
      status: 'active',
      gracePeriodStart: undefined,
      gracePeriodEnd: undefined,
      updatedAt: now,
    })

    const claimantMembership = await getMembership(ctx, user._id, camp._id)
    const claimantWasActive = claimantMembership?.status === 'active'
    await upsertMembership(ctx, {
      userId: user._id,
      campId: camp._id,
      role: 'owner',
      status: 'active',
    })

    if (previousOwnerId && previousOwnerId !== user._id) {
      const previousOwnerMembership = await getMembership(ctx, previousOwnerId, camp._id)
      if (previousOwnerMembership?.role === 'owner') {
        await ctx.db.patch(previousOwnerMembership._id, {
          role: 'member',
          updatedAt: now,
        })
      }
    }

    if (!claimantWasActive) {
      await refreshActiveMemberCount(ctx, camp._id)
    }

    const claimedCamp = await ctx.db.get(camp._id)
    if (!claimedCamp) {
      throwUserError('Camp not found')
    }

    return { success: true as const, camp: claimedCamp }
  },
})

// ── Backfill Migration: Admin account setup + required camp ownership ──

/**
 * Backfill mutation to:
 * 1. Set ownerId on all camps that don't have one
 * 2. Add admin@bondfires.org as an active camp member
 *    - owner when the admin account owns the camp
 *    - moderator when another user owns the camp
 * 3. Set admin roles without demoting legacy isAdmin accounts
 *
 * Run against prod via Convex dashboard or CLI:
 *   npx convex run --prod camps:adminBackfill
 */
export const adminBackfill = mutation({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUser(ctx)
    if (!isAdmin(user)) {
      throw new Error('Only admins can run this backfill')
    }

    const now = Date.now()

    // Find the canonical admin user
    const adminUser = await ctx.db
      .query('users')
      .withIndex('email', (q) => q.eq('email', 'admin@bondfires.org'))
      .first()

    if (!adminUser) {
      return {
        error: 'Admin user admin@bondfires.org not found. Create the admin account first.',
      }
    }

    const result = {
      campsOwnerSet: 0,
      campsAlreadyOwned: 0,
      adminMembershipsAdded: 0,
      adminMembershipsUpdated: 0,
      adminMembershipsAlreadyPresent: 0,
      activeMemberCountsRefreshed: 0,
      adminRoleSet: 0,
      adminFlagSet: 0,
      userRolesSet: 0,
      usersScanned: 0,
    }

    const camps = await ctx.db.query('camps').collect()
    for (const camp of camps) {
      let ownerId = camp.ownerId
      if (!camp.ownerId) {
        await ctx.db.patch(camp._id, {
          ownerId: adminUser._id,
          updatedAt: now,
        })
        ownerId = adminUser._id
        result.campsOwnerSet += 1
      } else {
        result.campsAlreadyOwned += 1
      }

      const adminMembershipRole = ownerId === adminUser._id ? 'owner' : 'moderator'
      const existingMembership = await getMembership(ctx, adminUser._id, camp._id)
      if (!existingMembership) {
        await upsertMembership(ctx, {
          userId: adminUser._id,
          campId: camp._id,
          role: adminMembershipRole,
          status: 'active',
        })
        result.adminMembershipsAdded += 1
        await refreshActiveMemberCount(ctx, camp._id)
        result.activeMemberCountsRefreshed += 1
      } else if (
        existingMembership.role !== adminMembershipRole ||
        existingMembership.status !== 'active'
      ) {
        await upsertMembership(ctx, {
          userId: adminUser._id,
          campId: camp._id,
          role: adminMembershipRole,
          status: 'active',
        })
        result.adminMembershipsUpdated += 1
        await refreshActiveMemberCount(ctx, camp._id)
        result.activeMemberCountsRefreshed += 1
      } else {
        result.adminMembershipsAlreadyPresent += 1
      }
    }

    const users = await ctx.db.query('users').collect()
    result.usersScanned = users.length

    for (const u of users) {
      const updates: { role?: 'admin' | 'user'; isAdmin?: true; updatedAt?: number } = {}
      if (u._id === adminUser._id) {
        if (u.role !== 'admin') {
          updates.role = 'admin'
          result.adminRoleSet += 1
        }
        if (u.isAdmin !== true) {
          updates.isAdmin = true
          result.adminFlagSet += 1
        }
      } else if (u.isAdmin === true && u.role !== 'admin') {
        updates.role = 'admin'
        result.adminRoleSet += 1
      } else if (!u.role) {
        updates.role = 'user'
        result.userRolesSet += 1
      }

      if (Object.keys(updates).length > 0) {
        await ctx.db.patch(u._id, {
          ...updates,
          updatedAt: now,
        })
      }
    }

    return result
  },
})

export const adminBackfillAdmin = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now()

    const adminUser = await ctx.db
      .query('users')
      .withIndex('email', (q) => q.eq('email', 'admin@bondfires.org'))
      .first()

    if (!adminUser) {
      return {
        error: 'Admin user admin@bondfires.org not found. Create the admin account first.',
      }
    }

    const result = {
      campsOwnerSet: 0,
      campsAlreadyOwned: 0,
      adminMembershipsAdded: 0,
      adminMembershipsUpdated: 0,
      adminMembershipsAlreadyPresent: 0,
      activeMemberCountsRefreshed: 0,
      adminRoleSet: 0,
      adminFlagSet: 0,
      userRolesSet: 0,
      usersScanned: 0,
    }

    const camps = await ctx.db.query('camps').collect()
    for (const camp of camps) {
      let ownerId = camp.ownerId
      if (!camp.ownerId) {
        await ctx.db.patch(camp._id, {
          ownerId: adminUser._id,
          updatedAt: now,
        })
        ownerId = adminUser._id
        result.campsOwnerSet += 1
      } else {
        result.campsAlreadyOwned += 1
      }

      const adminMembershipRole = ownerId === adminUser._id ? 'owner' : 'moderator'
      const existingMembership = await getMembership(ctx, adminUser._id, camp._id)
      if (!existingMembership) {
        await upsertMembership(ctx, {
          userId: adminUser._id,
          campId: camp._id,
          role: adminMembershipRole,
          status: 'active',
        })
        result.adminMembershipsAdded += 1
        await refreshActiveMemberCount(ctx, camp._id)
        result.activeMemberCountsRefreshed += 1
      } else if (
        existingMembership.role !== adminMembershipRole ||
        existingMembership.status !== 'active'
      ) {
        await upsertMembership(ctx, {
          userId: adminUser._id,
          campId: camp._id,
          role: adminMembershipRole,
          status: 'active',
        })
        result.adminMembershipsUpdated += 1
        await refreshActiveMemberCount(ctx, camp._id)
        result.activeMemberCountsRefreshed += 1
      } else {
        result.adminMembershipsAlreadyPresent += 1
      }
    }

    const users = await ctx.db.query('users').collect()
    result.usersScanned = users.length

    for (const u of users) {
      const updates: { role?: 'admin' | 'user'; isAdmin?: true; updatedAt?: number } = {}
      if (u._id === adminUser._id) {
        if (u.role !== 'admin') {
          updates.role = 'admin'
          result.adminRoleSet += 1
        }
        if (u.isAdmin !== true) {
          updates.isAdmin = true
          result.adminFlagSet += 1
        }
      } else if (u.isAdmin === true && u.role !== 'admin') {
        updates.role = 'admin'
        result.adminRoleSet += 1
      } else if (!u.role) {
        updates.role = 'user'
        result.userRolesSet += 1
      }

      if (Object.keys(updates).length > 0) {
        await ctx.db.patch(u._id, {
          ...updates,
          updatedAt: now,
        })
      }
    }

    return result
  },
})

// ── Admin-Only Mutations ──

/**
 * Transfer camp ownership to another user.
 * Only callable by admin users (checked via user.role).
 */
export const setOwner = mutation({
  args: {
    campId: v.id('camps'),
    newOwnerId: v.id('users'),
  },
  handler: async (ctx, args) => {
    const currentUser = await getCurrentUser(ctx)
    if (!isAdmin(currentUser)) {
      throw new Error('Only admins can transfer camp ownership')
    }

    const camp = await ctx.db.get(args.campId)
    if (!camp) {
      throw new Error('Camp not found')
    }

    const newOwner = await ctx.db.get(args.newOwnerId)
    if (!newOwner) {
      throw new Error('New owner user not found')
    }

    const previousOwnerId = camp.ownerId
    const now = Date.now()

    // Update camp ownerId
    await ctx.db.patch(args.campId, {
      ownerId: args.newOwnerId,
      ownerDisplayName: newOwner.displayName ?? newOwner.name ?? undefined,
      updatedAt: now,
    })

    const newOwnerMembership = await getMembership(ctx, args.newOwnerId, args.campId)
    const newOwnerWasActive = newOwnerMembership?.status === 'active'
    await upsertMembership(ctx, {
      userId: args.newOwnerId,
      campId: args.campId,
      role: 'owner',
      status: 'active',
    })
    if (!newOwnerWasActive) {
      await refreshActiveMemberCount(ctx, args.campId)
    }

    if (previousOwnerId && previousOwnerId !== args.newOwnerId) {
      const prevOwnerMembership = await getMembership(ctx, previousOwnerId, args.campId)
      if (prevOwnerMembership && prevOwnerMembership.role === 'owner') {
        await ctx.db.patch(prevOwnerMembership._id, {
          role: 'member',
          updatedAt: now,
        })
      }
    }

    return { campId: args.campId, previousOwnerId, newOwnerId: args.newOwnerId }
  },
})

const campSettingsFields = {
  name: v.optional(v.string()),
  theme: v.optional(v.string()),
  purpose: v.optional(v.string()),
  icon: v.optional(v.string()),
  color: v.optional(v.string()),
  defaultPrompt: v.optional(v.string()),
  rules: v.optional(
    v.object({
      access: v.object({
        gender: v.optional(
          v.object({
            value: v.union(v.literal('male'), v.literal('female'), v.literal('any')),
            visibilityMode: accessVisibilityModeValidator,
          }),
        ),
        allowedTiers: v.optional(
          v.object({
            value: v.array(
              v.union(v.literal('free'), v.literal('plus'), v.literal('premium'), v.literal('pro')),
            ),
            visibilityMode: v.union(v.literal('hide'), v.literal('gate')),
          }),
        ),
        inviteOnly: v.optional(
          v.object({
            value: v.boolean(),
            visibilityMode: accessVisibilityModeValidator,
          }),
        ),
        minAge: v.optional(
          v.object({
            value: v.number(),
            visibilityMode: accessVisibilityModeValidator,
          }),
        ),
        maxAge: v.optional(
          v.object({
            value: v.number(),
            visibilityMode: accessVisibilityModeValidator,
          }),
        ),
      }),
      participation: v.object({
        maxDurationMs: v.optional(v.number()),
        maxResponses: v.optional(v.number()),
      }),
      advisory: v.object({
        guidelines: v.optional(v.array(v.string())),
        requiresTradeTags: v.optional(v.boolean()),
      }),
    }),
  ),
  nameOverride: v.optional(v.string()),
  access: v.optional(v.union(v.literal('open'), v.literal('approval'), v.literal('invite'))),
  status: v.optional(
    v.union(
      v.literal('active'),
      v.literal('frozen'),
      v.literal('grace'),
      v.literal('inactive'),
      v.literal('archived'),
    ),
  ),
}

/**
 * Update camp settings.
 * Callable by the camp owner or an admin.
 */
export const updateSettings = mutation({
  args: {
    campId: v.id('camps'),
    ...campSettingsFields,
  },
  handler: async (ctx, args) => {
    const { campId, ...fields } = args
    const user = await getCurrentUser(ctx)

    const camp = await ctx.db.get(campId)
    if (!camp) {
      throw new Error('Camp not found')
    }

    if (!isAdmin(user) && camp.ownerId !== user._id) {
      throw new Error('Only the camp owner or an admin can update camp settings')
    }

    if (fields.status !== undefined) {
      if (!isAdmin(user)) {
        const ownerStatusChange =
          camp.ownerId === user._id && (fields.status === 'frozen' || fields.status === 'archived')
        if (!ownerStatusChange) {
          throw new Error('Only admins can change camp status')
        }
      }
    }

    const updates: Record<string, unknown> = { updatedAt: Date.now() }

    if (fields.name !== undefined) updates.name = fields.name
    if (fields.theme !== undefined) updates.theme = fields.theme
    if (fields.purpose !== undefined) updates.purpose = fields.purpose
    if (fields.icon !== undefined) updates.icon = fields.icon
    if (fields.color !== undefined) updates.color = fields.color
    if (fields.defaultPrompt !== undefined) updates.defaultPrompt = fields.defaultPrompt
    if (fields.rules !== undefined) updates.rules = fields.rules
    if (fields.nameOverride !== undefined) updates.nameOverride = fields.nameOverride
    if (fields.access !== undefined) updates.access = fields.access
    if (fields.status !== undefined) updates.status = fields.status

    await ctx.db.patch(campId, updates)

    return campId
  },
})

import { v } from 'convex/values'
import type { Doc, Id } from './_generated/dataModel'
import type { MutationCtx, QueryCtx } from './_generated/server'
import { mutation, query } from './_generated/server'
import { auth } from './auth'
import type { SubscriptionTier } from './entitlements'
import {
  assertCanCreatePrivateCamp,
  getEntitlementSubscriptionTier,
  PAID_TIERS,
  TIER_RANK,
} from './entitlements'
import { throwUserError } from './errors'

type CampAccess = 'open' | 'approval' | 'invite'
type CampGender = 'male' | 'female' | 'any'

/** Visibility-rule evaluation result. tier_too_low = visible upgrade opp. */
type CampVisibilityResult = {
  visible: boolean
  reason: 'member' | 'ok' | 'wrong_gender' | 'tier_too_low' | 'underage' | 'invite_only'
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

const roleValidator = v.union(v.literal('owner'), v.literal('moderator'), v.literal('member'))
const memberStatusValidator = v.union(
  v.literal('pending'),
  v.literal('active'),
  v.literal('banned'),
)
const accessValidator = v.union(v.literal('open'), v.literal('approval'), v.literal('invite'))

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
  return user.isAdmin === true
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

function userMatchesCampGender(user: Doc<'users'> | null, campGender: CampGender | undefined) {
  return !campGender || campGender === 'any' || user?.gender === campGender
}

/**
 * Evaluate structured visibilityRules.
 * Tier-locked → visible (upgrade opportunity).
 * Gender/age/invite mismatch → hidden.
 */
function evaluateVisibilityRules(
  camp: Doc<'camps'>,
  user: Doc<'users'> | null,
  userTier: SubscriptionTier,
  membership: Doc<'campMembers'> | null,
): CampVisibilityResult {
  if (membership?.status === 'active') {
    return { visible: true, reason: 'member' }
  }

  const rules = camp.visibilityRules
  let tierTooLow = false
  if (rules && rules.length > 0) {
    for (const rule of rules) {
      switch (rule.type) {
        case 'gender':
          if (rule.gender && (!user || user.gender !== rule.gender)) {
            return { visible: false, reason: 'wrong_gender' }
          }
          break
        case 'minAge':
          if (rule.minAge !== undefined) {
            const age = user?.birthDate ? calculateAge(user.birthDate) : null
            if (age === null || age < rule.minAge) {
              return { visible: false, reason: 'underage' }
            }
          }
          break
        case 'minTier':
          if (rule.minTier && TIER_RANK[userTier] < TIER_RANK[rule.minTier]) {
            tierTooLow = true
          }
          break
        case 'inviteRequired':
          return { visible: false, reason: 'invite_only' }
      }
    }
  }

  if (
    !rules?.some((rule) => rule.type === 'gender') &&
    !userMatchesCampGender(user, camp.rules.gender)
  ) {
    return { visible: false, reason: 'wrong_gender' }
  }

  if (tierTooLow) {
    return { visible: true, reason: 'tier_too_low' }
  }

  if (camp.access === 'invite') {
    return { visible: false, reason: 'invite_only' }
  }

  return { visible: true, reason: 'ok' }
}

/**
 * Evaluate structured joinRules for server-side enforcement.
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

  if (camp.visibility === 'private') {
    return { canJoin: false, reason: 'private' }
  }

  const rules = camp.joinRules
  if (rules && rules.length > 0) {
    for (const rule of rules) {
      switch (rule.type) {
        case 'gender':
          if (rule.gender && user.gender !== rule.gender) {
            return { canJoin: false, reason: 'wrong_gender' }
          }
          break
        case 'minAge':
          if (rule.minAge !== undefined) {
            const age = user.birthDate ? calculateAge(user.birthDate) : null
            if (age === null || age < rule.minAge) {
              return { canJoin: false, reason: 'underage' }
            }
          }
          break
        case 'minTier':
          if (rule.minTier && TIER_RANK[userTier] < TIER_RANK[rule.minTier]) {
            return { canJoin: false, reason: 'tier_too_low' }
          }
          break
        case 'inviteRequired':
          return { canJoin: false, reason: 'invite_only' }
        case 'approvalRequired':
          // Not a hard block — join proceeds as pending.
          break
      }
    }
  }

  // Legacy fallback: camp.rules.gender
  if (!userMatchesCampGender(user, camp.rules.gender)) {
    return { canJoin: false, reason: 'wrong_gender' }
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
  const visibility = evaluateVisibilityRules(camp, user, userTier, membership)
  if (!visibility.visible) {
    return 2
  }
  if (visibility.reason === 'member' || visibility.reason === 'ok') {
    return 0
  }
  return 1
}

/** Human-readable locked reason from visibilityRules. */
function lockedReason(camp: Doc<'camps'>, userTier: SubscriptionTier): string | undefined {
  const rules = camp.visibilityRules ?? []
  const tierRule = rules.find((r) => r.type === 'minTier')
  if (tierRule?.minTier && TIER_RANK[userTier] < TIER_RANK[tierRule.minTier]) {
    return `Requires ${tierRule.minTier} tier`
  }
  return undefined
}

/** Resolve camp display name — private camps use nameOverride or ownerDisplayName. */
function resolveCampDisplayName(camp: Doc<'camps'>): string {
  if (camp.visibility === 'private') {
    return camp.nameOverride ?? camp.ownerDisplayName ?? camp.name
  }
  return camp.name
}

function getJoinMembershipStatus(camp: Doc<'camps'>): 'pending' | 'active' {
  if (
    camp.access === 'approval' ||
    camp.joinRules?.some((rule) => rule.type === 'approvalRequired')
  ) {
    return 'pending'
  }

  return 'active'
}

function isCampVisibleToUser(camp: Doc<'camps'>, membership?: Doc<'campMembers'>) {
  if (camp.status !== 'active' && camp.status !== 'frozen') {
    return false
  }

  return camp.visibility === 'public' || membership?.status === 'active'
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

async function ensureCamp(ctx: MutationCtx, seed: CampSeed, args?: { isLaunchCamp?: boolean }) {
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
      gender: seed.gender,
      maxDurationMs: 30 * 60 * 1000,
      requiresTradeTags: seed.requiresTradeTags ?? false,
      allowedTiers: [...ALL_TIERS],
      advisoryGuidelines: [...seed.advisoryGuidelines],
    },
    crisisBroadcast: seed.crisisBroadcast ?? false,
    welcomeBroadcast: seed.welcomeBroadcast ?? false,
    visibility: 'public' as const,
    access: 'open' as const,
    status: 'active' as const,
    bondfireCount: existing?.bondfireCount ?? 0,
    activeMemberCount: existing?.activeMemberCount ?? 0,
    isLaunchCamp: args?.isLaunchCamp ?? false,
    updatedAt: now,
  }

  if (existing) {
    await ctx.db.patch(existing._id, campFields)
    return existing._id
  }

  return await ctx.db.insert('camps', {
    ...campFields,
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
        // Always show public camps + camps with active membership
        if (camp.visibility === 'public') {
          return true
        }
        const membership = membershipsByCamp.get(camp._id)
        return membership?.status === 'active'
      })
      .map((camp) => {
        const membership = membershipsByCamp.get(camp._id) ?? null
        const rank = computeSortRank(camp, user, userTier, membership)
        const reason = lockedReason(camp, userTier)
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

    // Use structured visibility for non-members
    if (membership?.status !== 'active') {
      const user = userId ? await ctx.db.get(userId) : null
      const userTier =
        user && userId
          ? await getEntitlementSubscriptionTier(ctx, userId)
          : ('free' as SubscriptionTier)
      const visibility = evaluateVisibilityRules(camp, user, userTier, null)
      if (!visibility.visible) {
        return null
      }
    } else {
      // Fallback: private camp without membership
      if (!isCampVisibleToUser(camp, membership ?? undefined)) {
        return null
      }
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
    if (existingCamps.length > 0) {
      const user = await getCurrentUser(ctx)
      if (!isAdmin(user)) {
        throw new Error('Only admins can reseed camps')
      }
    }

    const arenaId = await ensureCamp(ctx, getArenaSeed(), { isLaunchCamp: false })
    const launchCampIds = []
    for (const seed of getLaunchCampSeeds()) {
      launchCampIds.push(await ensureCamp(ctx, seed, { isLaunchCamp: true }))
    }

    return {
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
        gender: 'any',
        maxDurationMs: tier === 'pro' ? undefined : 30 * 60 * 1000,
        allowedTiers: [...PAID_TIERS],
        advisoryGuidelines: [
          'The camp owner starts new Bondfires here.',
          'Invited members can respond to fires they can access.',
        ],
      },
      nameOverride: name, // Custom name set by owner
      ownerDisplayName: user.displayName ?? user.name ?? undefined, // Default fallback
      crisisBroadcast: false,
      welcomeBroadcast: false,
      visibility: 'private',
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

    return campId
  },
})

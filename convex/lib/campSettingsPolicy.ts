import { ConvexError } from 'convex/values'
import type { Doc } from '../_generated/dataModel'
import type { AgeBand } from '../agePolicy'
import type { SubscriptionTier } from '../entitlements'

/**
 * Pure rules for owner-editable camp settings: details, visibility, and the
 * `rules` object. The mutations in camps.ts own auth and side effects; these
 * helpers own validation and the shape of what gets written, so they can be
 * unit tested without a database. The app imports the readers and limits
 * too, so this file stays free of server-only imports.
 */

/** Same as errors.ts throwUserError, without pulling server code into the app. */
function throwUserError(message: string): never {
  throw new ConvexError(message)
}

export type CampAccess = Doc<'camps'>['access']
export type PublicCampAccess = Exclude<CampAccess, 'invite'>
export type CampRules = Doc<'camps'>['rules']
export type CampRuleVisibilityMode = 'hide' | 'gate'
export type CampGenderRule = 'any' | 'male' | 'female'

export const ALL_CAMP_TIERS: readonly SubscriptionTier[] = ['free', 'plus', 'premium', 'pro']
const PRIVATE_CAMP_DEFAULT_TIERS: readonly SubscriptionTier[] = ['plus', 'premium', 'pro']

/** Guidelines createPrivateCamp seeds. They describe invite-only behaviour. */
export const PRIVATE_CAMP_DEFAULT_GUIDELINES = [
  'The camp owner starts new Bondfires here.',
  'Invited members can respond to fires they can access.',
] as const

/** Theme createPrivateCamp seeds; the camp header shows it as a subtitle. */
export const PRIVATE_CAMP_THEME = 'Private Camp'

export const CAMP_SETTINGS_LIMITS = {
  nameMin: 3,
  nameMax: 60,
  purposeMax: 280,
  promptMax: 200,
  maxDurationMinutes: 180,
  maxResponses: 1000,
  guidelines: 10,
  guidelineLength: 200,
} as const

const AGE_BOUNDS: Record<AgeBand, { min: number; max: number }> = {
  teen: { min: 13, max: 17 },
  adult: { min: 18, max: 120 },
}

/** The ages an owner may set for a camp in this age band. */
export function campAgeBounds(ageBand: AgeBand): { min: number; max: number } {
  return AGE_BOUNDS[ageBand]
}

export function isPublicAccess(access: CampAccess): access is PublicCampAccess {
  return access !== 'invite'
}

// ---------------------------------------------------------------------------
// Details
// ---------------------------------------------------------------------------

export type CampDetailsInput = {
  name?: string
  purpose?: string
  defaultPrompt?: string
}

/**
 * Validate a details edit and return the camp patch. Private camps display
 * `nameOverride`, so a rename keeps it in step with `name`.
 */
export function buildCampDetailsPatch(
  camp: Pick<Doc<'camps'>, 'nameOverride'>,
  input: CampDetailsInput,
): Partial<Pick<Doc<'camps'>, 'name' | 'nameOverride' | 'purpose' | 'defaultPrompt'>> {
  const patch: Partial<Pick<Doc<'camps'>, 'name' | 'nameOverride' | 'purpose' | 'defaultPrompt'>> =
    {}

  if (input.name !== undefined) {
    const name = input.name.trim()
    if (name.length < CAMP_SETTINGS_LIMITS.nameMin) {
      throwUserError(`Camp name must be at least ${CAMP_SETTINGS_LIMITS.nameMin} characters`)
    }
    if (name.length > CAMP_SETTINGS_LIMITS.nameMax) {
      throwUserError(`Camp name can be at most ${CAMP_SETTINGS_LIMITS.nameMax} characters`)
    }
    patch.name = name
    if (camp.nameOverride !== undefined) {
      patch.nameOverride = name
    }
  }

  if (input.purpose !== undefined) {
    const purpose = input.purpose.trim()
    if (purpose.length === 0) {
      throwUserError('Add a purpose so people know what the camp is for')
    }
    if (purpose.length > CAMP_SETTINGS_LIMITS.purposeMax) {
      throwUserError(`Purpose can be at most ${CAMP_SETTINGS_LIMITS.purposeMax} characters`)
    }
    patch.purpose = purpose
  }

  if (input.defaultPrompt !== undefined) {
    const prompt = input.defaultPrompt.trim()
    if (prompt.length === 0) {
      throwUserError('Add a prompt to get people started')
    }
    if (prompt.length > CAMP_SETTINGS_LIMITS.promptMax) {
      throwUserError(`Prompt can be at most ${CAMP_SETTINGS_LIMITS.promptMax} characters`)
    }
    patch.defaultPrompt = prompt
  }

  return patch
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

/** The owner-editable subset of `rules`, in the shape the settings UI edits. */
export type CampRulesInput = {
  gender: CampGenderRule
  minAge: number | null
  maxAge: number | null
  allowedTiers: SubscriptionTier[]
  /** One mode for every access rule: show-but-block ('gate') or hide. */
  visibilityMode: CampRuleVisibilityMode
  /** null = no camp limit; each person's plan still applies. */
  maxDurationMinutes: number | null
  /** null = no limit on responses per Bondfire. */
  maxResponses: number | null
  requiresTradeTags: boolean
  guidelines: string[]
}

/** Send only edited fields so unrelated rules and concurrent section edits survive. */
export function changedCampRules(
  initial: CampRulesInput,
  current: CampRulesInput,
  fields: readonly (keyof CampRulesInput)[],
): Partial<CampRulesInput> {
  const changes: Partial<CampRulesInput> = {}
  for (const field of fields) {
    if (JSON.stringify(initial[field]) !== JSON.stringify(current[field])) {
      Object.assign(changes, { [field]: current[field] })
    }
  }
  return changes
}

function assertWholeNumberInRange(value: number, min: number, max: number, message: string) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throwUserError(message)
  }
}

/**
 * Validate an owner's rules edit and merge it into the camp's existing rules.
 * Fields the settings UI doesn't edit (e.g. `inviteOnly`) are preserved.
 */
export function buildCampRules(
  existing: CampRules,
  input: Partial<CampRulesInput>,
  ageBand: AgeBand,
): CampRules {
  const bounds = AGE_BOUNDS[ageBand]
  const mode = input.visibilityMode
  const minAge = input.minAge === undefined ? existing.access.minAge?.value : input.minAge
  const maxAge = input.maxAge === undefined ? existing.access.maxAge?.value : input.maxAge

  if (input.minAge != null) {
    assertWholeNumberInRange(
      input.minAge,
      bounds.min,
      bounds.max,
      `Minimum age must be between ${bounds.min} and ${bounds.max}`,
    )
  }
  if (input.maxAge != null) {
    assertWholeNumberInRange(
      input.maxAge,
      bounds.min,
      bounds.max,
      `Maximum age must be between ${bounds.min} and ${bounds.max}`,
    )
  }
  if (minAge != null && maxAge != null && minAge > maxAge) {
    throwUserError('Minimum age can’t be higher than maximum age')
  }

  const tiers =
    input.allowedTiers && ALL_CAMP_TIERS.filter((tier) => input.allowedTiers?.includes(tier))
  if (tiers?.length === 0) {
    throwUserError('Let at least one plan join')
  }

  if (input.maxDurationMinutes != null) {
    assertWholeNumberInRange(
      input.maxDurationMinutes,
      1,
      CAMP_SETTINGS_LIMITS.maxDurationMinutes,
      `Longest video must be between 1 and ${CAMP_SETTINGS_LIMITS.maxDurationMinutes} minutes`,
    )
  }
  if (input.maxResponses != null) {
    assertWholeNumberInRange(
      input.maxResponses,
      1,
      CAMP_SETTINGS_LIMITS.maxResponses,
      `Responses per Bondfire must be between 1 and ${CAMP_SETTINGS_LIMITS.maxResponses}`,
    )
  }

  const guidelines = input.guidelines?.map((line) => line.trim()).filter((line) => line.length > 0)
  if (guidelines && guidelines.length > CAMP_SETTINGS_LIMITS.guidelines) {
    throwUserError(`A camp can have at most ${CAMP_SETTINGS_LIMITS.guidelines} guidelines`)
  }
  if (guidelines?.some((line) => line.length > CAMP_SETTINGS_LIMITS.guidelineLength)) {
    throwUserError(`Keep each guideline under ${CAMP_SETTINGS_LIMITS.guidelineLength} characters`)
  }

  const access = { ...existing.access }
  if (input.gender !== undefined) {
    access.gender = {
      value: input.gender,
      visibilityMode: mode ?? access.gender?.visibilityMode ?? 'gate',
    }
  }
  if (tiers !== undefined) {
    access.allowedTiers = {
      value: tiers,
      visibilityMode: mode ?? access.allowedTiers?.visibilityMode ?? 'gate',
    }
  }
  for (const key of ['minAge', 'maxAge'] as const) {
    const value = input[key]
    if (value !== undefined) {
      access[key] =
        value === null
          ? undefined
          : { value, visibilityMode: mode ?? access[key]?.visibilityMode ?? 'gate' }
    }
  }
  if (mode !== undefined) {
    for (const key of ['gender', 'allowedTiers', 'minAge', 'maxAge'] as const) {
      const rule = access[key]
      if (rule) Object.assign(access, { [key]: { ...rule, visibilityMode: mode } })
    }
  }

  return {
    ...existing,
    access,
    participation: {
      ...existing.participation,
      ...(input.maxDurationMinutes !== undefined && {
        maxDurationMs:
          input.maxDurationMinutes === null ? undefined : input.maxDurationMinutes * 60_000,
      }),
      ...(input.maxResponses !== undefined && { maxResponses: input.maxResponses ?? undefined }),
    },
    advisory: {
      ...existing.advisory,
      ...(guidelines !== undefined && { guidelines }),
      ...(input.requiresTradeTags !== undefined && { requiresTradeTags: input.requiresTradeTags }),
    },
  }
}

/** Read a camp's rules back into the settings UI's shape. */
export function readCampRulesInput(rules: CampRules): CampRulesInput {
  const access = rules.access
  const mode =
    access.gender?.visibilityMode ??
    access.minAge?.visibilityMode ??
    access.maxAge?.visibilityMode ??
    access.allowedTiers?.visibilityMode ??
    'gate'
  const tiers = access.allowedTiers?.value ?? []
  return {
    gender: access.gender?.value ?? 'any',
    minAge: access.minAge?.value ?? null,
    maxAge: access.maxAge?.value ?? null,
    allowedTiers: tiers.length > 0 ? [...tiers] : [...ALL_CAMP_TIERS],
    visibilityMode: mode,
    maxDurationMinutes:
      rules.participation.maxDurationMs !== undefined
        ? Math.round(rules.participation.maxDurationMs / 60_000)
        : null,
    maxResponses: rules.participation.maxResponses ?? null,
    requiresTradeTags: rules.advisory.requiresTradeTags === true,
    guidelines: [...(rules.advisory.guidelines ?? [])],
  }
}

// ---------------------------------------------------------------------------
// Visibility
// ---------------------------------------------------------------------------

function sameTiers(a: readonly SubscriptionTier[], b: readonly SubscriptionTier[]) {
  return a.length === b.length && a.every((tier) => b.includes(tier))
}

/**
 * The camp patch for a visibility change. Going public strips what
 * createPrivateCamp seeded for invite-only use: the "Private Camp" subtitle,
 * the owner-sparks guidelines, and the hidden paid-only tier gate (invited
 * Free members join private camps through their code, but a public camp with
 * that gate would be invisible to every Free member).
 */
export function buildVisibilityPatch(
  camp: Pick<Doc<'camps'>, 'access' | 'theme' | 'rules'>,
  next: CampAccess,
): Partial<Pick<Doc<'camps'>, 'access' | 'theme' | 'rules'>> {
  const patch: Partial<Pick<Doc<'camps'>, 'access' | 'theme' | 'rules'>> = { access: next }
  const goingPublic = camp.access === 'invite' && isPublicAccess(next)
  if (!goingPublic) {
    return patch
  }

  if (camp.theme === PRIVATE_CAMP_THEME) {
    patch.theme = undefined
  }

  const rules = camp.rules
  const defaults: readonly string[] = PRIVATE_CAMP_DEFAULT_GUIDELINES
  const guidelines = (rules.advisory.guidelines ?? []).filter((line) => !defaults.includes(line))
  const tierRule = rules.access.allowedTiers
  const isPrivateTierDefault =
    camp.theme === PRIVATE_CAMP_THEME &&
    tierRule !== undefined &&
    tierRule.visibilityMode === 'hide' &&
    sameTiers(tierRule.value, PRIVATE_CAMP_DEFAULT_TIERS)

  patch.rules = {
    ...rules,
    access: {
      ...rules.access,
      allowedTiers: isPrivateTierDefault
        ? { value: [...ALL_CAMP_TIERS], visibilityMode: 'gate' }
        : tierRule,
    },
    advisory: { ...rules.advisory, guidelines },
  }
  return patch
}

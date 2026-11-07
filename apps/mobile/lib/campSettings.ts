import type { Doc } from '../../../convex/_generated/dataModel'
import type { CampRulesInput } from '../../../convex/lib/campSettingsPolicy'

export type CampAccess = Doc<'camps'>['access']
export type CampVisibility = 'public' | 'private'
export type CampJoinMode = 'open' | 'approval'
export type CampVisibilityChoice = { visibility: CampVisibility; join: CampJoinMode }

export type { CampRulesInput }

/** Map the settings UI's two questions onto the camp's single `access` field. */
export function accessFromChoice(choice: CampVisibilityChoice): CampAccess {
  return choice.visibility === 'private' ? 'invite' : choice.join
}

export function choiceFromAccess(access: CampAccess): CampVisibilityChoice {
  if (access === 'invite') return { visibility: 'private', join: 'approval' }
  return { visibility: 'public', join: access }
}

export function describeAccess(access: CampAccess): { title: string; detail: string } {
  if (access === 'invite') {
    return {
      title: 'Private',
      detail: 'Invite code only. You spark; members respond.',
    }
  }
  if (access === 'approval') {
    return {
      title: 'Public · Approval required',
      detail: 'Anyone can find it. You approve who joins.',
    }
  }
  return { title: 'Public · Open', detail: 'Anyone can find it and join right away.' }
}

const GENDER_LABEL = { any: null, male: 'Men', female: 'Women' } as const
const ALL_TIERS = ['free', 'plus', 'premium', 'pro'] as const
const TIER_LABEL = { free: 'Free', plus: 'Plus', premium: 'Premium', pro: 'Pro' } as const

export function tierLabel(tier: (typeof ALL_TIERS)[number]): string {
  return TIER_LABEL[tier]
}

export function describeAgeRange(minAge: number | null, maxAge: number | null): string | null {
  if (minAge !== null && maxAge !== null) return `${minAge}–${maxAge}`
  if (minAge !== null) return `${minAge}+`
  if (maxAge !== null) return `Up to ${maxAge}`
  return null
}

/** "Men · 21+ · Any plan" — the Who can join row's summary. */
export function describeWhoCanJoin(rules: CampRulesInput): string {
  const parts: string[] = [GENDER_LABEL[rules.gender] ?? 'Anyone']
  const age = describeAgeRange(rules.minAge, rules.maxAge)
  if (age) parts.push(age)
  const allTiers = ALL_TIERS.every((tier) => rules.allowedTiers.includes(tier))
  parts.push(
    allTiers
      ? 'Any plan'
      : ALL_TIERS.filter((tier) => rules.allowedTiers.includes(tier))
          .map(tierLabel)
          .join(', '),
  )
  return parts.join(' · ')
}

/** "Max 10 min · No response limit" — the Videos and responses row's summary. */
export function describeParticipation(rules: CampRulesInput): string {
  const length =
    rules.maxDurationMinutes !== null ? `Max ${rules.maxDurationMinutes} min` : 'Plan length limit'
  const responses =
    rules.maxResponses !== null
      ? `${rules.maxResponses} ${rules.maxResponses === 1 ? 'response' : 'responses'} max`
      : 'No response limit'
  return [length, responses].join(' · ')
}

/** Rule pills on the camp page, beyond access and member count. */
export function campRulePills(rules: CampRulesInput): string[] {
  const pills: string[] = []
  const gender = GENDER_LABEL[rules.gender]
  if (gender) pills.push(gender)
  const age = describeAgeRange(rules.minAge, rules.maxAge)
  if (age) pills.push(age)
  if (rules.maxDurationMinutes !== null) pills.push(`Max ${rules.maxDurationMinutes} min`)
  if (rules.maxResponses !== null) pills.push(`${rules.maxResponses} responses max`)
  if (rules.requiresTradeTags) pills.push('Need/offer tags')
  return pills
}

/**
 * Parse a typed whole number for a limit stepper. Returns null for anything
 * that isn't a whole number so the field can keep its last good value.
 */
export function parseLimitInput(text: string, min: number, max: number): number | null {
  const trimmed = text.trim()
  if (!/^\d+$/.test(trimmed)) return null
  return Math.min(max, Math.max(min, Number(trimmed)))
}

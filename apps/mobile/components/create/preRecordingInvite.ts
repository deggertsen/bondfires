import type { Id } from '../../../../convex/_generated/dataModel'

export const MAX_TITLE_LENGTH = 80
export const MAX_EMAIL_INVITES = 10

type InviteCandidate = {
  _id: Id<'users'>
  displayName?: string
  name?: string
  photoUrl?: string
}

/** Relationship a person has to the current user, most trusted first. */
export type AudienceGroup = 'family' | 'closeCircle' | 'recent'
export type AudienceFilterKey = 'all' | AudienceGroup

export interface AudienceItem {
  candidate: InviteCandidate
  group: AudienceGroup
  hint: string
}

export interface AudienceFilter {
  key: AudienceFilterKey
  label: string
  count: number
}

const AUDIENCE_HINTS: Record<AudienceGroup, string> = {
  family: 'Family connection',
  closeCircle: 'Close Circle',
  recent: 'Recent',
}

const AUDIENCE_LABELS: Record<AudienceFilterKey, string> = {
  all: 'All',
  family: 'Family',
  closeCircle: 'Close Circle',
  recent: 'Recent',
}

/**
 * Merge the three candidate lists into one rail. A person can appear in both
 * Close Circle and Recent, and family connections are excluded server-side
 * from Close Circle — the first list that claims an id wins the label, so the
 * most trusted relationship is the one shown.
 */
export function buildAudienceItems(
  familyConnections: ReadonlyArray<InviteCandidate>,
  closeCircle: ReadonlyArray<InviteCandidate>,
  recentConnections: ReadonlyArray<InviteCandidate>,
): AudienceItem[] {
  const claimed = new Set<Id<'users'>>()
  const items: AudienceItem[] = []
  const groups: ReadonlyArray<{
    group: AudienceGroup
    candidates: ReadonlyArray<InviteCandidate>
  }> = [
    { group: 'family', candidates: familyConnections },
    { group: 'closeCircle', candidates: closeCircle },
    { group: 'recent', candidates: recentConnections },
  ]

  for (const { group, candidates } of groups) {
    for (const candidate of candidates) {
      if (claimed.has(candidate._id)) continue
      claimed.add(candidate._id)
      items.push({ candidate, group, hint: AUDIENCE_HINTS[group] })
    }
  }

  return items
}

/** Filter chips for the merged rail; empty groups are dropped. */
export function buildAudienceFilters(items: ReadonlyArray<AudienceItem>): AudienceFilter[] {
  const keys: AudienceFilterKey[] = ['all', 'family', 'closeCircle', 'recent']
  return keys
    .map((key) => ({
      key,
      label: AUDIENCE_LABELS[key],
      count: key === 'all' ? items.length : items.filter((item) => item.group === key).length,
    }))
    .filter((filter) => filter.key === 'all' || filter.count > 0)
}

/**
 * A filter can outlive its candidates (a connection revoked in another
 * session), which would leave an empty rail behind a selected chip.
 */
export function resolveAudienceFilter(
  key: AudienceFilterKey,
  filters: ReadonlyArray<AudienceFilter>,
): AudienceFilterKey {
  return filters.some((filter) => filter.key === key) ? key : 'all'
}

/**
 * Items to render for the active filter. Selected people stay pinned to the
 * front even when the filter hides them, so a chosen invitee never disappears
 * from the rail mid-edit.
 */
export function selectAudienceItems(
  items: ReadonlyArray<AudienceItem>,
  filter: AudienceFilterKey,
  selectedIds: ReadonlyArray<Id<'users'>>,
): AudienceItem[] {
  const visible = filter === 'all' ? [...items] : items.filter((item) => item.group === filter)
  const visibleIds = new Set(visible.map((item) => item.candidate._id))
  const pinned = items.filter(
    (item) => selectedIds.includes(item.candidate._id) && !visibleIds.has(item.candidate._id),
  )
  return [...pinned, ...visible]
}

export function isValidInviteEmail(value: string): boolean {
  const email = value.trim()
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
}

function firstName(candidate: InviteCandidate): string {
  return (candidate.displayName ?? candidate.name ?? '').trim().split(/\s+/)[0] ?? ''
}

function emailHandle(email: string): string {
  const handle = email.trim().split('@')[0] ?? ''
  return handle ? `${handle[0]?.toUpperCase()}${handle.slice(1)}` : ''
}

/** Build a short audience-aware title from selected people and email invitees. */
export function buildAutoTitle(
  candidates: ReadonlyArray<InviteCandidate>,
  selectedIds: ReadonlyArray<Id<'users'>>,
  emails: ReadonlyArray<string> = [],
): string {
  const labels = [
    ...candidates.filter((candidate) => selectedIds.includes(candidate._id)).map(firstName),
    ...emails.map(emailHandle),
  ].filter((label) => label.length > 0)

  const uniqueLabels = labels.filter(
    (label, index) =>
      labels.findIndex((candidate) => candidate.toLowerCase() === label.toLowerCase()) === index,
  )

  let title: string
  if (uniqueLabels.length === 0) return ''
  if (uniqueLabels.length === 1) {
    title = `Hey ${uniqueLabels[0]}`
  } else if (uniqueLabels.length === 2) {
    title = `Hey ${uniqueLabels[0]} & ${uniqueLabels[1]}`
  } else {
    const visible = uniqueLabels.slice(0, 3)
    const remaining = uniqueLabels.length - visible.length
    title =
      remaining === 0
        ? `Hey ${visible.slice(0, -1).join(', ')} & ${visible[visible.length - 1]}`
        : `Hey ${visible.join(', ')} & ${remaining} more`
  }

  return title.slice(0, MAX_TITLE_LENGTH)
}

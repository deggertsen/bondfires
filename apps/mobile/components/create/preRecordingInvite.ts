import type { Id } from '../../../../convex/_generated/dataModel'

export const MAX_TITLE_LENGTH = 80
export const MAX_EMAIL_INVITES = 10

type InviteCandidate = {
  _id: Id<'users'>
  displayName?: string
  name?: string
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

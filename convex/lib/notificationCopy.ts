/**
 * Push notification body helpers — summary formatting and copy polish.
 * Kept pure so unit tests can cover fallbacks without Convex runtime.
 */

/** Build `Name: Rest of summary` from a third-person AI summary. */
export function bodyFromSummary(actorName: string, summary: string): string {
  const firstName = (actorName.trim().split(/\s+/)[0] || 'Someone').trim()
  const trimmed = summary.replace(/\s+/g, ' ').trim()
  if (!trimmed) return `${firstName} added a video to a Bondfire you're in`

  const withoutName = trimmed
    .replace(new RegExp(`^${escapeRegExp(firstName)}(?:'s)?\\s+`, 'i'), '')
    .trim()
  const rest = withoutName || trimmed
  const capitalized = rest.charAt(0).toUpperCase() + rest.slice(1)
  return `${firstName}: ${capitalized}`
}

/** Response publish body — summary when available, else generic fallback. */
export function responsePublishBody(
  responderName: string,
  summary: string | null | undefined,
): string {
  if (summary?.trim()) {
    return bodyFromSummary(responderName, summary)
  }
  return `${responderName} added a video to a Bondfire you're in`
}

/** Live response body — title-based, never summary (transcript not ready). */
export function responseLiveBody(
  responderName: string,
  bondfireTitle: string | null | undefined,
): string {
  return bondfireTitle
    ? `${responderName} is responding in "${bondfireTitle}" — watch live or later`
    : `${responderName} is responding live — watch now or later`
}

/** Camp / Hearth publish body when a summary exists. */
export function sparkPublishBodyWithSummary(creatorName: string, summary: string): string {
  return bodyFromSummary(creatorName, summary)
}

/** Single-item digest body with optional summary. */
export function digestSingleBody(item: {
  creatorName: string | null
  title: string | null
  kind: 'response' | 'bondfire'
  summary?: string | null
}): string {
  const name = item.creatorName ?? 'Someone'
  if (item.kind === 'bondfire') {
    if (item.summary?.trim()) {
      return bodyFromSummary(name, item.summary)
    }
    return item.title ? `${name} started "${item.title}"` : `${name} started a new Bondfire`
  }

  if (item.summary?.trim()) {
    // Plan nice-to-have: `David responded: Shares news…`
    const firstName = name.trim().split(/\s+/)[0] || 'Someone'
    const withoutName = item.summary
      .replace(/\s+/g, ' ')
      .trim()
      .replace(new RegExp(`^${escapeRegExp(firstName)}(?:'s)?\\s+`, 'i'), '')
      .trim()
    const rest = withoutName || item.summary.trim()
    const capitalized = rest.charAt(0).toUpperCase() + rest.slice(1)
    return `${firstName} responded: ${capitalized}`
  }

  return item.title
    ? `${name} responded in "${item.title}"`
    : `${name} added a video to a Bondfire you're in`
}

/** Hearth join copy — include bondfire title when present. */
export function hearthJoinBody(
  joinerName: string,
  bondfireTitle: string | null | undefined,
): string {
  if (bondfireTitle?.trim()) {
    return `${joinerName} joined "${bondfireTitle.trim()}"`
  }
  return `${joinerName} joined the conversation`
}

/** Access-approved push title. */
export function accessApprovedTitle(campName: string): string {
  return `${campName} let you in`
}

/** Access-approved push body (warmer copy). */
export function accessApprovedBody(): string {
  return "You're now a member — tap to look around"
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

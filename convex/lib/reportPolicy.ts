export const MIN_REPORT_COMMENT_LENGTH = 30
export const MAX_REPORT_COMMENT_LENGTH = 2_000
export const MAX_REPORTS_PER_DAY = 5

export function validateReportTargetCount(targets: unknown[]) {
  if (targets.filter(Boolean).length !== 1) {
    throw new Error('Exactly one content or user target must be provided')
  }
}

export function normalizeReportComments(comments: string) {
  const normalized = comments.trim()
  if (
    normalized.length < MIN_REPORT_COMMENT_LENGTH ||
    normalized.length > MAX_REPORT_COMMENT_LENGTH
  ) {
    throw new Error(
      `Comments must be between ${MIN_REPORT_COMMENT_LENGTH} and ${MAX_REPORT_COMMENT_LENGTH} characters`,
    )
  }
  return normalized
}

export function hasReachedDailyReportLimit(recentReportCount: number) {
  return recentReportCount >= MAX_REPORTS_PER_DAY
}

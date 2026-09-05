const REDACTED = '[Redacted]'
const SENSITIVE_KEY =
  /(?:authorization|cookie|password|secret|token|email|birth|dob|invite|\bcode\b|url|uri|playback|upload|asset|media)/i
const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi
const URL = /\b(?:https?|wss?|bondfires):\/\/[^\s"'<>]+/gi
const JWT = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi
const SECURE_INVITE = /\bbf-(?:[a-z0-9]{4}-){4}[a-z0-9]{4}\b/gi
const FAMILY_INVITE = /\bfamily-[0-9a-f]{32}\b/gi
const LEGACY_INVITE = /\b[a-z]{3,}-[a-z]{3,}-[a-z]{3,}\b/gi
const SECRET_ASSIGNMENT = /\b(?:token|secret|password|authorization|code)=([^\s&]+)/gi
const ISO_CALENDAR_DATE = /\b(?:19|20)\d{2}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])\b/g

export function redactSensitiveText(value: string): string {
  return value
    .replace(BEARER, REDACTED)
    .replace(JWT, REDACTED)
    .replace(EMAIL, REDACTED)
    .replace(URL, REDACTED)
    .replace(SECURE_INVITE, REDACTED)
    .replace(FAMILY_INVITE, REDACTED)
    .replace(LEGACY_INVITE, REDACTED)
    .replace(SECRET_ASSIGNMENT, (_match, _value) => REDACTED)
    .replace(ISO_CALENDAR_DATE, REDACTED)
}

export function scrubTelemetryValue(
  value: unknown,
  depth = 0,
  seen = new WeakSet<object>(),
): unknown {
  if (typeof value === 'string') return redactSensitiveText(value)
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value
  if (value === undefined) return undefined
  if (value instanceof Error) {
    return {
      name: redactSensitiveText(value.name),
      message: redactSensitiveText(value.message),
      stack: value.stack ? redactSensitiveText(value.stack) : undefined,
    }
  }
  if (typeof value !== 'object') return String(value)
  if (seen.has(value)) return '[Circular]'
  if (depth >= 5) return '[MaxDepth]'
  seen.add(value)

  if (Array.isArray(value)) {
    return value.map((item) => scrubTelemetryValue(item, depth + 1, seen))
  }

  const output: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    // Dynamic keys can themselves contain an email, invite, or media URL.
    if (redactSensitiveText(key) !== key) continue
    output[key] = SENSITIVE_KEY.test(key) ? REDACTED : scrubTelemetryValue(item, depth + 1, seen)
  }
  return output
}

export function isSensitiveTelemetryKey(key: string): boolean {
  return SENSITIVE_KEY.test(key)
}

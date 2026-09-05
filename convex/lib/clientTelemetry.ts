export const CLIENT_LOG_LIMITS = {
  eventBytes: 128,
  messageBytes: 4096,
  appVersionBytes: 64,
  sessionIdBytes: 128,
  deviceFieldBytes: 128,
  dataBytes: 16 * 1024,
  dataDepth: 8,
  dataNodes: 1000,
  batchEntries: 20,
  timestampPastMs: 24 * 60 * 60 * 1000,
  timestampFutureMs: 5 * 60 * 1000,
  entriesPerMinute: 120,
  entriesPerHour: 1200,
} as const

type ClientDeviceInfo = {
  modelName?: string
  osVersion?: string
  osName?: string
  manufacturer?: string
  brand?: string
}

export type ClientLogInput = {
  event: string
  message: string
  data?: unknown
  appVersion?: string
  sessionId?: string
  createdAt: number
  device?: ClientDeviceInfo
}

export type ClientLogRateState = {
  minuteWindowStartedAt: number
  minuteCount: number
  hourWindowStartedAt: number
  hourCount: number
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

function validateString(name: string, value: string | undefined, maxBytes: number): void {
  if (value === undefined) return
  if (utf8ByteLength(value) > maxBytes) {
    throw new Error(`${name} exceeds the ${maxBytes}-byte limit`)
  }
}

function validateDataValue(value: unknown, state: { nodes: number }, depth: number): void {
  state.nodes++
  if (state.nodes > CLIENT_LOG_LIMITS.dataNodes) {
    throw new Error(`data exceeds the ${CLIENT_LOG_LIMITS.dataNodes}-value limit`)
  }
  if (depth > CLIENT_LOG_LIMITS.dataDepth) {
    throw new Error(`data exceeds the maximum depth of ${CLIENT_LOG_LIMITS.dataDepth}`)
  }

  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  ) {
    return
  }

  if (Array.isArray(value)) {
    for (const item of value) validateDataValue(item, state, depth + 1)
    return
  }

  if (typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error('data must contain only JSON-compatible values')
    }
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      validateString('data key', key, CLIENT_LOG_LIMITS.eventBytes)
      validateDataValue(item, state, depth + 1)
    }
    return
  }

  throw new Error('data must contain only finite JSON-compatible values')
}

function validateData(data: unknown): void {
  if (data === undefined) return
  validateDataValue(data, { nodes: 0 }, 0)

  const serialized = JSON.stringify(data)
  if (serialized === undefined || utf8ByteLength(serialized) > CLIENT_LOG_LIMITS.dataBytes) {
    throw new Error(`data exceeds the ${CLIENT_LOG_LIMITS.dataBytes}-byte limit`)
  }
}

export function validateClientLogEntry(entry: ClientLogInput, now: number): void {
  validateString('event', entry.event, CLIENT_LOG_LIMITS.eventBytes)
  if (entry.event.length === 0) throw new Error('event cannot be empty')
  validateString('message', entry.message, CLIENT_LOG_LIMITS.messageBytes)
  validateString('appVersion', entry.appVersion, CLIENT_LOG_LIMITS.appVersionBytes)
  validateString('sessionId', entry.sessionId, CLIENT_LOG_LIMITS.sessionIdBytes)

  if (!Number.isSafeInteger(entry.createdAt)) {
    throw new Error('createdAt must be a safe integer timestamp')
  }
  if (entry.createdAt < now - CLIENT_LOG_LIMITS.timestampPastMs) {
    throw new Error('createdAt is too old')
  }
  if (entry.createdAt > now + CLIENT_LOG_LIMITS.timestampFutureMs) {
    throw new Error('createdAt is too far in the future')
  }

  if (entry.device) {
    for (const [key, value] of Object.entries(entry.device)) {
      validateString(`device.${key}`, value, CLIENT_LOG_LIMITS.deviceFieldBytes)
    }
  }

  validateData(entry.data)
}

export function validateClientLogBatch(entries: ClientLogInput[], now: number): void {
  if (entries.length === 0) throw new Error('Telemetry batch cannot be empty')
  if (entries.length > CLIENT_LOG_LIMITS.batchEntries) {
    throw new Error(`Cannot batch more than ${CLIENT_LOG_LIMITS.batchEntries} entries per call`)
  }
  for (const entry of entries) validateClientLogEntry(entry, now)
}

export function reserveClientLogRateLimit(
  existing: ClientLogRateState | null,
  now: number,
  requestedEntries: number,
): ClientLogRateState {
  if (!Number.isSafeInteger(requestedEntries) || requestedEntries < 1) {
    throw new Error('Telemetry rate reservation must be a positive integer')
  }

  const minuteActive =
    existing !== null &&
    now >= existing.minuteWindowStartedAt &&
    now - existing.minuteWindowStartedAt < 60_000
  const hourActive =
    existing !== null &&
    now >= existing.hourWindowStartedAt &&
    now - existing.hourWindowStartedAt < 60 * 60_000

  const next: ClientLogRateState = {
    minuteWindowStartedAt: minuteActive ? existing.minuteWindowStartedAt : now,
    minuteCount: (minuteActive ? existing.minuteCount : 0) + requestedEntries,
    hourWindowStartedAt: hourActive ? existing.hourWindowStartedAt : now,
    hourCount: (hourActive ? existing.hourCount : 0) + requestedEntries,
  }

  if (next.minuteCount > CLIENT_LOG_LIMITS.entriesPerMinute) {
    throw new Error('Telemetry rate limit exceeded; retry later')
  }
  if (next.hourCount > CLIENT_LOG_LIMITS.entriesPerHour) {
    throw new Error('Telemetry hourly rate limit exceeded; retry later')
  }

  return next
}

/**
 * Client-side telemetry logger (singleton).
 *
 * Queues breadcrumbs, errors, and warnings in memory and batch-flushes
 * them to the Convex `clientLogs` table every 10 seconds.  Also hooks
 * React Native's global error handler to capture unhandled exceptions.
 */

import Constants from 'expo-constants'
import * as Device from 'expo-device'
import { AppState, Platform } from 'react-native'
import { createMMKV, type MMKV } from 'react-native-mmkv'
import { redactSensitiveText, scrubTelemetryValue } from './privacyScrubber'

// ---------------------------------------------------------------------------
// React Native global declarations
// ---------------------------------------------------------------------------

// ErrorUtils is provided by React Native at runtime.
// We access it via globalThis to avoid redeclaring the ambient type.
const ErrorUtils = (globalThis as Record<string, unknown>)?.ErrorUtils as
  | {
      getGlobalHandler: () => ((error: Error, isFatal?: boolean) => void) | undefined
      setGlobalHandler: (handler: (error: Error, isFatal?: boolean) => void) => void
    }
  | undefined

// Hermes exposes a promise-rejection tracker; without it, rejected promises
// that never get a .catch are completely invisible in production.
const HermesInternal = (globalThis as Record<string, unknown>)?.HermesInternal as
  | {
      enablePromiseRejectionTracker?: (options: {
        allRejections: boolean
        onUnhandled: (id: number, error: unknown) => void
        onHandled?: (id: number) => void
      }) => void
    }
  | undefined

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LogLevel = 'error' | 'warn' | 'info' | 'breadcrumb'

export interface DeviceInfo {
  modelName?: string
  osVersion?: string
  osName?: string
  manufacturer?: string
  brand?: string
}

export interface LogEntry {
  level: LogLevel
  event: string
  message: string
  data?: unknown
  platform: 'ios' | 'android'
  appVersion?: string
  sessionId?: string
  createdAt: number
  /** Local routing marker only. It is stripped before network submission. */
  localUserId?: string
  /** Device info captured at startup; included on every entry for crash triage. */
  device?: DeviceInfo
}

// ---------------------------------------------------------------------------
// UUID v4 (lightweight, no dependency)
// ---------------------------------------------------------------------------

function generateSessionId(): string {
  const hex = '0123456789abcdef'
  let id = ''
  for (let i = 0; i < 32; i++) {
    if (i === 12) id += '4'
    else if (i === 16) id += hex[(Number.parseInt(id[15], 16) & 3) | 8]
    else id += hex[Math.floor(Math.random() * 16)]
    if ([7, 11, 15, 19].includes(i)) id += '-'
  }
  return id
}

// ---------------------------------------------------------------------------
// Queue
// ---------------------------------------------------------------------------

const MAX_QUEUE_SIZE = 100
const FLUSH_INTERVAL_MS = 10000
const MAX_SERIALIZE_DEPTH = 5
const MAX_SERIALIZE_KEYS = 50
const MAX_SERIALIZE_ARRAY_ITEMS = 100
const TELEMETRY_BATCH_SIZE = 20
const PERSIST_DEBOUNCE_MS = 1000
const STORAGE_ID = 'bondfires-telemetry'
const STORAGE_KEY = 'queue'
const LAST_CRASH_KEY = 'last-crash-breadcrumb'
const CLIENT_EVENT_MAX_BYTES = 128
const CLIENT_MESSAGE_MAX_BYTES = 4096
const CLIENT_DATA_PREVIEW_MAX_BYTES = 6 * 1024
const CLIENT_APP_VERSION_MAX_BYTES = 64
const CLIENT_METADATA_MAX_BYTES = 128
const CLIENT_LOG_MAX_AGE_MS = 23 * 60 * 60 * 1000

function utf8ByteLength(value: string): number {
  let bytes = 0
  for (const char of value) {
    const codePoint = char.codePointAt(0) ?? 0
    if (codePoint <= 0x7f) bytes += 1
    else if (codePoint <= 0x7ff) bytes += 2
    else if (codePoint <= 0xffff) bytes += 3
    else bytes += 4
  }
  return bytes
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (utf8ByteLength(value) <= maxBytes) return value

  const suffix = '…'
  const target = Math.max(0, maxBytes - utf8ByteLength(suffix))
  let bytes = 0
  let output = ''
  for (const char of value) {
    const charBytes = utf8ByteLength(char)
    if (bytes + charBytes > target) break
    output += char
    bytes += charBytes
  }
  return `${output}${suffix}`
}

function serializeForConvex(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value === 'boolean') {
    return value
  }

  if (typeof value === 'string') return truncateUtf8(value, CLIENT_MESSAGE_MAX_BYTES)

  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : String(value)
  }

  if (typeof value === 'undefined') return undefined
  if (typeof value === 'bigint' || typeof value === 'symbol' || typeof value === 'function') {
    return String(value)
  }

  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
    }
  }

  if (value instanceof Date) {
    return value.toISOString()
  }

  if (typeof value !== 'object') {
    return String(value)
  }

  if (seen.has(value)) {
    return '[Circular]'
  }

  if (depth >= MAX_SERIALIZE_DEPTH) {
    return '[MaxDepth]'
  }

  seen.add(value)

  if (Array.isArray(value)) {
    const output = value.slice(0, MAX_SERIALIZE_ARRAY_ITEMS).map((item) => {
      const serialized = serializeForConvex(item, depth + 1, seen)
      return typeof serialized === 'undefined' ? null : serialized
    })
    if (value.length > MAX_SERIALIZE_ARRAY_ITEMS) output.push('[Truncated]')
    return output
  }

  const output: Record<string, unknown> = {}
  for (const [index, [key, item]] of Object.entries(value as Record<string, unknown>).entries()) {
    if (index >= MAX_SERIALIZE_KEYS) {
      output.__truncated = true
      break
    }

    const serialized = serializeForConvex(item, depth + 1, seen)
    if (typeof serialized !== 'undefined') {
      output[key] = serialized
    }
  }

  return output
}

function boundTelemetryData(value: unknown): unknown {
  const serialized = serializeForConvex(value)
  if (serialized === undefined) return undefined

  try {
    const json = JSON.stringify(serialized)
    if (utf8ByteLength(json) <= CLIENT_DATA_PREVIEW_MAX_BYTES) return serialized
    return {
      __truncated: true,
      preview: truncateUtf8(json, CLIENT_DATA_PREVIEW_MAX_BYTES),
    }
  } catch {
    return { __truncated: true, preview: '[Unserializable telemetry data]' }
  }
}

function formatConsoleArgs(args: unknown[]): string {
  return args
    .map((arg) => {
      if (typeof arg === 'string') return arg
      if (arg instanceof Error) return arg.message

      try {
        return JSON.stringify(serializeForConvex(arg))
      } catch {
        return String(arg)
      }
    })
    .join(' ')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function telemetryErrorCode(error: unknown): string | undefined {
  if (!isRecord(error)) return undefined
  if (isRecord(error.data) && typeof error.data.code === 'string') return error.data.code
  return typeof error.code === 'string' ? error.code : undefined
}

function isLogLevel(value: unknown): value is LogLevel {
  return value === 'error' || value === 'warn' || value === 'info' || value === 'breadcrumb'
}

function isPlatform(value: unknown): value is LogEntry['platform'] {
  return value === 'ios' || value === 'android'
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function optionalBoundedString(value: unknown, maxBytes: number): string | undefined {
  const stringValue = optionalString(value)
  return stringValue === undefined ? undefined : truncateUtf8(stringValue, maxBytes)
}

function normalizeDeviceInfo(value: unknown): DeviceInfo | undefined {
  if (!isRecord(value)) return undefined

  const device: DeviceInfo = {}
  const modelName = optionalBoundedString(value.modelName, CLIENT_METADATA_MAX_BYTES)
  const osVersion = optionalBoundedString(value.osVersion, CLIENT_METADATA_MAX_BYTES)
  const osName = optionalBoundedString(value.osName, CLIENT_METADATA_MAX_BYTES)
  const manufacturer = optionalBoundedString(value.manufacturer, CLIENT_METADATA_MAX_BYTES)
  const brand = optionalBoundedString(value.brand, CLIENT_METADATA_MAX_BYTES)

  if (modelName !== undefined) device.modelName = modelName
  if (osVersion !== undefined) device.osVersion = osVersion
  if (osName !== undefined) device.osName = osName
  if (manufacturer !== undefined) device.manufacturer = manufacturer
  if (brand !== undefined) device.brand = brand

  return Object.keys(device).length > 0 ? device : undefined
}

function normalizePersistedEntry(value: unknown): LogEntry | null {
  if (!isRecord(value)) return null

  const { level, event, message, platform, createdAt } = value
  if (!isLogLevel(level)) return null
  if (typeof event !== 'string' || typeof message !== 'string') return null
  if (!isPlatform(platform)) return null
  if (typeof createdAt !== 'number' || !Number.isFinite(createdAt)) return null

  return {
    level,
    event: truncateUtf8(event, CLIENT_EVENT_MAX_BYTES) || 'unknown',
    message: truncateUtf8(message, CLIENT_MESSAGE_MAX_BYTES),
    data: boundTelemetryData(value.data),
    platform,
    appVersion: optionalBoundedString(value.appVersion, CLIENT_APP_VERSION_MAX_BYTES),
    sessionId: optionalBoundedString(value.sessionId, CLIENT_METADATA_MAX_BYTES),
    createdAt,
    // Migrate persisted entries from the previous wire format. This marker is
    // used only to prevent cross-account attribution and is never submitted.
    localUserId: optionalString(value.localUserId) ?? optionalString(value.userId),
    device: normalizeDeviceInfo(value.device),
  }
}

class LogQueue {
  private entries: LogEntry[] = []

  push(entry: LogEntry): void {
    if (this.entries.length >= MAX_QUEUE_SIZE) {
      this.entries.shift() // Drop oldest
    }
    this.entries.push(entry)
  }

  drain(): LogEntry[] {
    const batch = this.entries.splice(0)
    return batch
  }

  /** Non-destructive copy of the current entries (for persistence). */
  snapshot(): LogEntry[] {
    return this.entries.slice()
  }

  /**
   * Prepend entries ahead of any in-memory ones, capping at MAX_QUEUE_SIZE by
   * dropping the oldest. Used to restore persisted logs on startup and to put
   * failed-flush entries back so they retry instead of vanishing.
   */
  restore(entries: LogEntry[]): void {
    if (entries.length === 0) return
    const combined = [...entries, ...this.entries]
    this.entries =
      combined.length > MAX_QUEUE_SIZE ? combined.slice(combined.length - MAX_QUEUE_SIZE) : combined
  }

  get length(): number {
    return this.entries.length
  }
}

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

export class TelemetryLogger {
  private queue = new LogQueue()
  private sessionId: string
  private platform: 'ios' | 'android'
  private appVersion: string | undefined
  private deviceInfo: DeviceInfo | undefined
  private userId: string | null = null
  private isInitialized = false
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private persistTimer: ReturnType<typeof setTimeout> | null = null
  private storage: MMKV | null = null
  private _mutationCreateBatch: ((args: unknown) => Promise<unknown>) | null = null

  // Preserved original console methods
  private _origConsoleError: typeof console.error
  private _origConsoleWarn: typeof console.warn

  // Toast callback — set after toast store is available
  private _onErrorToast: ((message: string, referenceId: string) => void) | null = null

  // Crash-survivable breadcrumb: written synchronously to MMKV so it survives
  // a native process kill (SIGSEGV/OOM). On next launch, loadPersisted()
  // flushes it as a breadcrumb so we know what the app was doing when it died.
  private _lastCrashBreadcrumb: Record<string, unknown> | null = null

  constructor() {
    this.sessionId = generateSessionId()
    this.platform = Platform.OS as 'ios' | 'android'
    this._origConsoleError = console.error.bind(console)
    this._origConsoleWarn = console.warn.bind(console)

    try {
      this.appVersion = optionalBoundedString(
        Constants.expoConfig?.version ?? Constants.nativeAppVersion,
        CLIENT_APP_VERSION_MAX_BYTES,
      )
    } catch {
      this.appVersion = undefined
    }

    // Capture device info once at startup — included on every log entry so
    // crash reports always include the device model and OS version without
    // relying on the client to pass it per-call.
    this.deviceInfo = normalizeDeviceInfo({
      modelName: Device.modelName,
      osVersion: Device.osVersion,
      osName: Device.osName,
      manufacturer: Device.manufacturer,
      brand: Device.brand,
    })

    try {
      this.storage = createMMKV({ id: STORAGE_ID })
    } catch {
      // MMKV native module unavailable (e.g. tests) — degrade to in-memory only.
      this.storage = null
    }
  }

  // -----------------------------------------------------------------------
  // Initialization
  // -----------------------------------------------------------------------

  /**
   * Initialize the logger with Convex mutation refs and start capturing.
   * Call once during app startup (in _layout.tsx).
   */
  init(api: {
    create: (args: unknown) => Promise<unknown>
    createBatch: (args: unknown) => Promise<unknown>
  }): void {
    if (this.isInitialized) return

    this._mutationCreateBatch = api.createBatch
    this.isInitialized = true

    // Reload any logs persisted by a previous session (e.g. the app was killed
    // before they flushed, or flushes failed during the auth gap) so they get
    // another delivery attempt.
    this.loadPersisted()
    this.flushLastCrashBreadcrumb()
    // Drain whatever we just restored (plus anything queued during startup)
    // promptly rather than waiting a full flush interval.
    void this.sendBatch()

    this.startFlushTimer()
    this.installGlobalErrorHandler()
    this.installRejectionTracker()
    this.installMemoryWarningListener()
    this.installConsoleOverrides()
  }

  /**
   * Provide the Convex userId after auth resolves so subsequent entries
   * are tagged with the user.
   */
  setUserId(id: string | null): void {
    const wasAnonymous = this.userId === null
    this.userId = id
    // Auth just resolved: flush now so anything buffered across the sign-in
    // (or sign-out/sign-in) auth gap is delivered without waiting a full cycle.
    if (id !== null && wasAnonymous && this.isInitialized) {
      void this.sendBatch()
    }
  }

  /**
   * Register a callback that fires when `error()` is called, so we can
   * push toasts from the telemetry layer.
   */
  onErrorToast(cb: (message: string, referenceId: string) => void): void {
    this._onErrorToast = cb
  }

  // -----------------------------------------------------------------------
  // Public logging API
  // -----------------------------------------------------------------------

  breadcrumb(event: string, data?: unknown): void {
    this.enqueue('breadcrumb', event, event, data)
  }

  error(event: string, message: string, data?: unknown): void {
    this.enqueue('error', event, message, data)

    // Fire toast callback — the toast store will pick this up
    // We don't have a Convex doc ID yet, so use the sessionId + timestamp as ref
    if (this._onErrorToast) {
      const refId = `${this.sessionId.slice(0, 8)}:${Date.now().toString(36)}`
      this._onErrorToast(message, refId)
    }
  }

  warn(event: string, message: string, data?: unknown): void {
    this.enqueue('warn', event, message, data)
  }

  info(event: string, message: string, data?: unknown): void {
    this.enqueue('info', event, message, data)
  }

  // -----------------------------------------------------------------------
  // Crash-survivable breadcrumb
  // -----------------------------------------------------------------------

  /**
   * Write a crash-survivable breadcrumb to MMKV. Unlike normal telemetry
   * entries (which go through the in-memory queue + batch flush), this is
   * written synchronously to disk so it survives a native SIGSEGV or OOM
   * kill. On the next app launch, init() calls flushLastCrashBreadcrumb()
   * which emits it as a `crash:last_breadcrumb` entry and clears the key.
   *
   * Use this to record what the app was doing during high-risk operations
   * (e.g. mid-recording state) so that if the process is killed, we know
   * exactly what was happening.
   */
  setCrashBreadcrumb(event: string, data?: unknown): void {
    if (!this.storage) return
    try {
      this._lastCrashBreadcrumb = {
        event,
        data: boundTelemetryData(data),
        writtenAt: Date.now(),
      }
      this.storage.set(LAST_CRASH_KEY, JSON.stringify(this._lastCrashBreadcrumb))
    } catch {
      // Best-effort — never let telemetry crash the caller.
    }
  }

  /** Clear the crash breadcrumb (call after a graceful stop). */
  clearCrashBreadcrumb(): void {
    if (!this.storage) return
    try {
      this.storage.remove(LAST_CRASH_KEY)
      this._lastCrashBreadcrumb = null
    } catch {
      // ignore
    }
  }

  private flushLastCrashBreadcrumb(): void {
    if (!this.storage) return
    try {
      const raw = this.storage.getString(LAST_CRASH_KEY)
      if (!raw) return
      const parsed = JSON.parse(raw) as unknown
      if (!isRecord(parsed) || typeof parsed.event !== 'string') {
        this.storage.remove(LAST_CRASH_KEY)
        return
      }

      // Only flush if it's recent (within the last 10 minutes). Older entries
      // are likely from a previous session that exited cleanly but didn't
      // clear the breadcrumb.
      const writtenAt = typeof parsed.writtenAt === 'number' ? parsed.writtenAt : 0
      const ageMs = Date.now() - writtenAt
      if (ageMs < 10 * 60 * 1000) {
        const data = isRecord(parsed.data)
          ? { ...parsed.data, ageMs }
          : { data: parsed.data, ageMs }
        this.enqueue('breadcrumb', 'crash:last_breadcrumb', parsed.event, data, { echo: false })
        // The replayed crash breadcrumb should survive even if the relaunched
        // app dies again before the debounce timer or network flush runs.
        this.persistNow()
      }
      this.storage.remove(LAST_CRASH_KEY)
      this._lastCrashBreadcrumb = null
    } catch {
      try {
        this.storage.remove(LAST_CRASH_KEY)
      } catch {
        // ignore
      }
    }
  }

  // -----------------------------------------------------------------------
  // Flush
  // -----------------------------------------------------------------------

  /** Force-flush the queue immediately (e.g. on app background). */
  async flush(): Promise<void> {
    await this.sendBatch()
  }

  // -----------------------------------------------------------------------
  // Private
  // -----------------------------------------------------------------------

  private enqueue(
    level: LogLevel,
    event: string,
    message: string,
    data?: unknown,
    options: { echo?: boolean } = {},
  ): void {
    // Also echo to the original console so we can still see logs during dev
    if (options.echo ?? true) {
      if (level === 'error') {
        this._origConsoleError(`[telemetry:${level}] ${event} — ${message}`, data ?? '')
      } else if (level === 'warn') {
        this._origConsoleWarn(`[telemetry:${level}] ${event} — ${message}`, data ?? '')
      }
    }

    this.queue.push({
      level,
      // Keep newly captured entries inside the same byte limits enforced by
      // Convex. In particular, console errors can contain very large strings;
      // one oversized entry must not cause its otherwise-valid batch to be
      // rejected and discarded.
      event: truncateUtf8(redactSensitiveText(event), CLIENT_EVENT_MAX_BYTES) || 'unknown',
      message: truncateUtf8(redactSensitiveText(message), CLIENT_MESSAGE_MAX_BYTES),
      data: boundTelemetryData(scrubTelemetryValue(serializeForConvex(data))),
      platform: this.platform,
      appVersion: this.appVersion,
      sessionId: this.sessionId,
      createdAt: Date.now(),
      localUserId: this.userId ?? undefined,
      device: this.deviceInfo,
    })

    this.schedulePersist()
  }

  private startFlushTimer(): void {
    if (this.flushTimer) clearInterval(this.flushTimer)

    this.flushTimer = setInterval(() => {
      void this.sendBatch()
    }, FLUSH_INTERVAL_MS)
  }

  private async sendBatch(): Promise<void> {
    // Preserve startup/crash telemetry locally until Convex auth has resolved.
    // Anonymous ingestion would expose a database write endpoint to anyone.
    if (!this._mutationCreateBatch || !this.userId) return

    const batch = this.queue.drain()
    if (batch.length === 0) return

    // Anonymous startup events may be attributed to the user who authenticates
    // in this session. Never attach logs captured for a previous account to a
    // different account on a shared device.
    const oldestAcceptedAt = Date.now() - CLIENT_LOG_MAX_AGE_MS
    const attributable = batch.filter(
      (entry) =>
        (entry.localUserId === undefined || entry.localUserId === this.userId) &&
        entry.createdAt >= oldestAcceptedAt,
    )

    const failed: LogEntry[] = []
    // Match the Convex createBatch limit.
    for (let i = 0; i < attributable.length; i += TELEMETRY_BATCH_SIZE) {
      const chunk = attributable.slice(i, i + TELEMETRY_BATCH_SIZE)
      const payload = chunk.map(({ localUserId: _localUserId, ...entry }) => entry)
      try {
        await this._mutationCreateBatch({
          entries: payload.map((entry) => ({
            ...entry,
            event:
              truncateUtf8(redactSensitiveText(entry.event), CLIENT_EVENT_MAX_BYTES) || 'unknown',
            message: truncateUtf8(redactSensitiveText(entry.message), CLIENT_MESSAGE_MAX_BYTES),
            data: boundTelemetryData(scrubTelemetryValue(entry.data)),
          })),
        })
      } catch (error) {
        // Invalid entries can never succeed on retry, so discard this chunk
        // instead of letting one corrupt persisted event block the queue.
        if (telemetryErrorCode(error) === 'INVALID_TELEMETRY') continue
        // Keep failed entries instead of dropping them. The flush can fail for
        // non-user-facing reasons — a transient network blip or the
        // sign-out/sign-in auth gap — and silently losing these breadcrumbs is
        // exactly what blinds triage. They retry on the next flush.
        failed.push(...chunk)
      }
    }

    if (failed.length > 0) {
      this.queue.restore(failed)
    }
    // Reflect the drained/re-queued state on disk immediately so a kill right
    // after a (partial) flush doesn't resurrect already-delivered entries or
    // lose the ones still pending.
    this.persistNow()
  }

  // -----------------------------------------------------------------------
  // Persistence (survives app restarts)
  // -----------------------------------------------------------------------

  private schedulePersist(): void {
    if (!this.storage || this.persistTimer) return
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null
      this.persistNow()
    }, PERSIST_DEBOUNCE_MS)
  }

  private persistNow(): void {
    if (!this.storage) return
    if (this.persistTimer) {
      clearTimeout(this.persistTimer)
      this.persistTimer = null
    }
    try {
      this.storage.set(STORAGE_KEY, JSON.stringify(this.queue.snapshot()))
    } catch {
      // Best-effort persistence; never let it surface.
    }
  }

  private loadPersisted(): void {
    if (!this.storage) return
    try {
      const raw = this.storage.getString(STORAGE_KEY)
      if (!raw) return
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) {
        const entries = parsed.flatMap((entry) => {
          const normalized = normalizePersistedEntry(entry)
          return normalized ? [normalized] : []
        })
        if (entries.length > 0) {
          this.queue.restore(entries)
        }
        if (entries.length !== parsed.length) {
          this.persistNow()
        }
      }
    } catch {
      // Corrupt payload — drop it so we don't get stuck reloading garbage.
      try {
        this.storage.remove(STORAGE_KEY)
      } catch {
        // ignore
      }
    }
  }

  // -----------------------------------------------------------------------
  // Global error handler
  // -----------------------------------------------------------------------

  private installGlobalErrorHandler(): void {
    // React Native global error handler
    if (!ErrorUtils) return
    const originalHandler = ErrorUtils.getGlobalHandler?.()

    ErrorUtils.setGlobalHandler((error: Error, isFatal?: boolean) => {
      // Transient Convex auth blips surface here too — downgrade to breadcrumb.
      if (isTransientAuthError(error.message ?? '')) {
        this.enqueue(
          'breadcrumb',
          'error:auth:transient',
          error.message ?? 'Unknown auth error',
          {
            stack: error.stack,
            isFatal,
          },
          { echo: false },
        )
        return
      }

      this.error('error:unhandled', error.message ?? 'Unknown error', {
        stack: error.stack,
        isFatal,
      })

      // Fire-and-forget flush attempt
      void this.flush()

      // Call original handler
      if (originalHandler) {
        originalHandler(error, isFatal)
      }
    })
  }

  // -----------------------------------------------------------------------
  // Unhandled promise rejections
  // -----------------------------------------------------------------------

  private installRejectionTracker(): void {
    if (!HermesInternal?.enablePromiseRejectionTracker) return
    // Hermes supports a single tracker; installing ours in dev would replace
    // React Native's LogBox rejection warnings. Dev doesn't need telemetry.
    if (typeof __DEV__ !== 'undefined' && __DEV__) return

    HermesInternal.enablePromiseRejectionTracker({
      allRejections: true,
      onUnhandled: (id, error) => {
        const err = error instanceof Error ? error : new Error(String(error))
        const msg = err.message ?? 'Unhandled rejection'

        // Transient Convex auth blips frequently surface as unhandled rejections
        // (the auth promise rejects during a WS reconnect, .catch attaches a
        // tick late). Downgrade to a breadcrumb — these are noise, not bugs.
        if (isTransientAuthError(msg)) {
          this.enqueue(
            'breadcrumb',
            'error:auth:transient_rejection',
            msg,
            {
              stack: err.stack,
              rejectionId: id,
            },
            { echo: false },
          )
          return
        }

        // enqueue directly, NOT this.error(): error() fires the user-facing
        // toast, and rejections are frequent background noise (network blips,
        // .catch attached a tick late) — telemetry-only, never a toast.
        this.enqueue('error', 'error:unhandled_rejection', msg, {
          stack: err.stack,
          rejectionId: id,
        })
      },
      // A rejection handled late (e.g. .catch attached on a later tick) is
      // normal control flow — record it so the paired onUnhandled entry can
      // be discounted during triage.
      onHandled: (id) => {
        this.breadcrumb('error:rejection_handled_late', { rejectionId: id })
      },
    })
  }

  // -----------------------------------------------------------------------
  // Memory pressure
  // -----------------------------------------------------------------------

  private installMemoryWarningListener(): void {
    // iOS delivers memory warnings shortly before the OS kills the app; a
    // warning followed by an abrupt session end is the OOM signature. The
    // live-publisher module has its own native listener, but this one covers
    // the whole app — most importantly video playback.
    AppState.addEventListener('memoryWarning', () => {
      this.warn('app:memory_warning', 'OS reported memory pressure')
      // Flush immediately: if the app is OOM-killed moments later, the
      // warning would otherwise die in the queue with it.
      void this.flush()
    })
  }

  // -----------------------------------------------------------------------
  // Console overrides
  // -----------------------------------------------------------------------

  private installConsoleOverrides(): void {
    console.error = (...args: unknown[]) => {
      this._origConsoleError(...args)
      const formatted = formatConsoleArgs(args) || 'console.error'

      // Transient Convex auth blips (token expired during WS reconnect, etc.)
      // are auto-recovered by the client. Downgrade to a breadcrumb so we
      // keep the trail without firing an error-level telemetry entry or toast.
      if (isTransientAuthError(formatted)) {
        this.enqueue('breadcrumb', 'console:auth:transient', formatted, args, { echo: false })
        return
      }

      this.enqueue('error', 'console:error', formatted, args, {
        echo: false,
      })
    }

    console.warn = (...args: unknown[]) => {
      this._origConsoleWarn(...args)
      this.enqueue('warn', 'console:warn', formatConsoleArgs(args) || 'console.warn', args, {
        echo: false,
      })
    }
  }
}

// ---------------------------------------------------------------------------
// Transient auth error classification (module-level)
// ---------------------------------------------------------------------------

/**
 * Patterns that indicate a transient Convex auth/WebSocket blip — the server
 * briefly rejects a token during a reconnect, the client automatically
 * re-authenticates, and life continues. These are not user-actionable and
 * should not produce error-level telemetry (which fires a user-facing toast).
 * Downgrade to a breadcrumb so we still have the trail without the noise.
 *
 * Exported so call sites (login.tsx, signup.tsx, etc.) can classify the same
 * way without duplicating patterns.
 */
const TRANSIENT_AUTH_ERROR_PATTERNS: readonly RegExp[] = [
  /Failed to authenticate:/i,
  /\[Request ID:.*\] AuthError/i,
  /AuthError.*Request ID/i,
  /Not authenticated/i,
  /Unauthorized/i,
]

export function isTransientAuthError(message: string): boolean {
  return TRANSIENT_AUTH_ERROR_PATTERNS.some((p) => p.test(message))
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

export const telemetry = new TelemetryLogger()

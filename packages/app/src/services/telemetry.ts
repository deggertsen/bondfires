/**
 * Client-side telemetry logger (singleton).
 *
 * Queues breadcrumbs, errors, and warnings in memory and batch-flushes
 * them to the Convex `clientLogs` table every 10 seconds.  Also hooks
 * React Native's global error handler to capture unhandled exceptions.
 */

import Constants from 'expo-constants'
import { Platform } from 'react-native'
import { createMMKV, type MMKV } from 'react-native-mmkv'

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

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LogLevel = 'error' | 'warn' | 'info' | 'breadcrumb'

export interface LogEntry {
  level: LogLevel
  event: string
  message: string
  data?: unknown
  platform: 'ios' | 'android'
  appVersion?: string
  sessionId?: string
  createdAt: number
  userId?: string
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
const TELEMETRY_BATCH_SIZE = 20
const PERSIST_DEBOUNCE_MS = 1000
const STORAGE_ID = 'bondfires-telemetry'
const STORAGE_KEY = 'queue'

function serializeForConvex(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value
  }

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
    return value.map((item) => serializeForConvex(item, depth + 1, seen))
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

  constructor() {
    this.sessionId = generateSessionId()
    this.platform = Platform.OS as 'ios' | 'android'
    this._origConsoleError = console.error.bind(console)
    this._origConsoleWarn = console.warn.bind(console)

    try {
      this.appVersion = Constants.expoConfig?.version ?? Constants.nativeAppVersion
    } catch {
      this.appVersion = undefined
    }

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
    // Drain whatever we just restored (plus anything queued during startup)
    // promptly rather than waiting a full flush interval.
    void this.sendBatch()

    this.startFlushTimer()
    this.installGlobalErrorHandler()
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
      event,
      message,
      data: serializeForConvex(data),
      platform: this.platform,
      appVersion: this.appVersion,
      sessionId: this.sessionId,
      createdAt: Date.now(),
      userId: this.userId ?? undefined,
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
    if (!this._mutationCreateBatch) return

    const batch = this.queue.drain()
    if (batch.length === 0) return

    const failed: LogEntry[] = []
    // Match the Convex createBatch limit.
    for (let i = 0; i < batch.length; i += TELEMETRY_BATCH_SIZE) {
      const chunk = batch.slice(i, i + TELEMETRY_BATCH_SIZE)
      try {
        await this._mutationCreateBatch({ entries: chunk })
      } catch {
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
        this.queue.restore(parsed as LogEntry[])
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
  // Console overrides
  // -----------------------------------------------------------------------

  private installConsoleOverrides(): void {
    console.error = (...args: unknown[]) => {
      this._origConsoleError(...args)
      this.enqueue('error', 'console:error', formatConsoleArgs(args) || 'console.error', args, {
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
// Singleton
// ---------------------------------------------------------------------------

export const telemetry = new TelemetryLogger()

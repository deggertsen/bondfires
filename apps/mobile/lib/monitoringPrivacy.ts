import {
  isSensitiveTelemetryKey,
  redactSensitiveText,
} from '../../../packages/app/src/services/privacyScrubber'

type SentryFrame = {
  filename?: unknown
  function?: unknown
  module?: unknown
  lineno?: unknown
  colno?: unknown
  in_app?: unknown
}
type SentryBreadcrumbLike = {
  timestamp?: unknown
  type?: unknown
  category?: unknown
  level?: unknown
  message?: unknown
  data?: unknown
}
type SentryExceptionLike = {
  type?: unknown
  value?: unknown
  mechanism?: { type?: unknown; handled?: unknown }
  stacktrace?: { frames?: SentryFrame[] }
}
type SentryEventLike = {
  event_id?: unknown
  timestamp?: unknown
  platform?: unknown
  level?: unknown
  logger?: unknown
  release?: unknown
  dist?: unknown
  environment?: unknown
  message?: unknown
  exception?: { values?: SentryExceptionLike[] }
  breadcrumbs?: SentryBreadcrumbLike[]
  contexts?: {
    app?: unknown
    os?: unknown
    device?: Record<string, unknown>
  }
  tags?: Record<string, unknown>
  debug_meta?: unknown
  user?: unknown
  request?: unknown
  extra?: unknown
}
type ScrubbedSentryEvent = Omit<SentryEventLike, 'tags'> & {
  tags: Record<string, string>
}

function safeContext(value: unknown, keys: string[]) {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  return Object.fromEntries(
    keys.flatMap<[string, string | number | boolean]>((key) => {
      const item = record[key]
      if (typeof item === 'string') return [[key, redactSensitiveText(item)]]
      if (typeof item === 'number' || typeof item === 'boolean') return [[key, item]]
      return []
    }),
  )
}

// Debug-ID matching needs the same code location in frames and debug images,
// but not a server hostname, query credentials, or a user's local directory.
function safeCodeLocation(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  return redactSensitiveText(value.split(/[?#]/)[0].replaceAll('\\', '/').split('/').pop() ?? '')
}

function safeDebugMeta(value: unknown) {
  if (!value || typeof value !== 'object') return undefined
  const images = (value as { images?: unknown }).images
  if (!Array.isArray(images)) return undefined
  return {
    images: images.map((image) => {
      if (!image || typeof image !== 'object') return {}
      return {
        ...safeContext(image, ['type', 'debug_id', 'code_id', 'image_addr', 'image_size', 'arch']),
        code_file: safeCodeLocation(image.code_file),
        debug_file: safeCodeLocation(image.debug_file),
      }
    }),
  }
}

function scrubFrame(frame: SentryFrame): SentryFrame {
  return {
    filename: safeCodeLocation(frame.filename),
    function: typeof frame.function === 'string' ? redactSensitiveText(frame.function) : undefined,
    module: typeof frame.module === 'string' ? redactSensitiveText(frame.module) : undefined,
    lineno: frame.lineno,
    colno: frame.colno,
    in_app: frame.in_app,
  }
}

export function scrubSentryBreadcrumb(breadcrumb: SentryBreadcrumbLike): SentryBreadcrumbLike {
  return {
    timestamp: breadcrumb.timestamp,
    type:
      typeof breadcrumb.type === 'string' ? redactSensitiveText(breadcrumb.type) : breadcrumb.type,
    category:
      typeof breadcrumb.category === 'string'
        ? redactSensitiveText(breadcrumb.category)
        : breadcrumb.category,
    level: breadcrumb.level,
    message:
      typeof breadcrumb.message === 'string' ? redactSensitiveText(breadcrumb.message) : undefined,
  }
}

export function scrubSentryEvent(event: SentryEventLike): ScrubbedSentryEvent {
  const exceptionValues = event.exception?.values?.map((exception) => ({
    type: typeof exception.type === 'string' ? redactSensitiveText(exception.type) : exception.type,
    value: typeof exception.value === 'string' ? redactSensitiveText(exception.value) : undefined,
    mechanism: exception.mechanism
      ? {
          type:
            typeof exception.mechanism.type === 'string'
              ? redactSensitiveText(exception.mechanism.type)
              : exception.mechanism.type,
          handled: exception.mechanism.handled,
        }
      : undefined,
    stacktrace: exception.stacktrace
      ? { frames: exception.stacktrace.frames?.map(scrubFrame) }
      : undefined,
  }))
  const safeTags = Object.fromEntries(
    Object.entries(event.tags ?? {}).flatMap(([key, value]) => {
      if (isSensitiveTelemetryKey(key)) return []
      if (redactSensitiveText(key) !== key) return []
      if (typeof value === 'string') return [[key, redactSensitiveText(value)]]
      if (typeof value === 'number' || typeof value === 'boolean') return [[key, String(value)]]
      return []
    }),
  )

  return {
    event_id: event.event_id,
    timestamp: event.timestamp,
    platform: event.platform,
    level: event.level,
    logger: typeof event.logger === 'string' ? redactSensitiveText(event.logger) : event.logger,
    release: event.release,
    dist: event.dist,
    environment: event.environment,
    message: typeof event.message === 'string' ? redactSensitiveText(event.message) : undefined,
    exception: exceptionValues ? { values: exceptionValues } : undefined,
    breadcrumbs: event.breadcrumbs?.map(scrubSentryBreadcrumb),
    contexts: event.contexts
      ? {
          app: safeContext(event.contexts.app, [
            'app_identifier',
            'app_version',
            'app_build',
            'in_foreground',
          ]),
          os: safeContext(event.contexts.os, [
            'name',
            'version',
            'build',
            'kernel_version',
            'rooted',
          ]),
          device: event.contexts.device
            ? {
                arch: event.contexts.device.arch,
                brand: event.contexts.device.brand,
                family: event.contexts.device.family,
                model: event.contexts.device.model,
              }
            : undefined,
        }
      : undefined,
    tags: safeTags,
    debug_meta: safeDebugMeta(event.debug_meta),
  }
}

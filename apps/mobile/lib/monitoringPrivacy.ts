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

function scrubFrame(frame: SentryFrame): SentryFrame {
  return {
    filename: typeof frame.filename === 'string' ? redactSensitiveText(frame.filename) : undefined,
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
          app: event.contexts.app,
          os: event.contexts.os,
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
    debug_meta: event.debug_meta,
  }
}

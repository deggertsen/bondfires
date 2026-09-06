import { redactSensitiveText } from '../../../packages/app/src/services/privacyScrubber'

/** Copy only error text/frames; never forward cause, custom properties or user context. */
export function scrubMonitoringError(value: unknown): Error {
  const original = value instanceof Error ? value : new Error('Non-Error exception')
  const error = new Error(redactSensitiveText(original.message).slice(0, 1000))
  error.name = redactSensitiveText(original.name).slice(0, 100)
  // Preserve Hermes bytecode positions for offline symbolication, but remove
  // URL credentials, queries and local filesystem directories from locations.
  const frames = (original.stack ?? '')
    .split('\n')
    .slice(1, 31)
    .map((line) =>
      redactSensitiveText(
        line
          .replace(/(?:[a-z]+:\/\/|\/)[^\s()]*\/([^\s()/]+)(?=\)?$)/gi, '$1')
          .replace(/\?[^\s():]*(?=:\d)/g, ''),
      ).slice(0, 500),
    )
  error.stack = [`${error.name}: ${error.message}`, ...frames].join('\n')
  return error
}

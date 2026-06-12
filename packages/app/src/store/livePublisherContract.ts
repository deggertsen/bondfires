// ── Native live-publisher event contract ─────────────────────────────────────
//
// Single source of truth for every status and error-code string the native
// publisher modules may emit. The Swift and Kotlin modules each carry a
// matching enum (see modules/bondfire-live-publisher/README.md for the parity
// table); any new value must be added in all three places.
//
// JS must never cast an unknown native string into LivePublishStatus — use
// isNativePublisherStatus and treat unknown values as a contract violation.

export const NATIVE_PUBLISHER_STATUSES = [
  /** RTMP connection is being opened (emitted at start()). */
  'connecting',
  /** Publishing — recording is running. */
  'live',
  /** Transient network drop; the publisher is trying to re-establish. */
  'reconnecting',
  /** Intentional stop completed. */
  'ended',
  /** Start/connect failed; the pipeline is not publishing. */
  'errored',
  /** Encoder/stream stopped without stop() being called. */
  'stream_stopped_unexpectedly',
  /** The RTMP endpoint/socket closed without stop() being called. */
  'endpoint_closed',
] as const

export type NativePublisherStatus = (typeof NATIVE_PUBLISHER_STATUSES)[number]

export function isNativePublisherStatus(value: string): value is NativePublisherStatus {
  return (NATIVE_PUBLISHER_STATUSES as readonly string[]).includes(value)
}

/**
 * Known error codes emitted via the 'error' event. Informational — codes are
 * surfaced in telemetry; JS behavior keys off the event itself, not the code.
 */
export const NATIVE_PUBLISHER_ERROR_CODES = [
  // shared
  'camera_not_found',
  'connection_failed',
  // iOS
  'attachCamera_failed',
  'attachAudio_failed',
  'no_mic',
  'audio_session_failed',
  'invalid_url',
  'session_build_failed',
  'swapCamera_failed',
  'capture_interrupted',
  'capture_runtime_error',
  // Android
  'start_stream_failed',
  'streamer_internal_error',
] as const

export type NativePublisherErrorCode = (typeof NATIVE_PUBLISHER_ERROR_CODES)[number]

export interface NativePublisherError {
  /** One of NATIVE_PUBLISHER_ERROR_CODES, or a new code not yet in the contract. */
  code: string
  message: string
}

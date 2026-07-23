/**
 * iOS AVCaptureSession interruption reasons (the raw values Apple emits in
 * AVCaptureSessionInterruptionReasonKey). The native module forwards these in
 * the `capture_interrupted` / `capture_interruption_ended` event messages as
 * "(reason: N)"; this module keeps the parsing and human labels in one tested
 * place instead of scattering magic numbers through the hook and the UI.
 *
 * @see https://developer.apple.com/documentation/avfoundation/avcapturesession/interruptionreason
 */
export const CAPTURE_INTERRUPTION_REASONS = {
  videoDeviceNotAvailableInBackground: 1,
  audioDeviceInUseByAnotherClient: 2,
  videoDeviceInUseByAnotherClient: 3,
  videoDeviceNotAvailableWithMultipleForegroundApps: 4,
  videoDeviceNotAvailableDueToSystemPressure: 5,
} as const

/** Extract the integer reason from a native interruption event message. */
export function parseInterruptionReason(message: string | undefined): number | null {
  if (!message) return null
  const match = /reason:\s*(\d+)/i.exec(message)
  return match ? Number.parseInt(match[1], 10) : null
}

/**
 * User-facing explanation of why a recording was interrupted. Deliberately
 * plain and reassuring — every path pairs it with "Your video was saved."
 */
export function interruptionReasonLabel(reason: number | null): string {
  switch (reason) {
    case CAPTURE_INTERRUPTION_REASONS.audioDeviceInUseByAnotherClient:
      return 'a call or another app used your microphone'
    case CAPTURE_INTERRUPTION_REASONS.videoDeviceInUseByAnotherClient:
      return 'another app used your camera'
    case CAPTURE_INTERRUPTION_REASONS.videoDeviceNotAvailableInBackground:
      return 'the app moved to the background'
    case CAPTURE_INTERRUPTION_REASONS.videoDeviceNotAvailableWithMultipleForegroundApps:
      return "the camera isn't available while sharing the screen"
    case CAPTURE_INTERRUPTION_REASONS.videoDeviceNotAvailableDueToSystemPressure:
      return 'the device got too hot or low on resources'
    default:
      return 'something interrupted the camera or microphone'
  }
}

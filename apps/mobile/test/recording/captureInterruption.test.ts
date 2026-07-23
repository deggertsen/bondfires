import { describe, expect, it } from 'vitest'
import {
  CAPTURE_INTERRUPTION_REASONS,
  interruptionReasonLabel,
  parseInterruptionReason,
} from '../../../../packages/app/src/utils/captureInterruption'

describe('parseInterruptionReason', () => {
  it('extracts the reason from the native event message', () => {
    expect(parseInterruptionReason('Camera capture was interrupted (reason: 2)')).toBe(2)
    expect(parseInterruptionReason('Camera capture interruption ended (reason: 5)')).toBe(5)
  })

  it('is case-insensitive and tolerant of spacing', () => {
    expect(parseInterruptionReason('Reason:3')).toBe(3)
  })

  it('returns null when no reason is present', () => {
    expect(parseInterruptionReason('unknown')).toBeNull()
    expect(parseInterruptionReason(undefined)).toBeNull()
    expect(parseInterruptionReason('reason: unknown')).toBeNull()
  })
})

describe('interruptionReasonLabel', () => {
  it('gives a plain explanation for the common call/mic case', () => {
    expect(
      interruptionReasonLabel(CAPTURE_INTERRUPTION_REASONS.audioDeviceInUseByAnotherClient),
    ).toBe('a call or another app used your microphone')
  })

  it('covers every known reason distinctly', () => {
    const labels = Object.values(CAPTURE_INTERRUPTION_REASONS).map(interruptionReasonLabel)
    expect(new Set(labels).size).toBe(labels.length)
  })

  it('falls back to a generic label for unknown/null reasons', () => {
    const fallback = 'something interrupted the camera or microphone'
    expect(interruptionReasonLabel(null)).toBe(fallback)
    expect(interruptionReasonLabel(99)).toBe(fallback)
  })
})

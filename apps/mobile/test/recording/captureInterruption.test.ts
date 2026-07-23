import { describe, expect, it } from 'vitest'
import {
  CAPTURE_INTERRUPTION_REASONS,
  interruptionReasonLabel,
} from '../../../../packages/app/src/utils/captureInterruption'

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

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { LOUDNESS, programGain } from '../../../packages/media/src/loudness'
import { normalizationFilter, verifyNormalizedAudio } from './normalization'

const quiet = { integratedLufs: -32, truePeakDbtp: -20 }
describe('whole-program normalization policy', () => {
  it('targets -16 LUFS with bounded gain and peak priority', () => {
    expect(programGain(quiet, true)).toBe(16)
    expect(programGain({ integratedLufs: -52, truePeakDbtp: -40 }, true)).toBe(30)
    expect(programGain({ integratedLufs: -32, truePeakDbtp: -5 }, true)).toBe(3.5)
    expect(programGain({ integratedLufs: -10, truePeakDbtp: -1 }, true)).toBe(-6)
    expect(normalizationFilter(quiet, true)).toBe('volume=16dB')
  })
  it('never normalizes a growing prefix, silence, or noise floor', () => {
    expect(programGain(quiet, false)).toBeNull()
    expect(() => normalizationFilter(quiet, false)).toThrow()
    for (const value of [-Infinity, NaN, -65]) {
      expect(programGain({ integratedLufs: value, truePeakDbtp: -60 }, true)).toBeNull()
    }
    expect(programGain({ integratedLufs: -32, truePeakDbtp: Infinity }, true)).toBeNull()
  })
  it('rejects encoded true-peak overshoots and wrong output loudness', () => {
    expect(verifyNormalizedAudio(quiet, { integratedLufs: -16, truePeakDbtp: -4 })).toBe(true)
    expect(verifyNormalizedAudio(quiet, { integratedLufs: -16, truePeakDbtp: -1.4 })).toBe(false)
    expect(verifyNormalizedAudio(quiet, { integratedLufs: -20, truePeakDbtp: -4 })).toBe(false)
    expect(verifyNormalizedAudio(quiet, { integratedLufs: NaN, truePeakDbtp: -4 })).toBe(false)
  })
})

it('keeps Swift and Kotlin capture constants aligned with the product policy', () => {
  const root = 'apps/mobile/modules/bondfire-live-publisher'
  const sources = [
    `${root}/ios/SpeechLeveler.swift`,
    `${root}/android/src/main/java/org/bondfires/livepublisher/SpeechLeveler.kt`,
  ].map((path) => readFileSync(path, 'utf8'))
  for (const source of sources) {
    for (const constant of [
      LOUDNESS.captureRms,
      LOUDNESS.capturePeak,
      LOUDNESS.noiseGate,
      LOUDNESS.maxGain,
      LOUDNESS.riseSeconds,
      LOUDNESS.fallSeconds,
      LOUDNESS.releaseSeconds,
    ])
      expect(source).toContain(String(constant))
  }
  expect(20 * Math.log10(LOUDNESS.captureRms)).toBeCloseTo(LOUDNESS.captureRmsDbfs, 4)
  expect(20 * Math.log10(LOUDNESS.capturePeak)).toBeCloseTo(LOUDNESS.capturePeakDbfs, 4)
})

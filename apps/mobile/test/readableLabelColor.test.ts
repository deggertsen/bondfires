import { describe, expect, it } from 'vitest'
import {
  contrastRatio,
  LABEL_ON_DARK,
  LABEL_ON_LIGHT,
  readableLabelColor,
} from '../lib/readableLabelColor'

// Mirrors ACCENT_PALETTE in convex/campBranding.ts (importing it here would
// pull Convex server modules into the test).
const ACCENT_PALETTE = [
  '#FF6B35',
  '#E63946',
  '#F4A261',
  '#2A9D8F',
  '#264653',
  '#6C63FF',
  '#E9C46A',
  '#457B9D',
  '#1D3557',
  '#A8DADC',
]

describe('contrastRatio', () => {
  it('matches the WCAG extremes', () => {
    expect(contrastRatio('#FFFFFF', '#000000')).toBeCloseTo(21, 5)
    expect(contrastRatio('#777777', '#777777')).toBeCloseTo(1, 5)
  })

  it('matches the primary button tokens', () => {
    // $colorOnPrimary on $primarySolid / $primarySolidPress
    expect(contrastRatio('#FFFFFF', '#B85C2A')).toBeGreaterThanOrEqual(4.5)
    expect(contrastRatio('#FFFFFF', '#A04E24')).toBeGreaterThanOrEqual(4.5)
    // $colorOnError on $errorSolid / $errorSolidPress
    expect(contrastRatio('#FFFFFF', '#DC2626')).toBeGreaterThanOrEqual(4.5)
    expect(contrastRatio('#FFFFFF', '#B91C1C')).toBeGreaterThanOrEqual(4.5)
  })

  it('returns null for values that are not #RRGGBB', () => {
    expect(contrastRatio('$primary', '#FFFFFF')).toBeNull()
    expect(contrastRatio('#FFF', '#FFFFFF')).toBeNull()
  })
})

describe('readableLabelColor', () => {
  it('uses dark text on light accents and white on dark ones', () => {
    expect(readableLabelColor('#A8DADC')).toBe(LABEL_ON_LIGHT)
    expect(readableLabelColor('#E9C46A')).toBe(LABEL_ON_LIGHT)
    expect(readableLabelColor('#1D3557')).toBe(LABEL_ON_DARK)
    expect(readableLabelColor('#264653')).toBe(LABEL_ON_DARK)
  })

  it('falls back to white for unparseable input', () => {
    expect(readableLabelColor('$primary')).toBe(LABEL_ON_DARK)
  })

  // #E63946 and #6C63FF top out at 4.41 and 4.32 with either label, so the
  // bar here is the best available rather than a strict AA 4.5.
  it('keeps every camp accent at 4.3:1 or better', () => {
    for (const accent of ACCENT_PALETTE) {
      const label = readableLabelColor(accent)
      expect(contrastRatio(label, accent), accent).toBeGreaterThanOrEqual(4.3)
    }
  })
})

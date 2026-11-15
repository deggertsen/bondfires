/**
 * Picks a legible label color for text drawn on an arbitrary solid fill,
 * such as a camp's accent color behind its "Spark Here" button.
 *
 * Theme fills (`$primarySolid`, `$errorSolid`) already have a matching
 * `$colorOn*` token; this is only for user-chosen colors that don't.
 */

export const LABEL_ON_DARK = '#FFFFFF'
// Bondfire obsidian: the light theme's body text color.
export const LABEL_ON_LIGHT = '#141416'

function channelToLinear(channel: number): number {
  const c = channel / 255
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

/** WCAG 2.x relative luminance of a `#RRGGBB` color, or null if unparseable. */
export function relativeLuminance(hex: string): number | null {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!match) return null
  const value = match[1]
  const [r, g, b] = [0, 2, 4].map((i) =>
    channelToLinear(Number.parseInt(value.slice(i, i + 2), 16)),
  )
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** WCAG contrast ratio between two `#RRGGBB` colors (1–21), or null if either is unparseable. */
export function contrastRatio(a: string, b: string): number | null {
  const la = relativeLuminance(a)
  const lb = relativeLuminance(b)
  if (la == null || lb == null) return null
  const [hi, lo] = la > lb ? [la, lb] : [lb, la]
  return (hi + 0.05) / (lo + 0.05)
}

/**
 * White or obsidian, whichever contrasts more with `fill`. Returns white for
 * anything that isn't a `#RRGGBB` hex so callers can pass raw stored values.
 */
export function readableLabelColor(fill: string): string {
  const onDark = contrastRatio(LABEL_ON_DARK, fill)
  const onLight = contrastRatio(LABEL_ON_LIGHT, fill)
  if (onDark == null || onLight == null) return LABEL_ON_DARK
  return onDark >= onLight ? LABEL_ON_DARK : LABEL_ON_LIGHT
}

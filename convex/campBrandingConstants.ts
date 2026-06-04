export const ACCENT_PALETTE = [
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
] as const

export const COVER_IMAGE_MAX_BYTES = 5 * 1024 * 1024

export type AccentColor = (typeof ACCENT_PALETTE)[number]

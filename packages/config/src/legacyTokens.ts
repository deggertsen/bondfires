/**
 * Space, size, radius and zIndex scales frozen from @tamagui/themes@1.144.4.
 *
 * Tamagui v3's `@tamagui/themes` root exports the Config v6 (Tailwind 4px)
 * scale, which would silently shift every spacing value in the app ($4 18px ->
 * 16px, $10 60px -> 40px). Freezing the v1 values keeps layouts identical.
 * Half steps use the v3 hyphen spelling ($1.5 -> '1-5'); the legacy `true` and
 * negative keys are dropped because nothing references them.
 */

export const legacySpace = {
  '0': 0,
  '0-25': 0.5,
  '0-5': 1,
  '0-75': 1.5,
  '1': 2,
  '1-5': 4,
  '2': 7,
  '2-5': 10,
  '3': 13,
  '3-5': 16,
  '4': 18,
  '4-5': 21,
  '5': 24,
  '6': 32,
  '7': 39,
  '8': 46,
  '9': 53,
  '10': 60,
  '11': 74,
  '12': 88,
  '13': 102,
  '14': 116,
  '15': 130,
  '16': 144,
  '17': 144,
  '18': 158,
  '19': 172,
  '20': 186,
} as const

export const legacySize = {
  '0': 0,
  '0-25': 2,
  '0-5': 4,
  '0-75': 8,
  '1': 20,
  '1-5': 24,
  '2': 28,
  '2-5': 32,
  '3': 36,
  '3-5': 40,
  '4': 44,
  '4-5': 48,
  '5': 52,
  '6': 64,
  '7': 74,
  '8': 84,
  '9': 94,
  '10': 104,
  '11': 124,
  '12': 144,
  '13': 164,
  '14': 184,
  '15': 204,
  '16': 224,
  '17': 224,
  '18': 244,
  '19': 264,
  '20': 284,
} as const

export const legacyRadius = {
  '0': 0,
  '1': 3,
  '2': 5,
  '3': 7,
  '4': 9,
  '5': 10,
  '6': 16,
  '7': 19,
  '8': 22,
  '9': 26,
  '10': 34,
  '11': 42,
  '12': 50,
} as const

export const legacyZIndex = {
  '0': 0,
  '1': 100,
  '2': 200,
  '3': 300,
  '4': 400,
  '5': 500,
} as const

/** Radix palette colors still referenced directly (InviteSheet sent state). */
export const legacyColors = {
  green10Light: 'hsl(152, 57.5%, 37.6%)',
  green10Dark: 'hsl(151, 49.3%, 46.5%)',
} as const

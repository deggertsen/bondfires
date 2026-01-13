import { createAnimations } from '@tamagui/animations-react-native'
import { createInterFont } from '@tamagui/font-inter'
import { shorthands } from '@tamagui/shorthands'
import { tokens as defaultTokens } from '@tamagui/themes'
import { createTamagui, createTheme } from 'tamagui'

// ============================================
// Bondfire Brand Colors
// ============================================
const bondfireColors = {
  // Primary brand colors
  bondfireCopper: '#D97736',
  deepEmber: '#A04E24',
  moltenGold: '#F0AB68',
  
  // Background colors
  obsidian: '#141416',
  gunmetal: '#1F2023',
  iron: '#33353A',
  
  // Text colors
  whiteSmoke: '#F3F4F6',
  ash: '#9CA3AF',
  
  // Additional utility colors
  charcoal: '#2A2C31',
  slate: '#4B5563',
  ember: '#B85C2A',
  warmWhite: '#FAFAFA',
  
  // Status colors
  success: '#22C55E',
  successDark: '#16A34A',
  error: '#EF4444',
  errorDark: '#DC2626',
  warning: '#F59E0B',
  warningDark: '#D97706',
}

// ============================================
// Custom Tokens with Bondfire Colors
// ============================================
const tokens = {
  ...defaultTokens,
  color: {
    ...defaultTokens.color,
    // Brand colors as tokens
    bondfireCopper: bondfireColors.bondfireCopper,
    deepEmber: bondfireColors.deepEmber,
    moltenGold: bondfireColors.moltenGold,
    obsidian: bondfireColors.obsidian,
    gunmetal: bondfireColors.gunmetal,
    iron: bondfireColors.iron,
    whiteSmoke: bondfireColors.whiteSmoke,
    ash: bondfireColors.ash,
    charcoal: bondfireColors.charcoal,
    slate: bondfireColors.slate,
    ember: bondfireColors.ember,
    warmWhite: bondfireColors.warmWhite,
  },
  size: {
    ...defaultTokens.size,
    // Named size tokens used by Button and other components
    sm: defaultTokens.size['$3'],
    md: defaultTokens.size['$4'],
    lg: defaultTokens.size['$5'],
    xl: defaultTokens.size['$6'],
  },
}

// ============================================
// Dark Theme (Primary)
// ============================================
const darkTheme = createTheme({
  // Backgrounds
  background: bondfireColors.obsidian,
  backgroundHover: bondfireColors.gunmetal,
  backgroundPress: bondfireColors.iron,
  backgroundFocus: bondfireColors.gunmetal,
  backgroundStrong: bondfireColors.gunmetal,
  backgroundTransparent: 'rgba(20, 20, 22, 0)',
  
  // Foreground / Text
  color: bondfireColors.whiteSmoke,
  colorHover: bondfireColors.warmWhite,
  colorPress: bondfireColors.ash,
  colorFocus: bondfireColors.whiteSmoke,
  colorTransparent: 'rgba(243, 244, 246, 0)',
  
  // Primary (Bondfire Copper)
  primary: bondfireColors.bondfireCopper,
  primaryHover: bondfireColors.moltenGold,
  primaryPress: bondfireColors.deepEmber,
  primaryFocus: bondfireColors.bondfireCopper,
  
  // Secondary (Molten Gold)
  secondary: bondfireColors.moltenGold,
  secondaryHover: bondfireColors.bondfireCopper,
  secondaryPress: bondfireColors.deepEmber,
  secondaryFocus: bondfireColors.moltenGold,
  
  // Accent colors
  accent: bondfireColors.bondfireCopper,
  accentHover: bondfireColors.moltenGold,
  accentPress: bondfireColors.deepEmber,
  
  // Borders
  borderColor: bondfireColors.iron,
  borderColorHover: bondfireColors.ash,
  borderColorPress: bondfireColors.bondfireCopper,
  borderColorFocus: bondfireColors.bondfireCopper,
  
  // Placeholder
  placeholderColor: bondfireColors.ash,
  
  // Shadow
  shadowColor: 'rgba(0, 0, 0, 0.5)',
  shadowColorHover: 'rgba(0, 0, 0, 0.6)',
  shadowColorPress: 'rgba(0, 0, 0, 0.4)',
  shadowColorFocus: 'rgba(217, 119, 54, 0.3)',
  
  // Status colors
  success: bondfireColors.success,
  error: bondfireColors.error,
  warning: bondfireColors.warning,
  
  // Gray scale (mapped to Bondfire palette)
  gray1: bondfireColors.obsidian,
  gray2: bondfireColors.gunmetal,
  gray3: bondfireColors.charcoal,
  gray4: bondfireColors.iron,
  gray5: bondfireColors.slate,
  gray6: bondfireColors.slate,
  gray7: bondfireColors.ash,
  gray8: bondfireColors.ash,
  gray9: bondfireColors.ash,
  gray10: bondfireColors.whiteSmoke,
  gray11: bondfireColors.ash,
  gray12: bondfireColors.whiteSmoke,
  
  // Orange scale (mapped to Bondfire copper tones)
  orange1: '#1A0F08',
  orange2: '#2D1A0E',
  orange3: '#3D2213',
  orange4: '#4E2B18',
  orange5: bondfireColors.deepEmber,
  orange6: bondfireColors.ember,
  orange7: bondfireColors.bondfireCopper,
  orange8: bondfireColors.bondfireCopper,
  orange9: bondfireColors.bondfireCopper,
  orange10: bondfireColors.bondfireCopper,
  orange11: bondfireColors.moltenGold,
  orange12: bondfireColors.moltenGold,
})

// ============================================
// Light Theme
// ============================================
const lightTheme = createTheme({
  // Backgrounds
  background: bondfireColors.warmWhite,
  backgroundHover: bondfireColors.whiteSmoke,
  backgroundPress: '#E5E7EB',
  backgroundFocus: bondfireColors.whiteSmoke,
  backgroundStrong: '#FFFFFF',
  backgroundTransparent: 'rgba(250, 250, 250, 0)',
  
  // Foreground / Text
  color: bondfireColors.obsidian,
  colorHover: '#000000',
  colorPress: bondfireColors.gunmetal,
  colorFocus: bondfireColors.obsidian,
  colorTransparent: 'rgba(20, 20, 22, 0)',
  
  // Primary (Bondfire Copper)
  primary: bondfireColors.bondfireCopper,
  primaryHover: bondfireColors.deepEmber,
  primaryPress: bondfireColors.ember,
  primaryFocus: bondfireColors.bondfireCopper,
  
  // Secondary
  secondary: bondfireColors.deepEmber,
  secondaryHover: bondfireColors.bondfireCopper,
  secondaryPress: bondfireColors.ember,
  secondaryFocus: bondfireColors.deepEmber,
  
  // Accent colors
  accent: bondfireColors.bondfireCopper,
  accentHover: bondfireColors.deepEmber,
  accentPress: bondfireColors.ember,
  
  // Borders
  borderColor: '#D1D5DB',
  borderColorHover: bondfireColors.ash,
  borderColorPress: bondfireColors.bondfireCopper,
  borderColorFocus: bondfireColors.bondfireCopper,
  
  // Placeholder
  placeholderColor: bondfireColors.ash,
  
  // Shadow
  shadowColor: 'rgba(0, 0, 0, 0.1)',
  shadowColorHover: 'rgba(0, 0, 0, 0.15)',
  shadowColorPress: 'rgba(0, 0, 0, 0.08)',
  shadowColorFocus: 'rgba(217, 119, 54, 0.2)',
  
  // Status colors
  success: bondfireColors.successDark,
  error: bondfireColors.errorDark,
  warning: bondfireColors.warningDark,
  
  // Gray scale for light mode
  gray1: '#FFFFFF',
  gray2: bondfireColors.warmWhite,
  gray3: bondfireColors.whiteSmoke,
  gray4: '#E5E7EB',
  gray5: '#D1D5DB',
  gray6: bondfireColors.ash,
  gray7: bondfireColors.slate,
  gray8: bondfireColors.iron,
  gray9: bondfireColors.charcoal,
  gray10: bondfireColors.gunmetal,
  gray11: bondfireColors.slate,
  gray12: bondfireColors.obsidian,
  
  // Orange scale
  orange1: '#FFF7ED',
  orange2: '#FFEDD5',
  orange3: '#FED7AA',
  orange4: '#FDBA74',
  orange5: bondfireColors.moltenGold,
  orange6: bondfireColors.bondfireCopper,
  orange7: bondfireColors.bondfireCopper,
  orange8: bondfireColors.deepEmber,
  orange9: bondfireColors.deepEmber,
  orange10: bondfireColors.bondfireCopper,
  orange11: bondfireColors.deepEmber,
  orange12: '#7C2D12',
})

// ============================================
// Animations
// ============================================
const animations = createAnimations({
  bouncy: {
    type: 'spring',
    damping: 10,
    mass: 0.9,
    stiffness: 100,
  },
  lazy: {
    type: 'spring',
    damping: 20,
    stiffness: 60,
  },
  quick: {
    type: 'spring',
    damping: 20,
    mass: 1.2,
    stiffness: 250,
  },
  medium: {
    type: 'spring',
    damping: 15,
    stiffness: 120,
  },
  slow: {
    type: 'spring',
    damping: 20,
    stiffness: 60,
  },
})

// ============================================
// Fonts
// ============================================
const headingFont = createInterFont({
  size: {
    6: 15,
    7: 18,
    8: 21,
    9: 28,
    10: 38,
    sm: 18,
    md: 21,
    lg: 28,
    xl: 38,
  },
  weight: {
    6: '600',
    7: '700',
    8: '700',
    9: '800',
    10: '900',
  },
})

const bodyFont = createInterFont(
  {
    size: {
      1: 12,
      2: 14,
      3: 15,
      4: 16,
      5: 17,
      sm: 14,
      md: 16,
      lg: 18,
      xl: 20,
    },
  },
  {
    sizeLineHeight: (size) => size + 6,
  }
)

// ============================================
// Create Tamagui Config
// ============================================
export const config = createTamagui({
  animations,
  defaultTheme: 'dark',
  shouldAddPrefersColorThemes: true,
  themeClassNameOnRoot: true,
  shorthands,
  fonts: {
    heading: headingFont,
    body: bodyFont,
  },
  themes: {
    dark: darkTheme,
    light: lightTheme,
  },
  tokens,
  media: {
    xs: { maxWidth: 660 },
    sm: { maxWidth: 800 },
    md: { maxWidth: 1020 },
    lg: { maxWidth: 1280 },
    xl: { maxWidth: 1420 },
    xxl: { maxWidth: 1600 },
    gtXs: { minWidth: 660 + 1 },
    gtSm: { minWidth: 800 + 1 },
    gtMd: { minWidth: 1020 + 1 },
    gtLg: { minWidth: 1280 + 1 },
    short: { maxHeight: 820 },
    tall: { minHeight: 820 },
    hoverNone: { hover: 'none' },
    pointerCoarse: { pointer: 'coarse' },
  },
})

export type AppConfig = typeof config

declare module 'tamagui' {
  interface TamaguiCustomConfig extends AppConfig {}
}

export const tamaguiConfig = config

// Export colors for direct use in components
export { bondfireColors }
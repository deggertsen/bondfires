import {
  type GetProps,
  getTokenValue,
  Spinner as TamaguiSpinner,
  useTheme,
  variableToString,
} from 'tamagui'

type TamaguiSpinnerProps = GetProps<typeof TamaguiSpinner>

function resolveThemeColor(
  color: TamaguiSpinnerProps['color'],
  theme: ReturnType<typeof useTheme>,
) {
  if (typeof color !== 'string') {
    return color
  }

  // Tamagui v3 tokens have no `$` sigil: resolve config-first (theme key, then
  // color token) and treat anything unknown as a literal color.
  const themeValue = theme[color as keyof typeof theme]

  return themeValue
    ? variableToString(themeValue)
    : (getTokenValue(color as never, 'color') ?? color)
}

export function Spinner({ color, ...props }: TamaguiSpinnerProps) {
  const theme = useTheme()

  return <TamaguiSpinner {...props} color={resolveThemeColor(color, theme)} />
}

export type SpinnerProps = TamaguiSpinnerProps

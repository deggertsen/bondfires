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
  if (typeof color !== 'string' || color[0] !== '$') {
    return color
  }

  const themeKey = color.slice(1)
  const themeValue = theme[themeKey as keyof typeof theme]

  return themeValue
    ? variableToString(themeValue)
    : (getTokenValue(color as never, 'color') ?? color)
}

export function Spinner({ color, ...props }: TamaguiSpinnerProps) {
  const theme = useTheme()

  return <TamaguiSpinner {...props} color={resolveThemeColor(color, theme)} />
}

export type SpinnerProps = TamaguiSpinnerProps

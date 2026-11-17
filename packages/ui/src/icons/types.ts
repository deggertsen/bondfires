import type { ColorValue } from 'react-native'
import type { NumberProp, SvgProps } from 'react-native-svg'

/**
 * Props an icon body receives after `themed()` has resolved theme colors and
 * font-size tokens to plain values.
 */
export type ResolvedIconProps = Omit<SvgProps, 'color'> & {
  color?: ColorValue
  size?: NumberProp
}

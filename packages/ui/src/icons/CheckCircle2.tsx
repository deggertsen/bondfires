import type { IconProps } from '@tamagui/helpers-icon'
import { themed } from '@tamagui/helpers-icon'
import { memo } from 'react'
import { Circle as _Circle, Path, Svg } from 'react-native-svg'
import type { ResolvedIconProps } from './types'

export const CheckCircle2 = themed(
  memo(function CheckCircle2(props: IconProps) {
    const { color = 'black', size = 24, ...otherProps } = props as ResolvedIconProps
    return (
      <Svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke={color}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        {...otherProps}
      >
        <_Circle cx="12" cy="12" r="10" stroke={color} />
        <Path d="m9 12 2 2 4-4" stroke={color} />
      </Svg>
    )
  }),
)

import type { IconProps } from '@tamagui/helpers-icon'
import { themed } from '@tamagui/helpers-icon'
import { memo } from 'react'
import { Circle as _Circle, Line, Path, Svg } from 'react-native-svg'
import type { ResolvedIconProps } from './types'

export const Smile = themed(
  memo(function Smile(props: IconProps) {
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
        <Path d="M8 14s1.5 2 4 2 4-2 4-2" stroke={color} />
        <Line x1="9" x2="9.01" y1="9" y2="9" stroke={color} />
        <Line x1="15" x2="15.01" y1="9" y2="9" stroke={color} />
      </Svg>
    )
  }),
)

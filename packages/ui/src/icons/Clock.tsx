import type { IconProps } from '@tamagui/helpers-icon'
import { themed } from '@tamagui/helpers-icon'
import { memo } from 'react'
import { Circle as _Circle, Polyline, Svg } from 'react-native-svg'
import type { ResolvedIconProps } from './types'

export const Clock = themed(
  memo(function Clock(props: IconProps) {
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
        <Polyline points="12 6 12 12 16 14" stroke={color} />
      </Svg>
    )
  }),
)

import type { IconProps } from '@tamagui/helpers-icon'
import { themed } from '@tamagui/helpers-icon'
import { memo } from 'react'
import { Circle as _Circle, Path, Svg } from 'react-native-svg'
import type { ResolvedIconProps } from './types'

export const Users = themed(
  memo(function Users(props: IconProps) {
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
        <Path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" stroke={color} />
        <Path d="M16 3.128a4 4 0 0 1 0 7.744" stroke={color} />
        <Path d="M22 21v-2a4 4 0 0 0-3-3.87" stroke={color} />
        <_Circle cx="9" cy="7" r="4" stroke={color} />
      </Svg>
    )
  }),
)

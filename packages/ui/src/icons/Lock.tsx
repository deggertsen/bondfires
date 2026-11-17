import type { IconProps } from '@tamagui/helpers-icon'
import { themed } from '@tamagui/helpers-icon'
import { memo } from 'react'
import { Path, Rect, Svg } from 'react-native-svg'
import type { ResolvedIconProps } from './types'

export const Lock = themed(
  memo(function Lock(props: IconProps) {
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
        <Rect width="18" height="11" x="3" y="11" rx="2" ry="2" stroke={color} />
        <Path d="M7 11V7a5 5 0 0 1 10 0v4" stroke={color} />
      </Svg>
    )
  }),
)

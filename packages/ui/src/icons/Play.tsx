import type { IconProps } from '@tamagui/helpers-icon'
import { themed } from '@tamagui/helpers-icon'
import { memo } from 'react'
import { Polygon, Svg } from 'react-native-svg'
import type { ResolvedIconProps } from './types'

export const Play = themed(
  memo(function Play(props: IconProps) {
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
        <Polygon points="6 3 20 12 6 21 6 3" stroke={color} />
      </Svg>
    )
  }),
)

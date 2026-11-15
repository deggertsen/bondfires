import type { IconProps } from '@tamagui/helpers-icon'
import { themed } from '@tamagui/helpers-icon'
import { memo } from 'react'
import { Circle as _Circle, Path, Svg } from 'react-native-svg'
import type { ResolvedIconProps } from './types'

export const ArrowUpCircle = themed(
  memo(function ArrowUpCircle(props: IconProps) {
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
        <Path d="m16 12-4-4-4 4" stroke={color} />
        <Path d="M12 16V8" stroke={color} />
      </Svg>
    )
  }),
)

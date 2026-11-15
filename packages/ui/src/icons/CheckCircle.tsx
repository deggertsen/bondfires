import type { IconProps } from '@tamagui/helpers-icon'
import { themed } from '@tamagui/helpers-icon'
import { memo } from 'react'
import { Path, Svg } from 'react-native-svg'
import type { ResolvedIconProps } from './types'

export const CheckCircle = themed(
  memo(function CheckCircle(props: IconProps) {
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
        <Path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" stroke={color} />
        <Path d="m9 11 3 3L22 4" stroke={color} />
      </Svg>
    )
  }),
)

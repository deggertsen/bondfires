import type { IconProps } from '@tamagui/helpers-icon'
import { themed } from '@tamagui/helpers-icon'
import { memo } from 'react'
import { Path, Polyline, Svg } from 'react-native-svg'
import type { ResolvedIconProps } from './types'

export const Home = themed(
  memo(function Home(props: IconProps) {
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
        <Path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" stroke={color} />
        <Polyline points="9 22 9 12 15 12 15 22" stroke={color} />
      </Svg>
    )
  }),
)

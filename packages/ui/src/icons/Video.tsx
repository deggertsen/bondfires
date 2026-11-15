import type { IconProps } from '@tamagui/helpers-icon'
import { themed } from '@tamagui/helpers-icon'
import { memo } from 'react'
import { Path, Rect, Svg } from 'react-native-svg'
import type { ResolvedIconProps } from './types'

export const Video = themed(
  memo(function Video(props: IconProps) {
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
        <Path
          d="m16 13 5.223 3.482a.5.5 0 0 0 .777-.416V7.87a.5.5 0 0 0-.752-.432L16 10.5"
          stroke={color}
        />
        <Rect x="2" y="6" width="14" height="12" rx="2" stroke={color} />
      </Svg>
    )
  }),
)

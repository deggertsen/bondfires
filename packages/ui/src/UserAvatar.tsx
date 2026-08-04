import type { ReactNode } from 'react'
import { Avatar, YStack } from 'tamagui'
import { Text } from './Text'

// Ember tones straight from the brand palette rather than theme tokens: these
// circles are drawn over video and on themed surfaces alike, so a token that
// flips with the theme is only ever right in one of those places.
const INITIALS_BACKGROUND = '#A04E24'
const INITIALS_COLOR = '#F3F4F6'
// Initials sit a little under half the circle's height, which keeps two letters
// comfortably inside the smallest avatars we draw (24px in a row stack).
const INITIALS_SCALE = 0.36

/**
 * "David Eggertsen" → "DE", a mononym → one letter, nothing usable → "?".
 * Array.from so a name starting with an emoji or an astral character is not
 * sliced mid-codepoint.
 */
export function userInitials(name?: string | null) {
  const words = (name ?? '').trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return '?'
  const first = Array.from(words[0])[0] ?? ''
  const last = words.length > 1 ? (Array.from(words[words.length - 1])[0] ?? '') : ''
  return `${first}${last}`.toUpperCase()
}

export type UserAvatarProps = {
  /** Used for the initials when there is no photo. */
  name?: string | null
  photoUrl?: string | null
  /** Numeric so the initials can scale with the circle. */
  size: number
  /** Replaces the initials — for states that mean something else, like "invite sent". */
  fallback?: ReactNode
  fallbackBackgroundColor?: string
  borderWidth?: number
  borderColor?: string
  borderRadius?: number
  marginLeft?: number
}

/**
 * The one avatar in the app: a photo when we have one, the person's initials on
 * an ember circle when we don't.
 *
 * Tamagui only paints `Avatar.Fallback` while the avatar's image loading status
 * is not 'loaded', and that status is only ever set by `Avatar.Image`. With no
 * photo there is no image child, so the status never moves off its initial
 * value and the fallback never renders — which is why avatars for people
 * without a profile photo used to be empty circles. So the no-photo case draws
 * the circle itself, and `Avatar.Fallback` is kept only for the case it does
 * handle: a photo that exists but fails to load.
 */
export function UserAvatar({
  name,
  photoUrl,
  size,
  fallback,
  fallbackBackgroundColor = INITIALS_BACKGROUND,
  borderRadius,
  ...frameProps
}: UserAvatarProps) {
  const radius = borderRadius ?? size / 2
  const fallbackContent = fallback ?? (
    <Text
      fontSize={Math.round(size * INITIALS_SCALE)}
      fontWeight="700"
      color={INITIALS_COLOR}
      letterSpacing={0.5}
    >
      {userInitials(name)}
    </Text>
  )

  if (!photoUrl) {
    return (
      <YStack
        width={size}
        height={size}
        borderRadius={radius}
        backgroundColor={fallbackBackgroundColor}
        alignItems="center"
        justifyContent="center"
        flexShrink={0}
        {...frameProps}
      >
        {fallbackContent}
      </YStack>
    )
  }

  return (
    <Avatar size={size} borderRadius={radius} flexShrink={0} {...frameProps}>
      <Avatar.Image source={{ uri: photoUrl }} />
      <Avatar.Fallback
        backgroundColor={fallbackBackgroundColor}
        alignItems="center"
        justifyContent="center"
      >
        {fallbackContent}
      </Avatar.Fallback>
    </Avatar>
  )
}

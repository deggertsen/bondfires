export const FREE_EMOJIS = ['🙏', '❤️', '🔥'] as const

export const ALL_EMOJIS = [
  '🙏',
  '❤️',
  '🔥',
  '😂',
  '😮',
  '👏',
  '💪',
  '🙌',
  '💯',
  '✅',
  '👀',
  '🎉',
  '😢',
  '😍',
  '🤔',
  '👍',
] as const

export function isFreeEmoji(emoji: string): boolean {
  return (FREE_EMOJIS as readonly string[]).includes(emoji)
}

export function isReactionEmoji(emoji: string): boolean {
  return (ALL_EMOJIS as readonly string[]).includes(emoji)
}

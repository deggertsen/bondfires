export const FREE_EMOJIS = ['🙏', '❤️', '🔥']

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
]

export function isFreeEmoji(emoji: string): boolean {
  return FREE_EMOJIS.includes(emoji)
}

export const MAX_RECENT_EMOJIS = 4

export type EmojiUsage = {
  emoji: string
  createdAt: number
}

export function rankRecentEmojis(reactions: EmojiUsage[], limit = MAX_RECENT_EMOJIS): string[] {
  const stats = new Map<string, { count: number; mostRecentAt: number; firstSeenIndex: number }>()

  reactions.forEach((reaction, index) => {
    const current = stats.get(reaction.emoji)
    if (current) {
      current.count += 1
      current.mostRecentAt = Math.max(current.mostRecentAt, reaction.createdAt)
      return
    }

    stats.set(reaction.emoji, {
      count: 1,
      mostRecentAt: reaction.createdAt,
      firstSeenIndex: index,
    })
  })

  return [...stats.entries()]
    .sort((a, b) => {
      if (b[1].count !== a[1].count) {
        return b[1].count - a[1].count
      }
      if (b[1].mostRecentAt !== a[1].mostRecentAt) {
        return b[1].mostRecentAt - a[1].mostRecentAt
      }
      return a[1].firstSeenIndex - b[1].firstSeenIndex
    })
    .slice(0, limit)
    .map(([emoji]) => emoji)
}

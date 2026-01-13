export interface CompletionMessage {
  message: string
  emoji: string
}

export const completionMessages: CompletionMessage[] = [
  { message: 'Nice work!', emoji: '🔥' },
  { message: 'You nailed it!', emoji: '🎯' },
  { message: "That's what I'm talking about!", emoji: '💪' },
  { message: 'Well done!', emoji: '👏' },
  { message: 'Hell yeah!', emoji: '🤘' },
  { message: 'Absolute legend!', emoji: '👑' },
  { message: 'Crushed it!', emoji: '💥' },
  { message: 'Straight fire!', emoji: '🔥' },
  { message: "That's the way!", emoji: '✊' },
  { message: 'Powerful!', emoji: '💪' },
  { message: 'Impressive!', emoji: '🎖️' },
  { message: 'Top tier!', emoji: '⭐' },
  { message: 'Respect!', emoji: '🙏' },
  { message: "You're a beast!", emoji: '🦁' },
  { message: "That's how it's done!", emoji: '🏆' },
]

export function getRandomCompletionMessage(): CompletionMessage {
  const randomIndex = Math.floor(Math.random() * completionMessages.length)
  return completionMessages[randomIndex]
}

export interface CompletionMessage {
  message: string
  emoji: string
}

/**
 * Tone buckets for the post-recording congratulation screen.
 *
 * Everyone sees the `neutral` pool. On top of that, users whose profile
 * gender is `male` or `female` get a blend with their matching pool, so the
 * copy feels addressed to them without ever being exclusive. Gender
 * `other`/unset falls back to the neutral pool alone.
 */
export const neutralCompletionMessages: CompletionMessage[] = [
  { message: 'Nice work!', emoji: '🔥' },
  { message: 'You nailed it!', emoji: '🎯' },
  { message: 'Well done!', emoji: '👏' },
  { message: "That's the way!", emoji: '✊' },
  { message: 'Powerful!', emoji: '💪' },
  { message: 'Impressive!', emoji: '🎖️' },
  { message: 'Top tier!', emoji: '⭐' },
  { message: 'Respect!', emoji: '🙏' },
  { message: "That's how it's done!", emoji: '🏆' },
]

export const masculineCompletionMessages: CompletionMessage[] = [
  { message: 'Hell yeah!', emoji: '🤘' },
  { message: "You're a beast!", emoji: '🦁' },
  { message: "That's what I'm talking about!", emoji: '💪' },
  { message: 'Crushed it!', emoji: '💥' },
  { message: 'Absolute legend!', emoji: '👑' },
  { message: 'Straight fire!', emoji: '🔥' },
]

export const feminineCompletionMessages: CompletionMessage[] = [
  { message: 'You were born for this!', emoji: '🌟' },
  { message: 'So proud of you!', emoji: '💛' },
  { message: 'That came from the heart.', emoji: '💖' },
  { message: 'You spoke your truth.', emoji: '💫' },
  { message: 'Beautifully done!', emoji: '🌸' },
  { message: 'Queen energy!', emoji: '👑' },
  { message: 'Absolutely radiant!', emoji: '✨' },
  { message: "You're a force!", emoji: '🌪️' },
  { message: 'Powerful and poised!', emoji: '🕊️' },
  { message: 'Stunning!', emoji: '💎' },
  { message: 'You shine!', emoji: '☀️' },
  { message: 'Graceful and bold!', emoji: '🦋' },
  { message: 'You made it look easy!', emoji: '⭐' },
  { message: 'Effortless!', emoji: '💐' },
]

export type CompletionGender = 'male' | 'female' | 'other' | null | undefined

/**
 * The full candidate pool for a gender: the neutral pool plus the matching
 * gender pool. Neutral-only for everyone else.
 */
export function getCompletionMessages(gender: CompletionGender): CompletionMessage[] {
  if (gender === 'female') {
    return [...feminineCompletionMessages, ...neutralCompletionMessages]
  }
  if (gender === 'male') {
    return [...masculineCompletionMessages, ...neutralCompletionMessages]
  }
  return [...neutralCompletionMessages]
}

/**
 * Pick a random congratulation for the given gender. Defaults to the neutral
 * pool when gender is unknown.
 */
export function getRandomCompletionMessage(gender?: CompletionGender): CompletionMessage {
  const pool = getCompletionMessages(gender)
  const randomIndex = Math.floor(Math.random() * pool.length)
  return pool[randomIndex]
}

import { useEffect, useRef, useState } from 'react'
import {
  type CompletionGender,
  type CompletionMessage,
  getRandomCompletionMessage,
} from '../data/completionMessages'
import { useCurrentUserId } from './useCurrentUserId'

/**
 * Picks a post-recording congratulation once, tailored to the signed-in
 * user's gender (neutral + matching pool). Re-picks once auth/profile
 * resolves so an unloaded profile doesn't lock the user into the neutral
 * pool for the whole screen. Stable afterwards.
 */
export function useCompletionMessage(): CompletionMessage {
  const { currentUser, isLoading } = useCurrentUserId()
  const gender: CompletionGender = isLoading ? undefined : (currentUser?.gender ?? null)

  const [message, setMessage] = useState<CompletionMessage>(() =>
    getRandomCompletionMessage(gender),
  )
  const resolvedRef = useRef(!isLoading)

  useEffect(() => {
    if (isLoading || resolvedRef.current) return
    resolvedRef.current = true
    setMessage(getRandomCompletionMessage(gender))
  }, [isLoading, gender])

  return message
}

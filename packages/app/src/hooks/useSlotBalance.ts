import { useQuery } from 'convex/react'
import { api } from '../../../../convex/_generated/api'

export function useSlotBalance() {
  const result = useQuery(api.campSlots.getSlotBalance, {})

  return {
    balance: result?.balance ?? 0,
    transactions: result?.transactions ?? [],
    isLoading: result === undefined,
    error: result === null ? new Error('Not authenticated') : null,
  }
}

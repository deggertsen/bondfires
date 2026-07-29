import { describe, expect, it } from 'vitest'
import { isUserCancelledPurchase } from '../../../packages/app/src/utils/subscriptionIapPolicy'

describe('isUserCancelledPurchase', () => {
  it('recognizes the native cancellation code without relying on localized copy', () => {
    expect(isUserCancelledPurchase({ code: 'E_USER_CANCELLED' }, 'Operation failed')).toBe(true)
  })

  it('recognizes common cancellation messages from both stores', () => {
    expect(isUserCancelledPurchase({}, 'User cancelled the purchase')).toBe(true)
    expect(isUserCancelledPurchase({}, 'Purchase canceled')).toBe(true)
  })

  it('does not classify unrelated references to cancellation as user cancellations', () => {
    expect(isUserCancelledPurchase({}, 'This subscription cannot be cancelled here')).toBe(false)
    expect(isUserCancelledPurchase({ code: 'E_NETWORK_ERROR' }, 'Purchase failed')).toBe(false)
  })
})

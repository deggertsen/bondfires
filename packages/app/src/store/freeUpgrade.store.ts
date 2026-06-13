import { observable } from '@legendapp/state'
import { syncObservable } from '@legendapp/state/sync'
import { telemetry } from '../services/telemetry'
import { subscriptionActions } from './subscription.store'

/**
 * Where a free-user upgrade surface was triggered from. Used as the `source`
 * field on the `paywall:*` telemetry events so we can attribute conversions to
 * specific entry points now that the always-visible Spark tab is gone.
 */
export type PaywallSource =
  | 'live_blocked'
  | 'camps_hearth_card'
  | 'feed_empty'
  | 'feed_spark'
  | 'feed_summary'
  | 'camp_detail'

interface FreeUpgradeState {
  /** Whether the "What can I do for free?" explainer modal is visible. */
  isExplainerVisible: boolean
  /** The entry point that opened the explainer, carried onto its "View Plans" CTA. */
  explainerSource: PaywallSource | null
}

export const freeUpgradeStore$ = observable<FreeUpgradeState>({
  isExplainerVisible: false,
  explainerSource: null,
})

/**
 * Persisted dismissal of the free-user Feed summary card (M11). Once dismissed
 * it stays dismissed across app restarts so we don't nag, while still being the
 * persistent low-friction upgrade front door until the user hides it.
 */
export const freeSummaryDismissed$ = observable<{ dismissed: boolean }>({ dismissed: false })

syncObservable(freeSummaryDismissed$, {
  persist: {
    name: 'bondfires-free-summary-dismissed',
  },
})

export const freeUpgradeActions = {
  /** Open the subscription paywall, attributing the entry point for telemetry. */
  openPaywall(source: PaywallSource) {
    telemetry.info('paywall:opened_from', 'Subscription paywall opened', { source })
    subscriptionActions.showPaywall()
  },

  /** Open the free-capabilities explainer modal. */
  openExplainer(source: PaywallSource) {
    telemetry.info('paywall:explainer_clicked', 'Free-capabilities explainer opened', { source })
    freeUpgradeStore$.explainerSource.set(source)
    freeUpgradeStore$.isExplainerVisible.set(true)
  },

  hideExplainer() {
    freeUpgradeStore$.isExplainerVisible.set(false)
  },

  /** Move from the explainer into the paywall (the explainer's "View Plans" CTA). */
  openPaywallFromExplainer() {
    const source = freeUpgradeStore$.explainerSource.get() ?? 'live_blocked'
    freeUpgradeStore$.isExplainerVisible.set(false)
    freeUpgradeActions.openPaywall(source)
  },

  /** Record that an upgrade CTA became visible (e.g. the live-screen safety net). */
  trackCtaShown(source: PaywallSource) {
    telemetry.info('paywall:cta_shown', 'Upgrade CTA shown', { source })
  },

  /** Record that an upgrade CTA was tapped. */
  trackCtaClicked(source: PaywallSource) {
    telemetry.info('paywall:cta_clicked', 'Upgrade CTA clicked', { source })
  },

  dismissSummaryCard() {
    freeSummaryDismissed$.dismissed.set(true)
  },
}

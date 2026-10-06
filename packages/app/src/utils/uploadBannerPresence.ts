/**
 * Presence state machine for the app-wide upload status strip ("Ember Strip",
 * docs/plans/2026-09-29-upload-status-banner.md).
 *
 * The strip sits in flow and, on hide, animates its own height down to the
 * status-bar inset. Screens below must give up their compact top padding at the
 * moment the strip leaves the tree — NOT when the underlying upload status goes
 * idle — otherwise the content jumps down at the start of the exit. Keeping the
 * "is the strip actually occupying space" decision pure makes that contract
 * explicit and unit-testable, independent of React.
 *
 * Kept free of React/native imports so it is unit-testable.
 */

export interface UploadBannerPresence {
  /** True while the strip is rendered, including while it animates away. */
  mounted: boolean
  /** True while the strip is playing its exit animation. */
  exiting: boolean
}

export interface UploadBannerPresenceInput {
  /** Target visibility from the upload status plus the route/recording gates. */
  visible: boolean
  /**
   * True when the hide must be instantaneous — the camera/recording lock or the
   * create route — rather than animated. The strip must never animate over the
   * camera or the completion screen.
   */
  immediateHide: boolean
}

export const UPLOAD_BANNER_HIDDEN: UploadBannerPresence = { mounted: false, exiting: false }

/**
 * Next presence for a hide/show transition. Returns the same object when
 * nothing changes so a React state setter can bail out of a re-render.
 *
 * - `visible` -> mounted and not exiting (a re-show mid-exit cancels the exit).
 * - hidden while not mounted -> unchanged.
 * - hidden while mounted and `immediateHide` -> removed at once.
 * - hidden while mounted otherwise -> start (or continue) the exit animation.
 */
export function nextBannerPresence(
  prev: UploadBannerPresence,
  input: UploadBannerPresenceInput,
): UploadBannerPresence {
  if (input.visible) {
    if (prev.mounted && !prev.exiting) return prev
    return { mounted: true, exiting: false }
  }
  if (!prev.mounted) return prev
  if (input.immediateHide) return { mounted: false, exiting: false }
  if (prev.exiting) return prev
  return { mounted: true, exiting: true }
}

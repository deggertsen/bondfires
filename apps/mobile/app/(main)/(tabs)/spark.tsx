/**
 * Spark tab stub.
 *
 * The real create screen lives at `(main)/create` (a pushed stack screen) so it
 * mounts on push and FULLY unmounts on navigate-away — no lingering duplicate
 * instance fighting the active one, and no orphaned Mux live session quietly
 * costing money. This file only exists to back the Flame tab-bar entry; its
 * press handler in `(tabs)/_layout.tsx` pushes the real screen.
 *
 * IMPORTANT: this stub must NEVER navigate. An earlier version redirected here
 * to `/(main)/create` on focus, which — when react-navigation briefly considered
 * this tab focused while the real create screen was already pushed on top —
 * fired a `router.replace` that tore down and re-mounted the active create
 * screen in a ~6s loop, thrashing the camera and orphaning Mux sessions.
 *
 * Leaving the stub inert avoids any navigation side effect if the tab route is
 * focused by navigation bookkeeping. Controlled legacy paths are resolved in
 * `lib/routes.ts` directly to the pushed create route instead of relying on this
 * component as a redirect bridge.
 */
export default function SparkTabStub() {
  return null
}

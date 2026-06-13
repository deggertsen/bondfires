# Free User Experience

**Author(s):** David (mavrick2424) + Forge
**Date:** 2026-06-12
**Status:** Draft
**Complexity:** Large

---

# ONE-PAGER

## Diagnosis

Free users are the entry tier for Bondfires. Today the app repeatedly places a "Spark" action in front of them (tab bar, feed header, camp detail, camp picker, personal hearth card) and then dead-ends them on a camera screen with a passive text message and **no button to upgrade**. PR #104 (commit `2ed9db7`) made it worse on the live path by removing the working `Alert.alert("Upgrade to Create", …, [{text:"View Plans", onPress: showPaywall}])` flow. The result: free users discover the paywall by getting stuck, with no explanation of the free-vs-paid value prop and no graceful recovery.

## Current Gaps

- The Spark tab in the bottom bar is always visible to free users and is dead-on-arrival — hostile for the primary nav action.
- The live record screen's "blocked" state is a passive message; the user has no way to open the paywall from the camera view.
- "Spark Here" on camp detail and "Spark" at the top of the Feed both route to create and dead-end for free users without any framing.
- The Hearth card on the Camps tab is a single line — "Upgrade to Plus to start your own hearth" — with no value prop for what Hearth actually is or what free users get today.
- The paywall sheet's free-tier row is minimal and free users are routed to it without context.
- Free users can never spark, anywhere, regardless of camp membership — this is a product decision, but the UI doesn't communicate it as a deliberate "respond-only" identity vs. a missing feature.

## Solution Summary

Rebrand the free experience as a coherent **respond-first** identity: clear entry to the upgrade journey when free users hit a spark wall, never trap them in flow, and educate them about free value while making the upgrade path feel earned.

**Guiding principle — dead-end vs. invitation.** The problem today is not that spark is gated; it's that every spark surface is a *dead-end* (the user reaches for it and gets stopped on a screen they can't use). The fix is not to hide every spark affordance. It is to ensure **a free user is never routed into a screen they cannot act on**, while keeping surfaces that *invite* them to understand the upgrade. So: spark disappears from persistent navigation chrome (the tab), contextual spark surfaces become invitations that open the explainer/paywall *directly* (never the camera), and the live-screen block-CTA is retained only as a **safety net** for edge paths we didn't intercept (old deep links, legacy affordances, notifications). No primary free-user flow should ever reach the live-screen block state.

Specifically: (1) hide the Spark tab for free users (nav chrome can't be made inviting, only walling); (2) make the Feed header "Spark" open the explainer/paywall directly for free users — it never routes to the live screen; (3) replace "Spark Here" on camp detail with a soft invitation hint for free members instead of a dead-end button; (4) keep the live-screen "View Plans" / "What can I do for free?" block-CTA as a safety net for any path that still reaches the camera; (5) upgrade the Hearth card to a stable-size, value-rich card that educates without nagging; (6) keep one persistent, low-friction upgrade front door on the Feed now that the tab is gone; (7) expand the paywall's free-tier row so the upgrade sheet is educational, not just a price list.

## Not Doing (Out of Scope)

- **Onboarding flow** for new free users post-signup. Parked for a separate spec; flagged as a follow-up.
- **Kindling / consumable upgrades for free users.** Kindling is pro-only; free users never see it and we will not introduce it.
- **Pricing changes, new tiers, free trial mechanics.** This is UX/IA work; commercial model is untouched.
- **Backend changes to `assertCanCreateBondfire`.** Free users are correctly gated from creating anywhere; the work is surface-level UX, not permission model.
- **A/B testing infrastructure, analytics dashboards.** We will emit telemetry events, but dashboards/experiments are out of scope.
- **Redesigning the paywall sheet from scratch.** We will only enrich the free-tier row and the entry CTA on the blocked state; tier comparison and purchase flow are unchanged.

---

# VERIFICATION CONTRACT

## Success Criteria

### Must Have

- [ ] **M1. Spark tab is hidden for free users; the tabs bar shows 4 tabs (`Camps / Feed / My Fires / Profile`) with stable layout, no empty slot.**
  - *Verify by:* log in as a seeded free-tier user on a development build; the tab bar contains exactly 4 entries; tapping `Camps` or `Feed` or `My Fires` or `Profile` works; verify a paid-tier user (Plus or above) still sees 5 tabs with Spark visible.

- [ ] **M2. SAFETY NET. If a free user somehow reaches the live record screen (old deep link to `routes.create`, legacy affordance, notification, or any path not intercepted upstream), the screen shows a "View Plans" CTA instead of dead-ending.** This is a backstop, not a primary flow — primary surfaces (Feed header, camp detail) must open the explainer/paywall directly per M6/M4 and should never route here.
  - *Verify by:* force-navigate a free user to `routes.create` directly (simulate a stale deep link); the live screen renders, `preConnectBlockReason` is set, the overlay shows a primary "View Plans" button that calls `showPaywall()` and a secondary "What can I do for free?" link that opens the explainer (W1). Tapping "View Plans" opens the SubscriptionPaywall sheet. Confirm that under normal navigation (Feed header / camp detail), a free user never lands on this screen.

- [ ] **M3. The Hearth card on the Camps tab, when shown to a free user, is the same outer dimensions as the existing card but with richer content: Hearth value prop (private group of friends, invite-only, 7-day invite codes, tier-gated retention) in 2–3 short lines, plus the existing "Upgrade to Plus" CTA. Card height/width does not change.**
  - *Verify by:* measure the card frame with the dev layout inspector before and after — width/height/padding/margin unchanged. Visual diff shows the new copy fits within the existing card.

- [ ] **M4. The "Spark Here" button on camp detail is hidden for free members and replaced with a soft invitation hint (not a dead-end button). The "Join Camp" / "Request to Join" button is unaffected.**
  - The hint shows only when the free user is a *member* of the camp (so non-members don't see confusing copy), e.g. "Free members can join and respond here — spark your own with Plus." Tapping the hint opens the explainer/paywall; it never routes to the live screen.
  - *Verify by:* as a free user, open a public camp you're a member of — the "Spark Here" button is not rendered; the soft hint is shown and opens the explainer/paywall on tap. As a paid user in the same camp, the "Spark Here" button is rendered and the hint is absent. As a free non-member, neither the button nor the hint appears. Free users still see "Join Camp" and "Respond" on the bondfires list inside the camp.

- [ ] **M5. The Feed empty state for free users (when the filtered feed is empty) shows a free-friendly message and CTA — e.g., "Join a camp to see Bondfires here" or "Browse the feed to find a fire to respond to" — instead of the current "Spark a Bondfire / Be the first to share a video!" copy that dead-ends them.**
  - *Verify by:* as a free user, set the feed filter to a camp you haven't joined (or use a state with no bondfires); the empty state renders free-friendly copy and a CTA that goes somewhere useful (browse camps or feed).

- [ ] **M6. The Feed header "Spark" button, when tapped by a free user, opens the explainer/paywall DIRECTLY — it never routes to the live record screen.** (For paid users the button is unchanged and routes to create.)
  - *Verify by:* as a free user on the Feed tab, tap "Spark" in the top-right; the explainer (W1) or paywall opens immediately as a modal/sheet; the live record screen is never mounted. Confirm `paywall:opened_from` fires with `source: feed_spark`. As a paid user, the button still routes to the create flow.

- [ ] **M7. The SubscriptionPaywall sheet's free-tier row, when shown to a free user, lists the same capabilities as the M5 empty state / M2 explainer — so the upgrade sheet is consistent with in-flow messaging. Free-tier features (browse, join camps, watch, respond) are listed with checkmarks; the paid-tier rows list what they unlock (spark, hearth, longer retention, etc.).**
  - *Verify by:* open the paywall as a free user; the free row's features match the in-flow copy; visually check no checkbox is missing or extra.

- [ ] **M8. All existing free-user "respond" and "join" flows still work end-to-end with no regression.**
  - *Verify by:* manual regression — as a free user, (a) open a bondfire, tap "Respond", complete a response recording, see it land in the bondfire; (b) open a public camp, tap "Join Camp", land on the camp feed; (c) open a personal camp via invite link, see and respond to its bondfires.

- [ ] **M9. Telemetry events fire for the new flow points: `paywall:cta_shown` (live screen blocked), `paywall:cta_clicked` (View Plans tapped), `paywall:explainer_clicked` (What can I do for free? tapped), `paywall:opened_from` with source (`live_blocked`, `camps_hearth_card`, `feed_empty`, `feed_spark`, `feed_summary`, `camp_detail`).**
  - *Verify by:* trigger each entry point in dev, inspect the `clientLogs` Convex table for the matching event with the correct `source` value.

- [ ] **M10. The pre-release audit per `docs/RELEASE_PROCESS.md` passes — navigation integrity, TypeScript compile, build health, architecture consistency — for the changed files.**
  - *Verify by:* `npx tsc --noEmit` exits 0; manual route walk-through of all changed screens; no new top-level abstractions.

- [ ] **M11. With the Spark tab gone, free users retain at least one persistent, low-friction upgrade front door on the Feed: a dismissible summary card (above the camp pills, below the header) — "You're on the free plan — respond to any fire, or upgrade to spark your own" with an "Upgrade" link.** (Promoted from W4. Rationale: removing the tab removes the most prominent always-visible upgrade trigger; this is the conversion-surface replacement.)
  - *Verify by:* as a free user, the card renders on the Feed; tapping "Upgrade" opens the paywall and fires `paywall:opened_from` with `source: feed_summary`; dismissing it removes the card and reclaims its vertical space; the dismissed state persists across app restarts (persisted observable). Paid users never see the card.

- [ ] **M12. The free value prop is communicated PROACTIVELY, not only after hitting a wall.** A free user can see what they *can* do (browse, join, watch, respond) without first triggering a block — via the M11 summary card and/or the Hearth card's explainer entry. The "respond-first identity" is legible on first run, not discovered by getting stopped.
  - *Verify by:* a fresh free user who never taps a spark surface still encounters at least one positive-framing surface (M11 card copy, or the explainer reachable from it) describing free capabilities.

- [ ] **M13. The tab bar reacts to a live, mid-session tier change without an app restart.** A free user who upgrades to Plus in-session sees the Spark tab appear; a user whose subscription lapses to free in-session sees it disappear. The layout reads `useSubscription` reactively.
  - *Verify by:* in dev, mutate the active subscription tier (free→Plus and Plus→free) while the app is foregrounded on the tab bar; the tab count updates (4↔5) without a reload or relaunch.

- [ ] **M14. New, screen-reader-facing UI carries accessibility labels.** The live-screen "View Plans" / "What can I do for free?" CTAs, the M11 summary card "Upgrade" link, the M4 soft hint, and the W1 explainer's buttons all have `accessibilityLabel` / `accessibilityRole` set, consistent with existing CTA patterns.
  - *Verify by:* VoiceOver (iOS) walk-through of each new control announces a meaningful label and role.

### Nice to Have

- [ ] **W1. "What can I do for free?" explainer** is a styled in-app modal (or sheet) that shows three free capabilities with icons: **Join camps** (open to your tier), **Watch Bondfires** (TikTok-style feed), **Respond to Bondfires** (record a response video, ≤5 min), and a single "View Plans" primary CTA at the bottom. This is the explainer M2 links to.
- [ ] **W2. The Hearth card, when shown to a free user, has a small subtle "i" icon that opens the same free-capabilities explainer** — extra discoverability beyond the "View Plans" CTA.
- [ ] **W3. The My Fires tab, for a free user with no responses, shows a free-friendly empty state** (currently may show "no fires" or be a paid-feature message) — make sure free users see they can use this tab once they respond to something.
- [ ] **W4. → Promoted to M11** (the free-user Feed summary card is now a Must Have, since it replaces the upgrade trigger lost by hiding the Spark tab).
- [ ] **W5. The personal camp "invite-only" entry** — when a free user is invited to a personal bondfire, the join flow could highlight that they can respond without paying. Verify the existing flow does this; if it doesn't, add a small line.
- [ ] **W6. → Promoted into M4** (the camp-detail soft hint is now the required replacement for the hidden "Spark Here" button, not an optional extra).

## Verification Scenarios

### Happy Path

1. **Given** a free user with the new build installed, **when** they open the app, **then** the tab bar shows 4 tabs (Camps / Feed / My Fires / Profile), the Spark tab is not visible.
2. **Given** a free user on the Feed tab, **when** they tap "Spark" in the top-right, **then** the explainer/paywall opens directly (the live record screen is never mounted), and tapping "View Plans" opens the paywall sheet.
3. **Given** a free user on the Camps tab, **when** they see the Hearth card, **then** it shows the rich value-prop copy and a "View Plans" CTA; tapping the card or CTA opens the paywall.
4. **Given** a free member on a public camp detail, **when** the camp loads, **then** "Spark Here" is hidden and the soft invitation hint is shown; "Join Camp" or "Respond" is shown as appropriate. Tapping the hint opens the explainer/paywall.
5. **Given** a free user opens the paywall sheet, **when** they view the free tier row, **then** the features list matches the in-flow messaging: browse, join, watch, respond.
6. **Given** a paid user (Plus+) on the same build, **when** they open the app, **then** the Spark tab is visible in the tab bar (5 tabs).
7. **Given** a free user on the Feed, **when** they open the app, **then** the M11 summary card is visible above the camp pills and communicates free capabilities + an Upgrade link without the user having to tap any spark surface.
8. **Given** a free user who upgrades to Plus mid-session, **when** the purchase resolves, **then** the Spark tab appears in the tab bar without an app restart.

### Edge Cases

1. **Given** a free user on a personal camp invite deep link (`/personal-bondfire/[id]/[code]`), **when** they accept, **then** the personal bondfire loads and respond is available; no paywall nag appears during the flow.
2. **Given** a free user with a stale subscription (e.g., a Plus subscription that expired), **when** they open the app, **then** they see the free-tier experience (no Spark tab, hearth card in "frozen/upgrade" state).
3. **Given** a free user mid-recording of a response (which is allowed), **when** the live publisher reports a transient error, **then** the recovery path is unchanged — no M2 block-CTA is shown mid-recording (block-CTA is for spark pre-connect, not response).
4. **Given** a returning free user on a cold start (`subscription` still loading), **when** the layout renders, **then** the first paint already shows 4 tabs by reading a **persisted last-known tier** (Legend State persisted observable, per CLAUDE.md), avoiding the 5→4 snap that a "default to 5 while loading" strategy would cause on every launch. Only a user with no persisted tier (true first run) defaults to the 5-tab layout and re-renders once `subscription` resolves. Document this in code.
5. **Given** a free user on the Feed with the empty-state CTA tapped, **when** the destination is "browse camps", **then** navigation goes to the Camps tab (not the Create screen).
6. **Given** a stale deep link or notification pointing a free user directly at `routes.create`, **when** it resolves, **then** the M2 safety-net block-CTA is shown (not a passive dead-end), and the user can reach the paywall/explainer from it.

### Regression Checks

- All existing paid-tier flows (spark, hearth create, hearth manage, archive, etc.) work unchanged.
- All existing free-tier "respond" flows complete end-to-end.
- All existing "join camp" flows for public/approval/invite-only camps work unchanged.
- Deep link invite flows for personal bondfires work unchanged.
- The legacy `LegacyRecordScreen` alert-with-CTA path remains functional (the simulator/no-dev-build fallback) — verify on simulator that the Alert.alert("Upgrade to Create", …, [{text: "View Plans", onPress: showPaywall}]) still fires for free users.
- `npx tsc --noEmit` passes; `npx convex dev --typecheck` passes.
- `clientLogs` table still receives existing telemetry events; new events have stable names and `source` values.

## Post-Release Guardrail Metric

This is a monetization-sensitive change: hiding the Spark tab removes the most prominent always-visible upgrade trigger. A/B testing is out of scope, so we will not run a controlled experiment — but we **must** name a guardrail and watch it. The guardrail is the **free→paid conversion rate** (new paid subscriptions divided by active free users, weekly). Capture a 2–4 week pre-release baseline before merge, then watch the same window post-release using the M9 telemetry (`paywall:opened_from` by source, `paywall:cta_clicked`) plus the existing subscription-start events. If conversion drops materially versus baseline, the M11 front door and/or the explainer copy are the first levers to revisit. Owner: David, to confirm the baseline source before merge.

## Automated Tests

No new automated tests are in scope. The change is UX/IA surface; the verification is manual walk-through of the scenarios above. Future: a Detox or Maestro E2E test for the tab-bar reshape and blocked-overlay CTA could be added in a follow-up.

**Validation commands:**

```bash
npx tsc --noEmit
npx convex dev --typecheck
yarn turbo run typecheck
```

---

# IMPLEMENTATION CONTEXT

## Required Reading

- `apps/mobile/app/(main)/(tabs)/_layout.tsx` — current 5-tab layout; this is the reshape point.
- `apps/mobile/components/create/LiveRecordScreen.tsx` — `preConnectBlockReason` (line 540) and the `showPreConnectBlocked` render (line 818) are where the M2 **safety-net** CTA goes. Note: under the new IA this screen should be unreachable by free users via primary nav (Feed header / camp detail intercept upstream). The CTA here only catches stale deep links / legacy paths.
- `apps/mobile/app/(main)/bondfire/[id].tsx:1220` — bondfire detail "Respond" route (this path is fine, do not change).
- `apps/mobile/app/(main)/(tabs)/camps.tsx:217-345` — `PersonalCampCard` component, the Hearth card; the rich-copy target.
- `apps/mobile/app/(main)/(tabs)/feed.tsx:148-180` (EmptyFeed) and `:697` (header Spark button) — both feed create affordances. For free users, the header Spark button must open the explainer/paywall directly (M6) rather than `router.push(routes.create)`; the M11 summary card also lands here.
- `apps/mobile/app/(main)/(tabs)/create.tsx` — router, gates, completion screen (preserve all behavior).
- `apps/mobile/app/(main)/camp/[id].tsx:482-497` (CampHeader) — "Spark Here" button condition; this is where we add `&& canCreate`.
- `apps/mobile/app/(main)/_layout.tsx` — `GlobalPaywall` and the `SubscriptionPaywall` mount point.
- `packages/app/src/hooks/useSubscription.ts` — `canCreate`, `showPaywall`, `currentTier` are the existing API.
- `packages/app/src/store/subscription.store.ts` — `isPaywallVisible`, `subscriptionActions.showPaywall()`, tier rank helpers.
- `packages/ui/` (SubscriptionPaywall) — the paywall component; check whether `freeTier` features are passed as a prop or hardcoded.
- `convex/videos.ts:510-565` — `assertUserCanParticipateInCamp` confirms spark always requires Plus (sanity check; no change).
- `docs/RELEASE_PROCESS.md` — the pre-release audit checklist (must pass before merge).

## Strategy & Constraints

**General approach:** Treat this as a UX/IA refactor across 5–6 screens plus the global paywall. Most changes are conditional rendering (`&& canCreate`), a tab-bar reshape (hide one entry for free users), routing interception (free-user spark surfaces open the explainer/paywall directly rather than the live screen), and copy enrichment. Backend, permission model, and state management are unchanged. No new abstractions.

The organizing principle is **dead-end vs. invitation** (see Solution Summary): no free-user primary flow routes into a screen they can't act on; the live-screen block-CTA is a safety net only.

**Patterns to follow:**
- Use `canCreate` (already returned by `useSubscription`) as the free-vs-paid gate everywhere. Don't introduce a new `isFree` boolean.
- Use `useValue(subscriptionStore$.isPaywallVisible)` and `subscriptionActions.showPaywall()` for paywall interactions.
- For the tab bar, use Expo Router's `Tabs.Screen` with `href: null` to hide a tab (preferred over conditional `<Tabs.Screen>` blocks because it preserves order and avoids remount flicker). Pattern is the same as official Expo Router docs.
- For first-paint correctness, read a **persisted last-known tier** so a returning free user renders 4 tabs on cold start without a 5→4 snap (see Edge Case 4). Persist it via a Legend State `syncObservable` store per CLAUDE.md; the tab layout reads it synchronously, then reconciles when `useSubscription` resolves. The layout must read `useSubscription` reactively so a mid-session tier change updates the tab count without restart (M13).
- For free-user spark surfaces (Feed header, camp-detail hint), call `subscriptionActions.showPaywall()` / open the explainer directly. Do NOT `router.push(routes.create)` for free users — that's the dead-end being removed.
- For the Hearth card, replace the single `<Text>` line with a small `<YStack>` of 2–3 lines using existing tokens (`$placeholderColor`, `$secondary`, etc.) and the existing card padding. Do not change the wrapping `Pressable` or outer `YStack` style.
- For the new "View Plans" button on the live screen, follow the visual style of the existing primary CTAs (e.g., the "Try Again" button at `LiveRecordScreen.tsx:805`) — same `borderRadius`, `paddingHorizontal`, `backgroundColor: '$primary'`.
- For the explainer modal/sheet (W1), use the existing `Modal` import pattern from `app/(main)/camp/[id].tsx` (ban-reason modal) — same `transparent` + `rgba(0,0,0,0.7)` overlay, same `maxWidth={400}` content card. Or, if a bottom sheet is preferred, use Tamagui's `Sheet` if available — check `packages/ui/`.
- For telemetry, use the existing `telemetry.info(name, message, { source, ... })` pattern from `apps/mobile/app/(main)/(tabs)/create.tsx:203,389` and the `clientLogs` table convention from memory 2026-06-02.

**Anti-patterns (do NOT do these):**
- DO NOT introduce a new global "user tier context" provider. `useSubscription` is the source of truth.
- DO NOT change `assertCanCreateBondfire` or any Convex permission. The free-vs-paid gate is correct; only the surface is changing.
- DO NOT remove or rename the Spark tab route file. Hide it with `href: null`. Keep the route addressable for any future deep links.
- DO NOT add kindling references, free trials, or pricing-model changes. Out of scope.
- DO NOT change the Hearth card's outer dimensions, padding, or background. Richer copy fits inside; the card must not change size.
- DO NOT show the new "View Plans" CTA during an active recording (response recording is allowed for free users). The CTA is only for the pre-connect blocked state, not mid-recording errors.
- DO NOT use React `useState` for the new explainer modal's open/close; use a small Legend State observable or local `useState` only if it's a single boolean. Follow existing patterns.
- DO NOT refactor the create router (`create.tsx`) or `LiveRecordScreen` beyond what's needed for the new CTA. The bug fix is the M2 overlay CTA only; do not "improve" other code in the same change.

**Key files for reference:**
- `apps/mobile/app/(main)/(tabs)/_layout.tsx` — current tab layout, where `href: null` is added.
- `apps/mobile/components/create/LiveRecordScreen.tsx` — current passive overlay, where the CTA buttons go.
- `apps/mobile/app/(main)/camp/[id].tsx:489-501` — current "Spark Here" `Button`, where `&& canCreate` is added.
- `apps/mobile/app/(main)/(tabs)/camps.tsx:317-345` — current Hearth card `Pressable`, where richer copy goes.
- `apps/mobile/app/(main)/(tabs)/feed.tsx:148-180` — current `EmptyFeed`, where free-friendly copy goes.
- `apps/mobile/app/(main)/_layout.tsx:23-99` — current `GlobalPaywall` `freeTier` definition, where the features list is enriched.

## Complexity Budget

**Target tier:** Large
**Acceptable range:** 400–900 net new production lines

If implementation approaches the upper bound, stop and simplify. The Hearth card copy enrichment and the live-screen CTA are the highest-leverage changes — everything else is small adjustments.

## Process

- Agent implements autonomously through completion.
- **Verification is the primary activity.** Walk through every scenario and Must Have criterion twice — once after building, once after a fresh-eyes pass.
- **Manual regression sweep** on a real device (or simulator with a dev build) covering: free user logs in → 4 tabs (correct on first paint, no snap) → Feed summary card (M11) visible → Feed "Spark" opens explainer/paywall directly (never the camera) → Camps "Hearth" card has rich copy + CTA → camp detail hides "Spark Here" and shows the soft hint → public camp "Join Camp" works → bondfire detail "Respond" works end-to-end → paywall sheet opens and shows rich free-tier row → stale deep link to `routes.create` hits the M2 safety-net CTA → mid-session upgrade reveals the Spark tab.
- PR targets `main` branch.
- One PR per logical change group if it gets large: PR A = tab-bar reshape (incl. persisted-tier first paint + reactive mid-session update) + M2 safety-net CTA + M4 Spark Here hide/hint + M6 Feed-header routing intercept. PR B = M3 Hearth card + M5 Feed empty state + M11 Feed summary card + W1 explainer. PR C = M7 paywall free-tier row + M9 telemetry + M14 a11y labels. Agent decides based on file boundaries.
- If stuck, try to resolve independently first. Escalate only if truly blocked.
- **Definition of done = all Must Have criteria verified twice, plus any Nice-to-Haves the agent picked up.**

## Open Questions

- [ ] **Q1. Should the W1 "What can I do for free?" explainer be a modal, a bottom sheet, or a full screen?** Suggest modal for parity with existing patterns; final call during implementation. (Owner: implementing agent.)
- [ ] **Q2. Should the Hearth card on the free-user state show the "View Plans" CTA inline in the card, or make the whole card tappable (current behavior)?** Current card is tappable; the CTA inside is a redundancy. Suggest keeping card tappable AND adding a clearly styled inline CTA for discoverability. (Owner: implementing agent.)
- [ ] **Q3. What's the exact copy for the Hearth card value prop?** Suggested: title "Hearth" + 2 lines: "A private camp for your inner circle. Invite-only, 7-day invite codes, and bondfires that stay between you and the people you trust." Then the existing "Upgrade to Plus" CTA. (Owner: David, before final commit.)
- [ ] **Q4. Should the Feed empty state for free users point to "browse camps" or "switch to Discover / All"?** Both are valid; suggest the Camps tab. (Owner: implementing agent.)
- [x] **Q5. RESOLVED. Do we want a transition animation for the Spark-tab-hide, or just snap 5→4 on first subscription-resolution?** Superseded by the persisted-last-known-tier approach (Edge Case 4 / Strategy): a returning free user paints 4 tabs immediately with no snap. Only the true first run can show a 5→4 reconcile; no animation needed. (Resolved.)
- [x] **Q6. RESOLVED. What is the IA philosophy — hide every spark surface, or keep some?** Resolved to **dead-end vs. invitation** (see Solution Summary). Remove spark from persistent nav (tab); turn contextual spark surfaces into invitations that open the explainer/paywall directly; retain the live-screen block-CTA only as a safety net. Mix is intentional and coherent along the dead-end/invitation axis, not the hide/show axis. (Resolved with David, 2026-06-12.)
- [x] **Q7. RESOLVED. Should the Feed header "Spark" button be visible to free users at all (as an invitation), or hidden in favor of the M11 summary card as the front door?** Resolved to **visible-as-invitation** — keep the button for free users (more conversion surface now that the tab is gone); tapping it opens the explainer/paywall directly per M6, never the live screen. (Resolved with David, 2026-06-12.)

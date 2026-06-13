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

Rebrand the free experience as a coherent **respond-first** identity: clear entry to the upgrade journey when free users hit a spark wall, never trap them in flow, and educate them about free value while making the upgrade path feel earned. Specifically: (1) hide the Spark tab for free users and rely on contextual feed/header/camp affordances that explain why each one requires Plus; (2) fix the live-screen dead-end with a working "View Plans" CTA and a "What can I do for free?" link; (3) hide "Spark Here" on camp detail for free users and add a free-user "Respond here" prompt instead; (4) upgrade the Hearth card to a stable-size, value-rich card that educates without nagging; (5) expand the paywall's free-tier row so the upgrade sheet is educational, not just a price list.

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

- [ ] **M2. The live record screen shows a "View Plans" CTA when a free user reaches it (via Feed header, camp detail legacy affordances, or any other route).**
  - *Verify by:* as a free user, tap the Feed header "Spark" button — the live screen renders, `preConnectBlockReason` is set, the overlay shows a primary "View Plans" button that calls `showPaywall()`. Tapping it opens the SubscriptionPaywall sheet. There is also a secondary "What can I do for free?" link that navigates to a brief explainer (in-app screen or modal — see W3).

- [ ] **M3. The Hearth card on the Camps tab, when shown to a free user, is the same outer dimensions as the existing card but with richer content: Hearth value prop (private group of friends, invite-only, 7-day invite codes, tier-gated retention) in 2–3 short lines, plus the existing "Upgrade to Plus" CTA. Card height/width does not change.**
  - *Verify by:* measure the card frame with the dev layout inspector before and after — width/height/padding/margin unchanged. Visual diff shows the new copy fits within the existing card.

- [ ] **M4. The "Spark Here" button on camp detail is hidden for free users. The "Join Camp" / "Request to Join" button is unaffected.**
  - *Verify by:* as a free user, open a public camp you're a member of — the "Spark Here" button is not rendered. As a paid user in the same camp, the button is rendered. Free users still see "Join Camp" and "Respond" on the bondfires list inside the camp.

- [ ] **M5. The Feed empty state for free users (when the filtered feed is empty) shows a free-friendly message and CTA — e.g., "Join a camp to see Bondfires here" or "Browse the feed to find a fire to respond to" — instead of the current "Spark a Bondfire / Be the first to share a video!" copy that dead-ends them.**
  - *Verify by:* as a free user, set the feed filter to a camp you haven't joined (or use a state with no bondfires); the empty state renders free-friendly copy and a CTA that goes somewhere useful (browse camps or feed).

- [ ] **M6. The Feed header "Spark" button, when tapped by a free user, opens the live screen which now shows the M2 block-with-CTA state (no longer dead-ends with no escape).**
  - *Verify by:* as a free user on the Feed tab, tap "Spark" in the top-right; the live screen renders, the blocked overlay shows "View Plans" + "What can I do for free?", both CTAs are functional.

- [ ] **M7. The SubscriptionPaywall sheet's free-tier row, when shown to a free user, lists the same capabilities as the M5 empty state / M2 explainer — so the upgrade sheet is consistent with in-flow messaging. Free-tier features (browse, join camps, watch, respond) are listed with checkmarks; the paid-tier rows list what they unlock (spark, hearth, longer retention, etc.).**
  - *Verify by:* open the paywall as a free user; the free row's features match the in-flow copy; visually check no checkbox is missing or extra.

- [ ] **M8. All existing free-user "respond" and "join" flows still work end-to-end with no regression.**
  - *Verify by:* manual regression — as a free user, (a) open a bondfire, tap "Respond", complete a response recording, see it land in the bondfire; (b) open a public camp, tap "Join Camp", land on the camp feed; (c) open a personal camp via invite link, see and respond to its bondfires.

- [ ] **M9. Telemetry events fire for the new flow points: `paywall:cta_shown` (live screen blocked), `paywall:cta_clicked` (View Plans tapped), `paywall:explainer_clicked` (What can I do for free? tapped), `paywall:opened_from` with source (`live_blocked`, `camps_hearth_card`, `feed_empty`, `feed_spark`, `camp_detail`).**
  - *Verify by:* trigger each entry point in dev, inspect the `clientLogs` Convex table for the matching event with the correct `source` value.

- [ ] **M10. The pre-release audit per `docs/RELEASE_PROCESS.md` passes — navigation integrity, TypeScript compile, build health, architecture consistency — for the changed files.**
  - *Verify by:* `npx tsc --noEmit` exits 0; manual route walk-through of all changed screens; no new top-level abstractions.

### Nice to Have

- [ ] **W1. "What can I do for free?" explainer** is a styled in-app modal (or sheet) that shows three free capabilities with icons: **Join camps** (open to your tier), **Watch Bondfires** (TikTok-style feed), **Respond to Bondfires** (record a response video, ≤5 min), and a single "View Plans" primary CTA at the bottom. This is the explainer M2 links to.
- [ ] **W2. The Hearth card, when shown to a free user, has a small subtle "i" icon that opens the same free-capabilities explainer** — extra discoverability beyond the "View Plans" CTA.
- [ ] **W3. The My Fires tab, for a free user with no responses, shows a free-friendly empty state** (currently may show "no fires" or be a paid-feature message) — make sure free users see they can use this tab once they respond to something.
- [ ] **W4. A free-user summary card on the Feed** (above the camp pills, below the header) that quietly says "You're on the free plan — respond to any fire, or upgrade to spark your own" with an "Upgrade" link. Dismissible. Doesn't take vertical space if dismissed.
- [ ] **W5. The personal camp "invite-only" entry** — when a free user is invited to a personal bondfire, the join flow could highlight that they can respond without paying. Verify the existing flow does this; if it doesn't, add a small line.
- [ ] **W6. Camp detail for a free user shows a soft hint** under the camp name like "Free members can join and respond, but can't spark here" — only when the user is a member (so non-members don't see confusing copy).

## Verification Scenarios

### Happy Path

1. **Given** a free user with the new build installed, **when** they open the app, **then** the tab bar shows 4 tabs (Camps / Feed / My Fires / Profile), the Spark tab is not visible.
2. **Given** a free user on the Feed tab, **when** they tap "Spark" in the top-right, **then** the live record screen opens, the blocked overlay shows "View Plans" + "What can I do for free?", and tapping "View Plans" opens the paywall sheet.
3. **Given** a free user on the Camps tab, **when** they see the Hearth card, **then** it shows the rich value-prop copy and a "View Plans" CTA; tapping the card or CTA opens the paywall.
4. **Given** a free user on a public camp detail, **when** the camp loads, **then** "Spark Here" is hidden; "Join Camp" or "Respond" is shown as appropriate.
5. **Given** a free user opens the paywall sheet, **when** they view the free tier row, **then** the features list matches the in-flow messaging: browse, join, watch, respond.
6. **Given** a paid user (Plus+) on the same build, **when** they open the app, **then** the Spark tab is visible in the tab bar (5 tabs).

### Edge Cases

1. **Given** a free user on a personal camp invite deep link (`/personal-bondfire/[id]/[code]`), **when** they accept, **then** the personal bondfire loads and respond is available; no paywall nag appears during the flow.
2. **Given** a free user with a stale subscription (e.g., a Plus subscription that expired), **when** they open the app, **then** they see the free-tier experience (no Spark tab, hearth card in "frozen/upgrade" state).
3. **Given** a free user mid-recording of a response (which is allowed), **when** the live publisher reports a transient error, **then** the recovery path is unchanged — no M2 block-CTA is shown mid-recording (block-CTA is for spark pre-connect, not response).
4. **Given** a free user with `subscription === undefined` (still loading), **when** the layout renders, **then** we render the paid-tier tab layout (5 tabs) to avoid a tab-bar flicker, and re-render as 4 tabs once `subscription` resolves to `free`. Document this in code.
5. **Given** a free user on the Feed with the empty-state CTA tapped, **when** the destination is "browse camps", **then** navigation goes to the Camps tab (not the Create screen).

### Regression Checks

- All existing paid-tier flows (spark, hearth create, hearth manage, archive, etc.) work unchanged.
- All existing free-tier "respond" flows complete end-to-end.
- All existing "join camp" flows for public/approval/invite-only camps work unchanged.
- Deep link invite flows for personal bondfires work unchanged.
- The legacy `LegacyRecordScreen` alert-with-CTA path remains functional (the simulator/no-dev-build fallback) — verify on simulator that the Alert.alert("Upgrade to Create", …, [{text: "View Plans", onPress: showPaywall}]) still fires for free users.
- `npx tsc --noEmit` passes; `npx convex dev --typecheck` passes.
- `clientLogs` table still receives existing telemetry events; new events have stable names and `source` values.

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
- `apps/mobile/components/create/LiveRecordScreen.tsx` — `preConnectBlockReason` (line 540) and the `showPreConnectBlocked` render (line 818) are where the new CTA goes.
- `apps/mobile/app/(main)/bondfire/[id].tsx:1220` — bondfire detail "Respond" route (this path is fine, do not change).
- `apps/mobile/app/(main)/(tabs)/camps.tsx:217-345` — `PersonalCampCard` component, the Hearth card; the rich-copy target.
- `apps/mobile/app/(main)/(tabs)/feed.tsx:148-180` (EmptyFeed) and `:697` (header Spark button) — both feed create affordances.
- `apps/mobile/app/(main)/(tabs)/create.tsx` — router, gates, completion screen (preserve all behavior).
- `apps/mobile/app/(main)/camp/[id].tsx:482-497` (CampHeader) — "Spark Here" button condition; this is where we add `&& canCreate`.
- `apps/mobile/app/(main)/_layout.tsx` — `GlobalPaywall` and the `SubscriptionPaywall` mount point.
- `packages/app/src/hooks/useSubscription.ts` — `canCreate`, `showPaywall`, `currentTier` are the existing API.
- `packages/app/src/store/subscription.store.ts` — `isPaywallVisible`, `subscriptionActions.showPaywall()`, tier rank helpers.
- `packages/ui/` (SubscriptionPaywall) — the paywall component; check whether `freeTier` features are passed as a prop or hardcoded.
- `convex/videos.ts:510-565` — `assertUserCanParticipateInCamp` confirms spark always requires Plus (sanity check; no change).
- `docs/RELEASE_PROCESS.md` — the pre-release audit checklist (must pass before merge).

## Strategy & Constraints

**General approach:** Treat this as a UX/IA refactor across 5–6 screens plus the global paywall. Most changes are conditional rendering (`&& canCreate`), a tab-bar reshape (hide one entry for free users), and copy enrichment. Backend, permission model, and state management are unchanged. No new abstractions.

**Patterns to follow:**
- Use `canCreate` (already returned by `useSubscription`) as the free-vs-paid gate everywhere. Don't introduce a new `isFree` boolean.
- Use `useValue(subscriptionStore$.isPaywallVisible)` and `subscriptionActions.showPaywall()` for paywall interactions.
- For the tab bar, use Expo Router's `Tabs.Screen` with `href: null` to hide a tab (preferred over conditional `<Tabs.Screen>` blocks because it preserves order and avoids remount flicker). Pattern is the same as official Expo Router docs.
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
- **Manual regression sweep** on a real device (or simulator with a dev build) covering: free user logs in → 4 tabs → Feed "Spark" dead-end has CTA → Camps "Hearth" card has rich copy + CTA → camp detail hides "Spark Here" → public camp "Join Camp" works → bondfire detail "Respond" works end-to-end → paywall sheet opens and shows rich free-tier row.
- PR targets `main` branch.
- One PR per logical change group if it gets large: PR A = tab-bar reshape + M2 CTA + M4 Spark Here hide. PR B = M3 Hearth card + M5 Feed empty state + W1 explainer. PR C = M7 paywall free-tier row + M9 telemetry. Agent decides based on file boundaries.
- If stuck, try to resolve independently first. Escalate only if truly blocked.
- **Definition of done = all Must Have criteria verified twice, plus any Nice-to-Haves the agent picked up.**

## Open Questions

- [ ] **Q1. Should the W1 "What can I do for free?" explainer be a modal, a bottom sheet, or a full screen?** Suggest modal for parity with existing patterns; final call during implementation. (Owner: implementing agent.)
- [ ] **Q2. Should the Hearth card on the free-user state show the "View Plans" CTA inline in the card, or make the whole card tappable (current behavior)?** Current card is tappable; the CTA inside is a redundancy. Suggest keeping card tappable AND adding a clearly styled inline CTA for discoverability. (Owner: implementing agent.)
- [ ] **Q3. What's the exact copy for the Hearth card value prop?** Suggested: title "Hearth" + 2 lines: "A private camp for your inner circle. Invite-only, 7-day invite codes, and bondfires that stay between you and the people you trust." Then the existing "Upgrade to Plus" CTA. (Owner: David, before final commit.)
- [ ] **Q4. Should the Feed empty state for free users point to "browse camps" or "switch to Discover / All"?** Both are valid; suggest the Camps tab. (Owner: implementing agent.)
- [ ] **Q5. Do we want to mark the Spark-tab-hide as a one-time transition animation, or just snap the tab bar from 5 to 4 on first subscription-resolution?** Suggest snap — simpler, no flash. (Owner: implementing agent.)

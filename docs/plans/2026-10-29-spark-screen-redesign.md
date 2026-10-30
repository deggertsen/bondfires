# Spark screen redesign

Mockups: https://claude.ai/artifact/XMJGwZgVErTx9zdAXcfPqy (page "Round 2 · Refining A").
Chosen boards: P1 + P3 (people), K3 + K5/K6 + K7 (camp), K4 (no camps).

## Goal

The Spark tab assumes you're sparking with existing connections. Today it opens
`CampPickerScreen` ("Choose a Camp"), with My Hearth as one card on top. After this
change it opens straight onto the people picker (today's Hearth invite screen),
and a **People | Camp** toggle switches to starting a fire in one of your camps.

Out of scope: "Spark again" groups (P2), the inline camp list (K1), backend
changes, and the Plus gate on the Spark tab (unchanged).

## Behavior

### Entry points

| Entry | Today | After |
|---|---|---|
| Spark tab / `createFresh()` | Camp picker | People tab |
| `createForPersonalCamp()` (Hearth screen) | Invite screen | People tab (same screen) |
| `createForCamp(id)` (camp screen, feed Spark with a camp scoped) | Camp prompt splash → record | Camp tab, that camp selected (K3) |
| `createRespondTo(id)` | Recorder | Unchanged |
| `resumeDraft(id)` | Recorder for the draft | Unchanged |

- The default tab is always **People**. It never remembers the last tab, because
  the redesign assumes existing connections. The only exception is `campId`, which
  opens Camp.
- Switching tabs keeps both selections, and only the active tab's choice is used.
  Both panes stay mounted (the inactive one is hidden), so the people selection,
  typed title and invite sheet state survive a round trip to Camp.

### People tab (P1, P3)

This is `PreRecordingInviteScreen`, restyled:

- The header reads "New Bondfire" (was "New Hearth Bondfire"). The toggle sits
  under it, with a lock caption: "Private. Only the people you pick can see it."
- The audience chips and rail are unchanged.
- The email, share link and family link sections leave the scroll view. A single
  **Invite someone new** row opens a sheet (P3) that contains them. The share-link
  and family-link flows still create the draft server-side. Their state stays in
  the screen's `form$`, so `canSkip`, `canContinue` and the resume banner behave
  exactly as today.
- Title is unchanged.
- The CTA becomes "Continue with {names}" when people or emails are selected,
  using the same first-name summary as the auto title. Otherwise it stays
  "Continue to record". "Skip — record without inviting" is unchanged.

### Camp tab (K3, K5/K6, K7, K4)

- The caption under the toggle reads "Everyone in the camp can see and answer it."
- A **Which camp?** field shows the selected camp: its color swatch, name,
  member count, and "1 of N camps". Tapping it opens the camp sheet.
- The initial selection is `appStore$.currentCampId` if that is still a pickable
  camp, else the first pickable camp. A `campId` param wins.
- The **prompt card** shows `defaultPrompt ?? purpose`, then `purpose` as a
  subline when a prompt exists, then rule chips:
  - "Up to N min": the min of the camp's `maxDurationMs` and the tier limit,
    using the existing `formatMaxDuration`.
  - "Tag required" when `requiresTradeTags`.
  - "Title after recording".
- **Trading Post (K7):** when `requiresTradeTags`, a Need / Offer radio group sits
  inside the card. The CTA stays disabled until one is picked, then reads "Record
  your need" or "Record your offer". This replaces the separate "Need or Offer?"
  screen.
- The CTA reads "Record in {camp}". It sets `selectedCampId`, `tradeTag` and
  `appActions.setCurrentCampId`, then mounts the recorder exactly as the
  campId path does today.
- **Camp sheet (K5/K6):** a Tamagui `Sheet`, following the same pattern as
  `InviteSheet`.
  - Title "Choose a camp" with a count. The last-used camp comes first, then the
    rest A–Z. Pending camps are listed last, disabled, labelled "Request pending".
  - The search field appears only when there are more than 3 pickable camps. It
    is not auto-focused, so the list shows first. It does a case-insensitive
    substring match on the name.
  - Picking a camp closes the sheet and swaps the card. "Find more camps" goes
    to `routes.camps`.
- **No camps (K4):** if there are no pickable camps, the pane shows the empty
  state instead:
  - Up to 3 suggested camps, using today's picker ordering (Welcome Fires first,
    then gender match, then name), with **Join** buttons.
  - Join reuses `CampPickerScreen.handleSelectCamp`'s logic, including the pending
    alert and the auth-session redirect. A successful join selects that camp.
  - "Browse all camps" goes to `routes.camps`.

A camp is **pickable** when its membership is active. It must also meet today's
`sortedCamps` filter: invite-only camps count only for their owner.

## Implementation

### New files (`apps/mobile/components/create/`)

- `sparkComposer.ts`: pure helpers, unit-tested.
  - `resolveInitialSparkMode({ campId })` → `'people' | 'camp'`
  - `buildCampPickerList(camps, lastUsedCampId)` →
    `{ lastUsed, others, pending, pickableCount, showSearch }`
  - `filterCampsByName(camps, query)`
  - `resolveSelectedCamp(pickable, { paramCampId, selectedCampId, lastUsedCampId })`
  - `suggestCampsToJoin(camps, userGender, limit)`: move today's `sortedCamps`
    comparator here so K4 and the old ordering share one implementation.
  - `buildPeopleCtaLabel(candidates, selectedIds, emails)`: reuses `buildAutoTitle`'s
    name logic.
  - `buildCampCtaLabel(camp, tradeTag)`
- `SparkModeToggle.tsx`: segmented `tablist` plus the caption line. Theme tokens only.
- `CampSparkPane.tsx`: K3 / K7 / K4 body plus the sticky CTA.
- `CampPickerSheet.tsx`: K5 / K6.
- `InviteSomeoneSheet.tsx`: P3. It receives `form$` and the existing handlers
  from `PreRecordingInviteScreen` (add/remove email, create or copy share link,
  family link), so no logic moves out of the screen.

### Changed files

- `apps/mobile/app/(main)/create.tsx`:
  - Add `mode` to `state$`, seeded from `resolveInitialSparkMode`.
  - Stop gating the `existingDraft` query on `personalCamp=1`. The People tab is
    now the default for every fresh entry.
  - Replace the `CampPickerScreen` branch, the camp-prompt splash
    (`promptCampId` / `promptDismissed`) and the trade-tag screen with one
    composer branch. It renders the toggle, a People pane
    (`PreRecordingInviteScreen`) and a Camp pane (`CampSparkPane`).
  - At handoff, `personalCamp` becomes `mode === 'people'`.
  - Keep the camp-unavailable path. A bad `campId` falls back to the Camp tab with
    no selection and an inline notice, instead of a dead-end screen.
- `PreRecordingInviteScreen.tsx`:
  - Accept a `modeToggle` slot under the header.
  - Retitle the header and add the caption.
  - Move the three invite sections into `InviteSomeoneSheet` behind the new row.
  - Swap the CTA label.
  - Drop its own `onCancel` header placement only if the composer owns the header.
    Otherwise keep the X as is.
- `apps/mobile/lib/routes.ts`: update the `createFresh` comment. Nothing about it
  "skips the camp picker" anymore.
- Delete `CampPickerScreen.tsx`. `create.tsx` is its only importer.

### State

Per CLAUDE.md:

- Mode and the selected camp go in the existing `state$` observable in
  `create.tsx`.
- Sheet visibility and the search query are local `useObservable` state in their
  components.
- `appStore$.currentCampId` stays the persisted "last used" camp.
- No new global store.

## Tests

`apps/mobile/test/create/sparkComposer.test.ts`:

- Initial mode: `campId` gives Camp. Nothing, or `personalCamp=1`, gives People.
- Picker list:
  - The last-used camp goes first, then A–Z.
  - Pending camps go last and are excluded from `pickableCount`.
  - Invite-only camps appear only for their owner.
- `showSearch` is false at 3 pickable camps and true at 4.
- `filterCampsByName` is case-insensitive and keeps order.
- Selection precedence: param, then current, then last used, then first. A stale
  last-used id falls through.
- CTA labels: people summary, the "Continue to record" fallback, and need/offer
  phrasing.
- `suggestCampsToJoin` preserves today's ordering: Welcome Fires first, then gender
  match, then name.

Existing `preRecordingInvite.test.ts` and `createAvailability.test.ts` must still
pass. Run `npm test`, `npm run typecheck`, `npm run lint`.

## QA (iOS simulator from the worktree, then Android)

1. Spark tab opens on People. Pick 2 people, then Continue: the draft is created
   and the recorder records into the Hearth fire.
2. Open Invite someone new. Add an email, create a share link, close the sheet:
   Skip is hidden, and the resume banner appears on the next visit.
3. Switch to Camp and back: the people selection and title are kept.
4. Camp tab with 1–3 camps shows no search. With 4+ camps search shows, the
   last-used camp is on top, and pending camps are disabled.
5. Record in a camp: the fire lands in that camp. Trading Post requires
   Need/Offer and tags the fire.
6. A camp page's Spark button opens the Camp tab with that camp preselected.
7. A user with no camps sees K4. Joining an open camp selects it. An approval
   camp shows the pending alert.
8. Respond-to and resume-draft paths are unchanged.
9. Light theme pass, because all colors come from theme tokens.

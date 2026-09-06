# Teen safety release runbook

Bondfires permits accounts age 13 and older. Camps and public discovery are strictly separated at
the server boundary: people age 13–17 cannot discover, join, invite into, view, or participate in
adult Camps, and adults cannot do so in teen Camps. Private Hearths use the same boundary by default,
with one narrow exception for a mutually accepted Family Connection. A short-lived, single-use
family invitation grants access to one named Hearth Bondfire and establishes a revocable connection
for future private Hearth invitations. It never changes public discovery or Camp eligibility.

Date of birth is private and is re-evaluated on each request. Because DOB has no verified timezone,
Bondfires conservatively keeps a member in the younger band for the full UTC anniversary day; the
boundary changes at 00:00 UTC the following day without waiting for a cleanup job. This prevents an
early transition in negative UTC offsets at the cost of at most one extra day in the younger band.

This runbook is an engineering and store-submission checklist, not legal advice. Counsel must review
the privacy policy, Terms, child-safety standards, retention, and consent approach for every launch
country. Do not replace jurisdiction placeholders with guesses.

## Production rollout

Deploy backend enforcement before releasing a client that admits teen users.

1. Deploy the Convex schema and functions.
2. Run `npx convex run --prod internal:ageSafetyMaintenance:backfillAgeBands` and
   `npx convex run --prod internal:ageSafetyMaintenance:backfillPersonalCampAgeBands`.
   Existing camps and Hearths intentionally become adult-only. This is fail-safe and must happen
   before teen discovery is enabled; do not infer a historical audience from an owner's current age.
3. Run `npx convex run --prod internal:camps:seedTeenCampsAdmin` to create/update the three default
   13–17 camps.
4. Run `reconcileCampMemberships` and `reconcileHearthParticipants` once, then confirm each finishes
   all pages. Daily crons keep the rows reconciled after rollout. Reconciliation preserves a Hearth
   participant only when the participant is in the owner's current age band or that participant row
   is tied to an active Family Connection. A member who turns 18 receives a new adult Hearth after
   the conservative UTC transition; their historical teen Hearth remains permanently teen-banded
   and is frozen.
5. Verify with separate boundary test accounts aged 13, 17, 18, and an existing member on their 18th
   UTC anniversary day and at 00:00 UTC the following day. Test open, approval, camp-code, direct
   bondfire, ordinary Hearth-code, and direct Hearth invites in both directions. All public and
   ordinary private cross-age paths must fail.
6. Test the controlled family path in both directions:
   - only the Hearth owner can create a family link;
   - the link expires after 24 hours, works once, and shows an explicit accept/decline screen;
   - acceptance grants only the named Hearth Bondfire, while the connection appears in Profile for
     deliberate future Hearth invitations;
   - neither account becomes visible to the other in public Camps, search, or recommendations;
   - either account can revoke the connection, immediately losing every Hearth participant grant
     tied to it; a new relationship requires a new invitation and does not revive old grants; and
   - reporting and bidirectional account blocking work for content shared through a connection;
     blocking revokes the Family Connection and its grants so unblocking cannot silently restore
     the private audience.
7. Confirm the public child-safety page says 13+, accurately distinguishes public separation from
   controlled private Family Connections, contains the
   published CSAE standards, and lists a monitored child-safety contact.

Do not migrate an existing camp to `teen`. A teen camp must be explicitly seeded or created by a teen
account. Changing a populated adult camp's band would expose its historical content to a new audience.

## App Store Connect

Complete the current age-rating questionnaire truthfully. Bondfires includes social media,
user-generated video, messaging/social interaction, and age assurance. Do not select **Made for
Kids**. Apple calculates the regional rating from the questionnaire; if the result is lower than the
minimum experience the team and counsel approve, use Apple's supported higher-age override rather
than changing questionnaire answers. Apple's current process and rating definitions are documented
in [Set an app age rating](https://developer.apple.com/help/app-store-connect/manage-app-information/set-an-app-age-rating/)
and [Age rating values and definitions](https://developer.apple.com/help/app-store-connect/reference/app-information/age-ratings-values-and-definitions/).

Reviewer notes should state:

- registration requires a valid date of birth and rejects users under 13;
- DOB is not public;
- 13–17 and 18+ Camps and public discovery are mutually exclusive and checked server-side;
- ordinary invites and existing memberships do not bypass the public or private boundary;
- private cross-age Hearth access requires a 24-hour, one-time family link, explicit recipient
  acceptance, and a specific active participant grant that either account can revoke;
- a Family Connection does not enable public discovery or cross-age Camp access, and Bondfires does
  not represent that user-declared connection as a verified legal or biological relationship;
- in-app reporting/moderation and published child-safety standards are available (after the
  moderation/compliance PR is deployed).

## Google Play Console

In **Target audience and content**, select every age group actually served. If 13-year-olds can
register, do not omit **Ages 13–15** to avoid Families requirements. Select **Ages 16–17** and adult
groups as appropriate for the store listing. Declare the app's social and freeform-content features
in the IARC/content-rating questionnaire and keep Data safety answers aligned with private DOB and
video processing.

Google's current [target audience guidance](https://support.google.com/googleplay/android-developer/answer/9867159)
notes that 13–15 and 16–17 may be children in some locales. The
[Families Policy](https://support.google.com/googleplay/android-developer/answer/9893335) requires
accurate declarations and an online-safety reminder before child users exchange freeform media; the
signup flow now displays that reminder. Because Bondfires is a social app, also complete Google's
[Child Safety Standards](https://support.google.com/googleplay/android-developer/answer/14747720)
declaration with the exact published standards URL and monitored contact.

Owner/legal action before selecting 13–15: obtain written counsel review of whether the current
verified-email/signup flow and prohibition on sharing personal information satisfy the applicable
"adult action" requirement in each launch market. If counsel requires guardian consent or parental
controls, those controls are a release blocker; do not self-certify based on this engineering change.

## Ongoing operations

- Monitor reconciliation output and alert on disabled memberships/participants.
- Treat DOB corrections as a support-reviewed identity change, never a normal profile edit.
- Monitor family-invitation creation, acceptance, revocation, reports, and abuse-rate signals. The
  product label is user-declared and must never be described internally or publicly as identity,
  guardianship, or biological-relationship verification.
- Family Connections are capped at 50 active relationships per account. Treat attempts to reach
  that limit as a potential abuse signal rather than raising it without a safety review.
- Investigate reports involving a minor under the child-safety escalation procedure; preserve only
  the data counsel and applicable law require.
- Re-run the boundary test matrix before every change to camps, invites, feeds, playback, live
  sessions, or onboarding.
- Review store questionnaires and public policy copy whenever product behavior changes.

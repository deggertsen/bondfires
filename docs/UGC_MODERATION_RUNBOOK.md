# UGC moderation runbook

Bondfires combines technical controls with human review. This document describes what the product
actually does; it must stay aligned with the Terms, Community Guidelines, child-safety standards,
and store declarations.

## Publication policy

- New videos and responses in `open` or `approval` camps enter `pending_review`. Only the creator
  and administrators can see them until an administrator approves them in Profile → Safety
  moderation.
- Invite-only camp and Hearth content is immediately available only to its intended participants.
  It is not pre-reviewed, but participants can report the content or user and block the user.
- Missing moderation status is treated as approved for records created before this workflow.
- Removing content hides it from everyone except its creator (for appeal context) and admins. The
  underlying Mux asset is retained until the normal retention/deletion process makes a final
  disposition.
- The app does not claim automated visual detection. Human review is the public-content filter.

## Report response

1. Monitor the Profile moderation queue and `safety@bondfires.org` continuously during public use.
2. Triage child-safety and credible imminent-harm reports immediately; target all other reports for
   initial review within 24 hours.
3. Validate the content and user context. Resolve with content removal and/or account suspension,
   or dismiss with a clear internal reason.
4. Preserve the immutable admin audit entry and report evidence. Do not delete potential CSAM as a
   substitute for the legally required preservation/reporting workflow.
5. Escalate suspected CSAM to the designated child-safety lead and follow applicable reporting and
   preservation obligations, including NCMEC reporting where required.
6. Direct appeals to `safety@bondfires.org`. A different trained reviewer should review an appeal
   when staffing permits. Restore content or reactivate the account only after documenting why.

## Blocking semantics

A block is enforced in both directions. It removes direct invite artifacts and prevents discovery,
feed/playback access through app APIs, invites, reactions, presence exposure, and future social push
notifications between the two users. Shared camp membership is not removed. A user can manage their
blocked list under Profile → Safety & legal. If the users have an active Family Connection, blocking
also revokes it and removes every Hearth participant grant tied to it; unblocking does not recreate
that relationship or restore the prior private audience.

Public Mux playback URLs already learned outside the app cannot be revoked by a database block. Do
not describe blocking as deleting copies or preventing access to a URL someone already possesses.
Moving all public playback to signed URLs is the path to stronger revocation.

## Deployment and operations

- Deploy the backend together with a client containing the legal-acceptance gate. Older clients do
  not have the acceptance UI and will be unable to create UGC after backend enforcement starts.
- Staff the public-content queue before enabling public acquisition. A pre-publication queue without
  reviewer coverage will prevent public content from appearing.
- Configure on-call alerts for queue age, child-safety reports, email-delivery failures, and unusual
  report volume. The repository implements workflow state, not staffing or external alerts.
- Review policy versions whenever Terms or Community Guidelines materially change. Increment both
  constants in `convex/contentSafety.ts` when renewed acceptance is required.

## Required non-code launch work

- Publish Terms and Community Guidelines that define prohibited content and match the 13+ product.
- Correct the child-safety page and store declarations; do not claim unsupported automated detection.
- Name a trained child-safety point of contact and document jurisdiction-specific reporting steps.
- Complete App Store/Play UGC, age-rating, privacy, and child-safety declarations truthfully.
- Maintain a moderation staffing schedule, response SLA, evidence-retention policy, and appeal log.

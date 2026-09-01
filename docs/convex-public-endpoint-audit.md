# Convex public endpoint authorization audit

Last reviewed: 2026-09-05. This is an inventory of every function exported with
`query`, `mutation`, `action`, or `httpAction`. Internal functions are excluded
because Convex prevents clients from calling them. `yarn check:security` fails
when an exported endpoint is added or removed without updating this review.

“Public read” means signed-out access is intentional and the handler filters to
public/visible data. “Self” means identity comes from `auth`, never a client ID.
“Owner/member” means the referenced object is checked against the authenticated
user. “Admin” means both authentication and the persisted admin role/flag are
checked. Invite codes are bearer capabilities but redemption is authenticated.

| Area | Endpoints | Decision / boundary |
| --- | --- | --- |
| Admin | `admin.adminSearchUsers`, `admin.adminSetForcedTier`, `admin.adminGrantKindling`, `adminAudit.getAuditLog`, `adminDashboard.getSubscriptionStats`, `adminDashboard.getCampStats`, `adminDashboard.getRecentReports`, `adminDashboard.getBondfireStats`, `adminDashboard.getReconciliationHistory`, `adminDashboard.restoreAdminGraceCamps`, `adminDashboard.getRecentSignups`, `reconciliation.listRecentDiscrepancies` | Admin only; numeric lookbacks and result counts are capped. |
| Public configuration | `publicConfig.getUpdateConfig`, `publicConfig.getMinVersion` | Deliberate signed-out read for force-update startup. |
| Public configuration writes | `publicConfig.setMinVersion`, `publicConfig.getAdminUpdateConfig` | Admin only; audited configuration changes. |
| Public profiles | `users.get`, `users.getStats` | Deliberate public projection only; email, birth date, gender, roles, and auth metadata are excluded. |
| User self-service | `users.recordActive`, `users.current`, `users.updateProfile`, `users.setThemePreference`, `users.generateProfilePhotoUploadUrl`, `users.updateProfilePhoto`, `users.isAdmin` | Authenticated self; server derives user ID. Deletion uses the separate durable worker below. |
| Camps public discovery | `camps.list`, `camps.get` | Deliberate signed-out discovery; camp lifecycle/rule visibility filters apply. |
| Camps self/member | `camps.listMine`, `camps.join`, `camps.requestJoin`, `camps.leave`, `camps.muteCamp`, `camps.redeemInvite`, `camps.claimInactivePublicCamp`, `camps.listCampMembers` | Authenticated user/member; hard eligibility rules are server-derived. Invite redemption is generic and throttled. |
| Camps moderation/ownership | `camps.approveMember`, `camps.updateMemberStatus`, `camps.approveAccessRequest`, `camps.rejectAccessRequest`, `camps.getPendingRequests`, `camps.createInvite`, `camps.setCampAccess`, `camps.createPublicCamp`, `camps.createPrivateCamp`, `camps.setOwner`, `camps.removeMember`, `camps.banMember`, `camps.unbanMember`, `camps.getBannedMembers`, `camps.updateSettings`, `camps.archiveCamp`, `camps.unarchiveCamp`, `campAnalytics.getCampAnalytics`, `campBranding.generateCampCoverImageUploadUrl`, `campBranding.updateCampBranding` | Authenticated owner/moderator/admin as appropriate; target camp and membership are checked. Invite creation is throttled and bounded. |
| Camp maintenance | `camps.seedTeenCamps`, `camps.seedLaunchCamps`, `camps.resetAndReseed`, `camps.adminBackfill`, `bondfires.cleanupExpiredPrivateCampVideos` | Admin only. Empty-table seeding no longer bypasses admin. Destructive CLI variants remain internal functions. |
| Camp entitlements | `campKindling.getKindlingBalance`, `campKindling.getKindlingUsageSummary`, `campSlots.getSlotUsageSummary` | Authenticated self; no caller-supplied user ID. |
| Bondfire public reads | `bondfires.listFeed`, `bondfires.listByCamp`, `bondfires.get`, `bondfires.getWithCampContext`, `bondfires.getWithVideos`, `bondfires.getUnavailableReason`, `bondfires.listByUser`, `bondfireVideos.listByBondfire`, `bondfireVideos.listByUser`, `liveSessions.getByBondfireId`, `bondfireInvites.canAccessBondfire` | Signed-out access is intentional only for visible public content. Private, personal, expired, frozen, and membership-gated content uses shared visibility rules. Feed limits are capped. |
| Bondfire writes | `bondfires.updateTitle`, `bondfires.incrementViews`, `bondfires.pinBondfire`, `bondfires.unpinBondfire`, `bondfires.deleteBondfire` | Authenticated user plus creator/camp visibility authorization. Legacy view writes now dedupe and throttle. Caller-asserted Mux attachment endpoints are internal-only. |
| Bondfire invitations | `bondfireInvites.listInvitableContacts`, `bondfireInvites.sendBondfireInvite`, `inviteClaims.createDirectInvite`, `inviteClaims.createBondfireInviteCode`, `inviteClaims.redeemInviteCode`, `inviteClaims.markInviteSeen`, `inviteClaims.dismissInvite`, `inviteClaims.listUnseenInvites` | Authenticated sender/claimer. Creation and redemption are transactional fixed-window limited; invalid claims have one generic result. Raw secrets are not logged. |
| Personal fires | `personalCamps.getMyPersonalCamp`, `personalCamps.ensureMyPersonalCamp`, `personalBondfires.createDraftBondfire`, `personalBondfires.sendDraftInvites`, `personalBondfires.discardDraftBondfire`, `personalBondfires.createInvite`, `personalBondfires.redeemInvite`, `personalBondfires.checkInvite`, `personalBondfires.checkInviteSecure`, `personalBondfires.getMyDraftBondfire`, `personalBondfires.getInviteCandidates`, `personalBondfires.listMyPersonalBondfires`, `personalBondfires.listParticipants`, `personalBondfires.removeParticipant`, `personalBondfires.leaveBondfire`, `personalBondfires.deleteBondfire` | Authenticated owner/participant. Secure code check is a throttled mutation, requires the URL bondfire ID to match, and exposes only valid/unavailable. The old authenticated query accepts only >100-bit codes for deployed-client compatibility and fails closed for legacy codes. |
| Conversations | `conversations.listMyFires`, `conversations.listCloseCircle`, `conversations.markThreadRead`, `conversations.pinPerson`, `conversations.unpinPerson` | Authenticated self; visibility and thread participation are checked; list limits are capped. |
| Watch analytics | `watchEvents.record`, `watchEvents.hasWatched`, `watchEvents.getHistory` | Authenticated self. Target existence/playability/visibility, event state, unique event type, position, server duration/time, rate, and history cap are enforced. |
| Reactions and presence | `videoReactions.addReaction`, `videoReactions.getReactions`, `videoReactions.getRecentEmojis`, `presence.heartbeat`, `presence.leaveViewing`, `presence.listViewers` | Authenticated writes and visible reads; shared block/moderation visibility and reaction limits apply. |
| Reports | `reports.submit`, `reports.hasReportedBondfire`, `reports.hasReportedBondfireVideo` | Authenticated reporter and target checks; moderation/block integration and report throttling apply. |
| Notifications | `notifications.registerDevice`, `notifications.unregisterDevice`, `notifications.getDevices`, `notifications.getDeviceTokenCount`, `notifications.getPreferences`, `notifications.updatePreferences`, `sendNotification.sendTest` | Authenticated self; test notification can target only the caller. |
| Client telemetry | `clientLogs.create`, `clientLogs.createBatch`, `clientLogs.list`, `clientLogs.summary` | Writes are authenticated/self-attributed; admin reads. Server timestamps, payload bounds, redaction, and rate limiting apply. |
| Subscriptions | `subscriptions.current`, `subscriptions.canCreatePrivateCamp`, `subscriptions.syncStorePurchase`, `subscriptions.verifyStorePurchase` | Authenticated self. Store verification is server-to-store; caller identifiers are not treated as proof of entitlement. |
| Video creation/live | `videos.createMuxDirectUpload`, `videos.getMuxUploadStatus`, `videos.createLiveStream`, `videos.endLiveStream`, `videos.getLiveSessionRecordStatus`, `videos.createLiveBackupDirectUpload`, `videos.cancelLiveStream`, `videos.markBondfireLive`, `videos.markBondfireVideoLive`, `videos.touchLiveSession`, `videos.confirmLiveSessionLocalBackup`, `videos.validateCreateCamp`, `videos.validateRespondCamp`, `videos.validatePersonalCreate`, `liveSessions.listMyActive` | Authenticated creator/session owner with server-side camp/tier/respond checks. Upload-status lookup now proves ownership before calling or mutating Mux state. The unused caller-asserted backup attachment endpoint is now internal-only. |
| Video playback | `videos.getVideoUrls`, `videos.getVideoUrlsBatch`, `videos.getThumbnailUrl`, `videos.getThumbnailUrlsBatch` | All playback paths require shared object visibility before returning media URLs. Batch sizes are capped. |

| Account deletion | `accountDeletion.request`, `accountDeletion.status` | Authenticated self; durable deletion includes per-user abuse counters. |
| Family Connections | `familyConnections.createInvite`, `familyConnections.checkInvite`, `familyConnections.acceptInvite`, `familyConnections.listMine`, `familyConnections.revoke` | Owner creates a single-use high-entropy link; bearer preview exposes consent context; authenticated explicit acceptance grants access to the named Hearth. Blocks deny relationships. |
| Legal acceptance | `legal.getAcceptanceStatus`, `legal.acceptCurrent` | Authenticated self; exact policy versions are stored server-side. |
| Safety controls | `userSafety.block`, `userSafety.unblock`, `userSafety.listBlocked` | Authenticated self; bidirectional enforcement and family revocation. |
| Moderation | `moderation.getQueue`, `moderation.moderateContent`, `moderation.setUserStatus`, `moderation.reviewReport` | Admin only; actions audited. |

## Known limitations and composition

- Convex does not expose a trustworthy originating IP to these functions, so
  this PR does not claim anonymous/IP throttling. It also avoids a single global
  counter that would serialize all legitimate invite traffic. Edge/WAF controls
  remain a deployment defense for any future unauthenticated HTTP invite preview.
- Existing three-word codes are never reused. They remain redeemable only until
  the earlier of their normal expiry and the explicit October 1, 2026 migration
  cutoff; the daily cleanup then removes bounded batches of old no-expiry rows.
  All newly generated codes have more than 100 bits of CSPRNG entropy and a
  mandatory expiry.
- Codes remain plaintext at rest because the product reuses and re-displays an
  active link. A future hashed-code migration should store only a digest and
  stop re-displaying old secrets; it should not be mixed into this rollout.
- The durable account-deletion worker removes abuse counters in bounded batches.
- Invalid, expired, blocked, and age-ineligible Camp claims return a generic result
  so the attempt counter commits. A valid Hearth invitation may still report a
  capacity/entitlement error; high-entropy Family Connection consent keeps its
  dedicated preview and acceptance flow.
# Billing additions

- `storeBilling.billingHealth`: authenticated admin only; bounded, redacted operational counters.
- `storeBillingActions.prepareStorePurchase`: authenticated, non-deleting account; creates only a server-generated store binding, never an entitlement.

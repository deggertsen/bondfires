/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as accountDeletion from "../accountDeletion.js";
import type * as abuseLimits from "../abuseLimits.js";
import type * as admin from "../admin.js";
import type * as adminAudit from "../adminAudit.js";
import type * as adminDashboard from "../adminDashboard.js";
import type * as agePolicy from "../agePolicy.js";
import type * as ageSafetyMaintenance from "../ageSafetyMaintenance.js";
import type * as ai from "../ai.js";
import type * as auth from "../auth.js";
import type * as bondfireFailureCleanup from "../bondfireFailureCleanup.js";
import type * as bondfireInvites from "../bondfireInvites.js";
import type * as bondfireRetention from "../bondfireRetention.js";
import type * as bondfireVideos from "../bondfireVideos.js";
import type * as bondfireVisibility from "../bondfireVisibility.js";
import type * as bondfires from "../bondfires.js";
import type * as campAnalytics from "../campAnalytics.js";
import type * as campBranding from "../campBranding.js";
import type * as campKindling from "../campKindling.js";
import type * as campLifecycle from "../campLifecycle.js";
import type * as campSlots from "../campSlots.js";
import type * as camps from "../camps.js";
import type * as cleanup from "../cleanup.js";
import type * as clientLogs from "../clientLogs.js";
import type * as contentSafety from "../contentSafety.js";
import type * as conversations from "../conversations.js";
import type * as crons from "../crons.js";
import type * as digest from "../digest.js";
import type * as email from "../email.js";
import type * as entitlements from "../entitlements.js";
import type * as errors from "../errors.js";
import type * as familyConnectionRevocation from "../familyConnectionRevocation.js";
import type * as familyConnections from "../familyConnections.js";
import type * as familyRelationships from "../familyRelationships.js";
import type * as http from "../http.js";
import type * as inviteArtifacts from "../inviteArtifacts.js";
import type * as inviteBadges from "../inviteBadges.js";
import type * as inviteClaims from "../inviteClaims.js";
import type * as inviteCodes from "../inviteCodes.js";
import type * as legal from "../legal.js";
import type * as lib_accountDeletionPolicy from "../lib/accountDeletionPolicy.js";
import type * as lib_appVersion from "../lib/appVersion.js";
import type * as lib_clientTelemetry from "../lib/clientTelemetry.js";
import type * as lib_emojis from "../lib/emojis.js";
import type * as lib_latestResponsePlayback from "../lib/latestResponsePlayback.js";
import type * as lib_liveBackupRecovery from "../lib/liveBackupRecovery.js";
import type * as lib_liveIngest from "../lib/liveIngest.js";
import type * as lib_liveSessionStaleness from "../lib/liveSessionStaleness.js";
import type * as lib_notificationCopy from "../lib/notificationCopy.js";
import type * as lib_presence from "../lib/presence.js";
import type * as lib_pushProviders from "../lib/pushProviders.js";
import type * as lib_reportPolicy from "../lib/reportPolicy.js";
import type * as lib_storeBillingPolicy from "../lib/storeBillingPolicy.js";
import type * as lib_videoReactions from "../lib/videoReactions.js";
import type * as liveSessionProgress from "../liveSessionProgress.js";
import type * as liveSessions from "../liveSessions.js";
import type * as moderation from "../moderation.js";
import type * as notifications from "../notifications.js";
import type * as personalBondfireAccess from "../personalBondfireAccess.js";
import type * as personalBondfires from "../personalBondfires.js";
import type * as personalCamps from "../personalCamps.js";
import type * as presence from "../presence.js";
import type * as publicConfig from "../publicConfig.js";
import type * as reconciliation from "../reconciliation.js";
import type * as reports from "../reports.js";
import type * as responseCounts from "../responseCounts.js";
import type * as sendNotification from "../sendNotification.js";
import type * as serverTelemetry from "../serverTelemetry.js";
import type * as storeBilling from "../storeBilling.js";
import type * as storeBillingActions from "../storeBillingActions.js";
import type * as subscriptions from "../subscriptions.js";
import type * as userSafety from "../userSafety.js";
import type * as users from "../users.js";
import type * as videoCountRepair from "../videoCountRepair.js";
import type * as videoReactions from "../videoReactions.js";
import type * as videos from "../videos.js";
import type * as watchEvents from "../watchEvents.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  accountDeletion: typeof accountDeletion;
  abuseLimits: typeof abuseLimits;
  admin: typeof admin;
  adminAudit: typeof adminAudit;
  adminDashboard: typeof adminDashboard;
  agePolicy: typeof agePolicy;
  ageSafetyMaintenance: typeof ageSafetyMaintenance;
  ai: typeof ai;
  auth: typeof auth;
  bondfireFailureCleanup: typeof bondfireFailureCleanup;
  bondfireInvites: typeof bondfireInvites;
  bondfireRetention: typeof bondfireRetention;
  bondfireVideos: typeof bondfireVideos;
  bondfireVisibility: typeof bondfireVisibility;
  bondfires: typeof bondfires;
  campAnalytics: typeof campAnalytics;
  campBranding: typeof campBranding;
  campKindling: typeof campKindling;
  campLifecycle: typeof campLifecycle;
  campSlots: typeof campSlots;
  camps: typeof camps;
  cleanup: typeof cleanup;
  clientLogs: typeof clientLogs;
  contentSafety: typeof contentSafety;
  conversations: typeof conversations;
  crons: typeof crons;
  digest: typeof digest;
  email: typeof email;
  entitlements: typeof entitlements;
  errors: typeof errors;
  familyConnectionRevocation: typeof familyConnectionRevocation;
  familyConnections: typeof familyConnections;
  familyRelationships: typeof familyRelationships;
  http: typeof http;
  inviteArtifacts: typeof inviteArtifacts;
  inviteBadges: typeof inviteBadges;
  inviteClaims: typeof inviteClaims;
  inviteCodes: typeof inviteCodes;
  legal: typeof legal;
  "lib/accountDeletionPolicy": typeof lib_accountDeletionPolicy;
  "lib/appVersion": typeof lib_appVersion;
  "lib/clientTelemetry": typeof lib_clientTelemetry;
  "lib/emojis": typeof lib_emojis;
  "lib/latestResponsePlayback": typeof lib_latestResponsePlayback;
  "lib/liveBackupRecovery": typeof lib_liveBackupRecovery;
  "lib/liveIngest": typeof lib_liveIngest;
  "lib/liveSessionStaleness": typeof lib_liveSessionStaleness;
  "lib/notificationCopy": typeof lib_notificationCopy;
  "lib/presence": typeof lib_presence;
  "lib/pushProviders": typeof lib_pushProviders;
  "lib/reportPolicy": typeof lib_reportPolicy;
  "lib/storeBillingPolicy": typeof lib_storeBillingPolicy;
  "lib/videoReactions": typeof lib_videoReactions;
  liveSessionProgress: typeof liveSessionProgress;
  liveSessions: typeof liveSessions;
  moderation: typeof moderation;
  notifications: typeof notifications;
  personalBondfireAccess: typeof personalBondfireAccess;
  personalBondfires: typeof personalBondfires;
  personalCamps: typeof personalCamps;
  presence: typeof presence;
  publicConfig: typeof publicConfig;
  reconciliation: typeof reconciliation;
  reports: typeof reports;
  responseCounts: typeof responseCounts;
  sendNotification: typeof sendNotification;
  serverTelemetry: typeof serverTelemetry;
  storeBilling: typeof storeBilling;
  storeBillingActions: typeof storeBillingActions;
  subscriptions: typeof subscriptions;
  userSafety: typeof userSafety;
  users: typeof users;
  videoCountRepair: typeof videoCountRepair;
  videoReactions: typeof videoReactions;
  videos: typeof videos;
  watchEvents: typeof watchEvents;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};

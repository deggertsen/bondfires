/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as admin from "../admin.js";
import type * as adminAudit from "../adminAudit.js";
import type * as adminDashboard from "../adminDashboard.js";
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
import type * as conversations from "../conversations.js";
import type * as crons from "../crons.js";
import type * as digest from "../digest.js";
import type * as email from "../email.js";
import type * as entitlements from "../entitlements.js";
import type * as errors from "../errors.js";
import type * as http from "../http.js";
import type * as inviteCodes from "../inviteCodes.js";
import type * as liveSessions from "../liveSessions.js";
import type * as notifications from "../notifications.js";
import type * as personalBondfireAccess from "../personalBondfireAccess.js";
import type * as personalBondfires from "../personalBondfires.js";
import type * as personalCamps from "../personalCamps.js";
import type * as publicConfig from "../publicConfig.js";
import type * as reconciliation from "../reconciliation.js";
import type * as reports from "../reports.js";
import type * as responseCounts from "../responseCounts.js";
import type * as sendNotification from "../sendNotification.js";
import type * as serverTelemetry from "../serverTelemetry.js";
import type * as subscriptions from "../subscriptions.js";
import type * as users from "../users.js";
import type * as videoCountRepair from "../videoCountRepair.js";
import type * as videos from "../videos.js";
import type * as watchEvents from "../watchEvents.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  admin: typeof admin;
  adminAudit: typeof adminAudit;
  adminDashboard: typeof adminDashboard;
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
  conversations: typeof conversations;
  crons: typeof crons;
  digest: typeof digest;
  email: typeof email;
  entitlements: typeof entitlements;
  errors: typeof errors;
  http: typeof http;
  inviteCodes: typeof inviteCodes;
  liveSessions: typeof liveSessions;
  notifications: typeof notifications;
  personalBondfireAccess: typeof personalBondfireAccess;
  personalBondfires: typeof personalBondfires;
  personalCamps: typeof personalCamps;
  publicConfig: typeof publicConfig;
  reconciliation: typeof reconciliation;
  reports: typeof reports;
  responseCounts: typeof responseCounts;
  sendNotification: typeof sendNotification;
  serverTelemetry: typeof serverTelemetry;
  subscriptions: typeof subscriptions;
  users: typeof users;
  videoCountRepair: typeof videoCountRepair;
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

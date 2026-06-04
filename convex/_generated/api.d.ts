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
import type * as auth from "../auth.js";
import type * as bondfireVideos from "../bondfireVideos.js";
import type * as bondfires from "../bondfires.js";
import type * as campAnalytics from "../campAnalytics.js";
import type * as campBranding from "../campBranding.js";
import type * as campBrandingConstants from "../campBrandingConstants.js";
import type * as campLifecycle from "../campLifecycle.js";
import type * as campSlots from "../campSlots.js";
import type * as camps from "../camps.js";
import type * as cleanup from "../cleanup.js";
import type * as clientLogs from "../clientLogs.js";
import type * as conversations from "../conversations.js";
import type * as crons from "../crons.js";
import type * as email from "../email.js";
import type * as entitlements from "../entitlements.js";
import type * as errors from "../errors.js";
import type * as http from "../http.js";
import type * as liveSessions from "../liveSessions.js";
import type * as notifications from "../notifications.js";
import type * as reconciliation from "../reconciliation.js";
import type * as reports from "../reports.js";
import type * as sendNotification from "../sendNotification.js";
import type * as subscriptions from "../subscriptions.js";
import type * as users from "../users.js";
import type * as videos from "../videos.js";
import type * as watchEvents from "../watchEvents.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  admin: typeof admin;
  auth: typeof auth;
  bondfireVideos: typeof bondfireVideos;
  bondfires: typeof bondfires;
  campAnalytics: typeof campAnalytics;
  campBranding: typeof campBranding;
  campBrandingConstants: typeof campBrandingConstants;
  campLifecycle: typeof campLifecycle;
  campSlots: typeof campSlots;
  camps: typeof camps;
  cleanup: typeof cleanup;
  clientLogs: typeof clientLogs;
  conversations: typeof conversations;
  crons: typeof crons;
  email: typeof email;
  entitlements: typeof entitlements;
  errors: typeof errors;
  http: typeof http;
  liveSessions: typeof liveSessions;
  notifications: typeof notifications;
  reconciliation: typeof reconciliation;
  reports: typeof reports;
  sendNotification: typeof sendNotification;
  subscriptions: typeof subscriptions;
  users: typeof users;
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

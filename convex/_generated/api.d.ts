/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as auth from "../auth.js";
import type * as bondfireVideos from "../bondfireVideos.js";
import type * as bondfires from "../bondfires.js";
import type * as email from "../email.js";
import type * as http from "../http.js";
import type * as notifications from "../notifications.js";
import type * as sendNotification from "../sendNotification.js";
import type * as users from "../users.js";
import type * as videos from "../videos.js";
import type * as watchEvents from "../watchEvents.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  auth: typeof auth;
  bondfireVideos: typeof bondfireVideos;
  bondfires: typeof bondfires;
  email: typeof email;
  http: typeof http;
  notifications: typeof notifications;
  sendNotification: typeof sendNotification;
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

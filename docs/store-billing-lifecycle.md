# Store billing lifecycle operations

Bondfires treats Apple and Google as the source of truth for subscription lifecycle state. The
mobile purchase callback only supplies a lookup identifier. The backend verifies the purchase with
the store, binds it to a server-generated per-user account token, and persists the resulting
entitlement. Webhooks provide the fast path for later changes; bounded reconciliation is the
missed-webhook backstop.

No webhook, receipt, purchase token, signed payload, or service-account credential may be logged.
The durable event ledger stores a provider notification identifier and a SHA-256 subject hash, not
the underlying store identifier.

## Required Convex environment variables

Use [`store-billing.env.example`](store-billing.env.example) as the key inventory. Set secrets in
each Convex deployment; never put them in a mobile `.env` file or commit their values.

Apple:

- `APPLE_IAP_ENVIRONMENT`: exactly `production` or `sandbox`. Production rejects the production
  webhook unless this is `production`.
- `APPLE_IAP_ALLOW_SANDBOX_NOTIFICATIONS`: set to `true` in production only while sandbox
  notification delivery and sandbox/TestFlight purchase verification are intentionally enabled.
- `APPLE_BUNDLE_ID` and `APPLE_APP_ID`: the exact App Store application identifiers. The numeric
  Apple app ID is required for production signed-data verification.
- `APPLE_IAP_KEY_ID`, `APPLE_IAP_ISSUER_ID`, and `APPLE_IAP_PRIVATE_KEY`: an App Store Connect API
  key with access to the App Store Server API. Newlines may be stored literally or as `\n`.
- `APPLE_ROOT_CA_CERTIFICATES_BASE64`: comma-separated base64 of the DER bytes for Apple's current
  App Store signing root certificates. Download roots only from Apple's certificate authority
  page, review rotations operationally, and do not substitute an intermediate certificate.

Google:

- `GOOGLE_PLAY_PACKAGE_NAME`: the exact application ID published in Play Console.
- `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON`: the Play Developer API service-account JSON, or set both
  `GOOGLE_PLAY_SERVICE_ACCOUNT_EMAIL` and `GOOGLE_PLAY_SERVICE_ACCOUNT_PRIVATE_KEY` instead. The
  JSON form takes precedence.
- `GOOGLE_PUBSUB_AUDIENCE`: an exact audience value chosen for the push subscription. Using the
  HTTPS endpoint URL itself is recommended.
- `GOOGLE_PUBSUB_PUSH_SERVICE_ACCOUNT_EMAIL`: the exact service-account identity attached to the
  Pub/Sub push subscription. It is independently checked after Google's OIDC token signature and
  audience are verified.

## Provider configuration

For a deployment whose HTTP origin is `https://<deployment>.convex.site`, configure:

- App Store Connect production notifications V2:
  `https://<deployment>.convex.site/store/apple/notifications/production`
- App Store Connect sandbox notifications V2, only while enabled:
  `https://<deployment>.convex.site/store/apple/notifications/sandbox`
- Google Pub/Sub push:
  `https://<deployment>.convex.site/store/google/rtdn`

In App Store Connect, select App Store Server Notifications V2 and send a test notification after
configuration. Apple notification JWS, nested transaction JWS, and renewal JWS are verified by
Apple's official server library with certificate-chain online checks, expected environment, exact
bundle ID, and production app Apple ID. Each state-changing notification is then confirmed by the
App Store Server API before the entitlement changes.

In Google Play Console, connect Real-time Developer Notifications to a Pub/Sub topic. Create an
authenticated push subscription for the HTTPS endpoint, configure its OIDC service account and
the exact `GOOGLE_PUBSUB_AUDIENCE`. Grant Pub/Sub's service agent the documented Service Account
Token Creator role, and grant the operator creating the push subscription permission to act as its
OIDC service account. Separately grant the billing service account access to the Android Publisher
API and the app in Play Console. The push JWT is verified for Google signature, audience, verified
email, and exact service-account email before the RTDN body is decoded. RTDN is only a signal: the
backend always queries `purchases.subscriptionsv2.get` before changing entitlement state.

## State, retries, and reconciliation

- Renewal and active trials remain entitled. Cancel-at-period-end remains entitled until the
  provider expiration. Apple/Google grace periods remain entitled through their provider end.
- Billing retry, account hold, and pause are stored as `past_due` and are not entitled. Expiry,
  refund, and revocation end entitlement and run the existing downgrade/freeze workflow.
- Event claims are keyed by provider, protocol version, and notification/message ID. Completed
  events cannot replay; abandoned processing leases become retryable after five minutes.
- A notification received before its initial purchase is linked returns a retryable response for
  five deliveries. It is then acknowledged but remains failed and visible to admins; the
  reconciliation job can still recover it after the purchase is linked.
- The cron selects at most 20 due verified subscriptions every six hours. Queries and action work
  are bounded at 50; failures use exponential retry capped at 24 hours. Terminal subscriptions are
  still rechecked weekly so delayed refunds or corrections are observed.
- Billing event evidence is retained for 90 days and deleted in batches of 100.

This lifecycle reconciler covers auto-renewable subscriptions. Voided Google one-time products are
authenticated and recorded but intentionally ignored because Bondfires' kindling ledger has no
debt/clawback policy yet; support must define that customer and accounting policy before automated
kindling reversal is enabled. Apple consumables found revoked during an explicit verification are
marked refunded and are not credited.

In the Convex dashboard Function Runner, invoke `storeBilling:billingHealth` with an authenticated
admin identity to inspect safe failure summaries, stuck event counts, and overdue reconciliation
counts. Also alert on Convex action/cron failures and a persistently non-zero billing health result.
The health response deliberately omits purchase tokens, transaction IDs, user IDs, and signed
payloads.

## Rollout and recovery

1. Configure provider credentials and URLs in a non-production deployment and exercise Apple and
   Google test notifications.
2. Deploy the backward-compatible schema and backend before submitting the new clients. Existing
   entitlements continue to work, but old clients do not send the new account-binding token.
3. Release the new client and confirm an iOS and Android test purchase includes the generated
   account token. Set a minimum supported app version only after both stores serve that release;
   new purchases from older clients fail closed rather than creating an unbound entitlement.
4. Inspect billing health and reconciliation after rollout. Provider retries are safe because event
   completion and store identifiers are idempotent.
5. To replay a provider event, use the provider's documented resend mechanism. Failed events may be
   reclaimed; processed/ignored event IDs are intentionally no-ops. Do not delete an event merely
   to force replay without first confirming its authoritative store state.

## Merge-train requirements

- PR 217's durable account deletion and transaction tombstones must be rebased after this schema.
  Delete subscriptions and the user's `storeAccountToken` with the user, but retain the redacted
  `storeBillingEvents` ledger for its 90-day replay/evidence window. Its tombstone checks must run
  before initial sync, webhook application, and reconciliation so a deleted account's store
  transaction can never recreate entitlement on another account.
- PR 220 also changes `convex/schema.ts`, generated bindings, and account-deletion integration.
  Resolve those files explicitly and rerun Convex code generation plus the full validation suite.
  Standalone merge of this PR does not complete the PR 217/220 integration.

## Primary references

- [Apple App Store Server Library for Node.js](https://github.com/apple/app-store-server-library-node)
- [Apple App Store Server Notifications](https://developer.apple.com/documentation/appstoreservernotifications)
- [Apple App Store Server API](https://developer.apple.com/documentation/appstoreserverapi)
- [Apple certificate authority](https://www.apple.com/certificateauthority/)
- [Google Play Real-time Developer Notifications reference](https://developer.android.com/google/play/billing/rtdn-reference)
- [Google Play subscriptions v2 get](https://developers.google.com/android-publisher/api-ref/rest/v3/purchases.subscriptionsv2/get)
- [Google Cloud authenticated Pub/Sub push](https://cloud.google.com/pubsub/docs/authenticate-push-subscriptions)
- [Convex HTTP actions](https://docs.convex.dev/functions/http-actions)
- [Convex cron jobs](https://docs.convex.dev/scheduling/cron-jobs)

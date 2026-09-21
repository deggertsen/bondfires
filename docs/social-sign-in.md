# Apple and Google sign-in

New members choose Apple, Google, or Email. Apple/Google supply identity and available names; one registration screen still requires first name, last name, gender, birthday, and acceptance of Terms and Community Guidelines. Email keeps password/confirmation and emailed verification. Completed users skip registration on future logins.

## Configuration (per Convex deployment)

Deploy the backend before the mobile client. Both providers stay absent from the mobile UI until their ID and secret are configured. Existing password authentication remains available.

| Provider | Convex environment variables | HTTPS provider callback |
| --- | --- | --- |
| Google | `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET` | `https://<deployment>.convex.site/api/auth/callback/google` |
| Apple | `AUTH_APPLE_ID`, `AUTH_APPLE_SECRET` | `https://<deployment>.convex.site/api/auth/callback/apple` |

Use a Google **Web application** OAuth client with the exact HTTPS callback, an external consent screen, and dedicated test identities while in testing mode. Request only the normal identity, email and profile scopes. Do not request birthday/People API access.

For Apple, enable Sign in with Apple on the app identifier, create an associated Services ID and signing key, register the Convex HTTP domain and exact HTTPS return URL, and generate the client-secret JWT. The Services ID is `AUTH_APPLE_ID`. Rotate the client secret before its expiry (at most six months). Configure Apple's private email relay to accept the app's outbound email domain if sending mail to relay addresses.

The provider returns to Convex over HTTPS. Convex then redirects to the exact allowlisted `bondfires://auth-callback` native route with a one-time code. The app uses its existing `expo-web-browser` integration and Convex's stored verifier to exchange this code for a session. Neither provider tokens nor secrets belong in `EXPO_PUBLIC_*`. This implementation targets installed iOS/Android apps; social buttons are hidden on web, and Expo Go is not an OAuth QA target. No new native SDK is required.

Use a dedicated authentication test deployment/client configuration. Do not repoint production or replace the video experiment's running backend merely to test this PR. No credentials, provider-console changes, deployment, or release are included in this PR.

## Account and registration rules

- New social accounts have `registrationPending: true`. They can read their own registration state, finish registration, sign out, or request account deletion; shared backend authorization denies normal authenticated application operations, including actions. Public anonymous endpoints retain their existing behavior.
- Completion validates all required fields server-side, uses the existing conservative age-band boundary, records current legal versions, and atomically clears the pending flag. It is retry-safe and cannot be used to change an existing birthday. A restart resumes registration.
- Existing accounts without the new flag retain their current behavior. Provider login/linking never resets their birthday, legal acceptance, chosen names, gender, or moderation state.
- Matching verified email addresses link to the same user. Google must also be authoritative for the mailbox (Gmail or a verified Workspace `hd` claim); third-party Google email addresses do not auto-link or become email-verified in Bondfires. Password linking continues to require an emailed code before the new password account can issue a session. Unverified password registrations are not trusted for social linking. Ambiguous verified duplicates fail closed.
- Apple's relay address is a distinct address. Different-email accounts are **not merged automatically**. Members wanting their existing account should use their original sign-in method or the same shared, verified email. A separate user-initiated cross-email linking/merge UI is outside this change.
- Apple's first-authorization names are retained. Apple refresh tokens live in a separate server-only table. Account deletion revokes the Apple token before removing credentials or user data; provider/configuration failures use the existing durable retry queue. Never enable verbose auth logging in environments holding real provider tokens.
- Birthday remains self-declared; social login is not age verification. Platform age-range APIs are a separate future integration.

## Validation and device acceptance

Automated tests cover registration enforcement for queries/mutations/actions, full completion and retry behavior, age boundaries, names/gender/legal validation, verified/unverified linking, relay isolation, preservation of completed profiles, deletion tombstones, Apple revocation retries, callback replay deduplication, and expired/cancelled callbacks.

Before enabling for members, use dedicated Google/Apple QA identities on installed iOS and Android builds to verify:

1. New account → editable prefilled names → gender, birthday, legal acceptance on one screen → app access.
2. Cancel provider prompt, decline authorization, background/restart during sign-in, restart during registration, and retry a failed network exchange.
3. Returning account skips registration. Existing verified email account retains its camps, content, and completed profile. Apple first/repeat authorization works with both shared and relay email.
4. Under-13 and invalid dates are rejected; teen/adult access restrictions still apply. Deep links cannot bypass completion; invitations resume afterward.
5. Email signup/OTP, login, password reset, sign-out, and account deletion still work. Apple deletion revokes the provider token.
6. Light/dark mode, small-screen keyboard scrolling, and accessibility labels remain usable.

Official references: [Convex OAuth](https://labs.convex.dev/auth/config/oauth), [Google setup](https://labs.convex.dev/auth/config/oauth/google), [Apple setup](https://labs.convex.dev/auth/config/oauth/apple), [account linking](https://labs.convex.dev/auth/advanced), [Apple token revocation](https://developer.apple.com/documentation/technotes/tn3194-handling-account-deletions-and-revoking-tokens-for-sign-in-with-apple).

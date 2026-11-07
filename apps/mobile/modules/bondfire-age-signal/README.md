# bondfire-age-signal

Local Expo module that asks the phone for an age range during registration and
on later launches. It is the only place native age APIs are called.

| Platform | API | Notes |
| --- | --- | --- |
| iOS 26+ | Apple Declared Age Range (`AgeRangeService.shared.requestAgeRange(ageGates: 13, 18, …)`) | Weak-linked (`weak_frameworks`, `#if canImport`, `#available(iOS 26, *)`) so the app keeps its iOS 16.4 deployment target. Requires the `com.apple.developer.declared-age-range` entitlement, set in `app.json`. |
| Android | Google Play Age Signals (`com.google.android.play:age-signals:0.0.4`) | `requestAgeSignalsAccess` (may show Play's own share prompt) then `checkAgeSignals`. Default bands 0–12, 13–15, 16–17, 18+. |

## JS contract

`requestNativeAgeRange(minimumGate, adultGate)` resolves to
`{ status: 'shared' | 'declined' | 'unavailable', lowerBound?, upperBound? }`
and never rejects. Older iOS, Expo Go, a missing module, a user who declines,
a Play Services error, or any thrown error all resolve to `unavailable` or
`declined`; the app then asks for birth month and year instead. The module
never fabricates a range.

Mapping of a range onto the app's bands (13–17 teen, 18+ adult, under 13
blocked, straddling ranges handled conservatively) lives in
`convex/agePolicy.ts` so the server and client share one rule set.

This is a client-reported OS signal with the same trust level as a client-sent
birth date. It is not identity verification.

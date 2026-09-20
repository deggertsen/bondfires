# Internal segmented video experiment

This branch replaces Mux ingest and playback **only in the internal store profile**.
Production and the TestFlight Beta audience retain the existing build and Convex deployment.
The former TestFlight Alpha group has been renamed Internal; Google Play uses its internal track.

## Recording and delivery

The camera and microphone warm up before Record. No preroll is persisted. Record attaches
one continuous H.264/AAC encoder to a local fragmented MP4 writer. Approximately four-second
segments are committed atomically. Upload starts after capture and never gates the Record button.
A persisted job binds each recording to its user and destination camp or response. Uploads are
sequential, retry the same immutable filenames, and resume while the app is open. App backgrounding
ends capture and finalizes the local recording. An OS-terminated process can recover complete
fragments; the unfinished final fragment cannot be recovered.

Convex creates normal Bondfire/response rows using existing entitlement, moderation and membership
checks. A trusted Worker validates bounded MP4 data and records idempotent upload receipts.
A growing EVENT HLS playlist exposes only the contiguous received prefix. Eight seconds of received
media makes an ongoing recording watchable. Finalization adds ENDLIST when every declared segment
is present. The immutable 15-second target duration allows up to 45 seconds of ordinary HLS holdback;
actual playback startup and live lag need device measurement. Slow uplinks can exceed that delay.

The first implementation uses one 720p H.264 rendition and mono AAC at 128 kbps. It does not yet
provide adaptive bitrate renditions, generated captions, Mux thumbnails, or server-side loudness
normalization. Local capture should prevent transport disruption from corrupting recorded audio;
microphone routing and perceived loudness still require listening tests on real devices.

## Isolated resources

- Convex: `lovely-malamute-525`, named deployment `bondfires:bondfires:internal-video`.
- Video: private R2 bucket `bondfires-internal-video` in Transcend Systems.
- Worker: `https://bondfires-internal-media.yooweb.workers.dev`.
- Store build: EAS profile `internal`, channel `internal`, EAS environment `preview`.
- No user or video data is copied from production. Testers create internal accounts.

The mobile build validates the registered internal Convex URL. Backend media functions additionally
check the deployment URL and `INTERNAL_SEGMENT_MEDIA=1`. Worker credentials are independent random
secrets. Signed playback capabilities last 12 hours; every playlist and segment request also checks
current authorization. Membership removal, moderation, expiry, account deletion and deleted parent
records revoke playback without waiting for token expiry. Invocation logs are disabled to avoid
storing bearer tokens embedded in playlist URLs.

A cleanup job revokes orphaned/expired recordings and deletes their R2 prefixes. It retains a tombstone
for an hour and deletes again before removing metadata, covering uploads already in flight at
revocation. Unfinished uploads expire after seven days. Local media is removed after server-confirmed
completion. iOS excludes the local recording directory from backups.

## Release and rollback

Do **not** use `scripts/release.sh`: it deploys the production backend. Deploy this backend with
`convex deploy --env-file .env.internal-video.local`; deploy the Worker from `infrastructure/media`.
Secrets live in ignored local files and deployed secret stores, never source control.

Build and submit with the `internal` profile. Verify TestFlight Beta has no automatic access to the
new build before upload, and assign the processed build only to Internal. Do not promote the Play
internal release to another track. Internal currently has automatic access to all TestFlight builds,
so omit EAS Submit `--groups`: Apple rejects redundant manual assignments to that group. Confirm
its build list and `internalBuildState` after upload. Rollback is an older store build; internal media stays isolated
and does not need a production data migration.

## Internal release evidence — 2026-09-20

Version 1.0.88, build 103 was built from `2001c4a` and distributed to both stores.
The packaged JavaScript on both platforms contains the internal Convex URL and no production URL.
App Store Connect reports build `817ca30c-fe1d-4e7c-b9e1-6294a1fb41a1` as VALID and
IN_BETA_TESTING; the Internal group includes 103, while Beta remains on 102. Google Play reports
internal version code 103 as completed; alpha remains on 102. Later commits update repository
impact rules and documentation only.

Repository validation passes with 493 tests, and both store builds succeeded. The deployed service
smoke test verifies ordered uploads, exact retry/conflict handling, private playback, growing and
finalized playlists, byte ranges, deletion revocation and R2 cleanup. A synthetic capture through
the actual iOS writer decodes continuously as H.264/AAC with a normalized timeline. These checks
do not substitute for the device checks below.

## Required device checks

Measure tap-to-first-captured-frame and confirm the first spoken word is retained. Record on iOS and
Android and play each on the other platform, both while recording and after completion. Test short
clips, maximum duration, silence, speech, Bluetooth and wired microphones, low storage, incoming
calls, backgrounding, force quit, airplane mode, Wi-Fi/cellular changes, sign-out during upload,
retry conflicts, deletion, and camp membership removal. Compare audio loudness and artifacts with
the prior Mux build. Store distribution is a test release, not evidence these checks passed.

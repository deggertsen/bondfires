# Mux Live Streaming Setup

Bondfires live publishing uses Mux Live Streams over RTMPS:

- Ingest URL: `rtmps://global-live.mux.com/app`
- Latency mode: `low` by default
- Recording: enabled through `new_asset_settings`, so each ended live stream becomes a normal Mux VOD asset.

## Convex Environment

Set these variables per Convex deployment:

```bash
MUX_TOKEN_ID=...
MUX_TOKEN_SECRET=...
MUX_WEBHOOK_SECRET=...
MUX_SIGNING_KEY_ID=...
MUX_SIGNING_PRIVATE_KEY=...
MUX_LIVE_LATENCY_MODE=low
MUX_LIVE_RECONNECT_WINDOW_SECONDS=30
MUX_LIVE_RECONNECT_SLATE_URL=https://<public-host>/mux-live-slate.png
```

`MUX_PLAYBACK_POLICY`, `MUX_VIDEO_QUALITY`, and `MUX_UPLOAD_CORS_ORIGIN` keep their existing meanings for VOD uploads.

### Reconnect slate (branded placeholder)

> **Default: disabled.** `MUX_LIVE_RECONNECT_WINDOW_SECONDS` now defaults to `0`.
> Our native publishers do not auto-reconnect a dropped RTMP session, so a
> reconnect window never resumed a recording — it only let Mux splice a
> "connection interrupted" slate into the recorded VOD after an ungraceful
> disconnect (e.g. a client crash on stop). With a `0` window Mux finalizes the
> asset at the last frame it received, so playback freezes on that frame instead
> of ever showing the slate. The slate plumbing below only engages if you
> explicitly set a positive `MUX_LIVE_RECONNECT_WINDOW_SECONDS`.

When the RTMP encoder disconnects and the live stream has a positive
`reconnect_window`, Mux can fill that interruption with a "slate" image. Without
configuration it uses Mux's own generic placeholder, which can appear in the
recorded VOD if an interruption is captured before the recording is completed.

Set `MUX_LIVE_RECONNECT_SLATE_URL` to a **publicly downloadable** `.png`/`.jpg`
to show a Bondfires-branded frame instead. The branded asset lives at
`docs/brand/mux-live-slate.png` (1080×1920 portrait / 9:16, matching mobile
capture) — host it on a public URL (e.g. the marketing site / Cloudflare Pages /
R2) and point the env var at it. Notes:

- Mux downloads the image at the start of each live recording, so the URL must
  stay reachable (no auth). If the download fails, Mux falls back to its default
  slate and fires a `video.live_stream.warning` webhook.
- The asset is already portrait/9:16 to match mobile capture; if the captured
  aspect ratio ever changes, re-export to match or Mux will letterbox it.
- Slate insertion needs `reconnect_window > 0`. For `standard` latency mode the
  backend also sets `use_slate_for_standard_latency: true` when the reconnect
  window is positive; `low`/`reduced` only need the window. Leaving the env var
  unset keeps Mux's default slate.

The client also calls Mux's live-stream `/complete` endpoint through
`useLivePublisher.stop` before tearing down the RTMP publisher. Per Mux's API,
that ends the recorded asset immediately instead of waiting for the reconnect
window; Mux intentionally does not close the encoder connection immediately, so
the app still stops the native publisher afterward. The custom slate is the
safety net for mid-stream reconnect blips and any interruption that is captured
before completion.
`MUX_SIGNING_PRIVATE_KEY` can be the raw PEM returned by the Mux signing key API
with escaped newlines, or a base64-encoded PEM. These signing variables are
required for private camp videos because private camp assets are created with
signed playback IDs.

## Mux Webhook

In the Mux dashboard, configure the environment webhook URL to:

```text
https://<convex-deployment>/mux/webhook
```

Enable at least these event families:

- `video.live_stream.*`
- `video.asset.*`
- `video.upload.*`

Use the webhook signing secret as `MUX_WEBHOOK_SECRET` in the matching Convex deployment.

## Mobile Builds

The live publisher is a native Expo module, so it requires a fresh development build. It will not run in Expo Go.

```bash
yarn workspace mobile build:ios:dev
yarn workspace mobile build:android:dev
```

The app-level feature flag is `appStore$.preferences.livePublishEnabled`. It defaults to `false` so the legacy upload flow remains available during rollout.

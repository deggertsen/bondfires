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
MUX_LIVE_LATENCY_MODE=low
MUX_LIVE_RECONNECT_WINDOW_SECONDS=30
```

`MUX_PLAYBACK_POLICY`, `MUX_VIDEO_QUALITY`, and `MUX_UPLOAD_CORS_ORIGIN` keep their existing meanings for VOD uploads.

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

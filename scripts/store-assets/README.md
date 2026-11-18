# Store listing assets

Tools and copy for the App Store and Google Play listings. The November 2026 set was made with
these. Generated images go to `/store-assets/` at the repo root, which is gitignored. Raw
captures contain real users' faces, so never commit them.

| File | Purpose |
|------|---------|
| `slides.json` | Slide order, headline, accent words, subline, and the capture file for phone and tablet |
| `render.py` | Frames captures in a device mockup on the brand background at each store size (headless Chrome) |
| `anonymize.py` | Blurs other people's faces and removes last names from the raw captures |
| `feature_graphic.py` | Renders the 1024×500 Google Play feature graphic |
| `copy/apple/`, `copy/play/` | Listing text that is currently live (Play) or ready to paste (App Store) |

Requires Google Chrome in `/Applications` and Python 3 with Pillow.

## Output sizes

| Target | Size | Store slot |
|--------|------|------------|
| `ios-6.9` | 1320×2868 | App Store iPhone 6.9" (iPhone 17 Pro Max simulator captures at this size) |
| `ios-13` | 2064×2752 | App Store iPad 13" (iPad Pro 13-inch simulator captures at this size) |
| `play-phone` | 1080×1920 | Play phone screenshots |
| `play-tablet` | 1600×2560 | Play 10-inch tablet screenshots |

## Refreshing the screenshots

1. **Build a production-configured Release app for the simulator.** Development builds refuse to
   use the production Convex deployment, and real conversations only live there. A Release build
   with `APP_VARIANT=production` is allowed to use it, and it has no dev overlays:

   ```bash
   cd apps/mobile
   LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 APP_VARIANT=production EXPO_PUBLIC_APP_ENV=production \
     EXPO_PUBLIC_CONVEX_URL=https://ideal-akita-27.convex.cloud EXPO_PUBLIC_SEGMENT_MEDIA=1 \
     npx expo run:ios --configuration Release --device <iPhone 17 Pro Max udid> --no-bundler
   ```

   Install the same `.app` on the iPad Pro 13-inch simulator with `xcrun simctl install`.
   Leave `CRASHLYTICS_ENABLED` unset so the session doesn't report to production crash monitoring.

2. **Clean up the status bar and theme:**

   ```bash
   xcrun simctl status_bar <udid> override --time "9:41" --dataNetwork wifi --wifiMode active \
     --wifiBars 3 --cellularMode active --cellularBars 4 --batteryState charged --batteryLevel 100
   xcrun simctl ui <udid> appearance dark
   ```

3. **Sign in by hand** on each simulator with the account whose conversations you want to show.

4. **Capture** with `xcrun simctl io <udid> screenshot <file>.png` into a captures folder outside
   the repo. Video frames are easiest to catch with a burst loop of screenshots, then pick the
   best frame.

5. **Anonymize.** Update the `SPEC` coordinates in `anonymize.py` for the new captures. They are
   full-resolution pixel positions of other people's avatars and thumbnails, and of the text
   bands holding last names. Then run it. It also paints out the iPadOS window-resize grabber in
   the bottom-right corner of iPad captures.

6. **Render:**

   ```bash
   python3 -I scripts/store-assets/render.py scripts/store-assets/slides.json <caps> store-assets/out
   python3 -I scripts/store-assets/feature_graphic.py apps/mobile/assets/images/icon.png \
     store-assets/out/play/featureGraphic.png <hero capture> <second capture>
   ```

   Screens that are mostly empty on a 13" display (Spark, a camp with one thread) read poorly
   on iPad. Leave their `tablet` key out of `slides.json` to skip them for tablets.

## Uploading

**Google Play** uses fastlane supply with the service-account key in `apps/mobile`. Put the
images and `copy/play/*.txt` into the supply layout
(`metadata/en-US/{title,short_description,full_description}.txt`,
`metadata/en-US/images/{featureGraphic.png,phoneScreenshots/,tenInchScreenshots/}`). Validate
first, then upload by running the same command again without `validate_only:true`. Supply
replaces every existing screenshot of each type it uploads.

```bash
fastlane run upload_to_play_store package_name:org.bondfires \
  json_key:apps/mobile/google-services-key.json metadata_path:<metadata> \
  skip_upload_apk:true skip_upload_aab:true skip_upload_changelogs:true \
  track:internal validate_only:true
```

`track:internal` matters. The production track has no release yet, so supply fails there.

**App Store** has no App Store Connect API key set up for listing uploads, so upload by hand.
In App Store Connect, open the version page, then Previews and Screenshots. Drag in the
`ios-6.9` and `ios-13` folders in filename order, then paste each field from `copy/apple/`.

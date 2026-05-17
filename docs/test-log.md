# Bondfires Test Log

## 2026-05-16 17:16 ET - iOS Test Pass

Tester: Jake
Platform: iOS

### Results

- Sign up: Gmail received the email verification. Yahoo did not receive the email verification.
- Spark/Bondfire creation: Bondfire was created successfully and appeared in Discover, Recent, and Active.
- Feed timing: Newly created videos take about a minute to populate in activity lists.
- Camera switching: The flip camera button did not create a discernible change while recording.
- Playback/response: David's spark video could be viewed and responded to successfully.
- Navigation: Discover, Recent, Active, and Unseen tabs navigated correctly.
- Unseen feed: Unseen includes the tester's own videos.
- Search: Searching for creator "David" worked across all tabs.
- Settings: Stats, settings, bondfires, and delete account screens navigated as expected.
- Stats: Bondfires and Responses counts appeared correct, but Views stayed at zero after watching David's videos.
- Settings bondfire list: Tapping a Bondfire video on the settings page briefly highlights it orange but does not navigate or otherwise act.

### Follow-Up Items

- Investigate Yahoo email verification delivery.
- Add post-recording copy that sets expectations while Mux/video processing completes, e.g. "Awesome, great video! It may take up to two minutes for your video to show in your activity lists."
- Fix or clarify camera flip behavior during recording.
- Exclude the current user's own videos from Unseen.
- Verify view tracking and stats updates.
- Decide expected behavior for tapping Bondfire videos on the settings page, then implement or remove the tap affordance.

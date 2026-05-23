# Changelog

## v2.0.0 — Production rewrite (current)

This is a complete rewrite consolidating two earlier extensions, `twitter-auto-follow v1.0.1` and `X Follow Manager Elite v1.0.1`, into a single suite under a unified architecture. All UI was redesigned, all state machines were consolidated, and a class of queue-advancement bugs was fixed.

### New

- **Two complementary modes in one extension.** Profile-queue and list-walker share the same delay/cap/safety engine, the same analytics, and the same UI. Running one then the other does not double-count toward caps.
- **Unified safety engine.** Hourly + daily cap accounting, captcha/lockout detection, and the safety pulse score now live in `core/safetyEngine.js` and are shared across both modes.
- **Sparkline analytics.** A 14-day chart of daily follow counts on the dashboard, plus a clean "recent activity" feed.
- **Live safety pulse.** Both the popup and options page show the current 0–100 score and band, recomputed in real time as you change settings.
- **Centralized selectors.** All X.com DOM selectors live in `core/selectorEngine.js` with fallback chains. When X breaks one, we patch one file.
- **Atomic state mutations.** `mutateLocal(key, fn)` queues per-key updates on a promise chain, eliminating a race where two concurrent result writes could clobber each other.
- **Refined dark UI.** Linear / Notion / Raycast-inspired. Sidebar nav, scoped page transitions, custom timer ring, in-popup confirm and prompt dialogs (since Chrome popups can't use native modals), toast stack.
- **Light theme.** Toggleable from the popup top-bar; persisted in sync settings.
- **Standalone options page.** Full-window settings with the safety pulse hero, two-column layout, helper text on every row.
- **Manifest V3 ES module service worker.** Clean imports, no bundler needed.

### Changed

- **Queue advancement is now a single point.** Previously the legacy extension could re-enter the same handle if a script error happened mid-flow. v2 records a result and advances exactly once per iteration of `runProfileTick()`, regardless of outcome.
- **Snapshot pattern.** Popup makes one `GET_SNAPSHOT` call on open and listens to `chrome.storage.onChanged` for live updates. No polling.
- **Storage split.** Settings in `chrome.storage.sync` (cross-device); queue/results/logs/analytics in `chrome.storage.local` (per-device, hot data).
- **Filter set merged.** Profile-mode filters (min followers, max following, min posts) and walker-mode filters (verified, follows-you, has-bio, has-pic, smart score) are unified in one settings panel; each filter applies wherever the data is visible.
- **Pacing model.** Skewed-random delay, occasional bursts, scheduled long pauses, and warm-up mode are now part of one rate-limiter module rather than duplicated logic across the two source extensions.
- **Halt UI.** Sidebar dot turns red, top-bar shows the reason; the run can be resumed once the user clears the captcha or reloads x.com.

### Removed

- **Unfollow features.** The old extensions had unfollow modes; v2 is follow-only by design.
- **Monetization, telemetry, error reporting, external server calls.** None of these existed in the upstream projects, but to be explicit: v2 has none.
- **Hard-coded selectors duplicated in 3 files.** Replaced by `selectorEngine.js`.

### Fixed

- Queue could re-enter the same profile after a tab-script throw.
- A race where two concurrent result writes could lose one update.
- The popup could show stale data because nothing reactive was listening to storage changes.
- Pause-while-in-long-delay wasn't always honored if an alarm fired before the pause flag was checked.
- Walker continued to scroll when the user paused via the popup (now it parks at the current row).

### Migration notes

There is no automated migration from the upstream extensions. Disable / uninstall the old extension(s) before installing v2. Settings can be re-entered manually or imported from a JSON if you've previously exported one.

---

## Upstream

These versions predate this rewrite and are referenced here for credit:

### twitter-auto-follow v1.0.1 (upstream A)

- Profile-queue mode (paste handles, visit each profile in a tab).
- Background-driven scheduler with `chrome.alarms`.
- Human-click simulation (eased pointer trail, full pointer/mouse event sequence).
- Skewed-random delay, long-pause coffee breaks, burst chance, content-aware reading time.

### X Follow Manager Elite v1.0.1 (upstream B)

- List-walker mode (run on followers/following pages, walk rows, click inline Follow).
- Silent AudioContext keep-alive (defeats tab throttling).
- Wall-clock countdown (throttle-safe).
- Filters: verified, follows-you, follow-back ratio, bio keywords, smart-AI score with quality threshold 55.
- Safety pulse meter (0-100 score with bands STEALTH / BALANCED / AGGRESSIVE / RISKY / CRITICAL).

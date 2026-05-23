# Features

A complete tour of every feature in X Follow Grow v2.0.0.

## Modes

### Profile-queue mode

Paste a list of handles. The extension visits each profile in a managed tab, performs a human-like read, and clicks Follow.

- **Pasting:** the textarea accepts any mix of `@handle`, `username`, `https://x.com/username`, `https://twitter.com/username/...`, separated by commas, spaces, or newlines. Duplicates are automatically deduped.
- **Append vs replace:** **Load handles** replaces the queue; **Append to queue** adds to the existing queue (skipping handles already in it).
- **Extraction:** click **Extract from current tab** while you're on a followers/following/search page on x.com, and the active tab returns the visible handles to the popup. Or use **Extract from URL…** to fetch handles from any x.com URL the popup user pastes.
- **Per-profile workflow:** open the profile in a managed tab → run the read script (idle scroll, mouse jitter, lingering on bio) → run the follow-click script (find Follow button, full pointer/mouse event sequence with eased trail) → run the post-follow linger (random brief read, occasional bio re-scroll) → record the result → advance.
- **Recovery:** if the tab dies, the script throws, the SW catches, records `failed`, and advances to the next handle. No re-entry, no infinite loop.

### List-walker mode

Open any followers/following/search/hashtag/list-members page on x.com. The walker scrolls the visible list and clicks the inline Follow button on each row that passes your filters.

- **Row scanning:** uses `[data-testid="UserCell"]` with fallbacks to `[data-testid="cellInnerDiv"]` and generic `article`/`role="listitem"`.
- **Inline follow click:** finds the Follow button inside each row by aria-label, data-testid, and innerText fallbacks.
- **Auto-scroll:** when the visible row buffer empties, the walker scrolls down to load more.
- **Throttle-safe:** uses a wall-clock countdown (not `setInterval`) and a silent AudioContext to defeat tab-throttling, so the walker keeps working when the popup is closed and the tab is in the background.
- **Smart row filtering:** evaluates each row against your filter set (verified, has-bio, has-pic, smart score, follows-you, keywords) and skips rows that fail.

## Pacing

- **Skewed-random delay** between actions: log-normal distribution with a configurable `[min, max]` range. The mode of the distribution is around `min + (max-min)*0.35`, so most delays cluster on the short end with occasional long ones — much more human than uniform.
- **Burst chance:** with probability `burstChance` (default 0.08), an action uses a much shorter delay (1–4 s) — like when a real user is on a roll.
- **Long pauses (coffee breaks):** every `[longPauseAfterMin, longPauseAfterMax]` follows, a pause of `[longPauseMinSec, longPauseMaxSec]` seconds is inserted. Defaults: 10–20 follows → 3–7 minutes off.
- **Warm-up mode:** if enabled, doubles all delays for the first 24 hours of a session. Useful for new accounts or after a long break.

## Caps

- **Hourly cap:** stop the run if N follows happen in any rolling hour (default 30). Uses `actionHistory` timestamps in storage.local.
- **Daily cap:** same idea over a rolling 24h window (default 200).
- **Auto-halt sources:**
  - Captcha or "are you sure" prompt detected on the profile page.
  - Lockout / rate-limit page detected.
  - Hourly or daily cap reached.
  - Three consecutive `failed` results.
- **Halt UI:** sidebar dot turns red, top-bar shows "Halted: <reason>", desktop notification fires (if enabled).

## Filters

Available in both modes (when the data is visible):

| Filter | Default | Effect |
| --- | --- | --- |
| Skip private accounts | on | Won't follow protected/locked accounts |
| Skip "Follows you" | off | Skip accounts that already follow you (avoid double-follow loops) |
| Verified only | off | Walker: only follow blue-check accounts |
| Skip verified | off | Walker: never follow blue-check accounts |
| Require profile picture | off | Walker: skip default-avatar rows |
| Require bio | off | Walker: skip empty-bio rows |
| Min followers | 0 | Profile mode: skip < N followers |
| Max following | 0 | Profile mode: skip > N following |
| Min posts | 0 | Profile mode: skip < N posts |
| Follow-back filter | off | Require followers/following ≥ ratio |
| Min follow-back ratio | 0.5 | The required ratio (0.5 = balanced) |
| Smart scoring | off | Run a 0-100 heuristic and require ≥ threshold |
| Quality threshold | 55 | The score floor when smart scoring is on |
| Include keywords | "" | Bio must contain at least one (comma-separated) |
| Exclude keywords | "" | Skip if bio contains any (comma-separated) |
| Whitelist | [] | Never follow these handles (silent skip) |

### Smart score (0–100)

- Bio length (0–25 pts)
- Has profile picture (15 pts)
- Has bio (10 pts)
- Healthy follower/following ratio (0–25 pts)
- Verified (10 pts) or default avatar penalty (-15 pts)
- Display name realism (0–15 pts) — penalizes pure numbers, all-caps, hash-spam

## Safety pulse

A live 0–100 score reflecting the current pacing/cap/filter combo:

| Band | Score | Meaning |
| --- | --- | --- |
| STEALTH    | 80–100 | Stealthy rhythm — comfortable headroom against rate limits |
| BALANCED   | 60–79  | Suitable for daily use |
| AGGRESSIVE | 40–59  | Works in short bursts only |
| RISKY      | 20–39  | Rate limits become likely |
| CRITICAL   | 0–19   | Raise delays and lower caps |

The score is computed from the average and range of delays, hourly and daily caps, the long-pause schedule, warm-up mode, and a hard floor that punishes very low minimum delays. See `core/safetyEngine.js` for the formula.

## Analytics

- **Today:** followed / skipped / failed for the current day.
- **Last hour:** rolling-hour counter (drives hourly-cap accounting).
- **Last 24h:** rolling-24h counter.
- **Total ever:** all successful follows in the action history.
- **Success rate:** followed / (followed + failed) over all results.
- **14-day sparkline:** small inline chart of the last 14 days' followed counts.
- **Recent activity feed:** last 8 actions with status and time.

All persisted in `chrome.storage.local`. Reset via Settings → Reset analytics.

## UI

- **Dark + light theme.** Toggle via the popup top-bar or the options-page header. Theme is persisted in sync settings.
- **Sidebar nav.** Five pages: Dashboard / Queue / Discover / Settings / Logs. Active state shown by accent border-pseudo and emerald text.
- **Live timer.** When automation is running, the queue page shows a circular ring countdown to the next action and a digital MM:SS readout. Driven by `requestAnimationFrame`, no SW dependency.
- **Status indicator.** A pulsing dot at the bottom of the sidebar mirrors `runtime`: emerald (running), amber (paused), red (halted), faint (idle).
- **Toast feedback.** Every action shows a 2.4s toast at the bottom (success / warn / error / info colors).
- **Confirm + prompt dialogs.** Modal in-popup, no native `confirm()`/`prompt()` (Chrome popups don't allow them).
- **Stagger-in animations.** Cards fade up in sequence on page open, with a 200ms ease.
- **Scrollbar styling.** Slim, subtle, themed.

## Settings

- **Live save.** Every input change persists immediately to sync storage. No "Save" button.
- **Live pulse update.** As you tweak delays/caps/filters, the safety pulse score recomputes in real time on the options page hero.
- **Import / export.** JSON file of the entire settings blob. Useful for backup or sharing tuning between accounts.
- **Reset analytics.** Wipes activity history, results, and daily counters. Settings preserved.
- **Reset all settings.** Restores defaults. Analytics and queue preserved.

## Activity log

- **Last 250 entries.** Levels: debug, info, warn, error.
- **Mono font.** Easy to scan.
- **Clear button.** With confirmation.
- **Persistent.** Survives popup close, browser restart.

## Notifications

Optional desktop notifications (toggle in Settings):

- **Run complete:** "Followed N accounts."
- **Safety halt:** "Automation halted: <reason>."

## Privacy

- All data in your browser (`storage.sync` for settings, `storage.local` for everything else).
- Network access limited to x.com / twitter.com via host permissions.
- No analytics, no telemetry, no error reporting.
- Settings export to JSON gives you full data portability.

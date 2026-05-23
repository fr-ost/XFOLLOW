# X Follow Grow

> A premium, production-grade auto-follow extension for X (Twitter). Modular Manifest V3 architecture, intelligent queue, smart filters, human-like safety engine, and a live analytics dashboard.

**Version:** 2.0.1  
**Manifest:** v3  
**Follow only.** No unfollow features. No monetization. No telemetry. No external servers.

---

## Why this exists

We rebuilt two earlier extensions from scratch to merge their best ideas into one clean, dependable suite:

- **Profile-queue mode** (paste a list of `@handles`, the extension visits each profile, reads the page like a human, and clicks Follow). Inherited and improved from `twitter-auto-follow v1.0.1`.
- **List-walker mode** (open any followers / following / search / hashtag page on x.com, the walker scrolls and clicks inline Follow buttons that pass your filters). Inherited and improved from `X Follow Manager Elite v1.0.1`.

The new architecture removes the duplicated state machines, fixes a class of bugs around queue advancement, centralizes the X.com selector strategies, and gives both modes a unified safety pulse, analytics, and persistent settings.

---

## Highlights

- **Two complementary modes.** Use whichever fits the source — paste a list of curated handles, or walk a live page on x.com.
- **Human-like rhythm.** Skewed-random delays, occasional bursts, scheduled coffee breaks, and warm-up mode for new accounts.
- **Smart filters.** Skip protected, verified, no-bio, no-pic, low-quality, or unbalanced-ratio accounts. Bio keyword include/exclude lists. Optional 0–100 quality score with a configurable threshold.
- **Safety pulse.** Live 0–100 score reflecting your current pacing/cap/filter combo, classified into STEALTH / BALANCED / AGGRESSIVE / RISKY / CRITICAL bands.
- **Caps + auto-halt.** Hourly and daily caps, plus automatic halt on captcha, lockout, or rate-limit indicators.
- **Live dashboard.** Today's followed/skipped/failed, last-hour count, success rate, 14-day sparkline, and recent activity feed.
- **Persistent state.** Settings sync across your Chrome profile (`chrome.storage.sync`); queue/results/logs survive browser restarts and SW idle (`chrome.storage.local` + `chrome.alarms`).
- **Whitelist.** Handles you never want to follow — silently skipped.
- **Activity log.** Last 250 entries with level filtering. Exportable.
- **Import / export settings.** JSON, portable across devices.
- **Refined dark UI.** Linear / Notion / Raycast-inspired. Light theme included.

See `docs/FEATURES.md` for the complete list.

---

## Install

Quick version:

```
1. Download or clone this repo.
2. Visit chrome://extensions and enable "Developer mode" (top-right).
3. Click "Load unpacked" and select the `x-follow-suite/` folder.
4. Pin the extension to your toolbar.
5. Open x.com and click the X Follow Grow icon.
```

Full instructions in `docs/INSTALL.md`.

---

## Usage

### Profile-queue mode

1. Open the popup.
2. Go to the **Queue** tab.
3. Paste handles into the textarea — `@one, @two`, or one per line, or whole tweet/profile URLs (the parser is forgiving).
4. Click **Load handles**. Or use **Extract from current tab** when you're on a relevant x.com page, or **Extract from URL…** to fetch handles from a URL.
5. Click **Start queue** in the bottom action bar.

The extension opens each profile in a managed tab, performs a human-like read (scroll, linger, occasional cursor move), then clicks Follow. Between actions it waits a randomized delay; periodically it takes a "coffee break". You can pause, resume, or stop at any time. State is saved continuously, so closing the popup or restarting Chrome won't lose progress.

### List-walker mode

1. Open a followers, following, search, or hashtag page on x.com.
2. Open the popup and go to the **Discover** tab.
3. Tweak quick filters (verified, has-bio, has-pic, smart score, keywords).
4. Click **Start walker**.

The walker scrolls the visible list, evaluates each row against your filters, and clicks the inline Follow button when eligible. It uses the same delay rules as profile mode and respects the same hourly/daily caps.

### Settings

Click the gear icon in the popup, or right-click the extension and choose **Options** for the full-page settings view with the live safety-pulse hero. Every change is saved instantly and synced across your Chrome profile.

---

## Architecture (high level)

```
┌──────────────────────────────────────────────────────────┐
│                    Service Worker (MV3)                  │
│  ─ Profile-queue runner (alarms-based scheduler)         │
│  ─ Walker coordinator (counts toward shared caps)        │
│  ─ Safety gate (caps, captcha, lockout)                  │
│  ─ Single message API for popup/options/content scripts  │
└────────────┬─────────────────────────────┬───────────────┘
             │                             │
   chrome.tabs.executeScript        chrome.tabs.sendMessage
             │                             │
             ▼                             ▼
   ┌─────────────────┐           ┌───────────────────────┐
   │ Profile-mode    │           │ Content script        │
   │ in-page         │           │ (list-walker, helpers)│
   │ functions:      │           │                       │
   │  read, follow,  │           │  scroll, scan rows,   │
   │  linger, scroll │           │  filter, click follow │
   └─────────────────┘           └───────────────────────┘
```

`docs/ARCHITECTURE.md` has module-level diagrams and the message catalog.

---

## Privacy & data

- All data lives in your browser. The extension never makes outbound requests except to x.com itself (and only when you trigger an extraction from a URL you provide).
- Settings are stored in `chrome.storage.sync` (synced across your Chrome profile via your Google account if sync is on).
- Queue, results, logs, and analytics are stored in `chrome.storage.local` (this device only).
- No analytics, no telemetry, no error reporting.

---

## Disclaimers

This extension automates a manual user action. It does not bypass authentication, scrape protected data, or interact with X's private API. Even so, X's Terms of Service and rate limits apply — use responsibly. The defaults are tuned to be conservative and "human-paced", but you are responsible for the settings you choose. We don't recommend running it on accounts you can't afford to lose.

---

## License

MIT. See LICENSE for details.

---

## Credits

Built by combining and rewriting:

- twitter-auto-follow v1.0.1 — profile-queue mode, human-click simulation, alarms-based scheduling
- X Follow Manager Elite v1.0.1 — list-walker mode, smart scoring, safety pulse meter

Both upstream projects deserve credit for the original designs; this rewrite consolidates them under a single architecture.

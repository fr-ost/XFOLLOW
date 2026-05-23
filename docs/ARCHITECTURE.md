# Architecture

This document describes how X Follow Grow v2.0.0 is organized, how data flows between the parts, and the contracts that hold the modules together.

## Birds-eye

```
                                ┌────────────────────────────┐
                                │   Manifest V3 (chrome ext)  │
                                └────────────┬────────────────┘
                                             │
   ┌─────────────────┐    chrome.runtime    ┌─┴──────────────────┐
   │     Popup       │◀───── messages ─────▶│   Service Worker   │
   │   ui/pages/     │                      │   core/serviceWor- │
   │   popup.{html,  │                      │   ker.js (module)  │
   │   js,css}       │                      └─┬──────────────────┘
   └─────────────────┘                        │
   ┌─────────────────┐                        │
   │   Options page  │◀── chrome.runtime ────▶│
   │   ui/pages/     │     messages           │
   │   options.{...} │                        │
   └─────────────────┘                        │
                                              │ chrome.tabs
                                              │ .executeScript
                                              │ .sendMessage
                                              ▼
                                  ┌──────────────────────────┐
                                  │   Content script         │
                                  │   features/follow/       │
                                  │   contentScript.js       │
                                  │   (injected into x.com)  │
                                  └──────────────────────────┘
```

## Module map

```
core/
├── serviceWorker.js   - top-level orchestrator, message router, alarms,
│                        profile-queue runner, walker coordinator.
├── storage.js         - DEFAULT_SETTINGS / DEFAULT_RUNTIME, mutateLocal
│                        per-key promise chain, sync vs local split.
├── logger.js          - structured log entries (level/time/msg) capped
│                        at 250 in storage.local, plus console mirror.
├── safetyEngine.js    - hourly/daily cap accounting, captcha/lockout
│                        detection, computeSafetyScore + bands.
├── rateLimiter.js     - delay computation: skewed random, burst chance,
│                        long-pause cycles, warm-up halving.
├── selectorEngine.js  - centralized X.com selectors with fallback
│                        chains; serializable in-page inspectProfileState
│                        for executeScript.
├── queueManager.js    - queue I/O, atomic advance(), recordResult,
│                        getQueueSnapshot for the popup.
└── analytics.js       - daily rollups, dashboard stats, sparkline data,
                         clearAnalytics.

features/follow/
└── contentScript.js   - list-walker state machine: scan rows, apply
                         filters, click follow inline, scroll to load
                         more. Plus EXTRACT_HANDLES, GET_PROFILE,
                         GET_CONTEXT message handlers.

services/
├── tabManager.js      - getOrCreateXTab, gotoProfile, runInTab.
└── xDomService.js     - readProfileFn, followClickFn, postFollowLingerFn,
                         scrollDuringWaitFn — all SERIALIZABLE for use
                         with chrome.scripting.executeScript.

utils/
├── randomizer.js      - skewedDelay (lognormal), randInt, gaussian.
├── delays.js          - sleep, jitter helpers.
├── retry.js           - retryWithBackoff for tab/script ops.
└── parser.js          - extractHandles from any text/URL blob;
                         normalizeHandle, isValidHandle.

ui/
├── styles/
│   ├── theme.css      - design tokens, base components (.btn, .input,
│   │                    .card, .switch, .tag), light theme override.
│   ├── popup.css      - popup chrome (sidebar, pages, stats, timer,
│   │                    queue list, log list, toast, dialog).
│   └── options.css    - full-page options layout.
└── pages/
    ├── popup.html     - 420×580 popup, sidebar nav across 5 pages.
    ├── popup.js       - controller: GET_SNAPSHOT on open + storage
    │                    onChanged listener, no polling.
    ├── options.html   - full-window settings with safety pulse hero.
    └── options.js     - settings controller: live save + live pulse.

manifest.json
icons/
docs/
```

## State storage

State is split across two namespaces:

### `chrome.storage.sync` — Settings (cold, cross-device)

Holds user preferences that should follow them between devices. Defined by `DEFAULT_SETTINGS` in `core/storage.js`. Examples: `minDelaySec`, `hourlyCap`, `qualityThreshold`, `whitelist`, `theme`.

Sync storage has hard limits (~100 KB total, ~8 KB per item, ~512 keys). We stay well under.

### `chrome.storage.local` — Runtime (hot, per-device)

Holds the moment-to-moment state. Fields:

- `runtime` — see `DEFAULT_RUNTIME`. Single document holding `isRunning`, `mode`, `queue`, `queueIndex`, `nextActionAt`, `currentDelayMs`, `safetyHalted`, etc.
- `results` — chronological array of `{handle, status, time, error?}`. Capped at 1000.
- `actionHistory` — array of timestamps for every successful follow, used by `safetyEngine` for cap accounting.
- `analytics.daily` — rollup of `{date, followed, skipped, failed}` per day. Capped at 14 days.
- `log` — structured log entries `{t, level, msg}`, capped at 250.

### Atomic mutations

Every write to `chrome.storage.local` for a known key (`runtime`, `results`, `log`, `actionHistory`, `analytics.daily`) goes through `mutateLocal(key, fn)` in `core/storage.js`, which queues per-key updates on a promise chain. This prevents a class of races where two concurrent `recordResult` calls each read the old value, mutate, and write — losing one update.

## Message catalog

All popup/options ↔ SW IPC happens via `chrome.runtime.sendMessage`. The content script also uses `chrome.runtime.sendMessage` to ping the SW, and accepts `chrome.tabs.sendMessage` from the popup directly.

### Popup → SW

| Type | Payload | Returns |
| --- | --- | --- |
| `START_PROFILE_QUEUE` | `{opts?}` | `{ok}` |
| `PAUSE` | — | `{ok}` |
| `RESUME` | — | `{ok}` |
| `STOP` | — | `{ok}` |
| `RESET` | — | `{ok}` (clears local) |
| `RESET_SETTINGS` | — | `{ok}` (clears sync settings) |
| `RESET_ANALYTICS` | — | `{ok}` |
| `LOAD_HANDLES` | `{handles[], source}` | `{ok, count}` |
| `APPEND_HANDLES` | `{handles[], source}` | `{ok, count}` |
| `CLEAR_QUEUE` | — | `{ok}` |
| `EXTRACT_FROM_URL` | `{url}` | `{ok, handles}` |
| `EXTRACT_CURRENT_TAB` | — | `{ok, handles}` |
| `GET_SNAPSHOT` | — | `{ok, runtime, settings, queue, dashboard, safety, daily, log}` |
| `SET_SETTINGS` | `{settings}` | `{ok}` |
| `CLEAR_LOG` | — | `{ok}` |

### Popup → Content script (direct)

| Type | Returns |
| --- | --- |
| `GET_CONTEXT` | `{context: {kind, path}, profile}` |
| `GET_PROFILE` | `{profile}` |
| `EXTRACT_HANDLES` | `{handles[]}` |
| `WALKER_START` | `{ok}` |
| `WALKER_PAUSE` | `{ok}` |
| `WALKER_RESUME` | `{ok}` |
| `WALKER_STOP` | `{ok}` |
| `WALKER_STATUS` | `{ok, status}` |

### Content script → SW

| Type | Effect |
| --- | --- |
| `WALKER_FOLLOWED` | `{username, sourceUrl}` — increments shared counters |
| `WALKER_HALT` | `{reason}` — propagates safety halt to SW state |
| `WALKER_STOPPED` | `{reason, followed}` — final report |
| `CHECK_CAPS` | returns `{halt: boolean, reason}` |

## The single advance point

The most common bug pattern in earlier extensions was "loops on the same profile". v2 enforces a single rule: **the queue index is incremented in exactly one place**, after the result for the current item has been recorded. Specifically `queueManager.advance()`, called once at the end of every iteration of `runProfileTick()` in the service worker, regardless of whether the iteration ended in `followed`, `already`, `unavailable`, or `failed`.

If a tab dies mid-script, `runInTab` throws, the SW catches, records the result as `failed`, advances, and schedules the next item. There is no path where we re-enter the same item without recording a result.

## Snapshot pattern

The popup never polls. On open it fires one `GET_SNAPSHOT` message — which the SW satisfies by parallel-reading runtime, settings, queue, dashboard, history stats, daily rollup, and log. The popup renders all panels from this single snapshot.

After that the popup attaches `chrome.storage.onChanged.addListener(refresh)`. Any storage write (cap counter increment, result push, settings change) triggers a debounced re-render. This means:

- Zero polling overhead.
- The popup is always in sync with the SW state, even across multiple windows.
- The timer countdown is a pure local `requestAnimationFrame` — it's not driven by the SW at all, just the most recent `runtime.nextActionAt` and `runtime.currentDelayMs` from the snapshot.

## Selector strategy

X.com renames its DOM selectors regularly. Every selector we use lives in `core/selectorEngine.js` as part of a fallback chain. For example:

```js
FOLLOW_BUTTON: [
  '[data-testid$="-follow"]',                       // primary stable
  'div[role="button"][aria-label^="Follow @"]',     // aria fallback
  'button[aria-label^="Follow @"]',
  // ... text-based last resort
]
```

The walker's `findFollowButtonInRow()` and the profile mode's `inspectProfileStateFn()` both consult these chains. When X breaks one, we patch a single file.

## Why two modes

Profile-queue and list-walker complement each other:

- Profile mode is great for **curated lists** (paste 200 specific handles you've decided to follow). It also visits the profile, which helps trigger first-impression heuristics on X's side.
- Walker mode is great for **discovery** (paste no handles — just open someone's followers list and walk it). It's faster (no tab spawn per follow) and its filters can use list-row-only signals like the inline "Follows you" badge.

Both modes share the same delay/cap/safety engine via the SW, so caps are global — running walker for 20 minutes then switching to profile mode will not double up the daily cap.

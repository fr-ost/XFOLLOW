/**
 * storage.js
 *
 * Single, typed gateway to chrome.storage. Two areas:
 *
 *   - LOCAL: hot, mutable, large. Holds the queue, results, logs, analytics.
 *     These are modified often (every follow) and would push storage.sync
 *     past its quotas in seconds.
 *
 *   - SYNC:  cold, small, user-facing config. Holds settings the user wants
 *     to roam across devices (delays, filters, theme).
 *
 * The `mutate(key, fn)` helper does a read-modify-write under a per-key
 * promise chain so two awaited mutations can't trample each other. Without
 * this, two near-simultaneous `recordFollow()` calls would both read the
 * same baseline and one would clobber the other.
 *
 * Default values live in DEFAULTS_* exports; treat them as the schema.
 */

// ─── Schema / defaults ──────────────────────────────────────────────

export const DEFAULT_SETTINGS = Object.freeze({
  // ─ Pacing
  minDelaySec: 35,
  maxDelaySec: 90,
  minSkipDelaySec: 1,
  maxSkipDelaySec: 3,

  // ─ Daily / hourly safety caps
  hourlyCap: 30,
  dailyCap: 200,

  // ─ Long pause cycle
  longPauseAfterMin: 10,
  longPauseAfterMax: 20,
  longPauseMinSec: 180,
  longPauseMaxSec: 420,

  // ─ Burst probability (occasionally fast follows feel human)
  burstChance: 0.08,

  // ─ Warmup mode: first day, halve everything
  warmupMode: false,

  // ─ Filters (apply to list-walker mode)
  skipVerified: false,
  verifiedOnly: false,
  skipProtected: true,
  skipFollowsMe: false,
  requireProfilePicture: false,
  requireBio: false,

  // ─ Engagement filters
  minFollowers: 0,
  maxFollowers: 0,
  maxFollowing: 0,
  minPosts: 0,

  // ─ Smart selection
  smartScoring: false,
  qualityThreshold: 55,

  // ─ Bio keyword filters
  includeKeywords: '',
  excludeKeywords: '',

  // ─ Follow-back ratio (followers / following)
  followBackFilter: false,
  minFollowRatio: 0.5,

  // ─ Notifications & UX
  notifyOnComplete: true,
  notifyOnSafety: true,
  soundOnFollow: false,
  theme: 'dark',

  // ─ Whitelist (handles to never click follow on, even if matched)
  whitelist: [],

  // ─ Maintenance
  reloadOnStop: false,
});

export const DEFAULT_RUNTIME = Object.freeze({
  // ─ Lifecycle flags
  isRunning: false,
  isPaused: false,
  mode: 'idle',           // 'idle' | 'profile-queue' | 'list-walker'
  startedAt: null,
  completedAt: null,

  // ─ Queue (profile-queue mode only)
  queue: [],              // array of { handle, addedAt, source, priority }
  queueIndex: 0,
  queueSize: 0,

  // ─ Per-session counters
  sessionFollowed: 0,
  sessionSkipped: 0,
  sessionFailed: 0,
  followsSinceLongPause: 0,
  nextLongPauseAt: null,

  // ─ Schedule
  nextActionAt: null,
  currentDelayMs: 0,
  timerLabel: '',

  // ─ Last action
  lastHandle: '',
  lastStatus: '',

  // ─ Currently scanning / following profile (for live UI preview)
  currentProfile: null,   // { handle, displayName, avatarUrl, bio, verified, status, at }

  // ─ Logged-in user (extracted from X page)
  loggedInProfile: null,  // { name, handle, avatar }

  // ─ Walker context
  walkerPageKind: '',
  walkerPageUrl: '',

  // ─ Safety state
  safetyHalted: false,
  safetyReason: '',
});

// ─── Mutation queue per key ─────────────────────────────────────────

const _chains = new Map();

function chained(key, fn) {
  const prev = _chains.get(key) || Promise.resolve();
  const next = prev.then(fn, fn);
  // Always clear chain even on rejection so a single throw can't poison the key
  _chains.set(key, next.catch(() => {}));
  return next;
}

// ─── Local storage helpers (queue, results, logs, analytics) ────────

export async function getLocal(keys) {
  return chrome.storage.local.get(keys);
}

export async function setLocal(patch) {
  return chrome.storage.local.set(patch);
}

export async function mutateLocal(key, fn, fallback) {
  return chained('L:' + key, async () => {
    const data = await chrome.storage.local.get(key);
    const current = data[key] === undefined ? fallback : data[key];
    const next = await fn(current);
    if (next !== undefined) await chrome.storage.local.set({ [key]: next });
    return next;
  });
}

export async function clearLocal() {
  return chrome.storage.local.clear();
}

// ─── Settings (storage.sync, with full defaults applied) ────────────

export async function getSettings() {
  const stored = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  // Defensive: ensure every key from DEFAULT_SETTINGS exists, even if older
  // schemas missed some.
  return { ...DEFAULT_SETTINGS, ...stored };
}

export async function setSettings(patch) {
  return chrome.storage.sync.set(patch);
}

export async function resetSettings() {
  await chrome.storage.sync.clear();
  await chrome.storage.sync.set(DEFAULT_SETTINGS);
}

// ─── Runtime (the moment-to-moment state of automation) ─────────────

export async function getRuntime() {
  const stored = await chrome.storage.local.get(DEFAULT_RUNTIME);
  return { ...DEFAULT_RUNTIME, ...stored };
}

export async function setRuntime(patch) {
  return chrome.storage.local.set(patch);
}

/**
 * serviceWorker.js
 *
 * The top-level orchestrator. Imports every core module and exposes a
 * single message API to the popup / options / content script.
 *
 * Responsibilities:
 *
 *   1. PROFILE-QUEUE RUNNER
 *      Drives the "paste-a-list" automation flow: opens each handle in a
 *      tab, runs the read/click/linger phases, records results, schedules
 *      the next item via chrome.alarms (so the SW can sleep between long
 *      delays without losing state).
 *
 *   2. SAFETY GATE
 *      Every iteration checks: are we halted? have we hit the daily/hourly
 *      cap? did the last page show a captcha or lockout? Any hit halts
 *      automation and surfaces a notification.
 *
 *   3. BADGE & NOTIFICATIONS
 *      Live badge: 'ON' (running), 'II' (paused), '!' (halted), '✓' (done).
 *
 *   4. RECOVERY
 *      onStartup / onInstalled re-attaches alarms so a browser restart in
 *      the middle of a long delay resumes correctly.
 *
 *   5. WALKER COORDINATION
 *      The list-walker (content script) reports follows back to us so the
 *      daily/hourly cap accounting stays consistent across both modes.
 *
 * Module imports use the ES module SW (manifest "type": "module").
 */

import {
  getRuntime, setRuntime,
  getSettings, getLocal, setLocal, resetSettings,
  DEFAULT_SETTINGS,
} from './storage.js';

import {
  log, logInfo, logSuccess, logWarn, logError, clearLog,
} from './logger.js';

import {
  recordFollowAction, getHistoryStats, checkCaps,
  halt, clearHalt, isHalted, inspectPageForLocksFn,
  computeSafetyScore,
} from './safetyEngine.js';

import {
  computeNextDelay, resetPacing,
} from './rateLimiter.js';

import {
  setQueue, appendToQueue, peekCurrent, advance,
  recordResult, clearQueue, getQueueSnapshot, isExhausted,
  incrementAttempts,
} from './queueManager.js';

import {
  recordDaily, getDashboardStats, getDailyRollup, clearAnalytics,
} from './analytics.js';

import { extractHandles } from '../utils/parser.js';
import { sleep } from '../utils/delays.js';
import { randInt } from '../utils/randomizer.js';

import {
  getOrCreateXTab, gotoProfile, runInTab, findXTab,
} from '../services/tabManager.js';

import {
  inspectProfileStateFn,
} from './selectorEngine.js';

import {
  readProfileFn, followClickFn, postFollowLingerFn,
  scrollDuringWaitFn,
} from '../services/xDomService.js';

// ─── Constants ─────────────────────────────────────────────────────

const ALARM_NEXT = 'xfs.next';
const POST_LOAD_MIN_MS = 2200;
const POST_LOAD_MAX_MS = 5800;
const READ_PHASE_ARGS = {
  baseMin: 2000, baseMax: 5000,
  contentMin: 5000, contentMax: 25000,
  jitterMin: -1500, jitterMax: 2500,
};
const NOISE_CHANCE_LINGER = 0.6;
const WAIT_SCROLL_MAX_MS = 60_000;
const ALARM_CUTOFF_MS = 30_000; // delays >=30s use alarms; smaller use setTimeout

// ─── Badge helpers ─────────────────────────────────────────────────

async function setBadge(text, color) {
  try {
    await chrome.action.setBadgeText({ text });
    if (color) await chrome.action.setBadgeBackgroundColor({ color });
    if (chrome.action.setBadgeTextColor) {
      await chrome.action.setBadgeTextColor({ color: '#ffffff' });
    }
  } catch (_) {}
}
const badgeRunning = () => setBadge('ON', '#10b981');
const badgePaused  = () => setBadge('II', '#f59e0b');
const badgeHalted  = () => setBadge('!',  '#dc2626');
const badgeDone    = () => setBadge('✓',  '#3b82f6');
const badgeClear   = () => setBadge('',   '#000000');

// ─── Profile-queue runner ──────────────────────────────────────────

/**
 * Process the queue item at runtime.queueIndex, then schedule the next.
 * This function is the SINGLE re-entry point for the queue loop. Every
 * recursive path (initial start, alarm fire, setTimeout, manual resume)
 * eventually arrives here. The "advance the index exactly once per item"
 * invariant is enforced inside this function.
 */
async function processNext() {
  const r = await getRuntime();
  if (!r.isRunning || r.isPaused) return;
  if (r.safetyHalted) return;

  // Cap check up-front
  const settings = await getSettings();
  const cap = await checkCaps(settings);
  if (!cap.allowed) {
    await logWarn(cap.reason);
    await scheduleAfterMs(cap.retryAfterMs || 60_000, 'cap-wait');
    return;
  }

  // Exhausted?
  if (await isExhausted()) {
    return finishSession();
  }

  const item = await peekCurrent();
  if (!item) return finishSession();

  const idx = r.queueIndex || 0;
  const total = (r.queue && r.queue.length) || 0;
  await setRuntime({ nextActionAt: null, currentDelayMs: 0, lastHandle: item.handle });
  await logInfo(`→ @${item.handle} (${idx + 1}/${total})`);

  let lastStatus = 'failed';
  let detail = '';

  try {
    const result = await processOneProfile(item.handle);
    lastStatus = result.status;
    detail = result.detail || '';
  } catch (err) {
    lastStatus = 'failed';
    detail = err.message;
    await logError(`✗ @${item.handle} — ${err.message}`);
  }

  // Special: safety lock detected on page → halt everything
  if (lastStatus === 'safety_halt') {
    await recordResult(item.handle, 'safety_halt', detail);
    await halt(detail || 'rate_limit');
    return;
  }

  // Special: login required → halt with friendly message
  if (lastStatus === 'login_required') {
    await recordResult(item.handle, 'login_required', detail);
    await halt('Login required — sign in to X and try again.');
    return;
  }

  // For 'click_no_effect' or 'button_not_found' on first attempt, retry once.
  if ((lastStatus === 'button_not_found' || lastStatus === 'click_no_effect') && (item.attempts || 0) < 1) {
    const canRetry = await incrementAttempts();
    if (canRetry) {
      await logWarn(`↻ Retrying @${item.handle}`);
      // Don't advance — schedule a short retry
      await scheduleAfterMs(randInt(2_500, 4_000), 'retry');
      return;
    }
  }

  // Record + ALWAYS advance
  await recordResult(item.handle, lastStatus, detail);

  if (lastStatus === 'followed') {
    await recordFollowAction();
    await recordDaily('followed');
  } else if (lastStatus === 'already_following' || lastStatus === 'unavailable') {
    await recordDaily('skipped');
  } else {
    await recordDaily('failed');
  }

  await advance();
  await scheduleNext(lastStatus);
}

/**
 * Open the handle's profile, read it, click Follow, linger.
 * Returns { status, detail? }.
 */
async function processOneProfile(handle) {
  // 1. Open
  const tabId = await getOrCreateXTab();
  const nav = await gotoProfile(tabId, handle);
  if (!nav.ok) return { status: 'failed', detail: nav.error };

  // Brief settle delay (smooth animations / lazy images)
  await sleep(randInt(POST_LOAD_MIN_MS, POST_LOAD_MAX_MS));

  // 2. Lock detection FIRST (before any clicking)
  const lockCheck = await runInTab(tabId, inspectPageForLocksFn);
  if (lockCheck.ok && lockCheck.result && lockCheck.result.lock) {
    return { status: 'safety_halt', detail: lockCheck.result.kind || 'lock_detected' };
  }

  // 3. State check (already following / unavailable / login required)
  const state = await runInTab(tabId, inspectProfileStateFn);
  const ps = state.ok ? state.result : { status: 'ready' };
  if (ps && ps.status === 'login_required') return { status: 'login_required' };
  if (ps && ps.status === 'unavailable') return { status: 'unavailable', detail: ps.detail };
  if (ps && ps.status === 'already_following') return { status: 'already_following' };

  // 4. Read phase (content-aware dwell + scroll)
  await runInTab(tabId, readProfileFn, [READ_PHASE_ARGS]);

  // 5. Lock check AGAIN (X often shows the captcha after a delay)
  const lockCheck2 = await runInTab(tabId, inspectPageForLocksFn);
  if (lockCheck2.ok && lockCheck2.result && lockCheck2.result.lock) {
    return { status: 'safety_halt', detail: lockCheck2.result.kind };
  }

  // 6. Click phase
  const clickRes = await runInTab(tabId, followClickFn);
  const cr = clickRes.ok ? clickRes.result : null;
  if (!cr) return { status: 'failed', detail: clickRes.error || 'click_exec_failed' };

  // Lock check AFTER click (X may show the lock dialog post-click)
  if (cr.status === 'followed' || cr.status === 'click_no_effect') {
    const lockCheck3 = await runInTab(tabId, inspectPageForLocksFn);
    if (lockCheck3.ok && lockCheck3.result && lockCheck3.result.lock) {
      return { status: 'safety_halt', detail: lockCheck3.result.kind };
    }
  }

  // 7. Post-follow linger (only on successful follows)
  if (cr.status === 'followed' && Math.random() < NOISE_CHANCE_LINGER) {
    await runInTab(tabId, postFollowLingerFn);
  }

  return cr;
}

/**
 * Schedule the next iteration after the appropriate delay.
 * Long delays (>= 30s) use chrome.alarms so the SW can be terminated
 * and reawakened. Shorter delays use setTimeout (alarms have 30s minimum
 * granularity in production builds).
 */
async function scheduleNext(lastStatus) {
  const r = await getRuntime();
  if (!r.isRunning || r.isPaused) return;
  if (await isExhausted()) return finishSession();

  const settings = await getSettings();
  const { delayMs, kind } = await computeNextDelay(settings, lastStatus);

  const nextAt = Date.now() + delayMs;
  await setRuntime({ nextActionAt: nextAt, currentDelayMs: delayMs });

  let label;
  switch (kind) {
    case 'long-pause': label = `☕ Coffee break (${Math.round(delayMs / 1000)}s)`; break;
    case 'burst':       label = `⚡ Quick burst (${Math.round(delayMs / 1000)}s)`; break;
    case 'skip':        label = `⏩ Skip (${(delayMs / 1000).toFixed(1)}s)`; break;
    default:            label = `⏱ Next in ${Math.round(delayMs / 1000)}s`;
  }
  await logInfo(label);

  // Run the natural-scroll on the X tab during the wait (decoration only)
  if (delayMs >= 2000 && lastStatus === 'followed') {
    triggerWaitScroll(Math.min(delayMs - 500, WAIT_SCROLL_MAX_MS));
  }

  await scheduleAfterMs(delayMs, 'next');
}

async function scheduleAfterMs(delayMs, _reason) {
  const nextAt = Date.now() + delayMs;
  await setRuntime({ nextActionAt: nextAt, currentDelayMs: delayMs });
  if (delayMs >= ALARM_CUTOFF_MS) {
    await chrome.alarms.create(ALARM_NEXT, { when: nextAt });
  } else {
    setTimeout(() => { processNext().catch(console.error); }, delayMs);
  }
}

async function triggerWaitScroll(durationMs) {
  try {
    const tab = await findXTab();
    if (!tab) return;
    chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: scrollDuringWaitFn,
      args: [durationMs],
      world: 'MAIN',
    }).catch(() => {});
  } catch (_) {}
}

async function finishSession() {
  const r = await getRuntime();
  await setRuntime({
    isRunning: false,
    isPaused: false,
    completedAt: Date.now(),
    nextActionAt: null,
    currentDelayMs: 0,
  });
  const f = r.sessionFollowed || 0;
  const s = r.sessionSkipped || 0;
  const fe = r.sessionFailed || 0;
  await logSuccess(`✅ Session complete — ${f} followed, ${s} skipped, ${fe} failed`);
  await badgeDone();
  const settings = await getSettings();
  if (settings.notifyOnComplete) {
    try {
      chrome.notifications.create({
        type: 'basic',
        iconUrl: chrome.runtime.getURL('icons/icon128.png'),
        title: 'X Follow Grow — Complete',
        message: `Session complete: ${f} followed, ${s} skipped, ${fe} failed.`,
      });
    } catch (_) {}
  }
}

// ─── Lifecycle commands ────────────────────────────────────────────

async function cmdStartProfileQueue(opts = {}) {
  await chrome.alarms.clearAll();
  const settings = { ...(await getSettings()), ...opts };
  if (opts && Object.keys(opts).length) {
    // Persist any settings the user passed inline (delays etc)
    await chrome.storage.sync.set(opts);
  }

  await clearHalt();
  await resetPacing();
  await setRuntime({
    isRunning: true,
    isPaused: false,
    mode: 'profile-queue',
    startedAt: Date.now(),
    completedAt: null,
    queueIndex: 0,
    sessionFollowed: 0,
    sessionSkipped: 0,
    sessionFailed: 0,
    nextActionAt: null,
    currentDelayMs: 0,
    safetyHalted: false,
    safetyReason: '',
  });

  const r = await getRuntime();
  await logInfo(`▶ Profile queue started — ${(r.queue || []).length} in queue`);
  await badgeRunning();
  processNext().catch(console.error);
  return { ok: true };
}

async function cmdPause() {
  await chrome.alarms.clearAll();
  await setRuntime({ isPaused: true, nextActionAt: null });
  await logInfo('⏸ Paused');
  await badgePaused();
  return { ok: true };
}

async function cmdResume() {
  const r = await getRuntime();
  if (!r.isRunning) return { ok: false, error: 'not_running' };
  await setRuntime({ isPaused: false });
  await logInfo('▶ Resumed');
  await badgeRunning();
  processNext().catch(console.error);
  return { ok: true };
}

async function cmdStop() {
  await chrome.alarms.clearAll();
  await setRuntime({
    isRunning: false,
    isPaused: false,
    nextActionAt: null,
    currentDelayMs: 0,
    mode: 'idle',
  });
  await logWarn('■ Stopped');
  await badgeClear();
  return { ok: true };
}

async function cmdReset() {
  await chrome.alarms.clearAll();
  await chrome.storage.local.clear();
  await badgeClear();
  await logInfo('Extension state reset');
  return { ok: true };
}

async function cmdResetAnalytics() {
  await clearAnalytics();
  await logInfo('Analytics cleared');
  return { ok: true };
}

// ─── Discovery & queue building ────────────────────────────────────

async function cmdLoadHandles({ handles, source }) {
  const count = await setQueue(handles || [], source || 'manual');
  return { ok: true, count };
}

async function cmdAppendHandles({ handles, source }) {
  const settings = await getSettings();
  const count = await appendToQueue(handles || [], source || 'manual', settings.whitelist || []);
  return { ok: true, count };
}

async function cmdExtractFromUrl({ url }) {
  try {
    const resp = await fetch(url, {
      headers: { 'Accept': 'text/html,application/xhtml+xml' },
    });
    if (!resp.ok) return { ok: false, error: 'HTTP ' + resp.status };
    const html = await resp.text();
    const handles = extractHandles(html);
    return { ok: true, handles };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function cmdExtractFromCurrentTab() {
  try {
    const tab = await findXTab();
    if (!tab) return { ok: false, error: 'No X tab open' };
    const r = await chrome.tabs.sendMessage(tab.id, { type: 'EXTRACT_HANDLES' });
    return { ok: true, handles: (r && r.handles) || [] };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ─── Walker coordination ──────────────────────────────────────────

async function onWalkerStarted({ pageKind, pageUrl, loggedInProfile }) {
  await clearHalt();
  const patch = {
    isRunning: true,
    isPaused: false,
    mode: 'list-walker',
    startedAt: Date.now(),
    completedAt: null,
    sessionFollowed: 0,
    sessionSkipped: 0,
    sessionFailed: 0,
    safetyHalted: false,
    safetyReason: '',
    nextActionAt: null,
    currentDelayMs: 0,
    walkerPageKind: pageKind || '',
    walkerPageUrl: pageUrl || '',
    currentProfile: null,
  };
  if (loggedInProfile && (loggedInProfile.handle || loggedInProfile.name)) {
    patch.loggedInProfile = loggedInProfile;
  }
  await setRuntime(patch);
  await logInfo(`▶ List-walker started on ${pageKind || 'page'}`);
  await badgeRunning();
}

async function onWalkerFollowed({ username, sourceUrl }) {
  if (!username) return;
  await recordFollowAction();
  await recordDaily('followed');

  // recordResult pushes to results AND bumps runtime.sessionFollowed.
  // Do not increment sessionFollowed separately — that caused double-counting.
  await recordResult(username, 'followed', '');

  await setRuntime({
    lastHandle: username,
    lastStatus: 'followed',
  });

  // Mirror to followedProfiles list (kept for backwards compat / export)
  try {
    const data = await chrome.storage.local.get({ followedProfiles: [] });
    const rows = Array.isArray(data.followedProfiles) ? data.followedProfiles : [];
    if (!rows.some((row) => row.username === username)) {
      rows.push({
        username,
        profileUrl: `https://x.com/${username}`,
        followedAt: new Date().toISOString(),
        sourceUrl: sourceUrl || '',
      });
      await chrome.storage.local.set({ followedProfiles: rows });
    }
  } catch (_) {}

  await logSuccess(`✓ Walker followed @${username}`);
}

async function onWalkerSkipped({ username, reason }) {
  await recordDaily('skipped');
  // recordResult bumps sessionSkipped (for already_following / unavailable status).
  // For walker click failures we use 'failed' which bumps sessionFailed instead.
  // Use 'unavailable' so it counts as a skip in the UI.
  if (username) {
    await recordResult(username, 'unavailable', reason || '');
  }
}

async function onWalkerStopped({ reason, followed, skipped }) {
  await setRuntime({
    isRunning: false,
    isPaused: false,
    mode: 'idle',
    completedAt: Date.now(),
    nextActionAt: null,
    currentDelayMs: 0,
  });
  await logInfo(`Walker stopped: ${reason || ''} (followed ${followed || 0}, skipped ${skipped || 0})`);
  const settings = await getSettings();
  if (settings.notifyOnComplete && (followed || 0) > 0) {
    try {
      chrome.notifications.create({
        type: 'basic',
        iconUrl: chrome.runtime.getURL('icons/icon128.png'),
        title: 'X Follow Grow — Walker complete',
        message: `Followed ${followed || 0} accounts (${skipped || 0} skipped).`,
      });
    } catch (_) {}
  }
  await badgeClear();
}

async function onWalkerPaused() {
  await setRuntime({ isPaused: true });
  await logInfo('⏸ Walker paused');
  await badgePaused();
}

async function onWalkerResumed() {
  await setRuntime({ isPaused: false });
  await logInfo('▶ Walker resumed');
  await badgeRunning();
}

async function onWalkerHalt(reason) {
  await halt(reason);
}

// ─── Dashboard / state queries ────────────────────────────────────

async function cmdGetSnapshot() {
  const [runtime, settings, queueSnap, dash, hist, daily] = await Promise.all([
    getRuntime(),
    getSettings(),
    getQueueSnapshot(),
    getDashboardStats(),
    getHistoryStats(),
    getDailyRollup(),
  ]);
  const logEntries = (await getLocal('log')).log || [];
  return {
    ok: true,
    runtime,
    settings,
    queue: queueSnap,
    dashboard: dash,
    safety: {
      ...computeSafetyScore(settings),
      lastHour: hist.lastHour,
      lastDay: hist.lastDay,
    },
    daily,
    log: logEntries,
  };
}

// ─── Message router ────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      const action = (msg && (msg.type || msg.action)) || '';
      switch (action) {
        // ─ Profile queue commands
        case 'START_PROFILE_QUEUE': sendResponse(await cmdStartProfileQueue(msg.opts || {})); break;
        case 'PAUSE':                sendResponse(await cmdPause()); break;
        case 'RESUME':               sendResponse(await cmdResume()); break;
        case 'STOP':                 sendResponse(await cmdStop()); break;
        case 'RESET':                sendResponse(await cmdReset()); break;
        case 'RESET_ANALYTICS':      sendResponse(await cmdResetAnalytics()); break;
        case 'LOAD_HANDLES':         sendResponse(await cmdLoadHandles(msg)); break;
        case 'APPEND_HANDLES':       sendResponse(await cmdAppendHandles(msg)); break;
        case 'EXTRACT_FROM_URL':     sendResponse(await cmdExtractFromUrl(msg)); break;
        case 'EXTRACT_CURRENT_TAB':  sendResponse(await cmdExtractFromCurrentTab()); break;

        // ─ Snapshot for popup/dashboard
        case 'GET_SNAPSHOT':         sendResponse(await cmdGetSnapshot()); break;

        // ─ Settings (sync wrapper)
        case 'SET_SETTINGS':
          await chrome.storage.sync.set(msg.settings || {});
          sendResponse({ ok: true });
          break;
        case 'RESET_SETTINGS':
          await resetSettings();
          await logInfo('Settings reset to defaults');
          sendResponse({ ok: true });
          break;

        // ─ Walker → SW pings
        case 'WALKER_STARTED':
          await onWalkerStarted(msg);
          sendResponse({ ok: true });
          break;
        case 'WALKER_FOLLOWED':
          await onWalkerFollowed(msg);
          sendResponse({ ok: true });
          break;
        case 'WALKER_SKIPPED':
          await onWalkerSkipped(msg);
          sendResponse({ ok: true });
          break;
        case 'WALKER_PAUSED':
          await onWalkerPaused();
          sendResponse({ ok: true });
          break;
        case 'WALKER_RESUMED':
          await onWalkerResumed();
          sendResponse({ ok: true });
          break;
        case 'WALKER_HALT':
          await onWalkerHalt(msg.reason || 'walker_halt');
          sendResponse({ ok: true });
          break;
        case 'WALKER_STOPPED':
          await onWalkerStopped(msg);
          sendResponse({ ok: true });
          break;
        case 'WALKER_PROGRESS':
          // Walker reporting per-tick progress — silent ack.
          sendResponse({ ok: true });
          break;
        case 'WALKER_TIMER':
          // Walker reports its next-action deadline so popup can show countdown
          await setRuntime({
            nextActionAt: msg.nextActionAt || null,
            currentDelayMs: msg.currentDelayMs || 0,
            timerLabel: msg.message || '',
          });
          sendResponse({ ok: true });
          break;
        case 'WALKER_PROFILE':
          // Walker reports the profile it's about to / just acted on
          await setRuntime({
            currentProfile: {
              handle: msg.handle || '',
              displayName: msg.displayName || '',
              avatarUrl: msg.avatarUrl || '',
              bio: msg.bio || '',
              verified: !!msg.verified,
              status: msg.status || 'scanning', // 'scanning' | 'following' | 'followed' | 'skipped'
              at: Date.now(),
            },
          });
          sendResponse({ ok: true });
          break;
        case 'SET_LOGGED_IN_PROFILE':
          // Popup-side: opportunistic profile from active X tab
          if (msg.profile && (msg.profile.handle || msg.profile.name)) {
            await setRuntime({ loggedInProfile: msg.profile });
          }
          sendResponse({ ok: true });
          break;
        case 'CHECK_CAPS': {
          const settings = await getSettings();
          const r = await checkCaps(settings);
          sendResponse(r);
          break;
        }

        // ─ Convenience: clear log
        case 'CLEAR_LOG':            await clearLog(); sendResponse({ ok: true }); break;
        case 'CLEAR_QUEUE':          await clearQueue(); sendResponse({ ok: true }); break;

        default:
          sendResponse({ ok: false, error: 'unknown_action: ' + action });
      }
    } catch (err) {
      console.error('[X Follow Grow] router error:', err);
      try { sendResponse({ ok: false, error: err.message }); } catch (_) {}
    }
  })();
  return true; // keep channel open for async sendResponse
});

// ─── Alarms ───────────────────────────────────────────────────────

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ALARM_NEXT) return;
  const r = await getRuntime();
  if (r.isRunning && !r.isPaused && !r.safetyHalted) {
    processNext().catch(console.error);
  }
});

// ─── Recovery on browser startup / installed ──────────────────────

chrome.runtime.onStartup.addListener(async () => {
  const r = await getRuntime();
  if (r.isRunning && !r.isPaused && !r.safetyHalted && r.nextActionAt) {
    await badgeRunning();
    const remaining = r.nextActionAt - Date.now();
    if (remaining <= 0) {
      processNext().catch(console.error);
    } else if (remaining >= ALARM_CUTOFF_MS) {
      chrome.alarms.create(ALARM_NEXT, { when: r.nextActionAt });
    } else {
      setTimeout(() => { processNext().catch(console.error); }, remaining);
    }
  } else if (r.isPaused) {
    await badgePaused();
  } else if (r.safetyHalted) {
    await badgeHalted();
  }
});

chrome.runtime.onInstalled.addListener(async (details) => {
  await chrome.alarms.clearAll();
  await badgeClear();
  if (details.reason === 'install') {
    await logInfo('X Follow Grow installed — open the popup to begin.');
    // Ensure default settings are written
    const cur = await chrome.storage.sync.get(null);
    if (!cur || Object.keys(cur).length === 0) {
      await chrome.storage.sync.set(DEFAULT_SETTINGS);
    }
  } else if (details.reason === 'update') {
    await logInfo(`Updated to version ${chrome.runtime.getManifest().version}.`);
  }
});

// Mark module loaded (visible in chrome://extensions service-worker logs)
console.log('[X Follow Grow] service worker initialised');

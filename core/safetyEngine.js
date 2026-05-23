/**
 * safetyEngine.js
 *
 * The single source of truth for "is it safe to follow right now?".
 *
 * Concepts:
 *
 *   ROLLING WINDOW HISTORY
 *   ──────────────────────
 *   We keep an array of action timestamps (ms) for the last 24h. From this
 *   we derive: actions in last hour, actions in last 24h. We prune older
 *   entries on every check so the array stays bounded (max ~daily cap).
 *
 *   CAPS
 *   ────
 *   Hourly and daily caps are hard limits. Crossing them flips an
 *   automation halt with a reason — caller decides whether to wait or stop.
 *
 *   WARMUP
 *   ──────
 *   First-day or freshly-enabled accounts should follow much slower. When
 *   warmupMode is on, caps are halved and minimum delays are raised.
 *
 *   PAGE-SIDE LOCK DETECTION
 *   ────────────────────────
 *   `inspectPageForLocks()` runs in the X tab and looks for the strings X
 *   shows when it action-blocks you ("You are unable to follow more
 *   people", "Are you a robot?", a captcha iframe, a temporary lockout).
 *   If any are found we halt automation immediately and surface the reason.
 *
 *   SAFETY SCORE
 *   ────────────
 *   A 0..100 heuristic blending the user's settings — the popup shows it as
 *   the "Safety Pulse". Higher = safer. Distilled from the original Elite
 *   extension's calibrated curve, then tuned to also account for our caps.
 */

import { mutateLocal, getLocal, setLocal, getRuntime, setRuntime } from './storage.js';
import { logSafety, logWarn } from './logger.js';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS  = 24 * HOUR_MS;

// ─── History (timestamps of completed follows, for rate-limit math) ─

/**
 * Record a successful follow (call AFTER the click resolves successfully).
 * Returns the new history length so callers can short-circuit if they want.
 */
export async function recordFollowAction() {
  const now = Date.now();
  return mutateLocal('actionHistory', (prev) => {
    const arr = Array.isArray(prev) ? prev : [];
    arr.push(now);
    // Prune anything older than 25h (gives us a 1h grace window)
    const cutoff = now - DAY_MS - HOUR_MS;
    let i = 0;
    while (i < arr.length && arr[i] < cutoff) i++;
    return i > 0 ? arr.slice(i) : arr;
  }, []);
}

/** Returns { lastHour, lastDay, history } for inspection by the UI. */
export async function getHistoryStats() {
  const data = await getLocal('actionHistory');
  const history = Array.isArray(data.actionHistory) ? data.actionHistory : [];
  const now = Date.now();
  let lastHour = 0, lastDay = 0;
  for (const t of history) {
    if (now - t <= DAY_MS) lastDay++;
    if (now - t <= HOUR_MS) lastHour++;
  }
  return { lastHour, lastDay, history };
}

// ─── Caps & "may I act now?" check ──────────────────────────────────

/**
 * @param {object} settings  the merged settings object
 * @returns {Promise<{ allowed: boolean, reason?: string, retryAfterMs?: number }>}
 */
export async function checkCaps(settings) {
  const { lastHour, lastDay } = await getHistoryStats();

  // Warmup halves user-set caps, but never below sensible floors.
  const hourCap = settings.warmupMode
    ? Math.max(5, Math.floor(settings.hourlyCap / 2))
    : settings.hourlyCap;
  const dayCap = settings.warmupMode
    ? Math.max(20, Math.floor(settings.dailyCap / 2))
    : settings.dailyCap;

  if (lastDay >= dayCap) {
    return {
      allowed: false,
      reason: `Daily cap reached (${lastDay}/${dayCap}). Resuming after the oldest action ages out.`,
      retryAfterMs: await timeUntilOldestAgesOut(DAY_MS),
    };
  }
  if (lastHour >= hourCap) {
    return {
      allowed: false,
      reason: `Hourly cap reached (${lastHour}/${hourCap}). Cooling off.`,
      retryAfterMs: await timeUntilOldestAgesOut(HOUR_MS),
    };
  }
  return { allowed: true };
}

async function timeUntilOldestAgesOut(windowMs) {
  const data = await getLocal('actionHistory');
  const history = Array.isArray(data.actionHistory) ? data.actionHistory : [];
  if (!history.length) return 60_000;
  const oldestRelevant = history.find((t) => Date.now() - t <= windowMs);
  if (!oldestRelevant) return 60_000;
  // Wait until that one is just outside the window, plus 5s buffer
  return Math.max(60_000, (oldestRelevant + windowMs - Date.now()) + 5_000);
}

// ─── Halt: immediate stop with surfaced reason ──────────────────────

export async function halt(reason) {
  await setRuntime({
    safetyHalted: true,
    safetyReason: String(reason || 'unknown'),
    isRunning: false,
    isPaused: false,
    nextActionAt: null,
    currentDelayMs: 0,
  });
  await logSafety(`⚠ Halted: ${reason}`);
  try {
    await chrome.action.setBadgeText({ text: '!' });
    await chrome.action.setBadgeBackgroundColor({ color: '#dc2626' });
  } catch (_) {}
  try {
    chrome.notifications.create({
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title: 'X Follow Grow — Halted',
      message: String(reason || 'Automation halted for safety.').slice(0, 240),
    });
  } catch (_) {}
}

export async function clearHalt() {
  await setRuntime({ safetyHalted: false, safetyReason: '' });
  try { await chrome.action.setBadgeText({ text: '' }); } catch (_) {}
}

export async function isHalted() {
  const r = await getRuntime();
  return r.safetyHalted === true;
}

// ─── Page-side lock & captcha detection ─────────────────────────────

/**
 * Run in-page (via chrome.scripting.executeScript). Returns one of:
 *   - { lock: true, kind: 'rate_limit' | 'captcha' | 'suspended' | 'restricted', detail }
 *   - { lock: false }
 *
 * We look at innerText, presence of lockout sentences, captcha iframe
 * hostnames, and the auth-error flow X uses for soft locks.
 */
export function inspectPageForLocksFn() {
  // NOTE: serialized into the page; no external imports.
  try {
    const text = (document.body && document.body.innerText || '').toLowerCase();
    const lockPhrases = [
      'you are unable to follow more people at this time',
      'you have been rate limited',
      'rate limit exceeded',
      'try again later',
      'are you a robot',
      'verify you are human',
      'we need to verify you are a human',
      'your account has been locked',
      'your account is restricted',
      'caught in the middle of a',
      'suspicious activity',
    ];
    for (const p of lockPhrases) {
      if (text.includes(p)) {
        return {
          lock: true,
          kind:
            p.includes('robot') || p.includes('human') ? 'captcha' :
            p.includes('locked') || p.includes('restricted') ? 'restricted' :
            p.includes('suspicious') ? 'restricted' :
            'rate_limit',
          detail: p,
        };
      }
    }
    // Captcha iframes (Arkose / FunCaptcha / hCaptcha)
    const iframes = document.querySelectorAll('iframe[src*="arkose"], iframe[src*="funcaptcha"], iframe[src*="hcaptcha"], iframe[src*="captcha"]');
    if (iframes.length) {
      return { lock: true, kind: 'captcha', detail: 'captcha_iframe_present' };
    }
    return { lock: false };
  } catch (e) {
    return { lock: false, error: String(e && e.message || e) };
  }
}

// ─── Safety Pulse score ─────────────────────────────────────────────

/**
 * @param {object} settings
 * @returns {{ score: number, band: { label: string, color: string, note: string } }}
 */
export function computeSafetyScore(settings) {
  const minDelay = Math.max(1, +settings.minDelaySec || 30);
  const maxDelay = Math.max(minDelay, +settings.maxDelaySec || 90);
  const hourCap = Math.max(1, +settings.hourlyCap || 30);
  const dayCap = Math.max(1, +settings.dailyCap || 200);
  const longPauseMin = Math.max(1, +settings.longPauseAfterMin || 10);
  const longPauseSec = Math.max(60, +settings.longPauseMinSec || 180);

  const avg = (minDelay + maxDelay) / 2;
  const range = maxDelay - minDelay;

  let score = 50;

  // 1) Average delay is the biggest single factor.
  if      (avg >= 75) score += 30;
  else if (avg >= 50) score += 22;
  else if (avg >= 35) score += 14;
  else if (avg >= 22) score +=  6;
  else if (avg >= 14) score +=  0;
  else if (avg >=  8) score -= 14;
  else                score -= 26;

  // 2) Range — more jitter looks more human.
  if      (range >= 40) score += 8;
  else if (range >= 20) score += 5;
  else if (range >= 10) score += 2;
  else                  score -= 4;

  // 3) Hourly cap — too many follows per hour is the classic flag.
  if      (hourCap <= 15) score += 12;
  else if (hourCap <= 30) score += 6;
  else if (hourCap <= 50) score -= 4;
  else                    score -= 14;

  // 4) Daily cap.
  if      (dayCap <= 100) score += 10;
  else if (dayCap <= 200) score += 4;
  else if (dayCap <= 400) score -= 6;
  else                    score -= 18;

  // 5) Long-pause cycle: how often we coffee-break.
  if      (longPauseMin <= 8)  score += 6;
  else if (longPauseMin <= 15) score += 3;
  else                         score -= 4;
  if      (longPauseSec >= 240) score += 4;
  else if (longPauseSec >= 120) score += 2;
  else                          score -= 4;

  // 6) Warmup mode is essentially free safety.
  if (settings.warmupMode) score += 6;

  // Hard floors
  if (minDelay < 6) score -= 12;
  if (maxDelay < 12) score -= 8;
  if (hourCap > 80) score -= 12;

  score = Math.max(0, Math.min(100, Math.round(score)));

  let band;
  if      (score >= 80) band = { label: 'STEALTH',    color: '#10b981', note: 'Stealthy rhythm — comfortable headroom against rate limits.' };
  else if (score >= 60) band = { label: 'BALANCED',   color: '#3b82f6', note: 'Balanced pace, suitable for daily use.' };
  else if (score >= 40) band = { label: 'AGGRESSIVE', color: '#f59e0b', note: 'Aggressive — works in short bursts only.' };
  else if (score >= 20) band = { label: 'RISKY',      color: '#ef4444', note: 'Risky — rate limits become likely.' };
  else                  band = { label: 'CRITICAL',   color: '#7f1d1d', note: 'Critical — raise delays and lower the caps.' };

  return { score, band };
}

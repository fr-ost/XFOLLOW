/**
 * queueManager.js
 *
 * The persistent FIFO that drives profile-queue mode. Every operation
 * goes through here so the queue survives:
 *
 *   - popup close (the SW owns it)
 *   - service-worker termination (state lives in storage.local)
 *   - browser restart (we re-attach to the alarm or re-run on startup)
 *
 * Concepts:
 *
 *   ITEM  = { handle, addedAt, source, priority?, attempts? }
 *   STATE = { queue: Item[], queueIndex: number, results: Result[] }
 *
 *   queueIndex points at the NEXT item to process. When we successfully
 *   advance past an item, queueIndex increments BEFORE recording the
 *   result — guarantees we never loop on the same handle (the bug class
 *   that plagued the original v3.0.x).
 *
 *   We support a small per-item retry on transient errors (tab load
 *   timeout, network glitch). When an item exceeds its retry budget we
 *   record a permanent 'failed' and move on.
 */

import {
  getRuntime, setRuntime, mutateLocal, getLocal,
} from './storage.js';
import { logInfo, logSuccess, logWarn, logError } from './logger.js';
import { isValidHandle, normalizeHandle } from '../utils/parser.js';

const MAX_ATTEMPTS_PER_ITEM = 2;

// ─── Public API ─────────────────────────────────────────────────────

/**
 * Replace the queue entirely with a fresh batch. Use when the user pastes
 * a new list and clicks Start.
 *
 * @param {string[]} handles
 * @param {string}   source     short label, e.g. 'paste' | 'currentTab' | 'fetched'
 */
export async function setQueue(handles, source = 'manual') {
  const cleaned = (handles || [])
    .map(normalizeHandle)
    .filter(isValidHandle);
  // Deduplicate (preserve first occurrence)
  const seen = new Set();
  const items = [];
  for (const h of cleaned) {
    if (seen.has(h)) continue;
    seen.add(h);
    items.push({
      handle: h,
      addedAt: Date.now(),
      source,
      priority: 0,
      attempts: 0,
    });
  }
  await setRuntime({
    queue: items,
    queueIndex: 0,
    queueSize: items.length,
    sessionFollowed: 0,
    sessionSkipped: 0,
    sessionFailed: 0,
  });
  await mutateLocal('results', () => [], []);
  await logInfo(`Queue loaded: ${items.length} unique handle${items.length === 1 ? '' : 's'} from ${source}`);
  return items.length;
}

/**
 * Append handles to the existing queue. Useful for "discover then queue"
 * flows. Skips handles already present (case-insensitive) and the whitelist.
 *
 * @param {string[]} handles
 * @param {string}   source
 * @param {string[]} whitelist
 * @returns {Promise<number>}  count actually appended
 */
export async function appendToQueue(handles, source = 'manual', whitelist = []) {
  const cleaned = (handles || [])
    .map(normalizeHandle)
    .filter(isValidHandle);
  const r = await getRuntime();
  const present = new Set((r.queue || []).map((i) => i.handle));
  const wl = new Set((whitelist || []).map(normalizeHandle));

  const additions = [];
  for (const h of cleaned) {
    if (present.has(h)) continue;
    if (wl.has(h)) continue;
    present.add(h);
    additions.push({
      handle: h,
      addedAt: Date.now(),
      source,
      priority: 0,
      attempts: 0,
    });
  }
  if (!additions.length) return 0;

  const next = [...(r.queue || []), ...additions];
  await setRuntime({ queue: next, queueSize: next.length });
  await logInfo(`+${additions.length} handle${additions.length === 1 ? '' : 's'} appended (${source})`);
  return additions.length;
}

/**
 * Get the item at the current index, or null if exhausted.
 */
export async function peekCurrent() {
  const r = await getRuntime();
  if (!r.queue || r.queueIndex >= r.queue.length) return null;
  return r.queue[r.queueIndex] || null;
}

/**
 * Advance past the current item (after recording its result). The queue
 * always advances exactly once per item — the `attempts` budget is
 * consumed inside processProfile/scheduleNext, not by re-pointing the
 * index back at the same item.
 */
export async function advance() {
  const r = await getRuntime();
  const idx = (r.queueIndex || 0) + 1;
  await setRuntime({ queueIndex: idx });
  return idx;
}

/**
 * Increment retry count on the current item. Returns true if we still
 * have attempts left.
 */
export async function incrementAttempts() {
  const r = await getRuntime();
  if (!r.queue || r.queueIndex >= r.queue.length) return false;
  const item = r.queue[r.queueIndex];
  if (!item) return false;
  const nextAttempts = (item.attempts || 0) + 1;
  const updatedItem = { ...item, attempts: nextAttempts };
  const newQueue = [...r.queue];
  newQueue[r.queueIndex] = updatedItem;
  await setRuntime({ queue: newQueue });
  return nextAttempts < MAX_ATTEMPTS_PER_ITEM;
}

/**
 * Record a per-handle outcome and update aggregate stats.
 * Status: 'followed' | 'already_following' | 'unavailable' | 'failed' | 'login_required' | 'safety_halt'
 */
export async function recordResult(handle, status, detail = '') {
  const result = { handle, status, time: Date.now(), detail: String(detail || '').slice(0, 240) };
  await mutateLocal('results', (prev) => {
    const arr = Array.isArray(prev) ? prev : [];
    arr.push(result);
    return arr;
  }, []);

  // Update per-session counters
  const r = await getRuntime();
  const patch = {};
  if (status === 'followed') {
    patch.sessionFollowed = (r.sessionFollowed || 0) + 1;
  } else if (status === 'already_following' || status === 'unavailable') {
    patch.sessionSkipped = (r.sessionSkipped || 0) + 1;
  } else {
    patch.sessionFailed = (r.sessionFailed || 0) + 1;
  }
  patch.lastHandle = handle;
  patch.lastStatus = status;
  await setRuntime(patch);

  const tag =
    status === 'followed'         ? logSuccess :
    status === 'already_following' ? logWarn   :
    status === 'unavailable'       ? logWarn   :
    logError;
  const verb =
    status === 'followed'          ? '✓ Followed'        :
    status === 'already_following'  ? '↷ Already following' :
    status === 'unavailable'        ? '⊘ Unavailable'      :
    status === 'login_required'     ? '✗ Login required'   :
    status === 'safety_halt'        ? '⚠ Safety halt'       :
                                      '✗ Failed';
  await tag(`${verb}: @${handle}${detail ? ' (' + detail + ')' : ''}`);
}

/** Empty queue but keep results & analytics. */
export async function clearQueue() {
  await setRuntime({
    queue: [],
    queueIndex: 0,
    queueSize: 0,
  });
  await logInfo('Queue cleared');
}

/** Aggregate read for the UI. */
export async function getQueueSnapshot() {
  const r = await getRuntime();
  const data = await getLocal(['results']);
  return {
    queue: r.queue || [],
    queueIndex: r.queueIndex || 0,
    queueSize: r.queueSize || (r.queue ? r.queue.length : 0),
    results: data.results || [],
    sessionFollowed: r.sessionFollowed || 0,
    sessionSkipped: r.sessionSkipped || 0,
    sessionFailed: r.sessionFailed || 0,
  };
}

/** True when current index is past the end. */
export async function isExhausted() {
  const r = await getRuntime();
  return !r.queue || r.queueIndex >= r.queue.length;
}

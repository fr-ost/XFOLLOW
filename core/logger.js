/**
 * logger.js
 *
 * The activity log is a bounded ring buffer in chrome.storage.local. We cap
 * at MAX_LOG entries to prevent unbounded growth — long-running sessions
 * could log thousands of lines a day.
 *
 * Every write:
 *   1. Reads, prepends, slices to MAX_LOG, writes back (atomic via mutateLocal)
 *   2. Mirrors to console.* with a stable prefix
 *   3. Broadcasts a 'log_update' message so any open popup can refresh
 */

import { mutateLocal } from './storage.js';

const MAX_LOG = 250;
const PREFIX = '[X Follow Grow]';

/**
 * @typedef {object} LogEntry
 * @property {number} time      ms since epoch
 * @property {string} msg       human-readable message
 * @property {'info'|'success'|'warn'|'error'|'safety'} type
 */

/**
 * @param {string} msg
 * @param {LogEntry['type']} [type='info']
 * @returns {Promise<void>}
 */
export async function log(msg, type = 'info') {
  const entry = { time: Date.now(), msg: String(msg).slice(0, 500), type };

  // Console mirror — visible in chrome://extensions service-worker logs
  const fn =
    type === 'error' ? console.error :
    type === 'warn' || type === 'safety' ? console.warn :
    console.log;
  fn(PREFIX, entry.msg);

  await mutateLocal('log', (prev) => {
    const arr = Array.isArray(prev) ? prev : [];
    const next = [entry, ...arr];
    if (next.length > MAX_LOG) next.length = MAX_LOG;
    return next;
  }, []);

  // Best-effort broadcast — popup may or may not be open
  try { chrome.runtime.sendMessage({ type: 'log_update', entry }).catch(() => {}); }
  catch (_) {}
}

export const logInfo = (m) => log(m, 'info');
export const logSuccess = (m) => log(m, 'success');
export const logWarn = (m) => log(m, 'warn');
export const logError = (m) => log(m, 'error');
export const logSafety = (m) => log(m, 'safety');

/** Wipe the log entirely. */
export async function clearLog() {
  await mutateLocal('log', () => [], []);
  try { chrome.runtime.sendMessage({ type: 'log_update' }).catch(() => {}); }
  catch (_) {}
}

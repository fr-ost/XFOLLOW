/**
 * analytics.js
 *
 * Aggregates the action history into the numbers the dashboard needs.
 * Intentionally lightweight — every stat is computed on-demand from the
 * raw `actionHistory` array (which the safety engine maintains) plus the
 * `results` array (which queueManager appends to). No separate counter
 * to drift out of sync.
 *
 * Daily history is stored under `analytics.daily[]` as a rolling 30-day
 * array of { date: 'YYYY-MM-DD', followed, skipped, failed }. We update
 * it whenever a follow lands.
 */

import { getLocal, mutateLocal } from './storage.js';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS  = 24 * HOUR_MS;
const ROLLUP_DAYS = 30;

function dayKey(d = new Date()) {
  // Local-time YYYY-MM-DD (we want "today" to mean the user's today)
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/** Bump today's counter for `kind` ∈ followed | skipped | failed. */
export async function recordDaily(kind) {
  await mutateLocal('analytics.daily', (prev) => {
    const arr = Array.isArray(prev) ? prev : [];
    const today = dayKey();
    let entry = arr.find((e) => e.date === today);
    if (!entry) {
      entry = { date: today, followed: 0, skipped: 0, failed: 0 };
      arr.push(entry);
    }
    entry[kind] = (entry[kind] || 0) + 1;
    // Keep last ROLLUP_DAYS, sorted ascending by date
    arr.sort((a, b) => a.date.localeCompare(b.date));
    if (arr.length > ROLLUP_DAYS) arr.splice(0, arr.length - ROLLUP_DAYS);
    return arr;
  }, []);
}

export async function getDailyRollup() {
  const data = await getLocal('analytics.daily');
  return Array.isArray(data['analytics.daily']) ? data['analytics.daily'] : [];
}

/**
 * Aggregate dashboard summary.
 *
 * @returns {Promise<{
 *   today: { followed, skipped, failed },
 *   lastHour: number,
 *   lastDay: number,
 *   total: number,
 *   successRate: number,             // 0..1
 *   estFollowBackRate: number|null,  // 0..1, requires saved history
 *   recent: Array<{handle, status, time}>,
 *   sparkline: number[],             // last 14 days followed counts
 * }>}
 */
export async function getDashboardStats() {
  const data = await getLocal(['actionHistory', 'results', 'analytics.daily']);
  const history = Array.isArray(data.actionHistory) ? data.actionHistory : [];
  const results = Array.isArray(data.results) ? data.results : [];
  const daily = Array.isArray(data['analytics.daily']) ? data['analytics.daily'] : [];

  const now = Date.now();
  let lastHour = 0, lastDay = 0;
  for (const t of history) {
    if (now - t <= DAY_MS) lastDay++;
    if (now - t <= HOUR_MS) lastHour++;
  }

  const today = daily.find((d) => d.date === dayKey()) || {
    followed: 0, skipped: 0, failed: 0,
  };

  // Total ever-followed = total length of history (we only push on success)
  const total = history.length;

  // Success rate = followed / (followed + failed) over the whole results log
  const totalFollowed = results.filter((r) => r.status === 'followed').length;
  const totalFailed = results.filter((r) => r.status === 'failed').length;
  const denom = totalFollowed + totalFailed;
  const successRate = denom > 0 ? totalFollowed / denom : 1;

  // Recent activity (last 8)
  const recent = results.slice(-8).reverse();

  // 14-day sparkline of followed counts (oldest -> newest)
  const sparkline = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(now - i * DAY_MS);
    const key = dayKey(d);
    const e = daily.find((x) => x.date === key);
    sparkline.push(e ? (e.followed || 0) : 0);
  }

  // Follow-back estimation requires a separate observation pass we don't
  // do here (would require visiting each followee periodically). Returning
  // null tells the UI to render "—".
  const estFollowBackRate = null;

  return {
    today,
    lastHour,
    lastDay,
    total,
    successRate,
    estFollowBackRate,
    recent,
    sparkline,
  };
}

/** Erase analytics + history. Settings & queue are NOT touched. */
export async function clearAnalytics() {
  await chrome.storage.local.remove(['analytics.daily', 'actionHistory', 'results']);
}

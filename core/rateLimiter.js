/**
 * rateLimiter.js
 *
 * The safety engine answers "are we OVER the cap?". This module answers
 * "what's the next delay?" — it composes:
 *
 *   - the user's min/max delay window
 *   - the long-pause "coffee break" cycle (every N follows, take a break)
 *   - the burst chance (small probability of a quick gap)
 *   - the warmup multiplier (1.5x slower while warmupMode is on)
 *
 * Returns a single integer-ms value so the caller (queueManager) can
 * schedule via alarms.
 */

import { skewedDelayMs, randInt, chance } from '../utils/randomizer.js';
import { getRuntime, setRuntime } from './storage.js';

/**
 * Calculate the wait before the NEXT follow given the LAST result.
 *
 * @param {object} settings  merged settings
 * @param {'followed'|'skipped'|'failed'} lastStatus
 * @returns {Promise<{ delayMs: number, kind: 'normal'|'burst'|'long-pause'|'skip' }>}
 */
export async function computeNextDelay(settings, lastStatus) {
  // For non-follow outcomes, use the skip-delay window (much shorter).
  if (lastStatus !== 'followed') {
    const min = Math.max(0, +settings.minSkipDelaySec || 1);
    const max = Math.max(min, +settings.maxSkipDelaySec || 3);
    return { delayMs: randInt(min * 1000, max * 1000), kind: 'skip' };
  }

  // Increment our follows-since-long-pause counter
  const r = await getRuntime();
  const followsSince = (r.followsSinceLongPause || 0) + 1;
  let nextLongPauseAt = r.nextLongPauseAt;
  if (!nextLongPauseAt) {
    nextLongPauseAt = randInt(settings.longPauseAfterMin, settings.longPauseAfterMax);
  }

  // Long pause due?
  if (followsSince >= nextLongPauseAt) {
    const minSec = Math.max(60, +settings.longPauseMinSec || 180);
    const maxSec = Math.max(minSec, +settings.longPauseMaxSec || 420);
    const delayMs = randInt(minSec * 1000, maxSec * 1000);
    await setRuntime({
      followsSinceLongPause: 0,
      nextLongPauseAt: randInt(settings.longPauseAfterMin, settings.longPauseAfterMax),
    });
    return { delayMs, kind: 'long-pause' };
  }

  await setRuntime({
    followsSinceLongPause: followsSince,
    nextLongPauseAt,
  });

  // Quick burst?
  if (chance(settings.burstChance ?? 0.08)) {
    return { delayMs: randInt(5_000, 12_000), kind: 'burst' };
  }

  // Normal skewed delay
  let delayMs = skewedDelayMs(settings.minDelaySec, settings.maxDelaySec);

  // Warmup multiplier
  if (settings.warmupMode) {
    delayMs = Math.round(delayMs * 1.5);
  }

  return { delayMs, kind: 'normal' };
}

/**
 * Reset the long-pause counter — called when starting a fresh session.
 */
export async function resetPacing() {
  await setRuntime({
    followsSinceLongPause: 0,
    nextLongPauseAt: null,
  });
}

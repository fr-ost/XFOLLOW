/**
 * randomizer.js
 *
 * Single source of truth for randomness. Centralizing this means we can:
 *   - make every "random" call testable (swap Math.random for a seedable RNG)
 *   - keep distribution shapes consistent across modules
 *   - reuse one set of "feels human" curves rather than inventing them per file
 */

/** Inclusive integer in [min, max]. */
export function randInt(min, max) {
  min = Math.ceil(Number(min) || 0);
  max = Math.floor(Number(max) || 0);
  if (max < min) [min, max] = [max, min];
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/** Float in [min, max). */
export function randFloat(min, max) {
  if (max < min) [min, max] = [max, min];
  return Math.random() * (max - min) + min;
}

/** Pick one element from an array, undefined if empty. */
export function pick(arr) {
  if (!arr || arr.length === 0) return undefined;
  return arr[Math.floor(Math.random() * arr.length)];
}

/** Boolean true with probability p (0..1). */
export function chance(p) {
  return Math.random() < p;
}

/**
 * Skewed delay in ms — humans tend to act either *quickly* (most of the time)
 * or *very slowly* (when distracted). A flat uniform distribution looks
 * mechanical. We mix a quick band (30% probability) with a long-tail band.
 *
 * @param {number} minSec  lower bound seconds
 * @param {number} maxSec  upper bound seconds
 * @returns {number}       milliseconds
 */
export function skewedDelayMs(minSec, maxSec) {
  const min = Math.max(1, Number(minSec) || 30);
  const max = Math.max(min, Number(maxSec) || 90);
  const range = max - min;

  let frac;
  if (Math.random() < 0.3) {
    // Quick band: front 0..45% of range, biased low
    frac = Math.pow(Math.random(), 0.8) * 0.45;
  } else {
    // Slow band: back 45..100% of range, biased high
    frac = 0.45 + Math.pow(Math.random(), 1.3) * 0.55;
  }

  const seconds = min + frac * range;
  const jitterMs = (Math.random() - 0.5) * 800; // +- 0.4s of noise
  return Math.max(min * 1000, Math.round(seconds * 1000 + jitterMs));
}

/**
 * Apply a +/- pct jitter to a base value. e.g. jitter(60, 0.15) -> ~51..69.
 */
export function jitter(base, pct = 0.1) {
  const delta = base * pct * (Math.random() * 2 - 1);
  return Math.max(0, base + delta);
}

/** Fisher-Yates shuffle (in-place returns same array). Useful for queue priorities. */
export function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

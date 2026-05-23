/**
 * retry.js
 *
 * Tiny retry helper. Used for tab-load polling, follow-button searches,
 * and anything else that's flaky but cheap to retry. Caller owns the
 * "should I retry?" decision via the predicate; we just orchestrate
 * the timing.
 */

import { sleep } from './delays.js';

/**
 * @param {() => Promise<T>} fn         the operation
 * @param {object}           [opts]
 * @param {number}           [opts.attempts=3]      max attempts including the first
 * @param {number}           [opts.baseDelayMs=500] starting backoff
 * @param {number}           [opts.maxDelayMs=8000] cap on backoff
 * @param {(err, attempt) => boolean} [opts.shouldRetry] return false to give up early
 * @returns {Promise<T>}
 * @template T
 */
export async function retry(fn, opts = {}) {
  const attempts = opts.attempts ?? 3;
  const baseDelayMs = opts.baseDelayMs ?? 500;
  const maxDelayMs = opts.maxDelayMs ?? 8000;
  const shouldRetry = opts.shouldRetry || (() => true);

  let lastErr;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt >= attempts || !shouldRetry(err, attempt)) throw err;
      // Exponential backoff with jitter (avoids thundering herd on tab reloads)
      const exp = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt - 1));
      const jit = exp * (0.5 + Math.random() * 0.5);
      await sleep(jit);
    }
  }
  throw lastErr;
}

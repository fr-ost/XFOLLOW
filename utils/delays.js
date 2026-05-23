/**
 * delays.js
 *
 * Two patterns matter here:
 *
 *   1. `sleep(ms)` is the standard primitive. Cheap, no surprises.
 *
 *   2. `wallClockWait(ms, { isPaused, isCancelled })` is for long waits that
 *      must SURVIVE Chrome's background-tab throttling. When a tab is
 *      backgrounded, setTimeout is throttled to ~1/min. A naive
 *      `for(let i=N; i>0; i--) sleep(1000)` will drift to many minutes
 *      per second. We anchor on Date.now() so even if a wake-up arrives
 *      late, the next iteration recomputes "remaining" from the deadline
 *      and exits as soon as it's <=0.
 *
 *      pause/cancel are passed as zero-arg functions returning booleans so
 *      the caller can mutate state externally without us holding stale
 *      closures over their flags.
 */

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, Math.max(0, ms | 0)));
}

/**
 * @param {number} totalMs                   how long to wait
 * @param {object} [opts]
 * @param {() => boolean} [opts.isPaused]    when true, the countdown freezes (deadline shifts)
 * @param {() => boolean} [opts.isCancelled] when true, returns immediately with { cancelled: true }
 * @param {(remainingMs: number) => void} [opts.onTick] fires roughly every second
 * @returns {Promise<{ cancelled: boolean, drainedMs: number }>}
 */
export async function wallClockWait(totalMs, opts = {}) {
  const isPaused = opts.isPaused || (() => false);
  const isCancelled = opts.isCancelled || (() => false);
  const onTick = opts.onTick || (() => {});

  let deadline = Date.now() + Math.max(0, totalMs);
  let pausedAt = null;

  while (true) {
    if (isCancelled()) return { cancelled: true, drainedMs: 0 };

    if (isPaused()) {
      // Freeze the deadline at the moment we noticed the pause; resume by
      // adding the elapsed pause time back to the deadline.
      if (pausedAt === null) pausedAt = Date.now();
      await sleep(400);
      continue;
    } else if (pausedAt !== null) {
      deadline += Date.now() - pausedAt;
      pausedAt = null;
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) return { cancelled: false, drainedMs: totalMs };

    onTick(remaining);

    // Sleep until the next whole-second boundary, capped at 1s. If Chrome
    // throttles us and we wake up "late", the next loop iteration just sees
    // a smaller remaining value and exits — the wait is self-correcting.
    const next = Math.min(1000, remaining);
    await sleep(next);
  }
}

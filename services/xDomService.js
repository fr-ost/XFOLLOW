/**
 * xDomService.js
 *
 * Every function exported here is SERIALIZABLE — it must self-contain all
 * its helpers because chrome.scripting.executeScript stringifies the
 * function and runs it in the page context with no closure access.
 *
 * Why these particular behaviours?
 *
 *   READ PHASE
 *   ──────────
 *   Before clicking, a human spends time reading the bio, browsing posts,
 *   maybe scrolling. We mimic that with a content-aware dwell: more posts
 *   and a longer bio => longer read. This is the core anti-detection
 *   signal — cold-clicking Follow within 200ms of page load is a textbook
 *   bot fingerprint.
 *
 *   HUMAN CLICK
 *   ───────────
 *   We dispatch a multi-step `pointermove` trail to the button followed by
 *   `pointerover` / `mouseover` / `pointerenter` / `mouseenter` /
 *   `pointerdown` / `mousedown` / `pointerup` / `mouseup` / `click`. Many
 *   bot detectors look for a click event that arrives without preceding
 *   pointer activity — that pattern is essentially never produced by a
 *   real cursor.
 *
 *   POST-FOLLOW LINGER & NOISE
 *   ──────────────────────────
 *   After a follow, ~60% of users idle on the profile for a few seconds
 *   before navigating away. We sometimes scroll a bit, sometimes flick
 *   the cursor, sometimes do nothing. Variability matters more than any
 *   specific action — flat, identical post-follow patterns are a flag.
 */

// ─── read phase ─────────────────────────────────────────────────────

/**
 * SERIALIZABLE. Spend time reading the profile, scrolling naturally.
 * @param {{baseMin,baseMax,contentMin,contentMax,jitterMin,jitterMax}} args
 */
export function readProfileFn(args) {
  return new Promise((resolve) => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const rand = (a, b) => Math.random() * (b - a) + a;
    const randInt = (a, b) => Math.floor(rand(a, b + 1));

    function contentFactor() {
      try {
        const articles = document.querySelectorAll('article').length;
        const images = document.querySelectorAll('img[src*="pbs.twimg.com"]').length;
        const bio = document.querySelector('[data-testid="UserDescription"]');
        const bioLen = bio ? (bio.textContent || '').length : 0;
        return Math.min(articles / 12, 1) * 0.4 +
               Math.min(images / 8, 1)    * 0.3 +
               Math.min(bioLen / 160, 1)  * 0.3;
      } catch { return 0.5; }
    }

    function flickCursor() {
      try {
        const mx = randInt(120, Math.max(150, window.innerWidth - 200));
        const my = randInt(120, Math.max(150, window.innerHeight - 200));
        const t = document.elementFromPoint(mx, my);
        if (t) {
          t.dispatchEvent(new MouseEvent('mousemove', {
            bubbles: true, cancelable: true, view: window,
            clientX: mx, clientY: my,
          }));
        }
      } catch (_) {}
    }

    (async () => {
      try {
        const cf = contentFactor();
        const baseMs = randInt(args.baseMin, args.baseMax);
        const contentMs = Math.round(rand(args.contentMin, args.contentMax) * cf);
        const jitterMs = randInt(args.jitterMin, args.jitterMax);
        const totalMs = Math.max(2500, baseMs + contentMs + jitterMs);

        const startTime = Date.now();
        let depth = 0;

        while (Date.now() - startTime < totalMs) {
          const remaining = totalMs - (Date.now() - startTime);
          if (remaining < 500) break;

          const action = Math.random();
          if (action < 0.45) {
            const amt = randInt(120, 380);
            window.scrollBy({ top: amt, behavior: 'smooth' });
            depth += amt;
          } else if (action < 0.6) {
            if (depth > 0) {
              const amt = randInt(60, 220);
              window.scrollBy({ top: -amt, behavior: 'smooth' });
              depth = Math.max(0, depth - amt);
            }
          } else if (action < 0.72) {
            flickCursor();
          }

          const pause = Math.min(remaining - 200, randInt(500, 2500));
          if (pause > 0) await sleep(pause);
        }

        // Pre-click hesitation
        await sleep(randInt(300, 1500));
        // Always end at top so the primary Follow button is in view
        window.scrollTo({ top: 0, behavior: 'smooth' });
        await sleep(randInt(700, 1300));
        resolve({ ok: true });
      } catch (err) {
        resolve({ ok: false, error: err.message });
      }
    })();
  });
}

// ─── click phase (top-of-profile button) ────────────────────────────

/**
 * SERIALIZABLE. Find the primary Follow button and click it with full
 * pointer-event simulation. Returns one of:
 *   { status: 'followed' }
 *   { status: 'already_following' }
 *   { status: 'button_not_found' }
 *   { status: 'click_no_effect' }
 *   { status: 'failed', detail }
 */
export function followClickFn() {
  return new Promise((resolve) => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const rand = (a, b) => Math.random() * (b - a) + a;
    const randInt = (a, b) => Math.floor(rand(a, b + 1));

    function findFollowButton() {
      const candidates = [...document.querySelectorAll('[data-testid$="-follow"]')];
      const viable = [];
      for (const btn of candidates) {
        const tid = btn.getAttribute('data-testid') || '';
        if (tid.endsWith('-unfollow')) continue;
        const txt = (btn.textContent || '').trim();
        if (!(txt === 'Follow' || txt === 'Follow back')) continue;
        const inSidebar =
          btn.closest('[aria-label*="Who to follow"]') ||
          btn.closest('[aria-label*="who to follow"]') ||
          btn.closest('[data-testid="UserCell"]');
        if (inSidebar) continue;
        const rect = btn.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        viable.push({ btn, top: rect.top, width: rect.width });
      }
      if (!viable.length) {
        // Last-ditch fallback: any [role="button"] with text "Follow" near the top
        const all = document.querySelectorAll('[role="button"]');
        for (const btn of all) {
          const txt = (btn.textContent || '').trim();
          if (txt !== 'Follow' && txt !== 'Follow back') continue;
          const inSidebar =
            btn.closest('[aria-label*="Who to follow"]') ||
            btn.closest('[data-testid="UserCell"]');
          if (inSidebar) continue;
          const rect = btn.getBoundingClientRect();
          if (rect.top < 700 && rect.width > 30) return btn;
        }
        return null;
      }
      viable.sort((a, b) => a.top - b.top || b.width - a.width);
      return viable[0].btn;
    }

    async function humanClick(el) {
      try {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) {
          el.click();
          return;
        }

        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        const jx = (Math.random() - 0.5) * Math.min(rect.width * 0.55, 14);
        const jy = (Math.random() - 0.5) * Math.min(rect.height * 0.55, 9);
        const x = cx + jx;
        const y = cy + jy;

        // Scroll into view if cropped
        if (rect.top < 80 || rect.bottom > window.innerHeight - 60) {
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
          await sleep(randInt(450, 900));
        }

        const baseOpts = (extra = {}) => ({
          bubbles: true, cancelable: true, view: window,
          clientX: x, clientY: y, screenX: x, screenY: y,
          button: 0, buttons: extra.buttons ?? 0,
          ...extra,
        });

        // Eased curved approach (3-6 steps with small wobble)
        const steps = randInt(3, 6);
        for (let i = 1; i <= steps; i++) {
          const t = i / steps;
          const ease = t * t * (3 - 2 * t);
          const px = x + (1 - ease) * randInt(-40, 40);
          const py = y + (1 - ease) * randInt(-25, 25);
          const moveOpts = { ...baseOpts(), clientX: px, clientY: py, screenX: px, screenY: py };
          el.dispatchEvent(new PointerEvent('pointermove', moveOpts));
          el.dispatchEvent(new MouseEvent('mousemove', moveOpts));
          await sleep(randInt(15, 45));
        }

        el.dispatchEvent(new PointerEvent('pointerover',  baseOpts()));
        el.dispatchEvent(new MouseEvent  ('mouseover',    baseOpts()));
        el.dispatchEvent(new PointerEvent('pointerenter', baseOpts()));
        el.dispatchEvent(new MouseEvent  ('mouseenter',   baseOpts()));

        await sleep(randInt(140, 380));

        el.dispatchEvent(new PointerEvent('pointerdown', baseOpts({ buttons: 1 })));
        el.dispatchEvent(new MouseEvent  ('mousedown',   baseOpts({ buttons: 1 })));
        await sleep(randInt(55, 175));
        el.dispatchEvent(new PointerEvent('pointerup', baseOpts()));
        el.dispatchEvent(new MouseEvent  ('mouseup',   baseOpts()));
        el.dispatchEvent(new MouseEvent  ('click',     baseOpts()));
      } catch (_) {
        try { el.click(); } catch (_) {}
      }
    }

    (async () => {
      try {
        // Already followed? bail quickly
        if (document.querySelector('[data-testid$="-unfollow"]')) {
          return resolve({ status: 'already_following' });
        }
        const target = findFollowButton();
        if (!target) return resolve({ status: 'button_not_found' });

        await humanClick(target);
        await sleep(randInt(900, 1700));

        // Confirm: button should now be Following or there should be an
        // -unfollow testid somewhere on the page.
        const stillSaysFollow = (target.textContent || '').trim();
        if (stillSaysFollow === 'Follow' || stillSaysFollow === 'Follow back') {
          if (!document.querySelector('[data-testid$="-unfollow"]')) {
            return resolve({ status: 'click_no_effect' });
          }
        }
        resolve({ status: 'followed' });
      } catch (err) {
        resolve({ status: 'failed', detail: err.message });
      }
    })();
  });
}

// ─── post-follow linger ─────────────────────────────────────────────

/** SERIALIZABLE. Idle on the profile briefly with mixed scroll/cursor. */
export function postFollowLingerFn() {
  return new Promise((resolve) => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const rand = (a, b) => Math.random() * (b - a) + a;
    const randInt = (a, b) => Math.floor(rand(a, b + 1));

    (async () => {
      try {
        if (Math.random() < 0.6) {
          const dwell = randInt(2000, 8000);
          const start = Date.now();

          if (Math.random() < 0.6) {
            window.scrollBy({ top: randInt(150, 420), behavior: 'smooth' });
            await sleep(randInt(700, 1500));
          }
          if (Math.random() < 0.5) {
            try {
              const mx = randInt(120, Math.max(150, window.innerWidth - 200));
              const my = randInt(120, Math.max(150, window.innerHeight - 200));
              const t = document.elementFromPoint(mx, my);
              if (t) {
                t.dispatchEvent(new MouseEvent('mousemove', {
                  bubbles: true, cancelable: true, view: window,
                  clientX: mx, clientY: my,
                }));
              }
            } catch (_) {}
          }
          const elapsed = Date.now() - start;
          if (elapsed < dwell) await sleep(dwell - elapsed);
        } else {
          await sleep(randInt(300, 900));
        }
        resolve({ ok: true });
      } catch (err) {
        resolve({ ok: false, error: err.message });
      }
    })();
  });
}

// ─── inter-follow scroll (during the wait) ──────────────────────────

/** SERIALIZABLE. Scroll naturally for `durationMs` to simulate browsing. */
export function scrollDuringWaitFn(durationMs) {
  return new Promise((resolve) => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const rand = (a, b) => Math.random() * (b - a) + a;
    const randInt = (a, b) => Math.floor(rand(a, b + 1));

    function flick() {
      try {
        const mx = randInt(120, Math.max(150, window.innerWidth - 200));
        const my = randInt(120, Math.max(150, window.innerHeight - 200));
        const t = document.elementFromPoint(mx, my);
        if (t) {
          t.dispatchEvent(new MouseEvent('mousemove', {
            bubbles: true, cancelable: true, view: window,
            clientX: mx, clientY: my,
          }));
        }
      } catch (_) {}
    }

    (async () => {
      try {
        const start = Date.now();
        let depth = 0;
        while (Date.now() - start < durationMs) {
          const remaining = durationMs - (Date.now() - start);
          if (remaining < 600) break;
          const action = Math.random();
          if (action < 0.4) {
            const amt = randInt(140, 420);
            window.scrollBy({ top: amt, behavior: 'smooth' });
            depth += amt;
          } else if (action < 0.55) {
            if (depth > 0) {
              const amt = randInt(80, 240);
              window.scrollBy({ top: -amt, behavior: 'smooth' });
              depth = Math.max(0, depth - amt);
            } else {
              const amt = randInt(100, 250);
              window.scrollBy({ top: amt, behavior: 'smooth' });
              depth += amt;
            }
          } else if (action < 0.68) {
            flick();
          }
          let pause;
          const r = Math.random();
          if      (r < 0.55) pause = randInt(700, 2000);
          else if (r < 0.85) pause = randInt(2000, 4500);
          else               pause = randInt(4500, 8000);
          pause = Math.min(remaining - 300, pause);
          if (pause > 0) await sleep(pause);
        }
        resolve({ ok: true });
      } catch (err) {
        resolve({ ok: false, error: err.message });
      }
    })();
  });
}

// ─── extract handles from current page (in-page) ────────────────────

/** SERIALIZABLE. Returns array of { handle, source: 'currentPage' }. */
export function extractHandlesFromPageFn() {
  try {
    const reserved = new Set([
      'home', 'explore', 'search', 'notifications', 'messages',
      'settings', 'i', 'intent', 'hashtag', 'share', 'login', 'signup',
      'tos', 'privacy', 'help', 'about', 'compose', 'lists', 'topics',
      'moments', 'tags', 'logout', 'communities', 'spaces', 'tweet',
      'status', 'newsletter', 'bookmarks', 'who_to_follow',
    ]);
    const out = new Set();
    const links = document.querySelectorAll('a[href]');
    for (const a of links) {
      const m = a.getAttribute('href').match(/^\/?([A-Za-z0-9_]{1,15})(?:\/|$|\?)/);
      if (!m) continue;
      const h = m[1].toLowerCase();
      if (reserved.has(h)) continue;
      if (/^\d+$/.test(h)) continue;
      out.add(h);
    }
    return [...out];
  } catch (e) {
    return [];
  }
}

/**
 * selectorEngine.js
 *
 * X/Twitter changes its DOM frequently. Hard-coding selectors throughout
 * the codebase means a single layout shift breaks the whole extension.
 *
 * This module is the SINGLE place selectors live. For each logical concept
 * we provide an ORDERED list of selectors — engine tries each in turn.
 * If they all miss, callers know to bail out gracefully.
 *
 * `findFollowButtonOnProfile()` is a smarter variant: it does additional
 * disqualification (skip Who-to-follow sidebar, Following/Pending/Unfollow
 * states, etc.) so the SW never accidentally clicks a sidebar suggestion.
 *
 * Everything in this module is designed to be SERIALIZABLE — i.e. it can
 * be passed as the `func` argument to chrome.scripting.executeScript and
 * still work, since it has no external imports.
 */

// ─── Selector dictionary (used in-page) ─────────────────────────────

export const SELECTORS = Object.freeze({
  followButton: [
    '[data-testid$="-follow"]',
    '[role="button"][aria-label^="Follow @"]',
    '[role="button"][aria-label^="Follow back"]',
  ],
  unfollowButton: [
    '[data-testid$="-unfollow"]',
    '[aria-label^="Following @"]',
  ],
  userCell: [
    '[data-testid="UserCell"]',
    '[data-testid="cellInnerDiv"]',
    'article[role="article"]',
  ],
  userDescription: [
    '[data-testid="UserDescription"]',
    '[data-testid="userBio"]',
  ],
  verifiedBadge: [
    'svg[aria-label="Verified account"]',
    'svg[aria-label="Verified"]',
    '[aria-label*="Verified"]',
    '[data-testid="verifiedBadge"]',
  ],
  protectedBadge: [
    'svg[aria-label*="Protected"]',
    'svg[aria-label*="protected"]',
  ],
  followsYouIndicator: [
    '[data-testid="userFollowIndicator"]',
  ],
  profileAvatar: [
    '[data-testid="UserAvatar-Container-unknown"] img',
    'a[href*="/photo"] img[src*="profile_images"]',
    'img[src*="profile_images"]',
  ],
  whoToFollowContainer: [
    '[aria-label*="Who to follow"]',
    '[aria-label*="who to follow"]',
  ],
  loginRequired: [
    '[data-testid="loginButton"]',
    'a[href="/login"]',
  ],
});

// ─── In-page helpers (serializable) ─────────────────────────────────

/**
 * Resolve the first selector in the chain that matches anything within
 * `root`. Returns the matching element, or null.
 *
 * @param {Element} root
 * @param {string[]} chain
 * @returns {Element|null}
 */
export function querySelectorChain(root, chain) {
  for (const sel of chain) {
    try {
      const el = root.querySelector(sel);
      if (el) return el;
    } catch (_) {} // bad CSS or detached node — try next
  }
  return null;
}

export function querySelectorAllChain(root, chain) {
  for (const sel of chain) {
    try {
      const list = root.querySelectorAll(sel);
      if (list && list.length) return [...list];
    } catch (_) {}
  }
  return [];
}

// ─── In-page: detect "is this profile already followed?" ────────────

/**
 * SERIALIZABLE: pass to chrome.scripting.executeScript({ func: ... }).
 * Returns { status: 'already_following' | 'unavailable' | 'login_required' | 'ready', detail? }
 */
export function inspectProfileStateFn() {
  try {
    // Account state messages
    const text = (document.body && document.body.innerText) || '';
    if (text.includes("doesn't exist") ||
        text.includes('Account suspended') ||
        text.includes('This account has been suspended') ||
        text.includes('Caught in the middle of a')) {
      return { status: 'unavailable', detail: 'profile_unavailable' };
    }

    // Logged out?
    if (document.querySelector('[data-testid="loginButton"]') ||
        location.pathname === '/login' ||
        location.pathname === '/i/flow/login') {
      return { status: 'login_required' };
    }

    // Already following?
    if (document.querySelector('[data-testid$="-unfollow"]')) {
      return { status: 'already_following' };
    }
    const buttons = document.querySelectorAll('[role="button"]');
    for (const b of buttons) {
      const t = (b.textContent || '').trim();
      if (t === 'Following' || t === 'Pending') return { status: 'already_following' };
    }

    return { status: 'ready' };
  } catch (e) {
    return { status: 'ready' };
  }
}

// ─── In-page: find the MAIN profile-page Follow button ──────────────

/**
 * SERIALIZABLE. Used in profile-queue mode, where we open the user's
 * profile page and need the prominent Follow button at the top.
 *
 * Strategy:
 *   1. Find every `[data-testid$="-follow"]` outside the Who-To-Follow
 *      sidebar and outside any UserCell row.
 *   2. Of those, pick the one in the top half of the viewport (the prim
 *      action) — falls back to the first match.
 *
 * Returns null if nothing qualifies.
 */
export function findProfileFollowButtonFn() {
  try {
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

    if (!viable.length) return null;
    // Prefer top-of-viewport, wider buttons (the primary CTA is wider than
    // the small inline ones)
    viable.sort((a, b) => a.top - b.top || b.width - a.width);
    return viable[0].btn;
  } catch (_) {
    return null;
  }
}

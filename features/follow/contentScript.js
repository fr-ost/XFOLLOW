/**
 * contentScript.js
 *
 * Runs INSIDE x.com / twitter.com pages. Two responsibilities:
 *
 *   1. LIST-WALKER MODE (the main job)
 *      Walks visible UserCell rows on followers / following / search /
 *      hashtag / list-members pages, applies the user's filter set, and
 *      clicks the row's inline Follow button. Every row passes through a
 *      single eligibility funnel (`isEligible`), so a future filter is
 *      one branch in one place.
 *
 *   2. BRIDGE SERVICES
 *      - GET_PROFILE: returns the logged-in user's name/handle/avatar so
 *        the popup can say "Hey, @user".
 *      - EXTRACT_HANDLES: returns handles visible on the current page
 *        (used by the Discover panel to seed the profile-queue).
 *      - GET_CONTEXT: returns metadata about what kind of page we're on
 *        (followers, following, search, hashtag, etc).
 *
 * Tab-throttle mitigation:
 *   When a tab is backgrounded, setTimeout is throttled to ~1/min. We
 *   use a silent AudioContext oscillator (Chrome won't aggressively
 *   throttle audio-producing tabs) AND wall-clock countdowns (so even if
 *   a wakeup is late, the loop self-corrects against Date.now()).
 *
 * IMPORTANT: this file is loaded as a classic content script (not a
 * module — Manifest V3 doesn't support module content scripts cleanly),
 * so it's self-contained. No imports.
 */

(() => {
  'use strict';

  // ─── Constants ────────────────────────────────────────────────────
  const HOUR_MS = 60 * 60 * 1000;

  const DEFAULT_SETTINGS = {
    minDelaySec: 35,
    maxDelaySec: 90,
    hourlyCap: 30,
    dailyCap: 200,
    longPauseAfterMin: 10,
    longPauseAfterMax: 20,
    longPauseMinSec: 180,
    longPauseMaxSec: 420,
    burstChance: 0.08,
    warmupMode: false,

    skipVerified: false,
    verifiedOnly: false,
    skipProtected: true,
    skipFollowsMe: false,
    requireProfilePicture: false,
    requireBio: false,

    minFollowers: 0,
    maxFollowers: 0,
    maxFollowing: 0,
    minPosts: 0,

    smartScoring: false,
    qualityThreshold: 55,
    includeKeywords: '',
    excludeKeywords: '',

    followBackFilter: false,
    minFollowRatio: 0.5,

    soundOnFollow: false,
    whitelist: [],
  };

  // ─── State (module-scoped) ────────────────────────────────────────
  const state = {
    running: false,
    paused: false,
    mode: 'idle',
    sessionFollowed: 0,
    sessionScanned: 0,
    sessionSkipped: 0,
    seen: new Set(),
    startedAt: null,
    keepAliveCtx: null,
    keepAliveOsc: null,
    settings: null,
    lastNotifyAt: 0,
  };

  // ─── Utilities ────────────────────────────────────────────────────
  const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms | 0)));
  const rand = (a, b) => Math.random() * (b - a) + a;
  const randInt = (a, b) => Math.floor(rand(a, b + 1));

  function notify(msg, type = 'progress') {
    // Throttle progress notifications so we don't flood the popup
    const now = Date.now();
    if (type === 'progress' && now - state.lastNotifyAt < 250) return;
    state.lastNotifyAt = now;
    try {
      chrome.runtime.sendMessage({
        type: 'WALKER_PROGRESS',
        message: msg,
        running: state.running,
        paused: state.paused,
        followed: state.sessionFollowed,
        scanned: state.sessionScanned,
        skipped: state.sessionSkipped,
        elapsedSec: state.startedAt ? Math.floor((now - state.startedAt) / 1000) : 0,
      }).catch(() => {});
    } catch (_) {}
  }

  // ─── Tab keep-alive (silent audio oscillator) ────────────────────
  function startKeepAlive() {
    try {
      if (state.keepAliveCtx) return;
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      const ctx = new AC();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      gain.gain.value = 0;
      osc.frequency.value = 1;
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      state.keepAliveCtx = ctx;
      state.keepAliveOsc = osc;
      if (ctx.state === 'suspended') {
        const resume = () => ctx.resume().catch(() => {});
        ['click', 'keydown', 'mousemove'].forEach((ev) =>
          window.addEventListener(ev, resume, { once: true, passive: true })
        );
      }
    } catch (e) {
      console.warn('[X Follow Grow] keep-alive failed:', e);
    }
  }
  function stopKeepAlive() {
    try {
      if (state.keepAliveOsc) { state.keepAliveOsc.stop(); state.keepAliveOsc.disconnect(); state.keepAliveOsc = null; }
      if (state.keepAliveCtx) { state.keepAliveCtx.close(); state.keepAliveCtx = null; }
    } catch (_) {}
  }

  // ─── Profile detection (for greeting) ────────────────────────────
  function getLoggedInProfile() {
    const result = { name: '', handle: '', avatar: '' };
    try {
      const switcher = document.querySelector('[data-testid="SideNav_AccountSwitcher_Button"]');
      if (switcher) {
        const img = switcher.querySelector('img[src]');
        if (img) result.avatar = img.src;
        const lines = (switcher.innerText || '')
          .split('\n').map((s) => s.trim()).filter(Boolean);
        const handleLine = lines.find((s) => s.startsWith('@'));
        const nameLine = lines.find((s) => !s.startsWith('@') && s.toLowerCase() !== 'more');
        if (nameLine) result.name = nameLine;
        if (handleLine) result.handle = handleLine.replace(/^@/, '');
      }
      if (!result.avatar) {
        const imgs = document.querySelectorAll('img[src*="profile_images"]');
        if (imgs[0]) result.avatar = imgs[0].src;
      }
      if (!result.name && result.handle) result.name = result.handle;
    } catch (_) {}
    return result;
  }

  // ─── Page context detection ──────────────────────────────────────
  function getPageContext() {
    const path = location.pathname;
    let kind = 'unknown';
    if (/^\/[^\/]+\/followers/.test(path)) kind = 'followers';
    else if (/^\/[^\/]+\/following/.test(path)) kind = 'following';
    else if (/^\/[^\/]+\/verified_followers/.test(path)) kind = 'verified_followers';
    else if (/^\/i\/lists\/\d+\/members/.test(path)) kind = 'list_members';
    else if (/^\/search/.test(path)) kind = 'search';
    else if (/^\/hashtag\//.test(path)) kind = 'hashtag';
    else if (/^\/[^\/]+\/?$/.test(path)) kind = 'profile';
    else if (path === '/home') kind = 'home';
    else if (path === '/explore') kind = 'explore';
    return { kind, path };
  }

  // ─── Row scanning & filtering ─────────────────────────────────────
  function isVisible(el) {
    try {
      const r = el.getBoundingClientRect();
      const st = getComputedStyle(el);
      return r.width > 0 && r.height > 0 &&
             st.display !== 'none' && st.visibility !== 'hidden' &&
             r.bottom > 0 && r.top < window.innerHeight + 600;
    } catch (_) { return false; }
  }

  function rowsOnPage() {
    let rows = [...document.querySelectorAll('[data-testid="UserCell"]')];
    if (!rows.length) {
      rows = [...document.querySelectorAll('[data-testid="cellInnerDiv"], article, [role="listitem"]')];
    }
    return rows;
  }

  function findFollowButtonInRow(row) {
    const buttons = row.querySelectorAll('button, div[role="button"]');
    for (const btn of buttons) {
      const text = (btn.innerText || btn.textContent || '').trim().toLowerCase();
      const aria = (btn.getAttribute('aria-label') || '').toLowerCase();
      const tid = (btn.getAttribute('data-testid') || '').toLowerCase();

      const isFollow =
        text === 'follow' ||
        text.includes('follow back') ||
        tid === 'follow' ||
        tid.endsWith('-follow') ||
        (aria.includes('follow') && !aria.includes('following') && !aria.includes('unfollow'));

      const isBad =
        text === 'following' ||
        text === 'unfollow' ||
        text.includes('pending') ||
        tid.endsWith('-unfollow') ||
        aria.includes('following') ||
        aria.includes('unfollow');

      if (isFollow && !isBad) return btn;
    }
    return null;
  }

  function getUsernameFromRow(row) {
    try {
      const links = row.querySelectorAll('a[role="link"][href^="/"]');
      for (const a of links) {
        const m = (a.getAttribute('href') || '').match(/^\/([A-Za-z0-9_]{1,15})(?:$|\/)/);
        if (m) return m[1].toLowerCase();
      }
      const m2 = (row.innerText || '').match(/@([A-Za-z0-9_]{2,15})/);
      if (m2) return m2[1].toLowerCase();
    } catch (_) {}
    return '';
  }

  function looksVerified(row, rowText) {
    try {
      if (rowText.includes('verified')) return true;
      if (row.querySelector('svg[aria-label*="erified"]')) return true;
      let n = row;
      for (let i = 0; i < 4 && n; i++) {
        const label = (n.getAttribute && n.getAttribute('aria-label') || '').toLowerCase();
        if (label.includes('verified')) return true;
        n = n.parentElement;
      }
    } catch (_) {}
    return false;
  }

  function hasFollowsYouIndicator(row, rowText) {
    if (!row) return rowText.includes('follows you');
    try {
      if ((row.innerText || '').toLowerCase().includes('follows you')) return true;
      if (row.querySelector('[data-testid="userFollowIndicator"]')) return true;
    } catch (_) {}
    return false;
  }

  function parseFollowerCount(text) {
    const patterns = [
      /([\d.,]+)\s*([kmb])?\s*followers/i,
      /followers\s*([\d.,]+)\s*([kmb])?/i,
    ];
    for (const p of patterns) {
      const m = text.match(p);
      if (m) {
        let n = parseFloat(String(m[1]).replace(/,/g, ''));
        if (Number.isNaN(n)) return null;
        const u = (m[2] || '').toLowerCase();
        if (u === 'k') n *= 1e3;
        if (u === 'm') n *= 1e6;
        if (u === 'b') n *= 1e9;
        return Math.round(n);
      }
    }
    return null;
  }

  function parseFollowingCount(text) {
    const m = text.match(/([\d.,]+)\s*([kmb])?\s*following/i);
    if (!m) return null;
    let n = parseFloat(String(m[1]).replace(/,/g, ''));
    if (Number.isNaN(n)) return null;
    const u = (m[2] || '').toLowerCase();
    if (u === 'k') n *= 1e3;
    if (u === 'm') n *= 1e6;
    if (u === 'b') n *= 1e9;
    return Math.round(n);
  }

  function parseFollowRatio(text) {
    const followers = parseFollowerCount(text);
    const following = parseFollowingCount(text);
    if (followers === null || following === null || followers === 0) return null;
    return following / followers;
  }

  function hasProfilePicture(row) {
    try {
      // Default avatars include 'default_profile' in the URL; real ones don't
      const imgs = row.querySelectorAll('img[src*="profile_images"]');
      if (!imgs.length) return false;
      for (const img of imgs) {
        if (!/default_profile/i.test(img.src)) return true;
      }
      return false;
    } catch (_) { return false; }
  }

  function bioLength(row) {
    try {
      const bio = row.querySelector('[data-testid="UserDescription"]');
      return bio ? (bio.textContent || '').trim().length : 0;
    } catch (_) { return 0; }
  }

  function looksLikeBot(username) {
    if (!username) return false;
    // Trailing 5+ digit numeric run is a classic bot pattern
    if (/[0-9]{6,}$/.test(username)) return true;
    // Lots of consecutive underscores is also suspicious
    if (/_{3,}/.test(username)) return true;
    return false;
  }

  function smartScore(btn, row, rowText, settings, verified) {
    let score = 0;
    if (verified) score += 25;
    if (!rowText.includes('private') && !rowText.includes('protected')) score += 10;
    if (rowText.length > 80) score += 15;

    const username = getUsernameFromRow(row);
    if (username && username.length >= 4 && username.length <= 18) score += 10;
    if (username && !looksLikeBot(username)) score += 10;

    const followers = parseFollowerCount(rowText);
    if (followers !== null) {
      if (followers >= 1000) score += 10;
      if (followers >= 10000) score += 10;
      if (followers > 1_000_000) score -= 10;
    } else {
      score += 5; // benefit of the doubt
    }

    const badWords = [
      'airdrop', 'giveaway', 'free money', 'promo', 'casino',
      'betting', 'onlyfans', 'adult', 'crypto pump',
    ];
    if (badWords.some((w) => rowText.includes(w))) score -= 30;

    const include = String(settings.includeKeywords || '')
      .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    if (include.length && include.some((k) => rowText.includes(k))) score += 20;

    return score >= (Number(settings.qualityThreshold) || 55);
  }

  /**
   * Single funnel for "should we follow this row?".
   * Returns one of:
   *   { ok: true, btn, username }
   *   { ok: false, reason }
   */
  function isEligible(row, settings) {
    if (!isVisible(row)) return { ok: false, reason: 'not_visible' };

    let rowText;
    try { rowText = (row.innerText || '').toLowerCase(); }
    catch (_) { return { ok: false, reason: 'unreadable' }; }

    const btn = findFollowButtonInRow(row);
    if (!btn || !isVisible(btn)) return { ok: false, reason: 'no_follow_btn' };
    if (rowText.includes('pending')) return { ok: false, reason: 'pending' };

    const username = getUsernameFromRow(row);
    if (!username) return { ok: false, reason: 'no_username' };
    if (state.seen.has(username)) return { ok: false, reason: 'already_seen' };

    const wl = (settings.whitelist || []).map((s) => s.toLowerCase());
    if (wl.includes(username)) return { ok: false, reason: 'whitelisted' };

    if (settings.skipFollowsMe && hasFollowsYouIndicator(row, rowText)) {
      return { ok: false, reason: 'follows_me' };
    }

    const verified = looksVerified(row, rowText);
    if (settings.verifiedOnly && !verified) return { ok: false, reason: 'not_verified' };
    if (settings.skipVerified && verified) return { ok: false, reason: 'verified' };

    if (settings.skipProtected && (rowText.includes('protected') || rowText.includes('private'))) {
      return { ok: false, reason: 'protected' };
    }

    if (settings.requireProfilePicture && !hasProfilePicture(row)) {
      return { ok: false, reason: 'no_pic' };
    }
    if (settings.requireBio && bioLength(row) < 5) {
      return { ok: false, reason: 'no_bio' };
    }
    if (looksLikeBot(username)) {
      // Soft flag: only block when smartScoring is on (otherwise low-noise)
      if (settings.smartScoring) return { ok: false, reason: 'bot_username' };
    }

    // Bio keyword filters
    const include = String(settings.includeKeywords || '')
      .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    if (include.length && !include.some((k) => rowText.includes(k))) {
      return { ok: false, reason: 'kw_miss_include' };
    }
    const exclude = String(settings.excludeKeywords || '')
      .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    if (exclude.length && exclude.some((k) => rowText.includes(k))) {
      return { ok: false, reason: 'kw_hit_exclude' };
    }

    // Follower bounds
    const followers = parseFollowerCount(rowText);
    if (settings.minFollowers > 0) {
      if (followers === null || followers < settings.minFollowers) {
        return { ok: false, reason: 'below_min_followers' };
      }
    }
    if (settings.maxFollowers > 0) {
      if (followers !== null && followers > settings.maxFollowers) {
        return { ok: false, reason: 'above_max_followers' };
      }
    }
    if (settings.maxFollowing > 0) {
      const fing = parseFollowingCount(rowText);
      if (fing !== null && fing > settings.maxFollowing) {
        return { ok: false, reason: 'above_max_following' };
      }
    }

    // Follow-back ratio (followers/following)
    if (settings.followBackFilter) {
      const ratio = parseFollowRatio(rowText);
      if (ratio === null) return { ok: false, reason: 'ratio_unknown' };
      // The original Elite extension used following/followers; we invert
      // here so that "high followers, low following" => high ratio => good.
      // But we keep the user's setting intuitive: minFollowRatio is the
      // inverted following/followers, matching the original.
      if (ratio < Number(settings.minFollowRatio || 0.5)) {
        return { ok: false, reason: 'low_followback_ratio' };
      }
    }

    if (settings.smartScoring && !smartScore(btn, row, rowText, settings, verified)) {
      return { ok: false, reason: 'low_smart_score' };
    }

    return { ok: true, btn, username, row, verified };
  }

  // Extract a small profile snapshot from a row for the popup live-preview
  function getRowProfile(row, username, verified) {
    const profile = {
      handle: username || '',
      displayName: '',
      avatarUrl: '',
      bio: '',
      verified: !!verified,
    };
    try {
      // Display name: first <span> with non-empty text inside the user-name testid
      const nameEl = row.querySelector('[data-testid="UserName"] span, [data-testid="User-Name"] span');
      if (nameEl) profile.displayName = (nameEl.textContent || '').trim().slice(0, 80);
      // Avatar: first img in the row
      const img = row.querySelector('img[src*="profile_images"], img[src*="pbs.twimg.com/profile"]');
      if (img && img.src) profile.avatarUrl = img.src;
      else {
        const anyImg = row.querySelector('img[src]');
        if (anyImg) profile.avatarUrl = anyImg.src;
      }
      // Bio: lines after the username, excluding the username line itself
      const lines = (row.innerText || '').split('\n').map((s) => s.trim()).filter(Boolean);
      const idx = lines.findIndex((l) => l.toLowerCase().includes('@' + (username || '')));
      if (idx >= 0 && lines[idx + 1]) {
        profile.bio = lines.slice(idx + 1, idx + 4).join(' ').slice(0, 160);
      }
    } catch (_) {}
    return profile;
  }

  // ─── Synthetic hover before click ────────────────────────────────
  function fireMouse(type, el, x, y) {
    try {
      el.dispatchEvent(new MouseEvent(type, {
        bubbles: true, cancelable: true, view: window,
        clientX: x, clientY: y, screenX: x, screenY: y, button: 0,
      }));
    } catch (_) {}
  }
  function simulateHover(target) {
    try {
      const r = target.getBoundingClientRect();
      const tx = r.left + r.width * (0.35 + Math.random() * 0.30);
      const ty = r.top + r.height * (0.35 + Math.random() * 0.30);
      const sx = tx + (Math.random() * 120 - 60);
      const sy = ty + (Math.random() * 120 - 60);
      const steps = 4 + Math.floor(Math.random() * 4);
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const x = sx + (tx - sx) * t + (Math.random() * 4 - 2);
        const y = sy + (ty - sy) * t + (Math.random() * 4 - 2);
        fireMouse('mousemove', target, x, y);
      }
      fireMouse('mouseover', target, tx, ty);
      fireMouse('mouseenter', target, tx, ty);
    } catch (_) {}
  }

  // ─── Audio cue on follow ─────────────────────────────────────────
  function playBeep() {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      const ctx = new AC();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = 660;
      gain.gain.setValueAtTime(0.0001, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.06, ctx.currentTime + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.12);
      osc.connect(gain); gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.13);
      setTimeout(() => ctx.close().catch(() => {}), 250);
    } catch (_) {}
  }

  // ─── Wall-clock countdown (throttle-safe) ────────────────────────
  async function countdown(label, totalSec, message) {
    totalSec = Math.max(1, Math.floor(Number(totalSec) || 1));
    const totalMs = totalSec * 1000;
    const deadline = Date.now() + totalMs;
    // Tell the SW where the next action will land — drives popup timer ring
    try {
      chrome.runtime.sendMessage({
        type: 'WALKER_TIMER',
        nextActionAt: deadline,
        currentDelayMs: totalMs,
        label,
        message,
      }).catch(() => {});
    } catch (_) {}
    while (state.running) {
      if (state.paused) {
        // While paused, freeze the timer at the current remaining and wait.
        try {
          chrome.runtime.sendMessage({
            type: 'WALKER_TIMER',
            nextActionAt: Date.now() + 1, // stop animating
            currentDelayMs: 0,
            label,
            message: 'Paused',
          }).catch(() => {});
        } catch (_) {}
        await sleep(500);
        continue;
      }
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) break;
      notify(`${message} · ${Math.ceil(remainingMs / 1000)}s`);
      await sleep(Math.min(1000, remainingMs));
    }
    // Timer done — clear it so popup shows "Working…"
    try {
      chrome.runtime.sendMessage({
        type: 'WALKER_TIMER',
        nextActionAt: null,
        currentDelayMs: 0,
        label,
        message: 'Working',
      }).catch(() => {});
    } catch (_) {}
  }

  // ─── Local lock detection ────────────────────────────────────────
  function detectLockOnPage() {
    try {
      const text = (document.body && document.body.innerText || '').toLowerCase();
      const phrases = [
        'unable to follow more people',
        'rate limit',
        'try again later',
        'are you a robot',
        'verify you are human',
        'account has been locked',
        'caught in the middle of',
        'suspicious activity',
      ];
      for (const p of phrases) if (text.includes(p)) return p;
      if (document.querySelector('iframe[src*="arkose"], iframe[src*="captcha"], iframe[src*="funcaptcha"]')) {
        return 'captcha_iframe';
      }
    } catch (_) {}
    return null;
  }

  // ─── Hourly cap (read-only — SW owns the daily cap) ──────────────
  let hourlyHistory = []; // ms timestamps of in-tab follows this session
  function pruneHourly() {
    const now = Date.now();
    hourlyHistory = hourlyHistory.filter((t) => now - t <= HOUR_MS);
  }
  function hourlyCount() {
    pruneHourly();
    return hourlyHistory.length;
  }

  // ─── Main loop ───────────────────────────────────────────────────
  async function loop() {
    let ctx = getPageContext();
    let consecutiveScrollMisses = 0;

    while (state.running) {
      if (state.paused) { await sleep(500); continue; }

      // Lock detection between every iteration (cheap)
      const lock = detectLockOnPage();
      if (lock) {
        notify(`⚠ Halted: ${lock}`);
        try {
          chrome.runtime.sendMessage({ type: 'WALKER_HALT', reason: lock }).catch(() => {});
        } catch (_) {}
        await stop('Safety halt: ' + lock);
        return;
      }

      // Daily cap check via SW
      let capRes;
      try {
        capRes = await chrome.runtime.sendMessage({ type: 'CHECK_CAPS' });
      } catch (_) { capRes = { allowed: true }; }
      if (capRes && capRes.allowed === false) {
        notify('Cap reached — pausing');
        try {
          chrome.runtime.sendMessage({ type: 'WALKER_HALT', reason: capRes.reason || 'cap_reached' }).catch(() => {});
        } catch (_) {}
        await stop('Cap reached');
        return;
      }

      // Hourly cap enforced locally (safety blanket on top of SW)
      if (hourlyCount() >= state.settings.hourlyCap) {
        notify('Hourly cap reached — sleeping');
        await countdown('cap-cooldown', 5 * 60, 'Hourly cap cooldown');
        continue;
      }

      // Find a follow target
      const rows = rowsOnPage();
      let chosen = null;
      for (const row of rows) {
        const r = isEligible(row, state.settings);
        if (r.ok) { chosen = r; break; }
        if (r.username) state.seen.add(r.username);
      }

      if (!chosen) {
        consecutiveScrollMisses++;
        // Bail if we've scrolled many times with no eligible rows
        if (consecutiveScrollMisses > 15) {
          notify('No more eligible follows on this page');
          await stop('Page exhausted');
          return;
        }
        const offset = Math.round(window.innerHeight * (0.6 + Math.random() * 0.35));
        try { window.scrollBy({ top: offset, behavior: 'smooth' }); }
        catch (_) {}
        await countdown('scroll', 3, 'Scrolling');
        continue;
      }
      consecutiveScrollMisses = 0;

      state.seen.add(chosen.username);
      state.sessionScanned++;

      // Build the profile snapshot for the popup live-preview card
      const profile = getRowProfile(chosen.row, chosen.username, chosen.verified);
      try {
        chrome.runtime.sendMessage({
          type: 'WALKER_PROFILE',
          handle: profile.handle,
          displayName: profile.displayName,
          avatarUrl: profile.avatarUrl,
          bio: profile.bio,
          verified: profile.verified,
          status: 'scanning',
        }).catch(() => {});
      } catch (_) {}
      notify(`Scanned @${chosen.username}`);

      try {
        chosen.btn.scrollIntoView({ block: 'center', behavior: 'smooth' });
        window.scrollBy({ top: -20 + Math.floor(Math.random() * 40), behavior: 'smooth' });
      } catch (_) {}

      await sleep(randInt(550, 1400));
      try { simulateHover(chosen.btn); } catch (_) {}
      await sleep(randInt(120, 380));

      try {
        chosen.btn.click();
        state.sessionFollowed++;
        hourlyHistory.push(Date.now());
        if (state.settings.soundOnFollow) playBeep();
        notify(`Followed @${chosen.username}`);
        // Inform the SW for daily-cap accounting
        try {
          chrome.runtime.sendMessage({
            type: 'WALKER_FOLLOWED',
            username: chosen.username,
            sourceUrl: location.href,
          }).catch(() => {});
          // Mark profile as followed in the live preview
          chrome.runtime.sendMessage({
            type: 'WALKER_PROFILE',
            handle: profile.handle,
            displayName: profile.displayName,
            avatarUrl: profile.avatarUrl,
            bio: profile.bio,
            verified: profile.verified,
            status: 'followed',
          }).catch(() => {});
        } catch (_) {}
      } catch (e) {
        state.sessionSkipped++;
        notify(`Click failed for @${chosen.username}`);
        try {
          chrome.runtime.sendMessage({
            type: 'WALKER_SKIPPED',
            username: chosen.username,
            reason: 'click_failed',
          }).catch(() => {});
        } catch (_) {}
        await sleep(randInt(800, 1400));
        continue;
      }

      // Per-action delay with jitter
      const base = randInt(state.settings.minDelaySec, state.settings.maxDelaySec);
      const jitt = base * (Math.random() * 0.20 - 0.10);
      const delay = Math.max(3, Math.round(base + jitt));
      await countdown('next', delay, 'Waiting before next');
    }
  }

  // ─── Lifecycle ───────────────────────────────────────────────────
  async function start() {
    if (state.running) return;
    let stored;
    try { stored = await chrome.storage.sync.get(DEFAULT_SETTINGS); }
    catch (_) { stored = { ...DEFAULT_SETTINGS }; }
    state.settings = { ...DEFAULT_SETTINGS, ...stored };
    state.running = true;
    state.paused = false;
    state.sessionFollowed = 0;
    state.sessionScanned = 0;
    state.sessionSkipped = 0;
    state.seen.clear();
    state.startedAt = Date.now();
    state.mode = 'list-walker';
    hourlyHistory = [];
    startKeepAlive();
    notify('List-walker started');
    // Notify SW so caps + analytics + popup state stay consistent
    try {
      chrome.runtime.sendMessage({
        type: 'WALKER_STARTED',
        pageKind: getPageContext().kind,
        pageUrl: location.href,
        loggedInProfile: getLoggedInProfile(),
      }).catch(() => {});
    } catch (_) {}
    loop().catch((e) => {
      console.error('[X Follow Grow] walker crashed:', e);
      stop('Walker error: ' + e.message);
    });
  }
  async function pause() {
    state.paused = true;
    notify('Paused');
    try { chrome.runtime.sendMessage({ type: 'WALKER_PAUSED' }).catch(() => {}); } catch (_) {}
  }
  async function resume() {
    state.paused = false;
    notify('Resumed');
    try { chrome.runtime.sendMessage({ type: 'WALKER_RESUMED' }).catch(() => {}); } catch (_) {}
  }
  async function stop(reason = 'Stopped') {
    if (!state.running) return;
    state.running = false;
    state.paused = false;
    state.mode = 'idle';
    stopKeepAlive();
    try {
      chrome.runtime.sendMessage({
        type: 'WALKER_STOPPED',
        reason,
        followed: state.sessionFollowed,
        scanned: state.sessionScanned,
        skipped: state.sessionSkipped,
      }).catch(() => {});
    } catch (_) {}
  }

  // ─── Message bridge ──────────────────────────────────────────────
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    try {
      switch (msg && msg.type) {
        case 'GET_PROFILE':
          sendResponse({ profile: getLoggedInProfile() });
          return false;
        case 'GET_CONTEXT':
          sendResponse({ context: getPageContext(), profile: getLoggedInProfile() });
          return false;
        case 'EXTRACT_HANDLES': {
          const out = new Set();
          const links = document.querySelectorAll('a[href]');
          const reserved = new Set([
            'home','explore','search','notifications','messages','settings',
            'i','intent','hashtag','share','login','signup','tos','privacy',
            'help','about','compose','lists','topics','moments','tags',
            'logout','communities','spaces','tweet','status','newsletter',
            'bookmarks','who_to_follow',
          ]);
          for (const a of links) {
            const m = (a.getAttribute('href') || '').match(/^\/?([A-Za-z0-9_]{1,15})(?:\/|$|\?)/);
            if (!m) continue;
            const h = m[1].toLowerCase();
            if (reserved.has(h) || /^\d+$/.test(h)) continue;
            out.add(h);
          }
          sendResponse({ handles: [...out] });
          return false;
        }
        case 'WALKER_START':  start();  sendResponse({ ok: true }); return false;
        case 'WALKER_PAUSE':  pause();  sendResponse({ ok: true }); return false;
        case 'WALKER_RESUME': resume(); sendResponse({ ok: true }); return false;
        case 'WALKER_STOP':   stop('Stopped manually'); sendResponse({ ok: true }); return false;
        case 'WALKER_STATUS':
          sendResponse({
            running: state.running,
            paused: state.paused,
            mode: state.mode,
            followed: state.sessionFollowed,
            scanned: state.sessionScanned,
            skipped: state.sessionSkipped,
            elapsedSec: state.startedAt ? Math.floor((Date.now() - state.startedAt) / 1000) : 0,
          });
          return false;
        default:
          // Not for us — let other listeners handle
          return false;
      }
    } catch (e) {
      console.warn('[X Follow Grow] content msg error:', e);
      sendResponse({ ok: false, error: e.message });
      return false;
    }
  });

  // Mark the world: helps the SW know a content script is alive.
  console.log('[X Follow Grow] content script loaded on', location.host);
})();

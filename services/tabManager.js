/**
 * tabManager.js
 *
 * Profile-queue mode reuses ONE inactive tab to walk through profiles —
 * spawning a fresh tab per follow would be obvious bot behaviour and would
 * spike memory. This module is responsible for:
 *
 *   1. Finding the existing X tab (or creating one if none open)
 *   2. Navigating it to a profile URL
 *   3. Polling tab.status until it's 'complete' (or timeout)
 *
 * We poll instead of relying on chrome.webNavigation.onCompleted because
 * navigations to the same domain (SPA route changes) often don't fire
 * onCompleted again — but tab.status flips back through 'loading' to
 * 'complete' reliably.
 */

import { sleep } from '../utils/delays.js';

const MAX_TAB_WAIT_MS = 30_000;
const X_URL_PATTERNS = ['*://x.com/*', '*://twitter.com/*'];

/**
 * Find or create the working tab. Returns its tab id.
 * If there are multiple X tabs open we pick the most recently focused one.
 */
export async function getOrCreateXTab() {
  const tabs = await chrome.tabs.query({ url: X_URL_PATTERNS });
  if (tabs.length > 0) {
    // Prefer the active one, then most recent
    tabs.sort((a, b) => Number(!!b.active) - Number(!!a.active));
    return tabs[0].id;
  }
  const tab = await chrome.tabs.create({
    url: 'https://x.com/home',
    active: false,
  });
  return tab.id;
}

/**
 * Navigate `tabId` to the given handle's profile and wait for load.
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
export async function gotoProfile(tabId, handle) {
  const url = `https://x.com/${handle}`;
  try {
    await chrome.tabs.update(tabId, { url, active: false });
  } catch (e) {
    return { ok: false, error: 'navigate_failed: ' + e.message };
  }
  try {
    await waitForTabComplete(tabId);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message || 'tab_load_failed' };
  }
}

async function waitForTabComplete(tabId) {
  // 400ms head start — Chrome briefly reports 'complete' from the previous
  // page right after update() before flipping to 'loading'.
  await sleep(400);
  const start = Date.now();
  while (Date.now() - start < MAX_TAB_WAIT_MS) {
    let tab;
    try { tab = await chrome.tabs.get(tabId); }
    catch (_) { throw new Error('tab_gone'); }
    if (!tab) throw new Error('tab_gone');

    if (tab.status === 'complete') {
      const url = tab.url || '';
      if (url.includes('x.com') || url.includes('twitter.com')) return true;
    }
    await sleep(400);
  }
  throw new Error('tab_load_timeout');
}

/**
 * Execute a serializable function inside the tab. Errors swallowed and
 * returned as { ok: false, error } so callers can branch without try/catch.
 *
 * @template T
 * @param {number} tabId
 * @param {() => T} fn
 * @param {any[]} [args]
 * @returns {Promise<{ ok: boolean, result?: T, error?: string }>}
 */
export async function runInTab(tabId, fn, args = []) {
  try {
    const out = await chrome.scripting.executeScript({
      target: { tabId },
      func: fn,
      args,
      world: 'MAIN',
    });
    return { ok: true, result: out?.[0]?.result };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

/**
 * Convenience: find the most recent X tab without creating one. Returns
 * null if no X tab is open.
 */
export async function findXTab() {
  const tabs = await chrome.tabs.query({ url: X_URL_PATTERNS });
  if (!tabs.length) return null;
  tabs.sort((a, b) => Number(!!b.active) - Number(!!a.active));
  return tabs[0];
}

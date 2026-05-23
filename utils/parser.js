/**
 * parser.js
 *
 * Extract X/Twitter handles from arbitrary text/HTML. Two complementary
 * patterns:
 *   - URL form:    https://x.com/foo  /  twitter.com/foo
 *   - Mention form: @foo
 *
 * We aggressively de-dupe and filter out X's reserved routes (so that
 * "https://x.com/explore" never gets treated as a follow target).
 */

const RESERVED_ROUTES = new Set([
  'home', 'explore', 'search', 'notifications', 'messages',
  'settings', 'i', 'intent', 'hashtag', 'share', 'login', 'signup',
  'tos', 'privacy', 'help', 'about', 'compose', 'lists', 'topics',
  'moments', 'tags', 'who_to_follow', 'following', 'followers',
  'logout', 'verified_choose', 'jobs', 'communities', 'spaces',
  'oauth', 'oauth2', 'account', 'press', 'developers', 'business',
  'media', 'verified', 'login_verification', 'signup_email', 'session',
  'tweet', 'status', 'newsletter', 'bookmarks', 'lists',
]);

const URL_RE = /https?:\/\/(?:www\.)?(?:twitter\.com|x\.com|mobile\.twitter\.com)\/(@?[A-Za-z0-9_]{1,15})(?=\/|\?|#|"|'|\s|$|<|>|\)|\]|,)/gi;
const AT_RE = /(?:^|\s|>|\(|\[)@([A-Za-z0-9_]{2,15})(?=\s|$|<|\)|\]|,|\.|;|:|!)/g;

/** Validates a single handle (length, charset, not reserved). */
export function isValidHandle(h) {
  if (typeof h !== 'string') return false;
  const lc = h.replace(/^@/, '').toLowerCase();
  if (!/^[a-z0-9_]{1,15}$/.test(lc)) return false;
  if (RESERVED_ROUTES.has(lc)) return false;
  if (/^\d+$/.test(lc)) return false; // e.g. /1234567 are tweet IDs not handles
  return true;
}

/** Normalise to lowercase and strip any leading @. */
export function normalizeHandle(h) {
  return String(h || '').replace(/^@/, '').trim().toLowerCase();
}

/**
 * Extract every plausible handle from a blob of text. Returns a unique,
 * lower-cased, validated array preserving first-seen order.
 */
export function extractHandles(text) {
  if (!text) return [];
  const out = [];
  const seen = new Set();

  const push = (raw) => {
    const h = normalizeHandle(raw);
    if (!isValidHandle(h)) return;
    if (seen.has(h)) return;
    seen.add(h);
    out.push(h);
  };

  let m;
  URL_RE.lastIndex = 0;
  while ((m = URL_RE.exec(text)) !== null) push(m[1]);

  AT_RE.lastIndex = 0;
  while ((m = AT_RE.exec(text)) !== null) push(m[1]);

  return out;
}

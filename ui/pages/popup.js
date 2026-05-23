/* ============================================================
   X Follow Grow — Popup (controller)
   - Single GET_SNAPSHOT call on open, then listens to
     chrome.storage.onChanged for live updates (no polling).
   - All long-running work lives in the service worker; popup
     just renders state and dispatches commands.
   ============================================================ */

import { extractHandles as parseHandlesFromText } from '../../utils/parser.js';

// ─── Helpers ────────────────────────────────────────────────

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function send(msg) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(msg, (response) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message });
        } else {
          resolve(response || { ok: false, error: 'no response' });
        }
      });
    } catch (e) {
      resolve({ ok: false, error: String(e && e.message || e) });
    }
  });
}

function sendToTab(tabId, msg) {
  return new Promise((resolve) => {
    try {
      chrome.tabs.sendMessage(tabId, msg, (response) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message });
        } else {
          resolve(response || { ok: false });
        }
      });
    } catch (e) {
      resolve({ ok: false, error: String(e && e.message || e) });
    }
  });
}

async function getActiveTab() {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      resolve(tabs && tabs[0]);
    });
  });
}

function isXTab(tab) {
  if (!tab || !tab.url) return false;
  return /^https:\/\/(x\.com|twitter\.com|mobile\.twitter\.com)\b/.test(tab.url);
}

function fmtPct(n) {
  if (n == null || isNaN(n)) return '—';
  return Math.round(n * 100) + '%';
}

function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const now = Date.now();
  const diff = now - ts;
  if (diff < 60_000) return 'just now';
  if (diff < 60 * 60_000) return Math.floor(diff / 60_000) + 'm ago';
  if (diff < 24 * 60 * 60_000) return Math.floor(diff / 3_600_000) + 'h ago';
  return d.toLocaleDateString();
}

function fmtMmSs(ms) {
  if (!ms || ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ─── Toast & dialog ─────────────────────────────────────────

function toast(message, kind = 'info', ms = 2400) {
  const stack = $('#toastStack');
  if (!stack) return;
  const el = document.createElement('div');
  el.className = `toast toast-${kind}`;
  el.textContent = message;
  stack.appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transform = 'translateY(6px)';
    setTimeout(() => el.remove(), 200);
  }, ms);
}

function confirmDialog({ title, message, confirmText = 'Confirm', cancelText = 'Cancel', danger = false }) {
  return new Promise((resolve) => {
    const mount = $('#dialogMount');
    const html = `
      <div class="dialog-bg">
        <div class="dialog">
          <div class="dialog-body">
            <div class="dialog-title">${escapeHtml(title)}</div>
            <div class="dialog-message">${escapeHtml(message)}</div>
          </div>
          <div class="dialog-foot">
            <button type="button" class="btn btn-ghost btn-sm" data-act="cancel">${escapeHtml(cancelText)}</button>
            <button type="button" class="btn ${danger ? 'btn-danger' : 'btn-primary'} btn-sm" data-act="confirm">${escapeHtml(confirmText)}</button>
          </div>
        </div>
      </div>
    `;
    mount.innerHTML = html;
    const close = (val) => {
      mount.innerHTML = '';
      resolve(val);
    };
    mount.querySelector('[data-act="cancel"]').addEventListener('click', () => close(false));
    mount.querySelector('[data-act="confirm"]').addEventListener('click', () => close(true));
    mount.querySelector('.dialog-bg').addEventListener('click', (e) => {
      if (e.target === e.currentTarget) close(false);
    });
  });
}

function promptDialog({ title, message, placeholder = '', confirmText = 'OK' }) {
  return new Promise((resolve) => {
    const mount = $('#dialogMount');
    const html = `
      <div class="dialog-bg">
        <div class="dialog">
          <div class="dialog-body">
            <div class="dialog-title">${escapeHtml(title)}</div>
            <div class="dialog-message">${escapeHtml(message)}</div>
            <div style="height: 8px"></div>
            <input type="text" class="input" id="dialogInput" placeholder="${escapeHtml(placeholder)}" />
          </div>
          <div class="dialog-foot">
            <button type="button" class="btn btn-ghost btn-sm" data-act="cancel">Cancel</button>
            <button type="button" class="btn btn-primary btn-sm" data-act="confirm">${escapeHtml(confirmText)}</button>
          </div>
        </div>
      </div>
    `;
    mount.innerHTML = html;
    const input = mount.querySelector('#dialogInput');
    input.focus();
    const close = (val) => {
      mount.innerHTML = '';
      resolve(val);
    };
    mount.querySelector('[data-act="cancel"]').addEventListener('click', () => close(null));
    mount.querySelector('[data-act="confirm"]').addEventListener('click', () => close(input.value));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') close(input.value);
      if (e.key === 'Escape') close(null);
    });
    mount.querySelector('.dialog-bg').addEventListener('click', (e) => {
      if (e.target === e.currentTarget) close(null);
    });
  });
}

// ─── State ──────────────────────────────────────────────────

const state = {
  snapshot: null,
  walkerStatus: null,
  timerRaf: null,
  walkerTimerRaf: null,
  currentPage: 'dashboard',
};

// ─── Navigation ─────────────────────────────────────────────

function bindNav() {
  $$('.nav-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const page = btn.dataset.page;
      goToPage(page);
    });
  });
  $('#goToLogs')?.addEventListener('click', () => goToPage('logs'));
}

function goToPage(page) {
  state.currentPage = page;
  $$('.nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.page === page));
  $$('.page').forEach((p) => p.classList.toggle('active', p.id === `page-${page}`));
  const titles = {
    dashboard: 'Dashboard',
    queue: 'Queue mode',
    walker: 'Walker mode',
    logs: 'Activity Log',
  };
  $('#pageTitle').textContent = titles[page] || page;

  // Page-specific refresh
  if (page === 'walker') refreshWalkerContext();
}

// ─── Theme toggle ───────────────────────────────────────────

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme === 'light' ? 'light' : 'dark');
}

function bindThemeToggle() {
  $('#themeToggle').addEventListener('click', async () => {
    const cur = document.documentElement.getAttribute('data-theme');
    const next = cur === 'light' ? 'dark' : 'light';
    applyTheme(next);
    if (state.snapshot) {
      const settings = { ...state.snapshot.settings, theme: next };
      await send({ type: 'SET_SETTINGS', settings });
    }
  });
}

function bindSettingsLauncher() {
  const btn = document.getElementById('navSettings');
  if (!btn) return;
  btn.addEventListener('click', () => {
    try {
      // chrome.runtime.openOptionsPage opens the options_page from manifest
      // in its own tab/window per the user's Chrome settings.
      chrome.runtime.openOptionsPage(() => {
        if (chrome.runtime.lastError) {
          // Fallback: open via direct URL if options_page wasn't picked up
          chrome.tabs.create({ url: chrome.runtime.getURL('ui/pages/options.html') });
        }
        // Close the popup so user fully transitions to the options window
        window.close();
      });
    } catch (_) {
      chrome.tabs.create({ url: chrome.runtime.getURL('ui/pages/options.html') });
      window.close();
    }
  });
}

// ─── Snapshot loading & live sync ───────────────────────────

async function loadSnapshot() {
  const snap = await send({ type: 'GET_SNAPSHOT' });
  if (!snap || !snap.ok) {
    toast('Background not ready, reload the extension', 'error', 4000);
    return;
  }
  state.snapshot = snap;
  applyTheme((snap.settings && snap.settings.theme) || 'dark');
  renderAll(snap);

  // Opportunistically refresh the logged-in profile from the active X tab
  // (so users see their greeting even before walker is started)
  try {
    const tab = await getActiveTab();
    if (isXTab(tab)) {
      const resp = await sendToTab(tab.id, { type: 'GET_PROFILE' });
      if (resp && resp.profile && (resp.profile.handle || resp.profile.name)) {
        await send({ type: 'SET_LOGGED_IN_PROFILE', profile: resp.profile });
      }
    }
  } catch (_) {}
}

function bindStorageSync() {
  // Anything important changing in storage triggers a snapshot refresh.
  // Keep it light: we just call GET_SNAPSHOT (cheap, in-memory).
  let scheduled = false;
  const refresh = () => {
    if (scheduled) return;
    scheduled = true;
    setTimeout(async () => {
      scheduled = false;
      const snap = await send({ type: 'GET_SNAPSHOT' });
      if (snap && snap.ok) {
        state.snapshot = snap;
        renderAll(snap);
      }
    }, 60);
  };
  chrome.storage.onChanged.addListener(refresh);
}

// ─── Top-level renderers ────────────────────────────────────

function renderAll(snap) {
  renderModeBadge(snap);
  renderActionBar(snap);
  renderDashboard(snap);
  renderSafetyPulse(snap);
  renderRecentFeed(snap);
  renderQueueState(snap);
  renderLogs(snap);
}

// Status indicator + mode label
function renderModeBadge(snap) {
  const r = snap.runtime || {};
  const dot = $('#sidebarStatus');
  const label = $('#modeLabel');
  if (r.safetyHalted) {
    dot.className = 'sidebar-status halted'; dot.title = 'Halted: ' + r.safetyReason;
    label.textContent = 'Halted';
    return;
  }
  if (r.isRunning && r.isPaused) {
    dot.className = 'sidebar-status paused'; dot.title = 'Paused';
    label.textContent = `Paused · ${prettyMode(r.mode)}`;
    return;
  }
  if (r.isRunning) {
    dot.className = 'sidebar-status running'; dot.title = 'Running';
    label.textContent = `Running · ${prettyMode(r.mode)}`;
    return;
  }
  dot.className = 'sidebar-status'; dot.title = 'Idle';
  label.textContent = 'Idle';
}

function prettyMode(m) {
  if (m === 'profile-queue') return 'Queue';
  if (m === 'list-walker')   return 'Walker';
  return 'Idle';
}

// Per-page mode buttons + bottom status strip
function renderActionBar(snap) {
  const r = snap.runtime || {};
  const queueItems = ((snap.queue && snap.queue.queue) || []);
  const queueHasItems = queueItems.length > 0;

  // ─ Queue page buttons ─
  const qStart = $('#btnQueueStart');
  const qPause = $('#btnQueuePause');
  const qStop  = $('#btnQueueStop');
  if (qStart && qPause && qStop) {
    const isQueueMode = r.mode === 'profile-queue' && r.isRunning;
    if (!r.isRunning) {
      qStart.textContent = '▶ Start queue';
      qStart.disabled = !queueHasItems;
      qPause.disabled = true;
      qStop.disabled = true;
    } else if (isQueueMode && r.isPaused) {
      qStart.textContent = 'Resume';
      qStart.disabled = false;
      qPause.disabled = true;
      qStop.disabled = false;
    } else if (isQueueMode) {
      qStart.textContent = 'Running…';
      qStart.disabled = true;
      qPause.disabled = false;
      qStop.disabled = false;
    } else {
      // Walker is running — disable queue start to prevent collision
      qStart.textContent = 'Walker running';
      qStart.disabled = true;
      qPause.disabled = true;
      qStop.disabled = true;
    }
  }

  // ─ Walker page buttons ─
  const wStart = $('#btnWalkerStart');
  const wPause = $('#btnWalkerPause');
  const wStop  = $('#btnWalkerStop');
  if (wStart && wPause && wStop) {
    const isWalkerMode = r.mode === 'list-walker' && r.isRunning;
    if (!r.isRunning) {
      wStart.textContent = '▶ Start walker';
      wStart.disabled = false;
      wPause.disabled = true;
      wStop.disabled = true;
    } else if (isWalkerMode && r.isPaused) {
      wStart.textContent = 'Walker paused';
      wStart.disabled = true;
      wPause.textContent = 'Resume';
      wPause.disabled = false;
      wStop.disabled = false;
    } else if (isWalkerMode) {
      wStart.textContent = 'Walker running';
      wStart.disabled = true;
      wPause.textContent = 'Pause';
      wPause.disabled = false;
      wStop.disabled = false;
    } else {
      // Queue is running — disable walker start
      wStart.textContent = 'Queue running';
      wStart.disabled = true;
      wPause.disabled = true;
      wStop.disabled = true;
    }
  }

  // ─ Walker session stats ─
  const session = $('#walkerSession');
  if (session) {
    const isWalker = r.mode === 'list-walker';
    if (isWalker && r.isRunning) {
      session.classList.remove('hidden');
      setNumber('walkerFollowed', r.sessionFollowed || 0);
      setNumber('walkerSkipped',  r.sessionSkipped || 0, { bump: false });
      $('#walkerStatus').textContent = r.isPaused ? 'Paused' : (r.safetyHalted ? 'Halted' : 'Running');
    } else {
      session.classList.add('hidden');
    }
  }

  // ─ Walker live timer + current-profile card ─
  renderWalkerTimer(snap);
  renderCurrentProfile(snap);

  // ─ Bottom status strip ─
  const bar = $('#statusbar');
  if (!bar) return;
  if (!r.isRunning && !r.safetyHalted) {
    bar.classList.add('hidden');
    return;
  }
  bar.classList.remove('hidden');
  bar.classList.toggle('paused', !!r.isPaused);
  bar.classList.toggle('halted', !!r.safetyHalted);

  const modeLabel = r.mode === 'profile-queue' ? 'Queue mode' : (r.mode === 'list-walker' ? 'Walker mode' : 'Idle');
  let stateLabel;
  if (r.safetyHalted) stateLabel = 'Halted: ' + (r.safetyReason || 'unknown');
  else if (r.isPaused) stateLabel = 'Paused';
  else                 stateLabel = 'Running';

  $('#statusbarMode').textContent = `${modeLabel} · ${stateLabel}`;

  let detail = '';
  if (r.mode === 'profile-queue') {
    const q = snap.queue || {};
    detail = `${q.queueIndex || 0}/${(q.queue || []).length} · followed ${q.sessionFollowed || 0}`;
  } else if (r.mode === 'list-walker') {
    detail = `followed ${r.sessionFollowed || 0} · skipped ${r.sessionSkipped || 0}`;
  }
  $('#statusbarDetail').textContent = detail;

  const pauseBtn = $('#statusbarPause');
  if (pauseBtn) {
    pauseBtn.textContent = r.isPaused ? 'Resume' : 'Pause';
    pauseBtn.disabled = !!r.safetyHalted;
  }
}

// ─── Dashboard ──────────────────────────────────────────────

// Animated number setter — tweens from current value to target.
// Triggers a brief "bumped" CSS animation when the value increases.
const _numberAnims = new Map(); // id -> {raf, current, target}

function setNumber(id, target, opts = {}) {
  const el = document.getElementById(id);
  if (!el) return;
  const formatter = opts.format || ((n) => Math.round(n).toString());
  const tNum = Number(target) || 0;

  // Read current displayed value (parse number out of text)
  const rawCurrent = parseFloat(String(el.textContent).replace(/[^\d.\-]/g, ''));
  const current = isNaN(rawCurrent) ? 0 : rawCurrent;

  // Cancel previous animation on this element
  const prev = _numberAnims.get(id);
  if (prev && prev.raf) cancelAnimationFrame(prev.raf);

  if (current === tNum) {
    el.textContent = formatter(tNum);
    return;
  }

  // Bump animation when increasing
  if (tNum > current && opts.bump !== false) {
    el.classList.remove('bumped');
    void el.offsetWidth; // restart animation
    el.classList.add('bumped');
  }

  const startTs = performance.now();
  const duration = opts.duration || 480;
  const ease = (t) => 1 - Math.pow(1 - t, 3); // cubic-out

  const tick = (now) => {
    const t = Math.min(1, (now - startTs) / duration);
    const v = current + (tNum - current) * ease(t);
    el.textContent = formatter(v);
    if (t < 1) {
      const raf = requestAnimationFrame(tick);
      _numberAnims.set(id, { raf, current: v, target: tNum });
    } else {
      el.textContent = formatter(tNum);
      _numberAnims.delete(id);
    }
  };
  const raf = requestAnimationFrame(tick);
  _numberAnims.set(id, { raf, current, target: tNum });
}

function renderGreeting(snap) {
  const card = $('#greeting');
  const profile = (snap.runtime && snap.runtime.loggedInProfile) || null;
  if (!profile || !(profile.handle || profile.name)) {
    card.classList.add('hidden');
    return;
  }
  card.classList.remove('hidden');
  const name = profile.name || profile.handle;
  $('#greetingName').textContent = name || '';
  $('#greetingHandle').textContent = profile.handle ? '@' + profile.handle : '';
  const av = $('#greetingAvatar');
  if (profile.avatar && av.src !== profile.avatar) {
    av.src = profile.avatar;
  }
  // today's follows on the right
  const today = (snap.dashboard && snap.dashboard.today) || { followed: 0 };
  setNumber('greetingTodayNum', today.followed || 0);
}

function renderDashboard(snap) {
  const d = snap.dashboard || {};
  const today = d.today || { followed: 0, skipped: 0, failed: 0 };

  // Animated stat tiles
  setNumber('statToday',         today.followed || 0);
  setNumber('statTodaySkipped',  today.skipped || 0,  { bump: false });
  setNumber('statTodayFailed',   today.failed || 0,   { bump: false });
  setNumber('statLastHour',      d.lastHour || 0);
  $('#statHourCap').textContent  = (snap.settings && snap.settings.hourlyCap) || '—';
  $('#statSuccessRate').textContent   = fmtPct(d.successRate);
  setNumber('statTotalFollowed', d.total || 0, {
    format: (n) => `${Math.round(n)} total`,
    bump: false,
  });

  const sparkline = d.sparkline || [];
  const trendTotal = sparkline.reduce((a, b) => a + b, 0);
  setNumber('statTrendTotal', trendTotal);
  drawSparkline($('#sparkline'), sparkline);

  renderGreeting(snap);
}

function drawSparkline(canvas, data) {
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 180;
  const h = canvas.clientHeight || 28;
  if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
    canvas.width = w * dpr;
    canvas.height = h * dpr;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  if (!data || !data.length) {
    ctx.fillStyle = 'rgba(255,255,255,0.06)';
    ctx.fillRect(0, h - 1, w, 1);
    return;
  }

  const max = Math.max(1, ...data);
  const stepX = w / Math.max(1, data.length - 1);

  // Filled area path
  ctx.beginPath();
  for (let i = 0; i < data.length; i++) {
    const x = i * stepX;
    const y = h - (data[i] / max) * (h - 4) - 2;
    if (i === 0) ctx.moveTo(x, y);
    else         ctx.lineTo(x, y);
  }
  // Close down for fill
  ctx.lineTo(w, h);
  ctx.lineTo(0, h);
  ctx.closePath();
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, 'rgba(16, 185, 129, 0.30)');
  grad.addColorStop(1, 'rgba(16, 185, 129, 0.00)');
  ctx.fillStyle = grad;
  ctx.fill();

  // Stroke line
  ctx.beginPath();
  for (let i = 0; i < data.length; i++) {
    const x = i * stepX;
    const y = h - (data[i] / max) * (h - 4) - 2;
    if (i === 0) ctx.moveTo(x, y);
    else         ctx.lineTo(x, y);
  }
  ctx.strokeStyle = '#10b981';
  ctx.lineWidth = 1.5;
  ctx.lineJoin = 'round';
  ctx.stroke();

  // Last point dot
  const last = data[data.length - 1];
  const lx = (data.length - 1) * stepX;
  const ly = h - (last / max) * (h - 4) - 2;
  ctx.beginPath();
  ctx.arc(lx, ly, 2, 0, Math.PI * 2);
  ctx.fillStyle = '#10b981';
  ctx.fill();
}

// ─── Safety pulse ───────────────────────────────────────────

function renderSafetyPulse(snap) {
  const s = snap.safety || {};
  const score = s.score == null ? 0 : s.score;
  const band = s.band || { label: '—', color: '#888', note: '' };
  $('#pulseScore').textContent = score + ' / 100';
  $('#pulseBand').textContent  = band.label;
  $('#pulseDot').style.background = band.color;
  const fill = $('#pulseFill');
  fill.style.width = `${score}%`;
  fill.style.background = band.color;
  $('#pulseNote').textContent = band.note;
  $('#safetyHint').textContent = `${s.lastHour || 0}/h · ${s.lastDay || 0}/24h`;
}

// ─── Recent feed ────────────────────────────────────────────

function statusIcon(status) {
  switch (status) {
    case 'followed':    return '✓';
    case 'already':     return '↷';
    case 'skipped':     return '–';
    case 'unavailable': return '⊘';
    case 'failed':      return '✗';
    case 'protected':   return '🔒';
    default:            return '·';
  }
}

function renderRecentFeed(snap) {
  const feed = $('#recentFeed');
  const recent = (snap.dashboard && snap.dashboard.recent) || [];
  if (!recent.length) {
    feed.innerHTML = `<div class="feed-empty">No follows yet. Add handles in the Queue tab to begin.</div>`;
    return;
  }
  feed.innerHTML = recent.map((r) => `
    <div class="feed-item">
      <span class="feed-icon ${escapeHtml(r.status)}">${statusIcon(r.status)}</span>
      <span class="feed-handle"><span class="at">@</span>${escapeHtml(r.handle || '')}</span>
      <span class="feed-time">${escapeHtml(fmtTime(r.time))}</span>
    </div>
  `).join('');
}

// ─── Queue ──────────────────────────────────────────────────

function renderQueueState(snap) {
  const q = snap.queue || {};
  const r = snap.runtime || {};
  const items = q.queue || [];
  const idx = q.queueIndex || 0;
  const summary = items.length
    ? `${idx} / ${items.length} · ${q.sessionFollowed || 0} followed`
    : '—';
  $('#queueSummary').textContent = summary;
  $('#queueProgress').textContent = items.length ? `${idx}/${items.length}` : '';

  // Build a status map for quick lookup
  const resultsByHandle = new Map();
  for (const result of (q.results || [])) {
    const lc = (result.handle || '').toLowerCase();
    // Last-write-wins: results array is chronological.
    resultsByHandle.set(lc, result);
  }

  const list = $('#queueList');
  if (!items.length) {
    list.innerHTML = `
      <div class="empty">
        <div class="empty-icon">∅</div>
        <div class="empty-title">No handles loaded</div>
        <div class="empty-hint">Paste a list above and click Load handles.</div>
      </div>`;
  } else {
    // Render visible window: 80 items max
    const max = 80;
    const start = Math.max(0, Math.min(idx - 5, items.length - max));
    const slice = items.slice(start, start + max);
    list.innerHTML = slice.map((item, j) => {
      const realIndex = start + j;
      const handle = item.handle;
      const result = resultsByHandle.get((handle || '').toLowerCase());
      const status = result ? result.status : (realIndex < idx ? 'pending' : 'pending');
      const isCurrent = realIndex === idx && r.isRunning;
      return `
        <div class="queue-item ${isCurrent ? 'current' : ''}">
          <span class="queue-num">${realIndex + 1}</span>
          <span class="queue-status ${escapeHtml(status)}">${statusIcon(status)}</span>
          <span class="queue-handle">@${escapeHtml(handle || '')}</span>
          <span class="queue-meta">${item.source ? escapeHtml(item.source) : ''}</span>
        </div>
      `;
    }).join('');
  }

  // Timer card
  renderTimer(snap);
}

function renderTimer(snap) {
  const r = snap.runtime || {};
  const card = $('#timerCard');
  if (!r.isRunning || !r.nextActionAt) {
    card.classList.add('hidden');
    if (state.timerRaf) cancelAnimationFrame(state.timerRaf);
    state.timerRaf = null;
    return;
  }
  card.classList.remove('hidden');
  const total = r.currentDelayMs || 1;
  const ringFill = $('#ringFill');
  const C = 2 * Math.PI * 17; // r=17

  const tick = () => {
    const remaining = Math.max(0, r.nextActionAt - Date.now());
    $('#timerValue').textContent = fmtMmSs(remaining);
    const frac = total > 0 ? Math.max(0, Math.min(1, remaining / total)) : 0;
    ringFill.setAttribute('stroke-dasharray', String(C));
    ringFill.setAttribute('stroke-dashoffset', String(C * (1 - frac)));
    if (r.isPaused) {
      $('#timerLabel').textContent = 'Paused';
    } else if (remaining <= 0) {
      $('#timerLabel').textContent = 'Working…';
    } else {
      $('#timerLabel').textContent = 'Next action in';
    }
    state.timerRaf = requestAnimationFrame(tick);
  };
  if (state.timerRaf) cancelAnimationFrame(state.timerRaf);
  tick();
}

// ─── Walker page live timer (mirrors queue timer for walker mode) ──

function renderWalkerTimer(snap) {
  const r = snap.runtime || {};
  const card = $('#walkerTimerCard');
  if (!card) return;
  const isWalker = r.mode === 'list-walker' && r.isRunning;

  if (!isWalker) {
    card.classList.add('hidden');
    if (state.walkerTimerRaf) cancelAnimationFrame(state.walkerTimerRaf);
    state.walkerTimerRaf = null;
    return;
  }
  card.classList.remove('hidden');

  const ringFill = $('#walkerRingFill');
  const C = 2 * Math.PI * 17;

  const tick = () => {
    const next = r.nextActionAt;
    const total = r.currentDelayMs || 0;
    if (!next || next <= Date.now() + 50) {
      // No active countdown — show "working" state
      $('#walkerTimerValue').textContent = '—';
      $('#walkerTimerLabel').textContent = r.isPaused ? 'Paused' : 'Working…';
      ringFill.setAttribute('stroke-dasharray', String(C));
      ringFill.setAttribute('stroke-dashoffset', String(C));
    } else {
      const remaining = Math.max(0, next - Date.now());
      $('#walkerTimerValue').textContent = fmtMmSs(remaining);
      const frac = total > 0 ? Math.max(0, Math.min(1, remaining / total)) : 0;
      ringFill.setAttribute('stroke-dasharray', String(C));
      ringFill.setAttribute('stroke-dashoffset', String(C * (1 - frac)));
      $('#walkerTimerLabel').textContent = r.isPaused ? 'Paused' : 'Next action in';
    }
    $('#walkerTimerMeta').textContent = r.timerLabel || '';
    state.walkerTimerRaf = requestAnimationFrame(tick);
  };
  if (state.walkerTimerRaf) cancelAnimationFrame(state.walkerTimerRaf);
  tick();
}

// ─── Currently-walking profile preview card ───────────────

let _lastProfileHandle = null;

function renderCurrentProfile(snap) {
  const card = $('#currentProfileCard');
  if (!card) return;
  const r = snap.runtime || {};
  const profile = r.currentProfile;

  if (!profile || !profile.handle || r.mode !== 'list-walker' || !r.isRunning) {
    card.classList.add('hidden');
    _lastProfileHandle = null;
    return;
  }
  card.classList.remove('hidden');

  // Animate avatar pop on new handle
  if (_lastProfileHandle !== profile.handle) {
    card.classList.remove('fresh');
    void card.offsetWidth;
    card.classList.add('fresh');
    _lastProfileHandle = profile.handle;
  }

  // Avatar (avoid re-setting same src; that would re-trigger network)
  const avatar = $('#currentProfileAvatar');
  if (profile.avatarUrl && avatar.src !== profile.avatarUrl) {
    avatar.src = profile.avatarUrl;
  } else if (!profile.avatarUrl) {
    avatar.removeAttribute('src');
  }

  $('#currentProfileName').textContent = profile.displayName || '@' + profile.handle;
  $('#currentProfileHandle').textContent = '@' + profile.handle;
  $('#currentProfileBio').textContent = profile.bio || '';

  // Verified badge
  const verifiedEl = $('#currentProfileVerified');
  verifiedEl.classList.toggle('hidden', !profile.verified);

  // Status dot + text
  const dot = $('#currentProfileStatusDot');
  const statusText = $('#currentProfileStatusText');
  const status = profile.status || 'scanning';
  dot.className = 'profile-status-dot ' + status;
  const statusLabels = {
    scanning: 'Scanning…',
    following: 'Following…',
    followed: '✓ Followed',
    skipped: 'Skipped',
  };
  statusText.className = 'profile-status-text ' + status;
  statusText.textContent = statusLabels[status] || status;

  $('#currentProfileTime').textContent = fmtTime(profile.at);
}

// Queue input bindings
function bindQueueInput() {
  const input = $('#handleInput');
  const counter = $('#parsedCount');
  const handleCount = $('#handleCount');

  const updateCount = () => {
    const handles = parseHandlesFromText(input.value);
    counter.textContent = `${handles.length} parsed`;
    handleCount.textContent = handles.length;
  };
  input.addEventListener('input', updateCount);
  updateCount();

  $('#btnLoad').addEventListener('click', async () => {
    const handles = parseHandlesFromText(input.value);
    if (!handles.length) { toast('No handles found', 'warn'); return; }
    const r = await send({ type: 'LOAD_HANDLES', handles, source: 'paste' });
    if (r.ok) {
      toast(`Loaded ${r.count} handle${r.count === 1 ? '' : 's'}`, 'success');
      input.value = '';
      updateCount();
    } else {
      toast(r.error || 'Failed to load', 'error');
    }
  });

  $('#btnAppend').addEventListener('click', async () => {
    const handles = parseHandlesFromText(input.value);
    if (!handles.length) { toast('No handles found', 'warn'); return; }
    const r = await send({ type: 'APPEND_HANDLES', handles, source: 'paste' });
    if (r.ok) {
      toast(`Appended ${r.count} handle${r.count === 1 ? '' : 's'}`, 'success');
      input.value = '';
      updateCount();
    } else {
      toast(r.error || 'Failed to append', 'error');
    }
  });

  $('#btnExtractTab').addEventListener('click', async () => {
    const tab = await getActiveTab();
    if (!isXTab(tab)) {
      toast('Open an x.com page first', 'warn');
      return;
    }
    const r = await send({ type: 'EXTRACT_CURRENT_TAB' });
    if (r.ok) {
      const list = r.handles || [];
      if (!list.length) { toast('No handles found on page', 'warn'); return; }
      input.value = list.map((h) => '@' + h).join('\n');
      updateCount();
      toast(`Extracted ${list.length} handles`, 'success');
    } else {
      toast(r.error || 'Extraction failed', 'error');
    }
  });

  $('#btnExtractUrl').addEventListener('click', async () => {
    const url = await promptDialog({
      title: 'Extract handles from URL',
      message: 'Paste an x.com URL (followers/following/search/post).',
      placeholder: 'https://x.com/username/followers',
      confirmText: 'Extract',
    });
    if (!url) return;
    const r = await send({ type: 'EXTRACT_FROM_URL', url });
    if (r.ok) {
      const list = r.handles || [];
      if (!list.length) { toast('No handles found at URL', 'warn'); return; }
      input.value = list.map((h) => '@' + h).join('\n');
      updateCount();
      toast(`Extracted ${list.length} handles`, 'success');
    } else {
      toast(r.error || 'Extraction failed', 'error');
    }
  });

  $('#btnClearQueue').addEventListener('click', async () => {
    const ok = await confirmDialog({
      title: 'Clear the queue?',
      message: 'Removes all loaded handles. Results and analytics are kept.',
      confirmText: 'Clear',
      danger: true,
    });
    if (!ok) return;
    const r = await send({ type: 'CLEAR_QUEUE' });
    if (r.ok) toast('Queue cleared', 'info');
    else      toast(r.error || 'Failed', 'error');
  });
}

// Bottom status strip + per-page mode controls
function bindActionBar() {
  // Per-page Queue controls
  $('#btnQueueStart').addEventListener('click', async () => {
    if (!state.snapshot) return;
    const r = state.snapshot.runtime;
    const items = (state.snapshot.queue && state.snapshot.queue.queue) || [];
    if (!items.length) { toast('Add some handles first', 'warn'); return; }
    if (r.isRunning && r.mode !== 'profile-queue') {
      toast('Walker is running. Stop it first.', 'warn');
      return;
    }
    if (r.isRunning && r.isPaused) {
      const resp = await send({ type: 'RESUME' });
      if (resp.ok) toast('Resumed', 'success');
      return;
    }
    const resp = await send({ type: 'START_PROFILE_QUEUE', opts: {} });
    if (resp.ok) toast('Queue started', 'success');
    else         toast(resp.error || 'Failed to start', 'error');
  });

  $('#btnQueuePause').addEventListener('click', async () => {
    const resp = await send({ type: 'PAUSE' });
    if (resp.ok) toast('Paused', 'info');
  });

  $('#btnQueueStop').addEventListener('click', async () => {
    const ok = await confirmDialog({
      title: 'Stop the queue?',
      message: 'This stops the current run. Progress is saved — you can resume later.',
      confirmText: 'Stop',
      danger: true,
    });
    if (!ok) return;
    const resp = await send({ type: 'STOP' });
    if (resp.ok) toast('Stopped', 'info');
  });

  // Status strip controls (universal pause/stop for whichever mode is running)
  $('#statusbarPause').addEventListener('click', async () => {
    if (!state.snapshot) return;
    const r = state.snapshot.runtime;
    if (r.mode === 'profile-queue') {
      if (r.isPaused) {
        await send({ type: 'RESUME' });
      } else {
        await send({ type: 'PAUSE' });
      }
    } else if (r.mode === 'list-walker') {
      const tab = await getActiveTab();
      if (!isXTab(tab)) {
        toast('Pause/resume needs the X tab open', 'warn');
        return;
      }
      if (r.isPaused) {
        await sendToTab(tab.id, { type: 'WALKER_RESUME' });
      } else {
        await sendToTab(tab.id, { type: 'WALKER_PAUSE' });
      }
    }
  });

  $('#statusbarStop').addEventListener('click', async () => {
    if (!state.snapshot) return;
    const ok = await confirmDialog({
      title: 'Stop automation?',
      message: 'Halts the running mode. Progress is saved.',
      confirmText: 'Stop',
      danger: true,
    });
    if (!ok) return;
    const r = state.snapshot.runtime;
    if (r.mode === 'profile-queue') {
      await send({ type: 'STOP' });
    } else if (r.mode === 'list-walker') {
      const tab = await getActiveTab();
      if (isXTab(tab)) {
        await sendToTab(tab.id, { type: 'WALKER_STOP' });
      } else {
        // Tab gone — just clean up SW state directly
        await send({ type: 'WALKER_STOPPED', reason: 'Tab unavailable' });
      }
    }
    toast('Stopped', 'info');
  });

  // Dashboard mode-pick cards
  document.querySelectorAll('.mode-card').forEach((card) => {
    card.addEventListener('click', () => {
      const target = card.dataset.go;
      if (target) goToPage(target);
    });
  });
}

// ─── Walker context refresh (called when entering the Walker page) ──

async function refreshWalkerContext() {
  const tab = await getActiveTab();
  const ctx = $('#discoverContext');
  const ctxText = $('#ctxText');
  if (!ctx || !ctxText) return;
  if (!isXTab(tab)) {
    ctx.classList.add('warn');
    ctxText.innerHTML = 'You are not on x.com. Open a <code>x.com/&lt;handle&gt;/followers</code> or <code>/following</code> page to use the walker.';
    return;
  }
  // Try to ask the content script what it sees.
  let resp = null;
  try {
    resp = await sendToTab(tab.id, { type: 'GET_CONTEXT' });
  } catch (_) {}
  if (resp && resp.context) {
    const k = resp.context.kind || 'unknown';
    const labels = {
      followers: '✓ Followers list — perfect for walker',
      following: '✓ Following list — perfect for walker',
      verified_followers: '✓ Verified followers list — perfect for walker',
      list_members: '✓ List members — perfect for walker',
      search: '✓ Search results — perfect for walker',
      hashtag: '✓ Hashtag results — perfect for walker',
      profile: 'Profile page — open this user\'s followers or following tab to walk',
      home: 'Home timeline — open someone\'s followers/following list instead',
      explore: 'Explore — open a followers/following list to walk',
      unknown: 'Unrecognized X page',
    };
    const isGood = ['followers','following','verified_followers','list_members','search','hashtag'].includes(k);
    ctxText.textContent = labels[k] || k;
    ctx.classList.toggle('warn', !isGood);
  } else {
    ctxText.textContent = 'Reading current page…';
    ctx.classList.remove('warn');
  }
  // renderActionBar handles button enable/disable based on runtime state
}

function bindWalker() {
  const startBtn = $('#btnWalkerStart');
  const pauseBtn = $('#btnWalkerPause');
  const stopBtn  = $('#btnWalkerStop');

  // Live persist filter inputs to settings
  const filterMap = {
    fVerifiedOnly:    'verifiedOnly',
    fSkipVerified:    'skipVerified',
    fSkipFollowsMe:   'skipFollowsMe',
    fRequirePic:      'requireProfilePicture',
    fRequireBio:      'requireBio',
    fSmartScore:      'smartScoring',
    fQualityThreshold:'qualityThreshold',
    fInclude:         'includeKeywords',
    fExclude:         'excludeKeywords',
  };

  Object.keys(filterMap).forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    const handler = async () => {
      if (!state.snapshot) return;
      const key = filterMap[id];
      const value = el.type === 'checkbox' ? el.checked
                  : el.type === 'number'   ? Number(el.value)
                  : el.value;
      const settings = { ...state.snapshot.settings, [key]: value };
      state.snapshot.settings = settings;
      await send({ type: 'SET_SETTINGS', settings });
    };
    el.addEventListener('change', handler);
    if (el.type === 'number' || el.type === 'text') el.addEventListener('input', handler);
  });

  startBtn.addEventListener('click', async () => {
    if (!state.snapshot) return;
    const r = state.snapshot.runtime;
    if (r.isRunning && r.mode === 'profile-queue') {
      toast('Queue is running. Stop it first.', 'warn');
      return;
    }
    if (r.isRunning && r.mode === 'list-walker' && r.isPaused) {
      // Resume the walker
      const tab = await getActiveTab();
      if (!isXTab(tab)) { toast('Open the X tab where walker is running', 'warn'); return; }
      const resp = await sendToTab(tab.id, { type: 'WALKER_RESUME' });
      if (resp && resp.ok) toast('Resumed', 'success');
      return;
    }
    const tab = await getActiveTab();
    if (!isXTab(tab)) { toast('Open an x.com followers/following page first', 'warn'); return; }
    const resp = await sendToTab(tab.id, { type: 'WALKER_START' });
    if (resp && resp.ok) {
      toast('Walker started', 'success');
    } else {
      toast((resp && resp.error) || 'Failed to start walker', 'error');
    }
  });

  pauseBtn.addEventListener('click', async () => {
    if (!state.snapshot) return;
    const r = state.snapshot.runtime;
    const tab = await getActiveTab();
    if (!isXTab(tab)) { toast('Open the X tab where walker is running', 'warn'); return; }
    if (r.isPaused) {
      const resp = await sendToTab(tab.id, { type: 'WALKER_RESUME' });
      if (resp && resp.ok) toast('Resumed', 'success');
    } else {
      const resp = await sendToTab(tab.id, { type: 'WALKER_PAUSE' });
      if (resp && resp.ok) toast('Paused', 'info');
    }
  });

  stopBtn.addEventListener('click', async () => {
    const ok = await confirmDialog({
      title: 'Stop walker?',
      message: 'Stops scrolling and clicking on the current page.',
      confirmText: 'Stop',
      danger: true,
    });
    if (!ok) return;
    const tab = await getActiveTab();
    if (isXTab(tab)) {
      await sendToTab(tab.id, { type: 'WALKER_STOP' });
    } else {
      // Tab may have been closed; tell SW directly so runtime resets
      await send({ type: 'WALKER_STOPPED', reason: 'Tab unavailable' });
    }
    toast('Walker stopped', 'info');
  });
}

// ─── Logs ───────────────────────────────────────────────────

function renderLogs(snap) {
  const el = $('#logList');
  const logs = snap.log || [];
  if (!logs.length) {
    el.innerHTML = `<div class="log-empty">No log entries yet.</div>`;
    return;
  }
  // Most recent first
  const items = logs.slice().reverse().slice(0, 250);
  el.innerHTML = items.map((entry) => {
    const t = new Date(entry.t || Date.now());
    const hh = String(t.getHours()).padStart(2, '0');
    const mm = String(t.getMinutes()).padStart(2, '0');
    const ss = String(t.getSeconds()).padStart(2, '0');
    return `
      <div class="log-line">
        <span class="t">${hh}:${mm}:${ss}</span>
        <span class="lv ${escapeHtml(entry.level || 'info')}">${escapeHtml((entry.level || 'info').toUpperCase())}</span>
        <span class="msg">${escapeHtml(entry.msg || '')}</span>
      </div>
    `;
  }).join('');
}

function bindLogs() {
  $('#btnClearLog').addEventListener('click', async () => {
    const ok = await confirmDialog({
      title: 'Clear log?',
      message: 'Removes all activity log entries. Analytics counters are kept.',
      confirmText: 'Clear',
      danger: true,
    });
    if (!ok) return;
    const resp = await send({ type: 'CLEAR_LOG' });
    if (resp.ok) toast('Log cleared', 'success');
  });
}

// ─── Listen to walker progress (from content script via SW) ──

function bindWalkerEvents() {
  // The walker doesn't push us directly; it pushes to SW which updates
  // storage. Storage onChanged triggers our refresh. We just keep button
  // state in sync with runtime.
}

// ─── Init ───────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  bindNav();
  bindThemeToggle();
  bindSettingsLauncher();
  bindActionBar();
  bindQueueInput();
  bindWalker();
  bindLogs();
  bindWalkerEvents();
  bindStorageSync();
  await loadSnapshot();
});

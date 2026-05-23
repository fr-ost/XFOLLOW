/* ============================================================
   X Follow Grow — Options page controller
   Mirrors popup settings with full-page layout. Live save,
   live safety pulse, import/export.
   ============================================================ */

import { extractHandles } from '../../utils/parser.js';

const $ = (s) => document.querySelector(s);

function send(msg) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(msg, (response) => {
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

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function toast(msg, kind = 'info', ms = 2400) {
  const stack = $('#toastStack');
  if (!stack) return;
  const el = document.createElement('div');
  el.className = `toast toast-${kind}`;
  el.textContent = msg;
  stack.appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.remove(), 200); }, ms);
}

function confirmDialog({ title, message, confirmText = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    const mount = $('#dialogMount');
    mount.innerHTML = `
      <div class="dialog-bg">
        <div class="dialog">
          <div class="dialog-body">
            <div class="dialog-title">${escapeHtml(title)}</div>
            <div class="dialog-message">${escapeHtml(message)}</div>
          </div>
          <div class="dialog-foot">
            <button type="button" class="btn btn-ghost btn-sm" data-act="cancel">Cancel</button>
            <button type="button" class="btn ${danger ? 'btn-danger' : 'btn-primary'} btn-sm" data-act="confirm">${escapeHtml(confirmText)}</button>
          </div>
        </div>
      </div>`;
    const close = (v) => { mount.innerHTML = ''; resolve(v); };
    mount.querySelector('[data-act="cancel"]').addEventListener('click', () => close(false));
    mount.querySelector('[data-act="confirm"]').addEventListener('click', () => close(true));
    mount.querySelector('.dialog-bg').addEventListener('click', (e) => {
      if (e.target === e.currentTarget) close(false);
    });
  });
}

// ─── State ──────────────────────────────────────────────────

const state = { snapshot: null };

// ─── Bindings table: [elementId, settingsKey, type] ─────────

const SETTINGS_BINDINGS = [
  ['setMinDelay',          'minDelaySec',          'number'],
  ['setMaxDelay',          'maxDelaySec',          'number'],
  ['setMinSkip',           'minSkipDelaySec',      'number'],
  ['setMaxSkip',           'maxSkipDelaySec',      'number'],
  ['setBurstChance',       'burstChance',          'number'],
  ['setWarmup',            'warmupMode',           'checkbox'],
  ['setHourCap',           'hourlyCap',            'number'],
  ['setDayCap',            'dailyCap',             'number'],
  ['setLpAfterMin',        'longPauseAfterMin',    'number'],
  ['setLpAfterMax',        'longPauseAfterMax',    'number'],
  ['setLpMinSec',          'longPauseMinSec',      'number'],
  ['setLpMaxSec',          'longPauseMaxSec',      'number'],
  ['setSkipProtected',     'skipProtected',        'checkbox'],
  ['setSkipFollowsMe',     'skipFollowsMe',        'checkbox'],
  ['setVerifiedOnly',      'verifiedOnly',         'checkbox'],
  ['setSkipVerified',      'skipVerified',         'checkbox'],
  ['setRequirePic',        'requireProfilePicture','checkbox'],
  ['setRequireBio',        'requireBio',           'checkbox'],
  ['setMinFollowers',      'minFollowers',         'number'],
  ['setMaxFollowing',      'maxFollowing',         'number'],
  ['setMinPosts',          'minPosts',             'number'],
  ['setSmartScoring',      'smartScoring',         'checkbox'],
  ['setQualityThreshold',  'qualityThreshold',     'number'],
  ['setFollowBackFilter',  'followBackFilter',     'checkbox'],
  ['setMinFollowRatio',    'minFollowRatio',       'number'],
  ['setInclude',           'includeKeywords',      'text'],
  ['setExclude',           'excludeKeywords',      'text'],
  ['setNotifyDone',        'notifyOnComplete',     'checkbox'],
  ['setNotifySafety',      'notifyOnSafety',       'checkbox'],
];

function applyTheme(t) {
  document.documentElement.setAttribute('data-theme', t === 'light' ? 'light' : 'dark');
}

function renderSettings(s) {
  if (!s) return;
  for (const [id, key, type] of SETTINGS_BINDINGS) {
    const el = document.getElementById(id);
    if (!el) continue;
    if (type === 'checkbox') el.checked = !!s[key];
    else                     el.value   = s[key] != null ? s[key] : '';
  }
  const wl = $('#setWhitelist');
  if (wl) wl.value = (s.whitelist || []).map((h) => '@' + h).join('\n');
}

function renderPulse(snap) {
  const safe = snap.safety || {};
  const score = safe.score == null ? 0 : safe.score;
  const band = safe.band || { label: '—', color: '#888', note: '' };
  $('#heroScore').textContent = String(score);
  $('#heroBand').textContent = band.label;
  $('#heroDot').style.background = band.color;
  $('#heroNote').textContent = band.note;
  const ring = $('#heroRing');
  const C = 2 * Math.PI * 34;
  ring.setAttribute('stroke-dasharray', String(C));
  ring.setAttribute('stroke-dashoffset', String(C * (1 - score / 100)));
  ring.style.stroke = band.color;
  $('#heroLastHour').textContent = safe.lastHour || 0;
  $('#heroLastDay').textContent  = safe.lastDay || 0;
}

async function persistFromUI() {
  if (!state.snapshot) return;
  const next = { ...state.snapshot.settings };
  for (const [id, key, type] of SETTINGS_BINDINGS) {
    const el = document.getElementById(id);
    if (!el) continue;
    if (type === 'checkbox') next[key] = !!el.checked;
    else if (type === 'number') {
      const v = el.value === '' ? 0 : Number(el.value);
      next[key] = isNaN(v) ? 0 : v;
    } else {
      next[key] = el.value;
    }
  }
  const wl = $('#setWhitelist');
  if (wl) next.whitelist = extractHandles(wl.value);
  state.snapshot.settings = next;
  await send({ type: 'SET_SETTINGS', settings: next });
  // refresh pulse
  const snap = await send({ type: 'GET_SNAPSHOT' });
  if (snap && snap.ok) {
    state.snapshot = snap;
    renderPulse(snap);
  }
}

function bindAllInputs() {
  for (const [id, , type] of SETTINGS_BINDINGS) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.addEventListener('change', persistFromUI);
    if (type === 'number' || type === 'text') {
      el.addEventListener('input', persistFromUI);
    }
  }
  $('#setWhitelist')?.addEventListener('change', persistFromUI);

  $('#btnExport').addEventListener('click', () => {
    if (!state.snapshot) return;
    const blob = new Blob([JSON.stringify(state.snapshot.settings, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    chrome.downloads.download({
      url,
      filename: `x-follow-grow-settings-${Date.now()}.json`,
      saveAs: true,
    }, () => setTimeout(() => URL.revokeObjectURL(url), 1500));
  });

  $('#btnImport').addEventListener('click', () => $('#fileImport').click());
  $('#fileImport').addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const parsed = JSON.parse(reader.result);
        if (!parsed || typeof parsed !== 'object') throw new Error('Invalid file');
        await send({ type: 'SET_SETTINGS', settings: parsed });
        toast('Settings imported', 'success');
        await load();
      } catch (err) {
        toast('Invalid settings file: ' + err.message, 'error');
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  });

  $('#btnTheme').addEventListener('click', async () => {
    const cur = document.documentElement.getAttribute('data-theme');
    const next = cur === 'light' ? 'dark' : 'light';
    applyTheme(next);
    if (state.snapshot) {
      state.snapshot.settings.theme = next;
      await send({ type: 'SET_SETTINGS', settings: state.snapshot.settings });
    }
  });

  $('#btnResetAnalytics').addEventListener('click', async () => {
    const ok = await confirmDialog({
      title: 'Reset analytics?',
      message: 'Clears the activity history, results, and daily counters. Settings are kept.',
      confirmText: 'Reset',
      danger: true,
    });
    if (!ok) return;
    const r = await send({ type: 'RESET_ANALYTICS' });
    if (r.ok) toast('Analytics reset', 'success');
  });

  $('#btnResetSettings').addEventListener('click', async () => {
    const ok = await confirmDialog({
      title: 'Reset all settings?',
      message: 'Restores all settings to defaults. Analytics and queue are kept.',
      confirmText: 'Reset',
      danger: true,
    });
    if (!ok) return;
    const r = await send({ type: 'RESET_SETTINGS' });
    if (r.ok) {
      toast('Settings reset', 'success');
      await load();
    }
  });
}

async function load() {
  const snap = await send({ type: 'GET_SNAPSHOT' });
  if (!snap || !snap.ok) {
    toast('Background not ready, reload the extension', 'error', 4000);
    return;
  }
  state.snapshot = snap;
  applyTheme(snap.settings && snap.settings.theme);
  renderSettings(snap.settings);
  renderPulse(snap);
}

document.addEventListener('DOMContentLoaded', async () => {
  bindAllInputs();
  // Live updates from storage changes (e.g. analytics rolling)
  chrome.storage.onChanged.addListener(async () => {
    const snap = await send({ type: 'GET_SNAPSHOT' });
    if (snap && snap.ok) {
      state.snapshot = snap;
      renderPulse(snap);
    }
  });
  await load();
});

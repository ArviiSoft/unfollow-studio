import { classify, filterUsers, searchKey, csvOf, difference, settingsOf, DEFAULT_SETTINGS, FRESH_MS, validateSnapshot, parseProtected, uniqueUsers, UnfollowQueue } from './core.mjs';
import { InstagramClient, cookieValue, pageAccountUsername } from './instagram.mjs';
import { createDemoClient } from './demo.mjs';
import { SnapshotStore } from './storage.mjs';

const paths = {
  leaf: '<path d="M20 4C10 2 3 7 5 15s15 4 15-11Z"/><path d="M4 21 15 10M9 16v-5m0 5h5"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2m20 0v-2a4 4 0 0 0-3-3.9"/><circle cx="9" cy="7" r="4"/><path d="M16 3a4 4 0 0 1 0 8"/>',
  minus: '<circle cx="9" cy="7" r="4"/><path d="M2 21v-2a4 4 0 0 1 4-4h6a4 4 0 0 1 4 4v2m1-11h5"/>',
  heart: '<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8Z"/>',
  shield: '<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6Z"/><path d="m8 12 3 3 5-6"/>',
  chart: '<path d="M3 3v18h18M7 15l4-4 4 2 6-7"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  settings: '<path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3"/><circle cx="15" cy="17" r="3"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 2-3 4m.1 3h0"/>',
  search: '<circle cx="10" cy="10" r="6"/><path d="m15 15 5 5"/>',
  refresh: '<path d="M20 7v5h-5M4 17v-5h5M6 6a8 8 0 0 1 13 3M5 15a8 8 0 0 0 13 3"/>',
  download: '<path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/>',
  upload: '<path d="M12 16V4m-5 5 5-5 5 5M4 16v5h16v-5"/>',
  external: '<path d="M14 3h7v7m0-7L10 14M10 3H4v17h17v-6"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  moon: '<path d="M21 13a9 9 0 0 1-10-10A9 9 0 1 0 21 13Z"/>',
  chevron: '<path d="m9 5 7 7-7 7"/>',
  back: '<path d="m15 5-7 7 7 7"/>',
  lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  pause: '<path d="M8 5v14M16 5v14"/>',
  play: '<path d="m7 4 14 8-14 8Z"/>',
  small: '<path d="M5 12h14"/>',
  code: '<path d="m7 6-6 6 6 6m10-12 6 6-6 6M14 3l-4 18"/>'
};
const icon = name => `<svg viewBox="0 0 24 24" aria-hidden="true">${paths[name] ?? paths.users}</svg>`;
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const numberFormatter = new Intl.NumberFormat('en-US');
const dateFormatter = new Intl.DateTimeFormat('en-US', { dateStyle: 'short', timeStyle: 'short' });
const fmt = n => numberFormatter.format(n);
const date = value => dateFormatter.format(new Date(value));
const tabs = {
  nonfollowers: ['Not following back', 'minus', 'Accounts you follow that do not follow you back.'],
  following: ['Following', 'users', 'All the accounts you follow, in one place.'],
  mutual: ['Mutual follows', 'heart', 'Accounts that follow you back.'],
  fans: ['Only following you', 'heart', 'People who follow you, but you do not follow back.'],
  protected: ['Protected accounts', 'shield', 'These accounts are excluded from unfollow queues.'],
  changes: ['Follower changes', 'chart', 'Changes between your last two completed scans.'],
  history: ['Activity history', 'clock', 'The last 500 actions saved in this browser.']
};

export function startApp({ css, demo = false }) {
  const key = '__instaUnfollowStudioV1';
  if (window[key]) {
    window[key].show();
    if (window[key].version !== '1.1.3') alert('An older panel is still open. Stop its queue, close it, and run the new script again.');
    return;
  }
  if (!demo && (location.protocol !== 'https:' || !['www.instagram.com', 'instagram.com'].includes(location.hostname))) {
    alert('Run this script in the console on https://www.instagram.com while signed in.'); return;
  }
  const accountId = demo ? 'demo' : cookieValue('ds_user_id', document.cookie);
  if (!accountId || (!demo && !/^\d+$/.test(accountId))) { alert('Sign in to Instagram first.'); return; }
  const client = demo ? createDemoClient() : new InstagramClient({ accountId });
  const storageKey = `insta-unfollow-studio:v2:${accountId}`;
  const legacyKey = `insta-unfollow-studio:v1:${accountId}`;
  const snapshotStore = new SnapshotStore();
  let saved = {}, storageIssue = false;
  try { saved = JSON.parse(localStorage.getItem(storageKey) || localStorage.getItem(legacyKey) || '{}') || {}; } catch { storageIssue = true; }
  let snapshot = null;
  try { if (saved.snapshot) snapshot = validateSnapshot(saved.snapshot, accountId); } catch { storageIssue = true; }
  let protectedUsers = [];
  try { protectedUsers = uniqueUsers(saved.protected ?? []); } catch { storageIssue = true; }
  let previous = null;
  try { if (saved.previous) previous = validateSnapshot(saved.previous, accountId); } catch { }
  const state = {
    snapshot: demo ? client.snapshot() : snapshot, previous,
    protected: new Map(protectedUsers.map(u => [u.id, u])), selected: new Set(),
    settings: settingsOf(saved.settings ?? DEFAULT_SETTINGS), tab: 'nonfollowers', query: '', privacy: 'all', verified: 'all', sort: 'az', page: 1,
    fresh: demo, busy: !demo, scanController: null, queue: null, queueDone: 0, queueTotal: 0,
    profile: demo ? { username: 'demo.account' } : null, removedIds: new Set(), protectedVersion: 0,
    history: Array.isArray(saved.history) ? saved.history.filter(v => v && typeof v.username === 'string' && Number.isFinite(v.at)).slice(0, 500) : [],
    theme: saved.theme === 'dark' ? 'dark' : '', note: demo ? 'Demo mode: explore with sample accounts. Your Instagram account is not affected.' : snapshot ? 'Saved snapshot loaded. Run a new scan to enable actions.' : 'Scan your account when ready. Results are stored only in this browser.',
    noteError: false
  };
  const host = document.createElement('div');
  host.id = 'insta-unfollow-studio';
  host.dataset.theme = state.theme;
  host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;isolation:isolate;';
  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style'); style.textContent = css; shadow.append(style);
  const root = document.createElement('div'); shadow.append(root);
  document.documentElement.append(host);
  const oldOverflow = document.documentElement.style.overflow;
  document.documentElement.style.overflow = 'hidden';
  let closed = false, toastTimer, focusBeforeModal, searchTimer, persistenceReady = demo;
  const $ = selector => shadow.querySelector(selector);
  const $$ = selector => [...shadow.querySelectorAll(selector)];
  const button = (action, label, symbol, classes = '', attrs = '') => `<button type="button" class="btn ${classes}" data-action="${action}" ${attrs}>${symbol ? icon(symbol) : ''}${label}</button>`;
  const iconButton = (action, label, symbol, attrs = '') => `<button type="button" class="icon-btn" data-action="${action}" title="${label}" aria-label="${label}" ${attrs}>${icon(symbol)}</button>`;
  root.innerHTML = `
    <div class="app ${state.theme}" lang="en">
      <aside class="sidebar"><div class="brand"><span class="brand-symbol">${icon('leaf')}</span><span class="brand-text">unfollow<small>STUDIO</small></span></div>
        <div class="nav-caption">YOUR CONNECTIONS</div><nav aria-label="Account lists">${Object.entries(tabs).map(([id, [label, symbol]]) => `<button type="button" data-tab="${id}" title="${label}">${icon(symbol)}<span class="nav-label">${label}</span><span class="nav-count" data-count="${id}">0</span></button>`).join('')}</nav>
        <div class="sidebar-bottom"><nav>${[['settings', 'Settings', 'settings'], ['help', 'How it works', 'help']].map(([action, label, symbol]) => `<button type="button" data-action="${action}" title="${label}">${icon(symbol)}<span class="nav-label">${label}</span></button>`).join('')}</nav>
          <div class="local-card">${icon('lock')}<strong>Your data stays with you.</strong><p>No passwords. No external servers. Uses your existing Instagram session.</p></div><div class="version"><span>UNFOLLOW STUDIO</span><span>v1.1.3</span></div></div>
      </aside>
      <div class="workspace"><header class="topbar"><div class="breadcrumb"><span>Workspace</span><span>/</span><strong>Follow management</strong></div><div class="top-actions">${demo ? '<span class="badge demo-badge">DEMO</span>' : ''}<span class="account"><span class="status-dot"></span><span id="account-name">${demo ? '@demo.account' : 'Loading account…'}</span></span>${demo ? iconButton('copy-code', 'Copy the Instagram script', 'code') : ''}${iconButton('theme', 'Toggle theme', 'moon')}${iconButton('minimize', 'Minimize panel', 'small')}${iconButton('close', 'Close panel', 'close')}</div></header>
        <main class="content"><section class="page-heading"><div><div class="eyebrow">LESS NOISE. MORE YOU.</div><h1>Curate your connections.</h1><p class="subheading">See your connections. Curate your feed. Stay in control.</p></div><div class="heading-actions">${button('export', 'Export', 'download')}${button('scan', 'Scan my account', 'refresh', 'primary', 'id="scan-button"')}</div></section>
          <section class="stats" aria-label="Account overview"></section>
          <div class="notice" role="status">${icon('shield')}<span class="notice-copy"></span>${button('stop-scan', 'Stop', 'close', 'small', 'hidden')}</div>
          <section class="queue-panel" hidden aria-label="Action queue"><div class="queue-heading"><div><strong id="queue-title">Action queue</strong><div class="queue-info" aria-live="polite"></div></div><div class="queue-actions">${button('pause', 'Pause', 'pause', 'small')}${button('stop-queue', 'Stop', 'close', 'small')}</div></div><div class="progress" role="progressbar" aria-label="Queue progress" aria-valuemin="0" aria-valuemax="100"><span style="width:0%"></span></div></section>
          <section class="list-panel"><div class="list-heading"><div><div class="list-title"><h2></h2><span class="pill-count">0</span></div><p class="list-description"></p></div><div class="list-tools">${button('select-filtered', 'Select accounts', 'check', 'small')}${button('export', '<span class="export-label">Export</span>', 'download', 'small')}</div></div>
            <div class="filters"><label class="search">${icon('search')}<input id="search" type="search" placeholder="Search by username or name…" aria-label="Search by username or name"></label>
              <select id="privacy" aria-label="Account privacy"><option value="all">All accounts</option><option value="private">Private accounts</option><option value="public">Public accounts</option></select>
              <select id="verified" aria-label="Verification status"><option value="all">All badges</option><option value="yes">Verified</option><option value="no">Unverified</option></select>
              <select id="sort" aria-label="Sort order"><option value="az">Username: A–Z</option><option value="za">Username: Z–A</option></select></div>
            <div id="table-area"></div><footer class="pagination"></footer>
          </section><p class="footnote">${icon('help')}<span>Lists reflect relationships at scan time. Instagram may change its web interface or restrict automated actions. Delays do not guarantee that restrictions will be avoided.</span></p>
        </main>
      </div>
      <div class="selection-bar" hidden><div><strong id="selection-count">0 accounts selected</strong><small>Select accounts, then review.</small></div><button class="clear" data-action="clear-selection">Clear</button><span class="spacer"></span>${button('protect-selected', 'Protect selected', 'shield', 'protect-selected')}${button('confirm', 'Unfollow selected', 'minus', 'primary')}</div>
      <div class="modal-layer" hidden></div><div class="toast" role="status" hidden></div><input type="file" id="import-file" accept=".json,application/json" hidden>
    </div><button class="launcher" hidden>${icon('leaf')} Unfollow Studio</button>`;

  function save() {
    if (!persistenceReady) return;
    try { localStorage.setItem(storageKey, JSON.stringify({ format: 2, removedFrom: state.snapshot?.scannedAt, removedIds: [...state.removedIds],
      protected: [...state.protected.values()], history: state.history, settings: state.settings, theme: state.theme })); }
    catch { if (!storageIssue) { storageIssue = true; toast('Browser storage is full or unavailable. Export your data.', true); } }
  }
  function toast(message, error = false) {
    if (closed) return;
    const el = $('.toast'); el.textContent = message; el.classList.toggle('error', error); el.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.hidden = true; }, 6500);
  }
  function setNote(message, error = false) { state.note = message; state.noteError = error; renderNote(); }
  function renderNote() { $('.notice-copy').textContent = state.note; $('.notice').classList.toggle('error', state.noteError); $('[data-action="stop-scan"]').hidden = !state.scanController; }
  function isFresh() { return state.fresh && state.snapshot?.complete && Date.now() - state.snapshot.scannedAt < FRESH_MS; }
  let cachedDeltaBefore, cachedDeltaAfter, cachedDelta, cachedChanges, protectedVersion = -1, cachedProtected = [];
  function changes() {
    if (!cachedDelta || cachedDeltaBefore !== state.previous?.followers || cachedDeltaAfter !== state.snapshot?.followers) {
      cachedDeltaBefore = state.previous?.followers; cachedDeltaAfter = state.snapshot?.followers;
      cachedDelta = state.snapshot ? difference(state.previous, state.snapshot) : { lost: [], gained: [], available: false };
      cachedChanges = [...cachedDelta.lost.map(u => ({ ...u, change: 'lost' })), ...cachedDelta.gained.map(u => ({ ...u, change: 'gained' }))];
    }
    return cachedDelta;
  }
  let cachedFollowing, cachedFollowers, cachedGroups, nonfollowerIds, mutualIds;
  function groups() {
    if (!cachedGroups || cachedFollowing !== state.snapshot?.following || cachedFollowers !== state.snapshot?.followers) {
      cachedFollowing = state.snapshot?.following; cachedFollowers = state.snapshot?.followers;
      cachedGroups = classify(state.snapshot);
      nonfollowerIds = new Set(cachedGroups.nonfollowers.map(u => u.id));
      mutualIds = new Set(cachedGroups.mutual.map(u => u.id));
    }
    return cachedGroups;
  }
  function eligible(user) { groups(); return !!isFresh() && !state.protected.has(user.id) && nonfollowerIds.has(user.id); }
  function usersForTab() {
    if (state.tab === 'protected') {
      if (protectedVersion !== state.protectedVersion) { cachedProtected = [...state.protected.values()]; protectedVersion = state.protectedVersion; }
      return cachedProtected;
    }
    if (state.tab === 'changes') {
      changes(); return cachedChanges;
    }
    return groups()[state.tab] ?? [];
  }
  function filtered() { return filterUsers(usersForTab(), state); }
  function relationTag(user) {
    if (user.change) return `<span class="tag ${user.change === 'lost' ? 'amber' : 'green'}">${user.change === 'lost' ? 'No longer listed' : 'New follower'}</span>`;
    if (state.protected.has(user.id)) return `<span class="tag green">${icon('shield')}Protected</span>`;
    groups();
    if (mutualIds.has(user.id)) return '<span class="tag green">Mutual</span>';
    if (nonfollowerIds.has(user.id)) return '<span class="tag amber">Not following back</span>';
    return '<span class="tag">Follows you</span>';
  }
  function renderStats() {
    const g = groups();
    const cards = [['Following', g.following.length, 'users', 'Accounts in your following list'], ['Followers', g.followers.length, 'heart', 'People connected to you'], ['Not following back', g.nonfollowers.length, 'minus', 'Connections to review'], ['Mutual follows', g.mutual.length, 'shield', 'Connections that go both ways']];
    $('.stats').innerHTML = cards.map(([label, value, symbol, text], i) => `<article class="stat ${i === 2 ? 'highlight' : ''}"><div class="stat-top">${label}<span class="stat-icon">${icon(symbol)}</span></div><strong>${state.snapshot ? fmt(value) : '—'}</strong><div class="stat-bottom">${text}</div></article>`).join('');
    for (const id of Object.keys(tabs)) {
      const count = id === 'protected' ? state.protected.size : id === 'history' ? state.history.length : id === 'changes' ? changes().lost.length + changes().gained.length : g[id].length;
      $(`[data-count="${id}"]`).textContent = fmt(count);
    }
    $$('[data-tab]').forEach(el => { el.classList.toggle('active', el.dataset.tab === state.tab); el.setAttribute('aria-current', el.dataset.tab === state.tab ? 'page' : 'false'); });
  }
  function empty(title, text, action = '') {
    return `<div class="empty"><div class="empty-icon">${icon('leaf')}</div><h3>${title}</h3><p>${text}</p>${action}</div>`;
  }
  function renderTable() {
    const [title, , description] = tabs[state.tab];
    $('.list-title h2').textContent = title; $('.list-description').textContent = description;
    const history = state.tab === 'history';
    $('#privacy').disabled = history; $('#verified').disabled = history; $('#sort').disabled = history;
    $('[data-action="select-filtered"]').disabled = history || state.busy || !isFresh();
    const query = searchKey(state.query);
    const records = history ? state.history.filter(u => searchKey(`${u.username} ${u.message}`).includes(query)) : filtered();
    const pages = Math.max(1, Math.ceil(records.length / 20)); state.page = Math.min(state.page, pages);
    const start = (state.page - 1) * 20, page = records.slice(start, start + 20);
    $('.pill-count').textContent = fmt(records.length);
    if (!records.length) {
      let title = 'Nothing here yet.', text = 'Try another list or change your filters.';
      if (!state.snapshot && !history && state.tab !== 'protected') { title = 'Take a closer look at your connections.'; text = 'Compare your followers and following lists. Once the scan is complete, select accounts to manage.'; }
      else if (history) { title = 'No actions yet.'; text = 'Your unfollow results will appear here.'; }
      else if (state.tab === 'changes') { title = state.previous ? 'No follower changes found.' : 'Two scans are needed for a comparison.'; text = 'Your next complete scan will show new and missing followers. Deactivated accounts and blocks can also cause these changes.'; }
      else if (state.tab === 'protected') { title = 'Keep your favorite connections.'; text = 'Click the shield next to an account. Protected accounts cannot be unfollowed.'; }
      $('#table-area').innerHTML = empty(title, text, !state.snapshot && !history ? button('scan', 'Start your first scan', 'refresh', 'primary', state.busy ? 'disabled' : '') : '');
    } else if (history) {
      const labels = { success: 'Completed', skipped: 'Skipped', failed: 'Stopped', uncertain: 'Unverified' };
      $('#table-area').innerHTML = `<div class="table-scroll"><table><thead><tr><th>ACCOUNT</th><th>RESULT</th><th>DETAILS</th><th>DATE</th></tr></thead><tbody>${page.map(u => `<tr><td>@${esc(u.username)}</td><td><span class="tag ${u.status === 'success' ? 'green' : 'amber'}">${labels[u.status] ?? 'Unknown'}</span></td><td class="history-message">${esc(u.message)}</td><td>${esc(date(u.at))}</td></tr>`).join('')}</tbody></table></div>`;
    } else {
      const colors = ['#e7eada', '#dfebf1', '#f1e4db', '#e7e1ef', '#dcece3', '#efe9d7'];
      $('#table-area').innerHTML = `<div class="table-scroll"><table><thead><tr><th><input type="checkbox" id="select-page" aria-label="Select eligible accounts on this page" ${state.busy || !isFresh() ? 'disabled' : ''}></th><th>ACCOUNT</th><th class="relation-column">RELATIONSHIP</th><th class="type-column">ACCOUNT TYPE</th><th>ACTIONS</th></tr></thead><tbody>${page.map(u => `<tr class="${state.selected.has(u.id) ? 'selected' : ''}"><td><input type="checkbox" data-select="${u.id}" aria-label="${esc(u.username)} select account" ${state.selected.has(u.id) ? 'checked' : ''} ${state.busy || !eligible(u) ? 'disabled' : ''}></td><td><div class="user"><span class="avatar" style="--avatar-bg:${colors[Number(u.id.slice(-2)) % colors.length]}">${esc((u.full_name || u.username).split(/[ ._]+/).slice(0, 2).map(s => s[0]).join('').toUpperCase())}</span><div><a href="https://www.instagram.com/${encodeURIComponent(u.username)}/" target="_blank" rel="noopener noreferrer"><strong>${esc(u.username)}${u.is_verified ? '<span class="verified">' + icon('check') + '</span>' : ''}</strong></a><small>${esc(u.full_name)}</small></div></div></td><td class="relation-column">${relationTag(u)}</td><td class="type-column"><span class="tag">${u.is_private ? icon('lock') + ' Private' : 'Public'}</span></td><td><div class="row-actions"><button class="icon-btn ${state.protected.has(u.id) ? 'protected' : ''}" data-protect="${u.id}" title="${state.protected.has(u.id) ? 'Remove protection' : 'Protect account'}" aria-label="${esc(u.username)}: ${state.protected.has(u.id) ? 'remove protection' : 'protect account'}" ${state.busy ? 'disabled' : ''}>${icon('shield')}</button><a class="icon-btn" href="https://www.instagram.com/${encodeURIComponent(u.username)}/" target="_blank" rel="noopener noreferrer" title="Open profile" aria-label="${esc(u.username)} open profile">${icon('external')}</a></div></td></tr>`).join('')}</tbody></table></div>`;
      const selectable = page.filter(eligible), checked = selectable.filter(u => state.selected.has(u.id)).length;
      $('#select-page').checked = selectable.length > 0 && checked === selectable.length;
      $('#select-page').indeterminate = checked > 0 && checked < selectable.length;
    }
    $('.pagination').innerHTML = `<span>${records.length ? `${fmt(start + 1)}–${fmt(Math.min(start + 20, records.length))} / ${fmt(records.length)} records` : '0 records'}${state.snapshot ? ` · ${esc(date(state.snapshot.scannedAt))}` : ''}</span><span class="page-buttons">${iconButton('prev', 'Previous page', 'back', state.page === 1 ? 'disabled' : '')}<span>${state.page} / ${pages}</span>${iconButton('next', 'Next page', 'chevron', state.page === pages ? 'disabled' : '')}</span>`;
    renderSelection();
  }
  function renderSelection() {
    $('.selection-bar').hidden = state.selected.size === 0;
    $('#selection-count').textContent = `${fmt(state.selected.size)} accounts selected`;
    $('[data-action="confirm"]').disabled = !state.selected.size || state.busy || !isFresh();
    $('[data-action="protect-selected"]').disabled = !state.selected.size || state.busy;
    $('[data-action="clear-selection"]').disabled = state.busy;
    $('#scan-button').disabled = state.busy;
    $('#scan-button').innerHTML = icon('refresh') + (state.scanController ? 'Scanning…' : state.snapshot ? 'Scan again' : 'Scan my account');
  }
  function syncSelection() {
    const boxes = $$('[data-select]');
    for (const box of boxes) {
      box.checked = state.selected.has(box.dataset.select);
      box.closest('tr').classList.toggle('selected', box.checked);
    }
    const selectable = boxes.filter(box => !box.disabled), selected = selectable.filter(box => box.checked).length;
    const all = $('#select-page');
    if (all) { all.checked = selectable.length > 0 && selected === selectable.length; all.indeterminate = selected > 0 && selected < selectable.length; }
    renderSelection();
  }
  function renderProfile() {
    const el = $('#account-name');
    el.textContent = state.profile ? `@${state.profile.username}` : 'Your account';
    el.title = state.profile ? (state.fresh ? 'Signed-in Instagram account' : 'Account from the last scan') : 'Signed-in Instagram account';
  }
  function render() { if (closed) return; renderStats(); renderNote(); renderTable(); }
  function closeModal() { $('.modal-layer').hidden = true; $('.modal-layer').innerHTML = ''; focusBeforeModal?.focus(); }
  function modal(title, body, footer = '') {
    focusBeforeModal = shadow.activeElement;
    const layer = $('.modal-layer'); layer.innerHTML = `<section class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title"><div class="modal-head"><h2 id="modal-title">${title}</h2>${iconButton('close-modal', 'Close dialog', 'close')}</div>${body}${footer ? `<div class="modal-footer">${footer}</div>` : ''}</section>`;
    layer.hidden = false; layer.querySelector('button, input, select')?.focus();
  }
  async function withAccountLock(work) {
    if (demo) return work();
    if (!navigator.locks) throw new Error('This browser does not support cross-tab action locks. Use a current version of Chrome or Edge.');
    return navigator.locks.request(`insta-unfollow-studio:${accountId}`, { ifAvailable: true }, async lock => {
      if (!lock) throw new Error('A scan or queue is running in another tab. Stop it before continuing.');
      return work();
    });
  }
  async function scan() {
    if (state.busy) return;
    state.busy = true; state.fresh = false; state.selected.clear();
    state.scanController = new AbortController(); render();
    setNote('Loading your following list...');
    try {
      await withAccountLock(async () => {
        const next = await client.scan(state.scanController.signal, ({ kind, count, page, phase, remaining, retry, retries }) => {
          if (phase === 'cooldown') setNote(`Instagram limited the ${kind} list (HTTP 429). Retrying in ${remaining}s (${retry}/${retries}).`, true);
          else if (phase === 'pause') setNote(`Scan break: ${remaining}s before continuing the ${kind} list.`);
          else setNote(phase === 'fallback' ? `Instagram repeated a page in ${kind}. Checking the alternate read-only list…` : `Loading ${kind}: ${fmt(count)} accounts · page ${page}${phase === 'alternate' ? ' · alternate list' : ''}. Keep this tab open.`);
        });
        if (closed) return;
        if (!next.profile && state.profile) next.profile = state.profile;
        state.previous = state.snapshot; state.snapshot = next; state.fresh = true; state.page = 1; state.removedIds.clear();
        if (next.profile) { state.profile = next.profile; renderProfile(); }
        try { await snapshotStore.write(accountId, { snapshot: next, previous: state.previous }); }
        catch { toast('The scan could not be saved locally. Export it before closing the panel.', true); }
        save(); setNote(`Scan complete. ${fmt(groups().nonfollowers.length)} accounts do not follow you back.${demo ? ' These are sample accounts.' : ''}`);
      });
    } catch (error) {
      setNote(error.name === 'AbortError' ? 'Scan stopped. The previous snapshot can be viewed, but actions require a complete scan.' : error.message, true);
    }
    finally { state.busy = false; state.scanController = null; render(); }
  }
  function showConfirmation() {
    if (state.busy || !isFresh()) return toast('Run a complete scan first.', true);
    const chosen = groups().nonfollowers.filter(u => state.selected.has(u.id) && eligible(u));
    if (!chosen.length) return toast('No eligible accounts selected.', true);
    if (chosen.length > state.settings.maxItems) return toast(`Select up to ${state.settings.maxItems} accounts at a time.`, true);
    modal(`Unfollow ${chosen.length} accounts`, `<p>${demo ? 'Demo action: no requests will be sent to real accounts.' : 'These accounts will be unfollowed one at a time. Following a private account again may require approval.'} The current follow relationship is checked before each action.</p><div class="confirm-list">${chosen.map(u => `<span>@${esc(u.username)}</span>`).join('')}</div><p>${state.settings.delaySeconds}s between actions · ${state.settings.breakSeconds}s break after every ${state.settings.batchSize} actions.${demo ? ' Demo delays are accelerated.' : ''}</p><label class="check-label"><input type="checkbox" id="confirm-check">I reviewed this list and want to unfollow the selected accounts.</label>`, button('close-modal', 'Cancel', '', '') + button('run', demo ? 'Start demo' : 'Start unfollowing', 'minus', 'danger', 'disabled'));
  }
  async function runQueue() {
    if (state.busy || !$('#confirm-check')?.checked || !isFresh()) return;
    const targets = groups().nonfollowers.filter(u => state.selected.has(u.id) && eligible(u));
    closeModal(); state.busy = true; render();
    try {
      await withAccountLock(async () => {
        state.queue = new UnfollowQueue({ client, eligible, settings: state.settings, demo, onEvent: event => {
          if (event.type === 'start') { state.queueDone = 0; state.queueTotal = event.total; $('.queue-panel').hidden = false; $('#queue-title').textContent = 'Action queue'; }
          if (event.type === 'checking' || event.type === 'sending') $('.queue-info').textContent = `@${event.user.username} · ${event.type === 'checking' ? 'Checking follow relationship' : 'Unfollowing'}`;
          if (event.type === 'waiting') $('.queue-info').textContent = `${event.label}: ${event.remaining} seconds`;
          if (event.type === 'paused' || event.type === 'resumed') { $('[data-action="pause"]').innerHTML = icon(event.type === 'paused' ? 'play' : 'pause') + (event.type === 'paused' ? 'Resume' : 'Pause'); if (event.type === 'paused') $('.queue-info').textContent = 'Paused. A request already sent may still complete.'; }
          if (event.type === 'result') {
            state.queueDone++; state.selected.delete(event.user.id);
            state.history.unshift({ username: event.user.username, id: event.user.id, status: event.status, message: event.message, at: Date.now(), demo }); state.history = state.history.slice(0, 500);
            if (event.status === 'success') { state.snapshot.following = state.snapshot.following.filter(u => u.id !== event.user.id); state.removedIds.add(event.user.id); }
            if (event.status === 'uncertain' || event.status === 'failed') state.fresh = false;
            save(); render();
          }
          if (event.type === 'halted') setNote(event.reason === 'stopped' ? 'Queue stopped. Sent requests cannot be undone; check the activity history for results.' : event.message, event.reason !== 'stopped');
          if (event.type === 'finish') {
            $('#queue-title').textContent = event.reason === 'complete' ? 'Queue complete' : 'Queue stopped';
            $('.queue-info').textContent = `${event.completed} accounts unfollowed. ${demo ? 'Sample data was used.' : 'See activity history for details.'}`;
            $('[data-action="pause"]').disabled = true; $('[data-action="stop-queue"]').disabled = true;
          }
          const percent = Math.round(state.queueDone / Math.max(1, state.queueTotal) * 100);
          $('.progress span').style.width = `${percent}%`; $('.progress').setAttribute('aria-valuenow', String(percent));
        } });
        $('[data-action="pause"]').disabled = false; $('[data-action="stop-queue"]').disabled = false;
        $('[data-action="pause"]').innerHTML = icon('pause') + 'Pause';
        await state.queue.run(targets);
      });
    } catch (error) { setNote(error.message, true); }
    finally { state.busy = false; render(); }
  }
  function download(name, text, type = 'application/json') {
    const url = URL.createObjectURL(new Blob([text], { type })); const a = document.createElement('a');
    a.href = url; a.download = name; shadow.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function showExport() {
    modal('Export your data', `<p>${state.tab === 'history' ? 'Your activity history' : 'The entire filtered list in this tab'} can be downloaded. Protection backups can only be restored to this account.</p><div class="export-options">${state.tab === 'history' ? button('export-history', 'Activity history · JSON', 'clock') : button('export-csv', 'Filtered list · CSV', 'download') + button('export-json', 'Filtered list · JSON', 'code') + button('copy-list', 'Copy usernames', 'users')}${button('export-protected', 'Back up protected accounts · JSON', 'shield')}${button('import-protected', 'Import protection backup', 'upload')}${button('export-snapshot', 'Full scan snapshot · JSON', 'download', '', state.snapshot ? '' : 'disabled')}</div>`);
  }
  function showSettings() {
    modal('Queue settings', `<p>Delays reduce request frequency, but cannot guarantee freedom from Instagram restrictions. Changes apply to the next queue.</p><form id="settings-form">${[['delaySeconds', 'Delay between actions', '20–600 seconds', 20, 600], ['batchSize', 'Actions before a break', '1–10 accounts', 1, 10], ['breakSeconds', 'Batch break', '120–1800 seconds', 120, 1800], ['maxItems', 'Maximum queue size', '1–50 accounts', 1, 50]].map(([id, label, hint, min, max]) => `<label class="field"><span>${label}<small>${hint}</small></span><input type="number" name="${id}" value="${state.settings[id]}" min="${min}" max="${max}" required></label>`).join('')}</form>`, button('reset-settings', 'Reset defaults', '') + button('save-settings', 'Save settings', 'check', 'primary'));
  }
  function showHelp() {
    modal('A quick start', `<ol class="help-steps"><li><strong>Scan your account.</strong> Wait for both lists to finish loading.</li><li><strong>Review your connections.</strong> Search, filter and protect accounts with the shield icon.</li><li><strong>Select accounts.</strong> Bulk selection picks up to ${state.settings.maxItems} eligible accounts. Only accounts that do not follow you back can be unfollowed.</li><li><strong>Confirm your list.</strong> Start the queue, then pause or stop whenever needed.</li><li><strong>Keep your results.</strong> Export CSV or JSON. Restore a protection backup to the same account.</li></ol><p>Live actions require a new scan each time you open the panel. Scans expire after 30 minutes. Closing the tab stops the queue, but a sent request cannot be undone. Reopen the panel after switching accounts.</p><p>Demo mode uses sample data. Live mode only runs on instagram.com. This is not an official Instagram product.</p><p><strong>Console notices:</strong> Instagram's Permissions-Policy headers and blocked telemetry requests (such as /ajax/bz or logging_client_events) belong to Instagram and your browser. This panel cannot change those server headers or browser filters. It reports its own scan and action errors in the status banner.</p>`, button('close-modal', 'Got it', 'check', 'primary'));
  }
  function show() { $('.app').hidden = false; $('.launcher').hidden = true; host.style.inset = '0'; document.documentElement.style.overflow = 'hidden'; }
  function minimize() { $('.app').hidden = true; $('.launcher').hidden = false; host.style.inset = 'auto 0 0 auto'; document.documentElement.style.overflow = oldOverflow; }
  function close() {
    if (state.busy && !confirm('Stop the operation and close the panel? A request already sent may still complete.')) return;
    state.scanController?.abort(); state.queue?.stop();
    closed = true; clearInterval(expiry); clearTimeout(toastTimer); clearTimeout(searchTimer); host.remove();
    document.documentElement.style.overflow = oldOverflow; delete window[key];
  }
  function selectUsers(users, checked) {
    if (state.busy || !isFresh()) return;
    for (const user of users) {
      if (!checked) state.selected.delete(user.id);
      else { if (state.selected.size >= state.settings.maxItems) break; if (eligible(user)) state.selected.add(user.id); }
    }
    syncSelection();
  }
  const actions = {
    scan, 'stop-scan': () => state.scanController?.abort(), confirm: showConfirmation, run: runQueue,
    pause: () => state.queue?.paused ? state.queue.resume() : state.queue?.pause(), 'stop-queue': () => state.queue?.stop(),
    'clear-selection': () => { if (!state.busy) { state.selected.clear(); syncSelection(); } },
    'select-filtered': () => { selectUsers(filtered(), true); toast(`Selected up to ${state.settings.maxItems} eligible accounts. Changing filters keeps your selection.`); },
    'protect-selected': () => { if (state.busy) return; groups().following.forEach(u => { if (state.selected.has(u.id)) state.protected.set(u.id, u); }); state.protectedVersion++; state.selected.clear(); save(); render(); },
    prev: () => { state.page--; renderTable(); }, next: () => { state.page++; renderTable(); },
    theme: () => { state.theme = state.theme ? '' : 'dark'; $('.app').classList.toggle('dark', !!state.theme); host.dataset.theme = state.theme; save(); },
    settings: showSettings, help: showHelp, export: showExport, 'close-modal': closeModal,
    'save-settings': () => { const form = $('#settings-form'); if (!form.reportValidity()) return; state.settings = settingsOf(Object.fromEntries(new FormData(form))); save(); closeModal(); renderSelection(); toast('Settings saved.'); },
    'reset-settings': () => { Object.entries(DEFAULT_SETTINGS).forEach(([k, v]) => { $(`[name="${k}"]`).value = v; }); },
    'export-csv': () => download(`instagram-${state.tab}.csv`, csvOf(filtered()), 'text/csv;charset=utf-8'),
    'export-json': () => download(`instagram-${state.tab}.json`, JSON.stringify(filtered(), null, 2)),
    'export-history': () => download('instagram-activity.json', JSON.stringify(state.history, null, 2)),
    'export-snapshot': () => download('instagram-snapshot.json', JSON.stringify(state.snapshot, null, 2)),
    'export-protected': () => download('instagram-protected.json', JSON.stringify({ kind: 'insta-unfollow-protected', version: 1, accountId, users: [...state.protected.values()] }, null, 2)),
    'import-protected': () => { if (state.busy) return toast('Wait for the operation to finish before importing.', true); $('#import-file').click(); },
    'copy-list': async () => { await navigator.clipboard.writeText(filtered().map(u => u.username).join('\n')); toast('Usernames copied.'); },
    'copy-code': async () => { await navigator.clipboard.writeText(document.querySelector('#production-code')?.textContent ?? ''); toast('Script copied. Run it in the console on Instagram.'); },
    minimize, close
  };
  shadow.addEventListener('click', async event => {
    const target = event.target.closest('button, a'); if (!target || target.disabled) return;
    try {
      if (target.dataset.tab) { state.tab = target.dataset.tab; state.page = 1; render(); }
      else if (target.dataset.protect && !state.busy) {
        const id = target.dataset.protect;
        if (state.protected.has(id)) state.protected.delete(id);
        else { const user = usersForTab().find(u => u.id === id); if (user) state.protected.set(id, user); }
        state.protectedVersion++; state.selected.delete(id); save(); render();
      } else if (target.dataset.action) await actions[target.dataset.action]?.();
    } catch (error) { toast(error.message || 'The operation could not be completed.', true); }
  });
  $('#search').addEventListener('input', event => {
    state.query = event.target.value; state.page = 1; clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { if (!closed) renderTable(); }, 120);
  });
  shadow.addEventListener('change', async event => {
    const el = event.target;
    if (['privacy', 'verified', 'sort'].includes(el.id)) { state[el.id] = el.value; state.page = 1; renderTable(); }
    if (el.dataset.select) selectUsers([{ id: el.dataset.select }], el.checked);
    if (el.id === 'select-page') selectUsers(filtered().slice((state.page - 1) * 20, state.page * 20), el.checked);
    if (el.id === 'confirm-check') $('[data-action="run"]').disabled = !el.checked;
    if (el.id === 'import-file') {
      const file = el.files?.[0]; if (!file) return;
      try {
        if (state.busy) throw new Error('Wait for the operation to finish first.');
        if (file.size > 5 * 1024 * 1024) throw new Error('The file exceeds the 5 MB limit.');
        const users = parseProtected(await file.text(), accountId);
        if (state.busy) throw new Error('Import is unavailable while an operation is running.');
        users.forEach(u => { state.protected.set(u.id, u); state.selected.delete(u.id); }); state.protectedVersion++; save(); render(); closeModal(); toast(`${users.length} protection entries merged.`);
      } catch (error) { toast(error.message, true); } finally { el.value = ''; }
    }
  });
  shadow.addEventListener('keydown', event => {
    const layer = $('.modal-layer'); if (layer.hidden) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeModal(); }
    if (event.key === 'Tab') {
      const focusable = [...layer.querySelectorAll('button:not(:disabled),input:not(:disabled),select,a[href]')];
      const first = focusable[0], last = focusable.at(-1);
      if (event.shiftKey && shadow.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && shadow.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
  });
  $('.launcher').addEventListener('click', show);
  const expiry = setInterval(() => { if (state.fresh && !isFresh()) { state.fresh = false; setNote('The scan is over 30 minutes old. Scan again to enable actions.'); render(); } }, 10000);
  async function initialize() {
    if (demo) { renderProfile(); return; }
    try {
      const stored = await snapshotStore.read(accountId);
      if (closed) return;
      if (!stored?.snapshot && !state.snapshot) {
        const legacy = JSON.parse(localStorage.getItem(legacyKey) || '{}');
        if (legacy.snapshot) {
          state.snapshot = validateSnapshot(legacy.snapshot, accountId);
          state.previous = legacy.previous ? validateSnapshot(legacy.previous, accountId) : null;
        }
      }
      if (stored?.snapshot) {
        state.snapshot = validateSnapshot(stored.snapshot, accountId);
        state.previous = stored.previous ? validateSnapshot(stored.previous, accountId) : null;
        if (saved.removedFrom === state.snapshot.scannedAt && Array.isArray(saved.removedIds)) {
          state.removedIds = new Set(saved.removedIds.filter(id => /^\d+$/.test(id)));
          state.snapshot.following = state.snapshot.following.filter(user => !state.removedIds.has(user.id));
        }
      } else if (state.snapshot) {
        await snapshotStore.write(accountId, { snapshot: state.snapshot, previous: state.previous });
      }
      persistenceReady = true;
      save();
    } catch { storageIssue = true; persistenceReady = true; }
    if (closed) return;
    const username = pageAccountUsername(accountId);
    state.profile = username ? { id: accountId, username } : state.snapshot?.profile ?? null;
    state.busy = false;
    setNote(state.snapshot ? 'Saved snapshot loaded. Run a new scan to enable actions.' : 'Scan your account when ready. Results are stored only in this browser.');
    renderProfile();
    render();
    if (!closed && storageIssue) toast('Some saved data could not be loaded. Export your protection list as a backup.', true);
  }
  window[key] = { show, version: '1.1.3' };
  render();
  void initialize();
  if (storageIssue) toast('Some saved data could not be read. Import your protection backup if needed.', true);
}
(() => {
'use strict';
const DEFAULT_SETTINGS = Object.freeze({ delaySeconds: 30, batchSize: 5, breakSeconds: 120, maxItems: 20 });
const FRESH_MS = 30 * 60 * 1000;

function settingsOf(value = {}) {
  const bound = (key, min, max) => {
    const n = Number(value[key]);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : DEFAULT_SETTINGS[key];
  };
  return { delaySeconds: bound('delaySeconds', 20, 600), batchSize: bound('batchSize', 1, 10),
    breakSeconds: bound('breakSeconds', 120, 1800), maxItems: bound('maxItems', 1, 50) };
}

function normalizeUser(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('Account data could not be read; the scan is incomplete.');
  const rawId = raw.id ?? raw.pk_id ?? raw.pk;
  if (typeof rawId === 'number' && !Number.isSafeInteger(rawId)) throw new Error('The account ID could not be read without losing precision.');
  const id = String(rawId ?? '');
  const username = String(raw.username ?? '');
  if (!/^\d{1,30}$/.test(id) || !/^[a-zA-Z0-9_.]{1,30}$/.test(username)) {
    throw new Error('Unexpected account format; no action was taken with incomplete data.');
  }
  return { id, username, full_name: String(raw.full_name ?? '').slice(0, 200),
    is_private: raw.is_private === true, is_verified: raw.is_verified === true };
}

function uniqueUsers(users) {
  if (!Array.isArray(users) || users.length > 500000) throw new Error('The account list is invalid or too large.');
  return [...new Map(users.map(raw => { const user = normalizeUser(raw); return [user.id, user]; })).values()];
}

function classify(snapshot) {
  const following = snapshot?.following ?? [], followers = snapshot?.followers ?? [];
  const theirIds = new Set(followers.map(u => u.id)), myIds = new Set(following.map(u => u.id));
  return { following, followers, nonfollowers: following.filter(u => !theirIds.has(u.id)),
    mutual: following.filter(u => theirIds.has(u.id)), fans: followers.filter(u => !myIds.has(u.id)) };
}

function difference(previous, current) {
  if (!previous) return { lost: [], gained: [], available: false };
  const before = new Set(previous.followers.map(u => u.id)), after = new Set(current.followers.map(u => u.id));
  return { lost: previous.followers.filter(u => !after.has(u.id)), gained: current.followers.filter(u => !before.has(u.id)), available: true };
}

function searchKey(value) { return String(value).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replaceAll('ı', 'i'); }
const userCollator = new Intl.Collator('en', { sensitivity: 'base' });
const listIndexes = new WeakMap();
function filterUsers(users, { query = '', privacy = 'all', verified = 'all', sort = 'az' } = {}) {
  let index = listIndexes.get(users);
  if (!index) {
    const ordered = users.slice().sort((a, b) => userCollator.compare(a.username, b.username));
    index = { ordered, searchable: new Map(ordered.map(u => [u, searchKey(`${u.username} ${u.full_name}`)])), key: null, result: null };
    listIndexes.set(users, index);
  }
  const q = searchKey(query.trim()), key = JSON.stringify([q, privacy, verified, sort]);
  if (key === index.key) return index.result;
  let result = !q && privacy === 'all' && verified === 'all' ? index.ordered : index.ordered.filter(u => (!q || index.searchable.get(u).includes(q))
    && (privacy === 'all' || (privacy === 'private') === u.is_private)
    && (verified === 'all' || (verified === 'yes') === u.is_verified));
  if (sort === 'za') result = result.slice().reverse();
  index.key = key; index.result = result;
  return result;
}

function csvOf(users) {
  const cell = value => {
    let s = String(value ?? '');
    if (/^[\s]*[=+@\-\t\r]/.test(s)) s = `'${s}`;
    return `"${s.replaceAll('"', '""')}"`;
  };
  return '\uFEFF' + [['username', 'name', 'account_id', 'private', 'verified', 'profile'],
    ...users.map(u => [u.username, u.full_name, u.id, u.is_private, u.is_verified, `https://www.instagram.com/${u.username}/`])]
    .map(row => row.map(cell).join(',')).join('\r\n');
}

function validateSnapshot(value, accountId) {
  if (!value || value.accountId !== accountId || value.complete !== true || !Number.isFinite(value.scannedAt)
    || value.scannedAt > Date.now() + 60000 || value.scannedAt < 0) throw new Error('This snapshot is invalid or belongs to another account.');
  let profile;
  if (value.profile) { const p = normalizeUser(value.profile); if (p.id === accountId) profile = p; }
  return { accountId, scannedAt: value.scannedAt, complete: true, ...(profile ? { profile } : {}),
    following: uniqueUsers(value.following), followers: uniqueUsers(value.followers) };
}

function parseProtected(text, accountId) {
  const data = JSON.parse(text);
  if (data?.kind !== 'insta-unfollow-protected' || data.version !== 1 || data.accountId !== accountId) {
    throw new Error('This protection file is invalid or belongs to another account.');
  }
  return uniqueUsers(data.users);
}

function abortError() { return new DOMException('Operation stopped.', 'AbortError'); }
function checkAbort(signal) { if (signal?.aborted) throw abortError(); }
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const stop = () => { clearTimeout(timer); reject(abortError()); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', stop); resolve(); }, ms);
    signal?.addEventListener('abort', stop, { once: true });
  });
}

class UnfollowQueue {
  constructor({ client, eligible, onEvent = () => {}, settings = {}, wait = sleep, demo = false }) {
    Object.assign(this, { client, eligible, onEvent, wait, demo });
    this.settings = settingsOf(settings);
    this.running = false;
    this.paused = false;
  }
  pause() { if (this.running) { this.paused = true; this.onEvent({ type: 'paused' }); } }
  resume() { if (this.running) { this.paused = false; this.onEvent({ type: 'resumed' }); } }
  stop() { this.controller?.abort(); }
  async checkpoint() {
    checkAbort(this.controller.signal);
    while (this.paused) { await this.wait(200, this.controller.signal); checkAbort(this.controller.signal); }
  }
  async countdown(seconds, label) {
    const step = this.demo ? 15 : 1000;
    for (let remaining = seconds; remaining > 0; remaining--) {
      await this.checkpoint();
      this.onEvent({ type: 'waiting', remaining, label });
      await this.wait(step, this.controller.signal);
    }
  }
  async run(targets) {
    if (this.running) throw new Error('A queue is already running.');
    const users = uniqueUsers(targets);
    if (!users.length || users.length > this.settings.maxItems) throw new Error(`Select up to ${this.settings.maxItems} accounts per queue.`);
    this.controller = new AbortController();
    this.running = true; this.paused = false;
    let completed = 0, reason = 'complete';
    this.onEvent({ type: 'start', total: users.length });
    try {
      for (const user of users) {
        let posted = false;
        try {
          await this.checkpoint();
          if (!this.eligible(user)) { this.onEvent({ type: 'result', user, status: 'skipped', message: 'The account is no longer eligible or is protected.' }); continue; }
          this.onEvent({ type: 'checking', user });
          const relation = await this.client.relation(user.id, this.controller.signal);
          await this.checkpoint();
          if (relation.followed_by || !relation.following || !this.eligible(user)) {
            this.onEvent({ type: 'result', user, status: 'skipped', message: 'The follow relationship changed or the account is protected.' });
          } else {
            this.onEvent({ type: 'sending', user });
            await this.client.unfollow(user.id, this.controller.signal, () => { posted = true; });
            completed++;
            this.onEvent({ type: 'result', user, status: 'success', message: 'Unfollowed.' });
          }
        } catch (error) {
          reason = error.name === 'AbortError' ? 'stopped' : 'error';
          if (posted || error.name !== 'AbortError') this.onEvent({ type: 'result', user,
            status: posted ? 'uncertain' : 'failed', message: posted ? 'The result could not be verified. Scan again before retrying.' : error.message });
          throw error;
        }
        if (user !== users.at(-1)) {
          const long = completed > 0 && completed % this.settings.batchSize === 0;
          await this.countdown(long ? this.settings.breakSeconds : this.settings.delaySeconds, long ? 'Batch break' : 'Next action');
        }
      }
    } catch (error) {
      reason = error.name === 'AbortError' ? 'stopped' : 'error';
      this.onEvent({ type: 'halted', message: error.message, reason });
    } finally {
      this.running = false; this.paused = false;
      this.onEvent({ type: 'finish', completed, reason });
    }
  }
}

function cookieValue(name, cookie) {
  const entry = cookie.split(';').map(s => s.trim()).find(s => s.startsWith(`${name}=`));
  if (!entry) return '';
  try { return decodeURIComponent(entry.slice(name.length + 1)); } catch { return ''; }
}

class InstagramError extends Error {
  constructor(message, code = 'request', details = {}) {
    super(message); this.name = 'InstagramError'; this.code = code; this.details = details;
  }
}

function pageAccountUsername(accountId, pageDocument = globalThis.document) {
  let remaining = 50000;
  for (const script of pageDocument?.querySelectorAll('script[type="application/json"]') ?? []) {
    if (!remaining) break;
    if (script.textContent.length > 5 * 1024 * 1024) continue;
    let data;
    try { data = JSON.parse(script.textContent); } catch { continue; }
    const pending = [data];
    while (pending.length && remaining > 0) {
      const value = pending.pop(); remaining--;
      if (!value || typeof value !== 'object') continue;
      if (String(value.id ?? value.pk_id ?? value.pk ?? '') === accountId) {
        try { return normalizeUser(value).username; } catch { }
      }
      for (const child of Object.values(value)) {
        if (child && typeof child === 'object' && pending.length < remaining) pending.push(child);
      }
    }
  }
  return '';
}

function retryAfterTime(value, now = Date.now()) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const text = value.trim();
  const at = /^\d+$/.test(text) ? now + Number(text) * 1000 : /^[A-Za-z]{3},/.test(text) ? Date.parse(text) : NaN;
  return Number.isFinite(at) && at >= 0 && at <= 8640000000000000 ? Math.max(now, at) : null;
}

function requiresVerification(data) {
  return !!(data?.spam || data?.feedback_required || data?.checkpoint_url || data?.challenge
    || data?.challenge_required || data?.checkpoint_required || data?.require_login
    || /feedback_required|challenge_required|checkpoint_required|login_required/i.test(String(data?.message ?? '')));
}

const LIST_QUERIES = {
  followers: { hash: '37479f2b8209594dde7facb0d904896a', edge: 'edge_followed_by' },
  following: { hash: '58712303d941c6855d4e888c5f0cd22f', edge: 'edge_follow' }
};

class InstagramClient {
  constructor({ accountId, fetcher = globalThis.fetch.bind(globalThis), cookies = () => document.cookie, pageDelay = 2500, maxPages = 1000, scanRetries = 3, wait = sleep, now = Date.now }) {
    Object.assign(this, { accountId, fetcher, cookies, pageDelay, maxPages, scanRetries, wait, now });
    this.retryAt = 0;
  }
  assertSession() {
    if (!/^\d+$/.test(this.accountId) || cookieValue('ds_user_id', this.cookies()) !== this.accountId) {
      throw new InstagramError('The Instagram account changed or signed out. Reopen the panel on the correct account.', 'session');
    }
    if (!cookieValue('csrftoken', this.cookies())) throw new InstagramError('Instagram session not found. Please sign in again.', 'session');
  }
  async request(path, { signal, method = 'GET', beforeSend, operation = 'request' } = {}) {
    checkAbort(signal); this.assertSession();
    const allowed = typeof path === 'string' && (method === 'GET'
      ? /^\/api\/v1\/friendships\/(?:\d{1,30}\/(?:followers|following)|show\/\d{1,30})\/(?:\?[^#\\\s]*)?$/.test(path)
        || /^\/graphql\/query\/\?[^#\\\s]+$/.test(path)
      : method === 'POST' && /^\/web\/friendships\/\d{1,30}\/unfollow\/$/.test(path));
    if (!allowed) throw new InstagramError('Unexpected request destination or method. No request was sent.', 'destination');
    if (this.retryAt > this.now()) {
      throw new InstagramError(`Instagram requested a wait until ${new Date(this.retryAt).toLocaleString('en-US')}. No request was sent.`, 'rate_limit', { retryAt: this.retryAt });
    }
    const timer = new AbortController();
    const timeout = setTimeout(() => timer.abort(), 25000);
    const abort = () => timer.abort();
    signal?.addEventListener('abort', abort, { once: true });
    try {
      const headers = { 'X-IG-App-ID': '936619743392459', 'X-ASBD-ID': '129477', 'X-Requested-With': 'XMLHttpRequest',
        'X-CSRFToken': cookieValue('csrftoken', this.cookies()), Accept: 'application/json' };
      if (method === 'POST') headers['Content-Type'] = 'application/x-www-form-urlencoded';
      beforeSend?.();
      const response = await this.fetcher(path, { method, credentials: 'same-origin', redirect: 'error', cache: 'no-store',
        headers, signal: timer.signal, ...(method === 'POST' ? { body: '' } : {}) });
      if (response.status === 429) {
        const retryAt = retryAfterTime(response.headers?.get('Retry-After'), this.now());
        this.retryAt = retryAt ?? 0;
        let body;
        try { body = await response.json(); } catch { }
        const reason = typeof body?.message === 'string' ? body.message.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 240) : '';
        const waitMessage = retryAt == null ? 'Instagram did not provide a retry time.' : `Wait until ${new Date(retryAt).toLocaleString('en-US')} before trying again.`;
        throw new InstagramError(`Instagram limited the ${operation} (HTTP 429). ${reason ? `Server message: ${reason} ` : ''}${waitMessage} Request stopped.`, 'rate_limit', { status: 429, operation, retryAt, reason, retryable: !requiresVerification(body) });
      }
      if (response.status === 401 || response.status === 403) throw new InstagramError('Instagram denied access. Check your session and any notice on Instagram.', 'session');
      if (!response.ok) throw new InstagramError(`Instagram returned HTTP ${response.status}. The operation was stopped.`, 'http', { status: response.status });
      let data;
      try { data = await response.json(); } catch { throw new InstagramError('Instagram returned an unexpected response. Check your session.', 'response'); }
      if (!data || typeof data !== 'object' || data.status === 'fail' || requiresVerification(data)) {
        throw new InstagramError('Instagram rejected the request or requires verification. Stopped; check Instagram before continuing.', 'blocked');
      }
      this.assertSession(); return data;
    } catch (error) {
      checkAbort(signal);
      if (timer.signal.aborted) throw new InstagramError('Instagram timed out. The request was not retried automatically.', 'timeout');
      if (error instanceof TypeError) throw new InstagramError('Could not reach Instagram. Check your connection and whether this specific request was blocked by your browser.', 'network');
      throw error;
    } finally { clearTimeout(timeout); signal?.removeEventListener('abort', abort); }
  }
  async scanRequest(path, kind, signal, progress) {
    for (let attempt = 0; ; attempt++) {
      try { return await this.request(path, { signal, operation: `${kind} list` }); }
      catch (error) {
        if (error.code !== 'rate_limit' || error.details.status !== 429 || !error.details.retryable) throw error;
        if (attempt >= this.scanRetries) {
          throw new InstagramError(`${error.message} Scan stopped after ${attempt} retries; unfollowing remains disabled.`, error.code, error.details);
        }
        const retry = attempt + 1;
        const delay = Math.max(30000 * retry, (error.details.retryAt ?? 0) - this.now());
        await this.scanCountdown(delay, signal, progress, { kind, phase: 'cooldown', retry, retries: this.scanRetries });
      }
    }
  }
  async scanCountdown(ms, signal, progress, event) {
    for (let remaining = ms; remaining > 0; remaining -= Math.min(1000, remaining)) {
      checkAbort(signal); this.assertSession();
      progress({ ...event, remaining: Math.ceil(remaining / 1000) });
      await this.wait(Math.min(1000, remaining), signal);
    }
    checkAbort(signal);
  }
  async pagePause(kind, page, signal, progress) {
    if (page % 15 === 0) {
      await this.scanCountdown(Math.max(10000, this.pageDelay), signal, progress, { kind, phase: 'pause' });
    } else await this.wait(this.pageDelay, signal);
  }
  paginationError(kind, count, expected, reason) {
    return new InstagramError(`Could not finish the ${kind} list (${count}${expected == null ? '' : ` of ${expected}`} accounts). ${reason} Unfollowing remains disabled.`, 'pagination', { kind, count, expected, reason });
  }
  async list(kind, signal, progress = () => {}, expected = null) {
    if (!LIST_QUERIES[kind]) throw new Error('Invalid list type.');
    try { return await this.listRest(kind, signal, progress, expected); }
    catch (error) {
      if (error.code !== 'pagination') throw error;
      progress({ kind, count: error.details.count, page: 0, phase: 'fallback' });
      await this.wait(this.pageDelay, signal);
      return this.listGraphQL(kind, signal, progress, expected);
    }
  }
  async listRest(kind, signal, progress, expected) {
    const users = new Map(), cursors = new Set();
    const rankToken = `${this.accountId}_${globalThis.crypto.randomUUID()}`;
    let cursor = '', emptyPages = 0;
    for (let page = 0; page < this.maxPages; page++) {
      checkAbort(signal);
      const params = new URLSearchParams({ count: '50', search_surface: 'follow_list_page', rank_token: rankToken });
      if (cursor) params.set('max_id', cursor);
      const data = await this.scanRequest(`/api/v1/friendships/${this.accountId}/${kind}/?${params}`, kind, signal, progress);
      if (!Array.isArray(data.users)) throw this.paginationError(kind, users.size, expected, 'The list response format changed.');
      const before = users.size;
      for (const raw of data.users) { const user = normalizeUser(raw); users.set(user.id, user); }
      emptyPages = users.size === before ? emptyPages + 1 : 0;
      progress({ kind, count: users.size, page: page + 1 });
      const rawCursor = data.next_max_id;
      if (rawCursor != null && !['string', 'number'].includes(typeof rawCursor)) throw this.paginationError(kind, users.size, expected, 'Invalid page cursor.');
      const next = rawCursor == null || rawCursor === '' || rawCursor === 0 || rawCursor === '0' ? '' : String(rawCursor);
      const more = data.has_more === true || data.more_available === true;
      for (const flag of [data.has_more, data.more_available]) {
        if (flag != null && typeof flag !== 'boolean') throw this.paginationError(kind, users.size, expected, 'Invalid pagination flag.');
      }
      if (more && (data.has_more === false || data.more_available === false)) throw this.paginationError(kind, users.size, expected, 'Conflicting pagination flags.');
      if (next && (data.has_more === false || data.more_available === false)) throw this.paginationError(kind, users.size, expected, 'A terminal page still contains a continuation cursor.');
      const terminal = data.has_more === false || data.more_available === false || (!next && !more);
      if (terminal) {
        if (expected != null && users.size !== expected) throw this.paginationError(kind, users.size, expected, 'The account count does not match the returned list.');
        return [...users.values()];
      }
      if (!next || cursors.has(next) || emptyPages >= 2) {
        if (expected != null && users.size === expected && !more) return [...users.values()];
        throw this.paginationError(kind, users.size, expected, 'Instagram returned a missing or non-advancing cursor.');
      }
      cursors.add(next); cursor = next;
      await this.pagePause(kind, page + 1, signal, progress);
    }
    throw new InstagramError(`The ${kind} scan reached the page limit. Unfollowing remains disabled.`, 'page_limit');
  }
  async listGraphQL(kind, signal, progress, expected) {
    const { hash, edge: edgeKey } = LIST_QUERIES[kind];
    const users = new Map(), cursors = new Set();
    let cursor = '', total = expected, emptyPages = 0;
    for (let page = 0; page < this.maxPages; page++) {
      const variables = { id: this.accountId, include_reel: false, fetch_mutual: false, first: 50, ...(cursor ? { after: cursor } : {}) };
      const params = new URLSearchParams({ query_hash: hash, variables: JSON.stringify(variables) });
      const data = await this.scanRequest(`/graphql/query/?${params}`, kind, signal, progress);
      const edge = data.data?.user?.[edgeKey];
      if (!edge || !Array.isArray(edge.edges) || typeof edge.page_info?.has_next_page !== 'boolean') {
        throw this.paginationError(kind, users.size, total, 'The alternate read-only list is unavailable.');
      }
      if (Number.isSafeInteger(edge.count) && edge.count >= 0) {
        if (total != null && total !== edge.count) throw this.paginationError(kind, users.size, total, 'The list changed during the scan. Please scan again.');
        total = edge.count;
      }
      const before = users.size;
      for (const entry of edge.edges) { const user = normalizeUser(entry.node); users.set(user.id, user); }
      emptyPages = users.size === before ? emptyPages + 1 : 0;
      progress({ kind, count: users.size, page: page + 1, phase: 'alternate' });
      if (!edge.page_info.has_next_page) {
        if (total != null && users.size !== total) throw this.paginationError(kind, users.size, total, 'The alternate list is incomplete.');
        return [...users.values()];
      }
      const next = edge.page_info.end_cursor;
      if (typeof next !== 'string' || !next || cursors.has(next) || emptyPages >= 2) throw this.paginationError(kind, users.size, total, 'The alternate list did not advance.');
      cursors.add(next); cursor = next;
      await this.pagePause(kind, page + 1, signal, progress);
    }
    throw new InstagramError(`The ${kind} scan reached the page limit. Unfollowing remains disabled.`, 'page_limit');
  }
  async scan(signal, progress = () => {}) {
    checkAbort(signal); this.assertSession();
    const following = await this.list('following', signal, progress);
    await this.wait(this.pageDelay, signal);
    const followers = await this.list('followers', signal, progress);
    checkAbort(signal); this.assertSession();
    return { accountId: this.accountId, followers, following, scannedAt: this.now(), complete: true };
  }
  async relation(id, signal) {
    if (!/^\d+$/.test(id)) throw new Error('Invalid account ID.');
    const data = await this.request(`/api/v1/friendships/show/${id}/`, { signal, operation: 'relationship check' });
    const relationship = data.friendship_status ?? data;
    if (typeof relationship.following !== 'boolean' || typeof relationship.followed_by !== 'boolean') throw new Error('Could not verify the current follow relationship. No action was taken.');
    return relationship;
  }
  async unfollow(id, signal, beforeSend) {
    if (!/^\d+$/.test(id) || id === this.accountId) throw new Error('Invalid target account.');
    const data = await this.request(`/web/friendships/${id}/unfollow/`, { method: 'POST', signal, beforeSend, operation: 'unfollow request' });
    if (data.status !== 'ok') throw new Error('Could not verify the result.');
    if (data.friendship_status?.following === false) return;
    if (data.friendship_status?.following === true) throw new Error('The account is still followed.');
    const after = await this.relation(id, signal);
    if (after.following) throw new Error('Could not verify the unfollow.');
  }
}
class SnapshotStore {
  constructor(factory = globalThis.indexedDB) { this.factory = factory; this.database = null; }
  open() {
    if (!this.database) this.database = new Promise((resolve, reject) => {
      if (!this.factory) return reject(new Error('Snapshot storage is unavailable.'));
      const request = this.factory.open('insta-unfollow-studio', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('snapshots');
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('Snapshot storage is blocked by another tab.'));
      request.onsuccess = () => { request.result.onversionchange = () => request.result.close(); resolve(request.result); };
    });
    return this.database;
  }
  async read(accountId) {
    const database = await this.open();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction('snapshots', 'readonly');
      const request = transaction.objectStore('snapshots').get(accountId);
      transaction.oncomplete = () => resolve(request.result ?? null);
      transaction.onerror = transaction.onabort = () => reject(transaction.error ?? new Error('Snapshot could not be loaded.'));
    });
  }
  async write(accountId, value) {
    const database = await this.open();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction('snapshots', 'readwrite');
      transaction.objectStore('snapshots').put(value, accountId);
      transaction.oncomplete = () => resolve();
      transaction.onerror = transaction.onabort = () => reject(transaction.error ?? new Error('Snapshot could not be saved.'));
    });
  }
}

function createDemoClient() {
  const names = [
    ['ada.kare', 'Ada Yılmaz'], ['mert.studio', 'Mert Demir'], ['eceyollarda', 'Ece Aydın'], ['deniz.analog', 'Deniz Kaya'],
    ['selin.design', 'Selin Arslan'], ['keremnotlar', 'Kerem Çelik'], ['duru.atolye', 'Duru Aksoy'], ['emre.wav', 'Emre Şahin'],
    ['zeynep.co', 'Zeynep Koç'], ['baris.rotasi', 'Barış Yıldız'], ['elif.ciziyor', 'Elif Güneş'], ['can.digital', 'Can Eren'],
    ['flora.gunluk', 'Flora Günlük'], ['atlas.collective', 'Atlas Collective'], ['kahve.arasi', 'Kahve Arası'], ['pazar.studio', 'Pazar Studio'],
    ['yasam.notlari', 'Yaşam Notları'], ['aylin.jpg', 'Aylin Deniz'], ['burak.frames', 'Burak Arda'], ['seda.mutfak', 'Seda Mutlu'],
    ['utku.visual', 'Utku Can'], ['nazli.reads', 'Nazlı Işık'], ['onur.onroad', 'Onur Öztürk'], ['ipek.objects', 'İpek Tekin']
  ];
  const all = Array.from({ length: 128 }, (_, i) => {
    const [handle, name] = names[i % names.length], suffix = i < names.length ? '' : `_${Math.floor(i / names.length) + 1}`;
    return { id: String(100000 + i), username: handle + suffix, full_name: name,
      is_private: i % 3 === 0, is_verified: i % 11 === 0 };
  });
  let following = all.slice(0, 96);
  const followers = all.filter((_, i) => i >= 32 && i < 120);
  const snapshot = () => ({ accountId: 'demo', scannedAt: Date.now(), complete: true,
    following: structuredClone(following), followers: structuredClone(followers) });
  return {
    accountId: 'demo', snapshot,
    async scan(signal, progress) {
      for (const kind of ['followers', 'following']) {
        for (const count of [32, 64, kind === 'followers' ? 88 : following.length]) {
          await sleep(230, signal); progress({ kind, count, page: Math.ceil(count / 32) });
        }
      }
      return snapshot();
    },
    async relation(id, signal) { checkAbort(signal); await sleep(130, signal);
      return { following: following.some(u => u.id === id), followed_by: followers.some(u => u.id === id) }; },
    async unfollow(id, signal, beforeSend) { checkAbort(signal); beforeSend?.(); await sleep(300, signal); following = following.filter(u => u.id !== id); }
  };
}

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

function startApp({ css, demo = false }) {
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
startApp({ css: ":host{all:initial;--bg:#f6f8f7;--panel:#fff;--ink:#172c25;--muted:#738079;--line:#e3eae6;--green:#24634c;--soft:#eaf3ed;--danger:#b7483e;--amber:#986e2c;font-family:Inter,\"Segoe UI\",Arial,sans-serif;font-size:14px;color:var(--ink);line-height:1.5;color-scheme:light}\n*{box-sizing:border-box}button,input,select{font:inherit}button,a,input,select{touch-action:manipulation}button{cursor:pointer}button:disabled{cursor:not-allowed;opacity:.42}button{border:0}a{color:inherit;text-decoration:none}button,input,select,a{outline-offset:4px}button:focus-visible,a:focus-visible{outline:2px solid var(--green)}button svg{width:18px;height:18px;flex-shrink:0}svg{width:20px;height:20px;vertical-align:middle;fill:none;stroke:currentColor;stroke-width:1.65;stroke-linecap:round;stroke-linejoin:round}h1,h2,h3,p{margin:0}button{transition:background .15s,opacity .15s,transform .15s}button:active:not(:disabled){transform:translateY(1px)}[hidden]{display:none!important}\n.app{background:var(--bg);position:fixed;inset:0;display:grid;grid-template-columns:234px minmax(0,1fr);overflow:hidden}.app.dark{--bg:#09090b;--panel:#141416;--ink:#eeeef0;--muted:#a1a1aa;--line:#2a2a30;--green:#c7c7d0;--soft:#222226;--danger:#ed9393;--amber:#d6b37c;color-scheme:dark}\n.sidebar{background:var(--panel);border-right:1px solid var(--line);display:flex;flex-direction:column;padding:32px 18px 20px;min-height:0}.brand{display:flex;gap:10px;align-items:center;padding:0 10px 32px;font-size:20px;font-weight:720;letter-spacing:-.7px}.brand-symbol{background:var(--green);color:var(--panel);height:35px;width:35px;display:grid;place-items:center;border-radius:11px}.brand small{display:block;font-size:10px;letter-spacing:2.5px;color:var(--muted);font-weight:600;margin-top:-2px}.nav-caption{padding:0 14px;margin:14px 0 10px;font-size:10px;font-weight:700;letter-spacing:1.5px;color:var(--muted)}nav{display:flex;flex-direction:column;gap:5px}nav button{display:flex;align-items:center;width:100%;gap:11px;padding:11px 13px;border-radius:9px;background:transparent;color:var(--muted);text-align:left;font-size:13px;font-weight:550}nav button.active{background:var(--soft);color:var(--green)}nav button:hover{background:var(--bg)}nav button.active:hover{background:var(--soft)}.nav-count{margin-left:auto;font-size:11px;min-width:22px;text-align:center;color:var(--muted)}nav button.active .nav-count{color:var(--green);background:var(--panel);border-radius:5px}.sidebar-bottom{margin-top:auto;padding-top:20px}.local-card{border:1px solid var(--line);border-radius:12px;padding:15px;margin:20px 4px 14px}.local-card svg{color:var(--green);margin-bottom:8px}.local-card strong{display:block;font-size:12px;margin-bottom:5px}.local-card p{font-size:11px;line-height:1.7;color:var(--muted)}.version{color:var(--muted);font-size:10px;padding:6px 12px;display:flex;justify-content:space-between}\n.workspace{min-width:0;display:flex;flex-direction:column;overflow:auto;scrollbar-width:thin}.topbar{height:78px;min-height:78px;display:flex;align-items:center;justify-content:space-between;padding:0 42px;border-bottom:1px solid var(--line);background:var(--panel);gap:12px}.breadcrumb{font-size:12px;color:var(--muted);display:flex;gap:12px;align-items:center}.breadcrumb strong{font-weight:550;color:var(--ink)}.top-actions{display:flex;align-items:center;gap:10px}.account{font-size:12px;border-right:1px solid var(--line);padding-right:17px;margin-right:4px;display:flex;gap:8px;align-items:center}.status-dot{height:6px;width:6px;border-radius:50%;background:#60a579;display:inline-block}.icon-btn{background:transparent;color:var(--muted);display:inline-flex;align-items:center;justify-content:center;width:34px;height:34px;border-radius:8px}.icon-btn:hover{background:var(--soft);color:var(--green)}.badge{font-size:10px;letter-spacing:.3px;border-radius:5px;padding:4px 7px;background:var(--soft);color:var(--green);font-weight:650}.demo-badge{background:#fff1d7;color:#89602b}\n.content{max-width:1440px;width:100%;margin:0 auto;padding:37px 42px 112px}.page-heading{display:flex;justify-content:space-between;align-items:center;gap:18px;margin-bottom:28px}.eyebrow{font-size:10px;color:var(--green);font-weight:700;letter-spacing:2px;margin-bottom:8px}.page-heading h1{font-size:32px;letter-spacing:-1.2px;line-height:1.25;font-weight:650}.subheading{color:var(--muted);margin-top:9px;font-size:13px}.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;border-radius:8px;padding:10px 15px;background:var(--panel);color:var(--ink);border:1px solid var(--line);font-size:12px;font-weight:600;white-space:nowrap}.btn:hover:not(:disabled){background:var(--soft)}.btn.primary{background:var(--green);border-color:var(--green);color:var(--panel)}.btn.danger{background:var(--danger);color:var(--panel);border-color:var(--danger)}.btn.quiet{background:transparent}.btn.small{padding:7px 11px;font-size:11px}.heading-actions{display:flex;gap:9px}\n.stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:15px;margin-bottom:23px}.stat{background:var(--panel);border:1px solid var(--line);border-radius:13px;padding:20px 21px;min-width:0}.stat.highlight{background:var(--green);color:var(--panel);border-color:var(--green)}.stat-top{display:flex;align-items:center;justify-content:space-between;font-size:11px;color:var(--muted);gap:6px}.stat.highlight .stat-top{color:inherit;opacity:.78}.stat-icon{display:grid;place-items:center;width:30px;height:30px;border-radius:8px;background:var(--bg)}.highlight .stat-icon{background:#ffffff1c}.stat strong{display:block;font-size:33px;letter-spacing:-1px;font-weight:650;margin-top:10px;font-variant-numeric:tabular-nums}.stat-bottom{font-size:10px;color:var(--muted);margin-top:6px}.highlight .stat-bottom{color:inherit;opacity:.78}.stat small{font-size:10px;letter-spacing:0;font-weight:500}\n.notice{display:flex;align-items:center;gap:12px;padding:13px 16px;border:1px solid var(--line);background:var(--soft);border-radius:10px;margin-bottom:23px;color:var(--green);font-size:12px}.notice svg{flex-shrink:0}.notice.error{background:var(--panel);border-color:var(--danger);color:var(--danger)}.notice .notice-copy{flex:1}.notice strong{font-weight:650}.notice .btn{margin-left:auto}.queue-panel{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:17px 20px;margin-bottom:22px}.queue-heading{display:flex;align-items:center;justify-content:space-between;gap:14px}.queue-heading strong{font-size:13px}.queue-info{color:var(--muted);font-size:11px;margin-top:5px}.progress{height:5px;background:var(--line);border-radius:5px;margin-top:14px;overflow:hidden}.progress span{display:block;height:100%;background:var(--green);transition:width .25s}.queue-actions{display:flex;gap:7px}\n.list-panel{background:var(--panel);border:1px solid var(--line);border-radius:13px;overflow:hidden}.list-heading{padding:22px 23px 18px;display:flex;align-items:center;justify-content:space-between;gap:12px}.list-title{display:flex;align-items:center;gap:10px}.list-title h2{font-size:17px;font-weight:650;letter-spacing:-.3px}.pill-count{font-size:11px;padding:2px 7px;border-radius:5px;background:var(--soft);color:var(--green);font-weight:600}.list-description{font-size:11px;color:var(--muted);margin-top:5px}.list-tools{display:flex;gap:7px}.filters{display:flex;align-items:center;gap:9px;padding:0 23px 19px;flex-wrap:wrap}.search{flex:1;min-width:160px;position:relative}.search svg{position:absolute;left:11px;top:11px;width:16px;height:16px;color:var(--muted)}input[type=search]{width:100%;padding:10px 12px 10px 35px;border:1px solid var(--line);border-radius:7px;color:var(--ink);background:var(--bg);font-size:12px;line-height:18px}.filters select{border:1px solid var(--line);border-radius:7px;background:var(--panel);color:var(--muted);padding:10px 24px 10px 10px;font-size:11px;max-width:160px}.table-scroll{overflow-x:auto}table{border-collapse:collapse;width:100%;text-align:left}thead{background:var(--bg);border-top:1px solid var(--line);border-bottom:1px solid var(--line)}th{font-size:10px;font-weight:550;color:var(--muted);padding:11px 12px}td{border-bottom:1px solid var(--line);padding:12px;font-size:12px}th:first-child,td:first-child{padding-left:24px;width:45px}th:last-child,td:last-child{padding-right:24px;text-align:right}tr:last-child td{border-bottom:0}tr.selected{background:var(--soft)}tbody tr:hover{background:var(--bg)}input[type=checkbox]{width:15px;height:15px;accent-color:var(--green);cursor:pointer;vertical-align:middle}input[type=checkbox]:disabled{opacity:.3;cursor:default}.user{display:flex;align-items:center;gap:12px;min-width:165px}.avatar{display:grid;place-items:center;width:36px;height:36px;flex-shrink:0;border-radius:50%;font-size:11px;letter-spacing:.5px;font-weight:650;background:var(--avatar-bg,#e5eee8);color:#395a48}.user strong{font-size:12px;font-weight:620;display:inline-flex;align-items:center;gap:5px}.user .verified{color:#438aa1;width:13px;height:13px}.user small{display:block;color:var(--muted);font-size:11px;margin-top:2px}.user a:hover{text-decoration:underline}.tag{display:inline-flex;align-items:center;gap:5px;font-size:10px;padding:4px 8px;border:1px solid var(--line);border-radius:5px;color:var(--muted);white-space:nowrap}.tag svg{width:11px;height:11px}.tag.amber{color:var(--amber);border-color:#bda77438;background:#e6c78d12}.tag.green{color:var(--green);background:var(--soft);border-color:transparent}.row-actions{display:flex;align-items:center;justify-content:flex-end;gap:4px}.row-actions .protected{color:var(--green);background:var(--soft)}.empty{padding:55px 24px 62px;text-align:center;color:var(--muted)}.empty-icon{width:54px;height:54px;border-radius:16px;background:var(--soft);color:var(--green);display:grid;place-items:center;margin:0 auto 17px}.empty h3{color:var(--ink);font-size:18px;font-weight:600;margin-bottom:8px}.empty p{font-size:12px;max-width:440px;margin:0 auto 18px;line-height:1.8}.pagination{display:flex;justify-content:space-between;align-items:center;padding:14px 23px;border-top:1px solid var(--line);color:var(--muted);font-size:11px;gap:10px}.page-buttons{display:flex;align-items:center;gap:9px}.page-buttons .icon-btn{width:26px;height:26px}.footnote{display:flex;align-items:flex-start;gap:7px;color:var(--muted);font-size:10px;margin-top:15px;line-height:1.8}.footnote svg{width:13px;height:13px;margin-top:3px;flex-shrink:0}\n.selection-bar{position:fixed;bottom:22px;left:calc(234px + 42px);right:42px;z-index:10;max-width:1272px;margin:auto;background:var(--ink);color:var(--panel);border-radius:12px;box-shadow:0 8px 30px #0002;padding:13px 18px;display:flex;align-items:center;gap:14px}.selection-bar strong{font-size:12px}.selection-bar small{font-size:10px;opacity:.65;margin-left:6px}.selection-bar .clear{color:inherit;background:transparent;text-decoration:underline;font-size:11px;opacity:.7;padding:7px}.selection-bar .spacer{flex:1}.selection-bar .btn{background:transparent;border-color:#ffffff30;color:inherit}.selection-bar .btn.primary{color:#234c3c;background:#d6edbe;border-color:#d6edbe}.selection-bar .btn:disabled{opacity:.4}\n.modal-layer{position:fixed;inset:0;background:#0b211b66;display:flex;align-items:center;justify-content:center;padding:22px;z-index:30}.modal{width:min(540px,100%);max-height:90vh;overflow:auto;background:var(--panel);border:1px solid var(--line);box-shadow:0 24px 90px #0003;border-radius:17px;padding:26px}.modal-head{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:12px}.modal h2{font-size:21px;letter-spacing:-.5px}.modal p{font-size:12px;color:var(--muted);line-height:1.8;margin-bottom:16px}.modal label.field{display:flex;justify-content:space-between;align-items:center;padding:13px 0;border-bottom:1px solid var(--line);gap:18px;font-size:12px}.modal label.field small{display:block;color:var(--muted);font-size:10px;margin-top:3px}.modal input[type=number]{width:83px;padding:8px;border:1px solid var(--line);border-radius:7px;background:var(--bg);color:var(--ink)}.modal-footer{display:flex;justify-content:flex-end;gap:8px;margin-top:22px}.confirm-list{max-height:180px;overflow:auto;background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:10px 14px;margin-bottom:17px;display:flex;flex-wrap:wrap;gap:7px}.confirm-list span{font-size:11px;background:var(--panel);border:1px solid var(--line);border-radius:5px;padding:3px 6px}.check-label{display:flex;gap:9px;align-items:flex-start;font-size:12px}.check-label input{flex-shrink:0;margin-top:3px}.export-options{display:grid;gap:9px}.export-options button{justify-content:flex-start;padding:13px}.help-steps{padding-left:20px;font-size:12px;line-height:1.8;color:var(--muted)}.help-steps li{padding:4px}.help-steps strong{color:var(--ink)}.toast{position:fixed;bottom:95px;right:32px;max-width:400px;z-index:60;background:var(--ink);color:var(--panel);border-radius:9px;padding:13px 18px;font-size:12px;box-shadow:0 5px 24px #0002}.toast.error{background:var(--danger)}.launcher{position:fixed;bottom:24px;right:24px;z-index:2147483647;border-radius:12px;background:#24634c;color:#fff;box-shadow:0 8px 24px #0003;padding:13px 18px;display:flex;gap:9px;align-items:center;font:600 13px \"Segoe UI\",sans-serif}.history-message{max-width:330px;font-size:11px;color:var(--muted)}\n@media(min-width:1700px){.selection-bar{left:calc(234px + (100vw - 234px - 1356px)/2);right:calc((100vw - 234px - 1356px)/2)}}\n@media(max-width:1150px){.app{grid-template-columns:208px minmax(0,1fr)}.sidebar{padding-left:10px;padding-right:10px}.content{padding:28px 25px 110px}.topbar{padding:0 25px}.selection-bar{left:233px;right:25px}.stats{gap:10px}.stat{padding:15px}.stat-top{font-size:10px}.page-heading h1{font-size:28px}.type-column{display:none}.filters select{max-width:135px}.selection-bar small{display:none}}\n@media(max-width:850px){.app{grid-template-columns:68px minmax(0,1fr)}.sidebar{padding:25px 8px}.brand{padding:0 8px 25px}.brand-text,.nav-caption,nav button .nav-label,.nav-count,.local-card,.version{display:none}nav{gap:8px;margin-bottom:18px}nav button{justify-content:center;padding:12px}.sidebar-bottom nav{margin:0}.content{padding:25px 20px 120px}.topbar{padding:0 20px;height:62px;min-height:62px}.selection-bar{left:88px;right:20px}.account{display:none}.stats{grid-template-columns:repeat(2,minmax(0,1fr))}.page-heading{align-items:flex-start}.heading-actions{flex-direction:column}.breadcrumb{font-size:10px}.stat strong{font-size:28px}.selection-bar{flex-wrap:wrap;gap:8px}.selection-bar .spacer{display:none}.list-heading{padding:18px 16px}.filters{padding:0 16px 16px}.selection-bar .btn{padding:8px 10px}}\n@media(max-width:560px){.page-heading{display:block}.heading-actions{flex-direction:row;margin-top:18px}.content{padding:22px 12px 155px}.topbar{padding:0 12px}.breadcrumb>span{display:none}.stats{gap:8px}.stat{padding:12px}.stat-top svg{width:15px}.stat-icon{width:23px;height:23px}.stat strong{font-size:25px}.stat-bottom{font-size:9px}.page-heading h1{font-size:26px}.list-tools .export-label{display:none}.list-heading{padding:16px 12px}.list-title h2{font-size:15px}.filters{padding:0 12px 14px;gap:7px}.search{flex-basis:100%}.filters select{flex:1;max-width:none;min-width:0;padding-right:8px;font-size:10px}.relation-column{display:none}td,th{padding:10px 6px}td:first-child,th:first-child{padding-left:12px}td:last-child,th:last-child{padding-right:12px}.avatar{width:30px;height:30px;font-size:9px}.user{gap:8px;min-width:110px}.user strong{font-size:11px}.user small{font-size:10px;max-width:125px;overflow:hidden;text-overflow:ellipsis}.row-actions{gap:0}.row-actions .icon-btn{width:26px}.selection-bar{left:80px;right:12px;bottom:12px;padding:12px}.selection-bar .btn{font-size:10px}.selection-bar .protect-selected{display:none}.pagination{padding:12px;font-size:10px}.notice{font-size:11px}.notice .btn{padding:7px;font-size:10px}.toast{right:14px;left:80px;bottom:160px}.modal{padding:20px}.queue-heading{align-items:flex-start;flex-direction:column}.page-heading .subheading{font-size:12px}}\n@media(prefers-reduced-motion:reduce){*{transition:none!important;scroll-behavior:auto!important}}\n\n.app{color:var(--ink)}\n.dark .status-dot{background:#a1a1aa}\n.dark .stat.highlight{background:#1c1c20;color:var(--ink);border-color:#37373e}\n.dark .stat.highlight .stat-icon{background:#29292e}\n.dark .selection-bar{background:#222226;color:var(--ink);border:1px solid #393940;box-shadow:0 8px 30px #0008}\n.dark .selection-bar .btn.primary{background:#e4e4e8;border-color:#e4e4e8;color:#111114}\n.dark .avatar{background:#2a2a30;color:#d4d4dc}\n.dark .tag.amber{background:#26231e;border-color:#41382b}\n.dark .modal-layer{background:#0009}\n.dark .toast{background:#303036;color:var(--ink);border:1px solid #484850}\n.dark .toast.error{background:#572c2c;color:#fff}\n:host([data-theme=dark]) .launcher{background:#222226;color:#eeeef0;border:1px solid #393940}\n.workspace{overscroll-behavior:contain}", demo: false });
})();

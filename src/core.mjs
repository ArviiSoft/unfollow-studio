export const DEFAULT_SETTINGS = Object.freeze({ delaySeconds: 30, batchSize: 5, breakSeconds: 120, maxItems: 20 });
export const FRESH_MS = 30 * 60 * 1000;

export function settingsOf(value = {}) {
  const bound = (key, min, max) => {
    const n = Number(value[key]);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : DEFAULT_SETTINGS[key];
  };
  return { delaySeconds: bound('delaySeconds', 20, 600), batchSize: bound('batchSize', 1, 10),
    breakSeconds: bound('breakSeconds', 120, 1800), maxItems: bound('maxItems', 1, 50) };
}

export function normalizeUser(raw) {
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

export function uniqueUsers(users) {
  if (!Array.isArray(users) || users.length > 500000) throw new Error('The account list is invalid or too large.');
  return [...new Map(users.map(raw => { const user = normalizeUser(raw); return [user.id, user]; })).values()];
}

export function classify(snapshot) {
  const following = snapshot?.following ?? [], followers = snapshot?.followers ?? [];
  const theirIds = new Set(followers.map(u => u.id)), myIds = new Set(following.map(u => u.id));
  return { following, followers, nonfollowers: following.filter(u => !theirIds.has(u.id)),
    mutual: following.filter(u => theirIds.has(u.id)), fans: followers.filter(u => !myIds.has(u.id)) };
}

export function difference(previous, current) {
  if (!previous) return { lost: [], gained: [], available: false };
  const before = new Set(previous.followers.map(u => u.id)), after = new Set(current.followers.map(u => u.id));
  return { lost: previous.followers.filter(u => !after.has(u.id)), gained: current.followers.filter(u => !before.has(u.id)), available: true };
}

export function searchKey(value) { return String(value).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replaceAll('ı', 'i'); }
const userCollator = new Intl.Collator('en', { sensitivity: 'base' });
const listIndexes = new WeakMap();
export function filterUsers(users, { query = '', privacy = 'all', verified = 'all', sort = 'az' } = {}) {
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

export function csvOf(users) {
  const cell = value => {
    let s = String(value ?? '');
    if (/^[\s]*[=+@\-\t\r]/.test(s)) s = `'${s}`;
    return `"${s.replaceAll('"', '""')}"`;
  };
  return '\uFEFF' + [['username', 'name', 'account_id', 'private', 'verified', 'profile'],
    ...users.map(u => [u.username, u.full_name, u.id, u.is_private, u.is_verified, `https://www.instagram.com/${u.username}/`])]
    .map(row => row.map(cell).join(',')).join('\r\n');
}

export function validateSnapshot(value, accountId) {
  if (!value || value.accountId !== accountId || value.complete !== true || !Number.isFinite(value.scannedAt)
    || value.scannedAt > Date.now() + 60000 || value.scannedAt < 0) throw new Error('This snapshot is invalid or belongs to another account.');
  let profile;
  if (value.profile) { const p = normalizeUser(value.profile); if (p.id === accountId) profile = p; }
  return { accountId, scannedAt: value.scannedAt, complete: true, ...(profile ? { profile } : {}),
    following: uniqueUsers(value.following), followers: uniqueUsers(value.followers) };
}

export function parseProtected(text, accountId) {
  const data = JSON.parse(text);
  if (data?.kind !== 'insta-unfollow-protected' || data.version !== 1 || data.accountId !== accountId) {
    throw new Error('This protection file is invalid or belongs to another account.');
  }
  return uniqueUsers(data.users);
}

export function abortError() { return new DOMException('Operation stopped.', 'AbortError'); }
export function checkAbort(signal) { if (signal?.aborted) throw abortError(); }
export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const stop = () => { clearTimeout(timer); reject(abortError()); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', stop); resolve(); }, ms);
    signal?.addEventListener('abort', stop, { once: true });
  });
}

export class UnfollowQueue {
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
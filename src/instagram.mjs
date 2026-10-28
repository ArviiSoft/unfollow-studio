import { normalizeUser, checkAbort, sleep } from './core.mjs';

export function cookieValue(name, cookie) {
  const entry = cookie.split(';').map(s => s.trim()).find(s => s.startsWith(`${name}=`));
  if (!entry) return '';
  try { return decodeURIComponent(entry.slice(name.length + 1)); } catch { return ''; }
}

export class InstagramError extends Error {
  constructor(message, code = 'request', details = {}) {
    super(message); this.name = 'InstagramError'; this.code = code; this.details = details;
  }
}

export function pageAccountUsername(accountId, pageDocument = globalThis.document) {
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

export function retryAfterTime(value, now = Date.now()) {
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

const UNFOLLOW_MUTATION = 'usePolarisUnfollowMutation';
const UNFOLLOW_DOC_ID = '27789106940691111';

export function webMutationContext(pageWindow = globalThis.window, pageDocument = globalThis.document) {
  const context = { fbDtsg: '', lsd: '', docId: UNFOLLOW_DOC_ID };
  const readModule = name => { try { return pageWindow?.require?.(name); } catch { return null; } };
  const setToken = (key, value) => { if (typeof value === 'string' && value.length > 0 && value.length <= 4096) context[key] = value; };
  setToken('fbDtsg', readModule('DTSGInitialData')?.token);
  setToken('lsd', readModule('LSD')?.token);
  const mutation = readModule(`${UNFOLLOW_MUTATION}.graphql`);
  if (mutation?.params?.name === UNFOLLOW_MUTATION && /^\d{1,30}$/.test(mutation.params.id)) context.docId = mutation.params.id;
  let remaining = 50000;
  for (const script of pageDocument?.querySelectorAll('script[type="application/json"]') ?? []) {
    if ((context.fbDtsg && context.lsd) || !remaining) break;
    if (script.textContent.length > 5 * 1024 * 1024) continue;
    let parsed;
    try { parsed = JSON.parse(script.textContent); } catch { continue; }
    const pending = [parsed];
    while (pending.length && remaining > 0) {
      const value = pending.pop(); remaining--;
      if (!value || typeof value !== 'object') continue;
      if (Array.isArray(value)) {
        if (value[0] === 'DTSGInitialData' && !context.fbDtsg) setToken('fbDtsg', value[2]?.token);
        if (value[0] === 'LSD' && !context.lsd) setToken('lsd', value[2]?.token);
      }
      for (const child of Object.values(value)) if (child && typeof child === 'object' && pending.length < remaining) pending.push(child);
    }
  }
  if (!context.fbDtsg || !context.lsd) throw new InstagramError('Instagram action data is unavailable. Refresh Instagram, open a profile, then reopen the panel and scan again. No unfollow request was sent.', 'session');
  return context;
}

function unfollowRequestBody(body, accountId) {
  if (typeof body !== 'string') return false;
  const params = new URLSearchParams(body);
  try {
    const variables = JSON.parse(params.get('variables'));
    return params.get('fb_api_req_friendly_name') === UNFOLLOW_MUTATION && /^\d{1,30}$/.test(params.get('doc_id'))
      && params.get('av') === accountId && typeof variables?.target_user_id === 'string'
      && /^\d{1,30}$/.test(variables.target_user_id) && variables.target_user_id !== accountId;
  } catch { return false; }
}

export class InstagramClient {
  constructor({ accountId, fetcher = globalThis.fetch.bind(globalThis), cookies = () => document.cookie, mutationContext = webMutationContext, pageDelay = 2500, maxPages = 1000, scanRetries = 3, wait = sleep, now = Date.now }) {
    Object.assign(this, { accountId, fetcher, cookies, mutationContext, pageDelay, maxPages, scanRetries, wait, now });
    this.retryAt = 0;
  }
  assertSession() {
    if (!/^\d+$/.test(this.accountId) || cookieValue('ds_user_id', this.cookies()) !== this.accountId) {
      throw new InstagramError('The Instagram account changed or signed out. Reopen the panel on the correct account.', 'session');
    }
    if (!cookieValue('csrftoken', this.cookies())) throw new InstagramError('Instagram session not found. Please sign in again.', 'session');
  }
  async request(path, { signal, method = 'GET', body = '', beforeSend, operation = 'request' } = {}) {
    checkAbort(signal); this.assertSession();
    const allowed = typeof path === 'string' && (method === 'GET'
      ? /^\/api\/v1\/friendships\/(?:\d{1,30}\/(?:followers|following)|show\/\d{1,30})\/(?:\?[^#\\\s]*)?$/.test(path)
        || /^\/graphql\/query\/\?[^#\\\s]+$/.test(path)
      : method === 'POST' && path === '/api/graphql' && unfollowRequestBody(body, this.accountId));
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
      if (method === 'POST') {
        headers['Content-Type'] = 'application/x-www-form-urlencoded';
        headers['X-FB-Friendly-Name'] = UNFOLLOW_MUTATION;
        headers['X-FB-LSD'] = new URLSearchParams(body).get('lsd');
      }
      beforeSend?.();
      const response = await this.fetcher(path, { method, credentials: 'same-origin', redirect: 'error', cache: 'no-store',
        headers, signal: timer.signal, ...(method === 'POST' ? { body } : {}) });
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
      if (!response.ok) throw new InstagramError(`Instagram returned HTTP ${response.status} during the ${operation}. ${response.status === 404 ? 'The account or request endpoint is unavailable. ' : ''}The operation was stopped.`, 'http', { status: response.status, operation });
      let data;
      try { data = JSON.parse((await response.text()).replace(/^for \(;;\);\s*/, '')); } catch { throw new InstagramError(`Instagram returned an unexpected response during the ${operation}. Check your session.`, 'response'); }
      if (!data || typeof data !== 'object' || data.status === 'fail' || data.error || data.errors?.length || requiresVerification(data)) {
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
    if (typeof id !== 'string' || !/^\d{1,30}$/.test(id) || id === this.accountId) throw new Error('Invalid target account.');
    checkAbort(signal); this.assertSession();
    const { fbDtsg, lsd, docId } = this.mutationContext();
    const checksum = [...fbDtsg].reduce((sum, char) => sum + char.charCodeAt(0), 0);
    const body = new URLSearchParams({ av: this.accountId, __d: 'www', __user: '0', __a: '1', __comet_req: '7',
      fb_dtsg: fbDtsg, jazoest: `2${checksum}`, lsd, fb_api_caller_class: 'RelayModern',
      fb_api_req_friendly_name: UNFOLLOW_MUTATION, doc_id: docId, server_timestamps: 'true',
      variables: JSON.stringify({ target_user_id: id, container_module: 'profile', nav_chain: 'PolarisProfilePostsTabRoot:profilePage:1:via_cold_start' }) }).toString();
    const data = await this.request('/api/graphql', { method: 'POST', body, signal, beforeSend, operation: 'unfollow request' });
    if (!data.data || typeof data.data !== 'object' || !Object.keys(data.data).length) throw new Error('Could not verify the result.');
    const result = data.data.xdt_api__v1__friendships__destroy;
    if (result?.status === 'fail' || requiresVerification(result)) throw new Error('Instagram rejected the unfollow. Check Instagram before continuing.');
    if (result?.friendship_status?.following === true || result?.friendship_status?.outgoing_request === true) throw new Error('The account is still followed or has a pending follow request.');
    if (result?.friendship_status?.following === false) return;
    const after = await this.relation(id, signal);
    if (after.following) throw new Error('Could not verify the unfollow.');
  }
}